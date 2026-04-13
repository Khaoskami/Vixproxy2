import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { authenticator } from 'otplib';
import qrcode from 'qrcode';
import db from '../models/database.js';
import { generateId } from '../utils/crypto.js';
import { audit } from '../utils/audit.js';
import logger from '../utils/logger.js';
import rateLimit from 'express-rate-limit';

const router = Router();
const loginLimiter = rateLimit({ windowMs: 15*60*1000, max: parseInt(process.env.LOGIN_RATE_LIMIT_MAX||'5'), message: { error: 'Too many login attempts.' }, standardHeaders: true, legacyHeaders: false });

router.get('/login', (req, res) => { if (req.session?.userId) return res.redirect('/dashboard'); res.sendFile('login.html', { root: 'public' }); });
router.get('/register', (req, res) => { if (req.session?.userId) return res.redirect('/dashboard'); res.sendFile('register.html', { root: 'public' }); });

router.post('/api/auth/register', loginLimiter, async (req, res) => {
  try {
    const { username, password, invite_code } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
    if (username.length < 3 || username.length > 32) return res.status(400).json({ error: 'Username must be 3-32 characters' });
    if (!/^[a-zA-Z0-9_-]+$/.test(username)) return res.status(400).json({ error: 'Invalid username characters' });
    if (password.length < 8) return res.status(400).json({ error: 'Password must be 8+ characters' });
    if (db.prepare('SELECT id FROM users WHERE username = ?').get(username)) return res.status(409).json({ error: 'Username taken' });

    let role = 'user';
    if (invite_code) {
      const code = db.prepare("SELECT * FROM invite_codes WHERE code = ? AND status = 'pending'").get(invite_code);
      if (!code) return res.status(400).json({ error: 'Invalid or expired invite code' });
      if (code.expires_at && code.expires_at < Math.floor(Date.now()/1000)) { db.prepare("UPDATE invite_codes SET status = 'expired' WHERE id = ?").run(code.id); return res.status(400).json({ error: 'Invite code expired' }); }
      role = code.type;
      db.prepare("UPDATE invite_codes SET status = 'used', used_at = unixepoch() WHERE id = ?").run(code.id);
    }

    const hash = await bcrypt.hash(password, 12);
    const id = generateId();
    db.prepare(`INSERT INTO users (id, username, password_hash, role, created_at, updated_at) VALUES (?, ?, ?, ?, unixepoch(), unixepoch())`).run(id, username, hash, role);
    if (invite_code) db.prepare("UPDATE invite_codes SET used_by = ? WHERE code = ?").run(id, invite_code);
    audit(id, username, 'register', 'user', id, { role }, req.ip);
    req.session.userId = id; req.session.username = username; req.session.role = role;
    res.json({ success: true, role });
  } catch (err) { logger.error('Register error', err); res.status(500).json({ error: 'Registration failed' }); }
});

router.post('/api/auth/login', loginLimiter, async (req, res) => {
  try {
    const { username, password, totp } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
    const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });
    if (user.locked_until && user.locked_until > Math.floor(Date.now()/1000)) return res.status(423).json({ error: `Account locked. Try again later.` });
    if (user.is_banned) return res.status(403).json({ error: `Account banned: ${user.ban_reason||'policy violation'}` });
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      const fails = user.failed_logins + 1;
      db.prepare('UPDATE users SET failed_logins = ?, locked_until = ? WHERE id = ?').run(fails, fails >= 5 ? Math.floor(Date.now()/1000)+15*60 : null, user.id);
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    if (user.totp_enabled && user.totp_secret) {
      if (!totp) return res.status(200).json({ requires2fa: true });
      if (!authenticator.check(totp, user.totp_secret)) return res.status(401).json({ error: 'Invalid 2FA code' });
    }
    db.prepare('UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = ?').run(user.id);
    req.session.userId = user.id; req.session.username = user.username; req.session.role = user.role;
    audit(user.id, user.username, 'login', 'user', user.id, {}, req.ip);
    res.json({ success: true, role: user.role });
  } catch (err) { logger.error('Login error', err); res.status(500).json({ error: 'Login failed' }); }
});

router.post('/api/auth/logout', (req, res) => { req.session.destroy(() => res.json({ success: true })); });
router.get('/api/auth/me', (req, res) => {
  if (!req.session?.userId) return res.status(401).json({ error: 'Not authenticated' });
  const user = db.prepare('SELECT id, username, role, totp_enabled, daily_request_limit, requests_used_today, created_at FROM users WHERE id = ?').get(req.session.userId);
  res.json(user);
});

router.post('/api/auth/2fa/setup', async (req, res) => {
  if (!req.session?.userId) return res.status(401).json({ error: 'Not authenticated' });
  const secret = authenticator.generateSecret();
  const user = db.prepare('SELECT username FROM users WHERE id = ?').get(req.session.userId);
  const otpauth = authenticator.keyuri(user.username, 'VixProxy', secret);
  const qr = await qrcode.toDataURL(otpauth);
  req.session.pending2faSecret = secret;
  res.json({ secret, qr });
});

router.post('/api/auth/2fa/verify', (req, res) => {
  if (!req.session?.userId) return res.status(401).json({ error: 'Not authenticated' });
  const { totp } = req.body;
  const secret = req.session.pending2faSecret;
  if (!secret) return res.status(400).json({ error: 'No pending 2FA setup' });
  if (!authenticator.check(totp, secret)) return res.status(400).json({ error: 'Invalid code' });
  db.prepare('UPDATE users SET totp_secret = ?, totp_enabled = 1 WHERE id = ?').run(secret, req.session.userId);
  delete req.session.pending2faSecret;
  res.json({ success: true });
});

router.post('/api/auth/2fa/disable', async (req, res) => {
  if (!req.session?.userId) return res.status(401).json({ error: 'Not authenticated' });
  const { password } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId);
  if (!await bcrypt.compare(password, user.password_hash)) return res.status(401).json({ error: 'Invalid password' });
  db.prepare('UPDATE users SET totp_secret = NULL, totp_enabled = 0 WHERE id = ?').run(req.session.userId);
  res.json({ success: true });
});

export default router;
