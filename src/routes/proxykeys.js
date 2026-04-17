import { Router } from 'express';
import { requireAuth } from '../middleware/security.js';
import { generateProxyKey } from '../services/AuthService.js';
import { supabase } from '../models/supabase.js';

const router = Router();
router.use(requireAuth);

// POST /api/proxy-keys — Generate a new proxy key
router.post('/', async (req, res) => {
  const { raw, hash, prefix } = generateProxyKey();
  const label = (req.body?.label || 'Default Key').toString().slice(0, 100);

  const { error } = await supabase.from('vk_proxy_keys').insert({
    user_id: req.user.id,
    key_hash: hash,
    key_prefix: prefix,
    label,
  });

  if (error) return res.status(500).json({ error: 'Failed to create key' });
  res.status(201).json({
    key: { key: raw, prefix, label },
    message: "Copy this key now — it won't be shown again.",
  });
});

// GET /api/proxy-keys — List user's keys
router.get('/', async (req, res) => {
  const { data: keys, error } = await supabase
    .from('vk_proxy_keys')
    .select('id, key_prefix, label, is_active, created_at, last_used, expires_at')
    .eq('user_id', req.user.id)
    .order('created_at', { ascending: false });

  if (error) return res.status(500).json({ error: 'Failed to fetch keys' });
  res.json({ keys });
});

// DELETE /api/proxy-keys/:id — Revoke a key
router.delete('/:id', async (req, res) => {
  const { error } = await supabase
    .from('vk_proxy_keys')
    .delete()
    .eq('id', req.params.id)
    .eq('user_id', req.user.id);

  if (error) return res.status(500).json({ error: 'Failed to revoke key' });
  res.json({ message: 'Key revoked' });
});

export default router;
