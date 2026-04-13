import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import db from '../models/database.js';
import { generateId, generateProxyKey } from '../utils/crypto.js';
import { audit } from '../utils/audit.js';

const router = Router();
router.use(requireAuth);

router.get('/proxy-keys', (req, res) => {
  const keys = db.prepare(`SELECT pk.id, pk.name, pk.key_prefix, pk.status, pk.daily_limit, pk.daily_used, pk.context_lock_enabled, pk.allowed_contexts, pk.csam_scan_enabled, pk.expires_at, pk.last_used_at, pk.created_at, mk.name as master_key_name, mk.provider FROM proxy_keys pk JOIN master_keys mk ON pk.master_key_id = mk.id WHERE pk.user_id = ? ORDER BY pk.created_at DESC`).all(req.user.id);
  res.json(keys);
});

router.post('/proxy-keys', (req, res) => {
  const { name, master_key_id, daily_limit, csam_scan_enabled, context_lock_enabled, allowed_contexts } = req.body;
  if (!name || !master_key_id) return res.status(400).json({ error: 'name and master_key_id required' });
  const mk = db.prepare('SELECT id FROM master_keys WHERE id = ? AND is_active = 1').get(master_key_id);
  if (!mk) return res.status(404).json({ error: 'Master key not found or inactive' });
  const keyValue = generateProxyKey();
  const id = generateId();
  db.prepare(`INSERT INTO proxy_keys (id, name, key_value, key_prefix, user_id, master_key_id, daily_limit, csam_scan_enabled, context_lock_enabled, allowed_contexts, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch())`).run(id, name, keyValue, keyValue.slice(0,12), req.user.id, master_key_id, daily_limit||100, csam_scan_enabled!==false?1:0, context_lock_enabled?1:0, JSON.stringify(allowed_contexts||['general','creative','roleplay']));
  audit(req.user.id, req.user.username, 'create_proxy_key', 'proxy_key', id, { name }, req.ip);
  res.json({ id, name, key_value: keyValue, key_prefix: keyValue.slice(0,12) });
});

router.delete('/proxy-keys/:id', (req, res) => {
  const key = db.prepare('SELECT id FROM proxy_keys WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!key) return res.status(404).json({ error: 'Key not found' });
  db.prepare("UPDATE proxy_keys SET status = 'revoked' WHERE id = ?").run(req.params.id);
  audit(req.user.id, req.user.username, 'revoke_proxy_key', 'proxy_key', req.params.id, {}, req.ip);
  res.json({ success: true });
});

router.get('/stats', (req, res) => {
  const user = db.prepare('SELECT requests_used_today, daily_request_limit, last_reset_at FROM users WHERE id = ?').get(req.user.id);
  const recentLogs = db.prepare(`SELECT provider, model, status, total_tokens, latency_ms, csam_flagged, created_at FROM request_logs WHERE user_id = ? ORDER BY created_at DESC LIMIT 50`).all(req.user.id);
  const totalRequests = db.prepare('SELECT COUNT(*) as c FROM request_logs WHERE user_id = ?').get(req.user.id);
  const totalTokens = db.prepare('SELECT SUM(total_tokens) as t FROM request_logs WHERE user_id = ?').get(req.user.id);
  const csamFlags = db.prepare('SELECT COUNT(*) as c FROM request_logs WHERE user_id = ? AND csam_flagged = 1').get(req.user.id);
  res.json({ user, totals: { requests: totalRequests.c, tokens: totalTokens.t||0, csamFlags: csamFlags.c }, recentLogs });
});

router.get('/available-providers', (req, res) => {
  const keys = db.prepare(`SELECT id, name, provider, models FROM master_keys WHERE is_active = 1 ORDER BY provider, name`).all();
  res.json(keys.map(k => ({ ...k, models: JSON.parse(k.models||'[]') })));
});

export default router;
