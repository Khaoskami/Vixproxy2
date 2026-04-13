import { Router } from 'express';
import { requireAdmin, requireSuperadmin } from '../middleware/auth.js';
import db from '../models/database.js';
import { generateId, generateInviteCode, encrypt } from '../utils/crypto.js';
import { audit } from '../utils/audit.js';
import logger from '../utils/logger.js';

const router = Router();
router.use(requireAdmin); // Most admin routes just need admin, specific ones will nest requireSuperadmin

// ==========================================
// USERS
// ==========================================
router.get('/users', (req, res) => {
  const users = db.prepare('SELECT id, username, role, email, totp_enabled, failed_logins, locked_until, daily_request_limit, requests_used_today, last_reset_at, is_banned, ban_reason, created_at FROM users ORDER BY created_at DESC').all();
  res.json(users);
});

router.post('/users/:id/ban', requireSuperadmin, (req, res) => {
  const { reason } = req.body;
  if (req.user.id === req.params.id) return res.status(400).json({ error: 'Cannot ban yourself' });
  db.prepare('UPDATE users SET is_banned = 1, ban_reason = ? WHERE id = ?').run(reason || 'Violated terms', req.params.id);
  audit(req.user.id, req.user.username, 'ban_user', 'user', req.params.id, { reason }, req.ip);
  res.json({ success: true });
});

router.post('/users/:id/unban', requireSuperadmin, (req, res) => {
  db.prepare('UPDATE users SET is_banned = 0, ban_reason = NULL WHERE id = ?').run(req.params.id);
  audit(req.user.id, req.user.username, 'unban_user', 'user', req.params.id, {}, req.ip);
  res.json({ success: true });
});

router.post('/users/:id/limits', requireSuperadmin, (req, res) => {
  const { limit } = req.body;
  if (typeof limit !== 'number' || limit < 0) return res.status(400).json({ error: 'Invalid limit' });
  db.prepare('UPDATE users SET daily_request_limit = ? WHERE id = ?').run(limit, req.params.id);
  audit(req.user.id, req.user.username, 'update_user_limits', 'user', req.params.id, { limit }, req.ip);
  res.json({ success: true });
});

// ==========================================
// MASTER KEYS
// ==========================================
router.get('/master-keys', (req, res) => {
  const keys = db.prepare(`
    SELECT mk.id, mk.name, mk.provider, mk.models, mk.base_url, mk.is_active, mk.daily_quota, mk.daily_used, mk.last_reset_at, mk.created_at, u.username as created_by 
    FROM master_keys mk 
    LEFT JOIN users u ON mk.created_by = u.id 
    ORDER BY mk.created_at DESC
  `).all();
  res.json(keys.map(k => ({ ...k, models: JSON.parse(k.models || '[]') })));
});

router.post('/master-keys', requireSuperadmin, (req, res) => {
  const { name, provider, key, models, base_url, daily_quota } = req.body;
  if (!name || !provider || !key) return res.status(400).json({ error: 'Name, provider, and key required' });
  
  const id = generateId();
  const encrypted = encrypt(key);
  const modelsStr = JSON.stringify(models || []);
  
  db.prepare(`
    INSERT INTO master_keys (id, name, provider, encrypted_key, key_iv, key_tag, models, base_url, daily_quota, created_by, created_at, updated_at) 
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch(), unixepoch())
  `).run(id, name, provider, encrypted.data, encrypted.iv, encrypted.tag, modelsStr, base_url || null, daily_quota || 50000, req.user.id);
  
  audit(req.user.id, req.user.username, 'create_master_key', 'master_key', id, { name, provider }, req.ip);
  res.json({ success: true, id });
});

router.put('/master-keys/:id/toggle', requireSuperadmin, (req, res) => {
  const key = db.prepare('SELECT is_active FROM master_keys WHERE id = ?').get(req.params.id);
  if (!key) return res.status(404).json({ error: 'Key not found' });
  const newState = key.is_active ? 0 : 1;
  db.prepare('UPDATE master_keys SET is_active = ? WHERE id = ?').run(newState, req.params.id);
  audit(req.user.id, req.user.username, 'toggle_master_key', 'master_key', req.params.id, { active: newState }, req.ip);
  res.json({ success: true, is_active: newState });
});

router.delete('/master-keys/:id', requireSuperadmin, (req, res) => {
  db.prepare('DELETE FROM master_keys WHERE id = ?').run(req.params.id);
  audit(req.user.id, req.user.username, 'delete_master_key', 'master_key', req.params.id, {}, req.ip);
  res.json({ success: true });
});

// ==========================================
// PROXY KEYS (VIEW ALL)
// ==========================================
router.get('/proxy-keys', (req, res) => {
  const keys = db.prepare(`
    SELECT pk.id, pk.name, pk.status, pk.daily_limit, pk.daily_used, pk.created_at, u.username, mk.provider, mk.name as master_key_name 
    FROM proxy_keys pk 
    JOIN users u ON pk.user_id = u.id 
    JOIN master_keys mk ON pk.master_key_id = mk.id 
    ORDER BY pk.created_at DESC LIMIT 100
  `).all();
  res.json(keys);
});

// ==========================================
// INVITE CODES
// ==========================================
router.get('/invite-codes', requireSuperadmin, (req, res) => {
  const codes = db.prepare(`
    SELECT ic.id, ic.code, ic.type, ic.status, ic.expires_at, ic.created_at, ic.used_at, c.username as creator_name, u.username as used_by_name 
    FROM invite_codes ic 
    LEFT JOIN users c ON ic.created_by = c.id 
    LEFT JOIN users u ON ic.used_by = u.id 
    ORDER BY ic.created_at DESC
  `).all();
  res.json(codes);
});

router.post('/invite-codes', requireSuperadmin, (req, res) => {
  const { type, expires_in_days } = req.body;
  const roleType = ['admin', 'user'].includes(type) ? type : 'user';
  const id = generateId();
  const code = generateInviteCode();
  const expiresAt = expires_in_days ? Math.floor(Date.now()/1000) + (expires_in_days * 86400) : null;
  
  db.prepare(`
    INSERT INTO invite_codes (id, code, type, created_by, expires_at, created_at) 
    VALUES (?, ?, ?, ?, ?, unixepoch())
  `).run(id, code, roleType, req.user.id, expiresAt);
  
  audit(req.user.id, req.user.username, 'create_invite', 'invite_code', id, { type: roleType }, req.ip);
  res.json({ success: true, id, code });
});

// ==========================================
// LOGS
// ==========================================
router.get('/request-logs', (req, res) => {
  const limit = parseInt(req.query.limit) || 100;
  const offset = parseInt(req.query.offset) || 0;
  const logs = db.prepare(`
    SELECT rl.*, u.username 
    FROM request_logs rl 
    LEFT JOIN users u ON rl.user_id = u.id 
    ORDER BY rl.created_at DESC LIMIT ? OFFSET ?
  `).all(limit, offset);
  res.json(logs);
});

router.get('/audit-logs', (req, res) => {
  const limit = parseInt(req.query.limit) || 100;
  const offset = parseInt(req.query.offset) || 0;
  const logs = db.prepare(`SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT ? OFFSET ?`).all(limit, offset);
  res.json(logs);
});

export default router;
