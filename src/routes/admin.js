import { Router } from 'express';
import crypto from 'crypto';
import { body, param, validationResult } from 'express-validator';
import { requireAuth, requireAdmin, requireSuperadmin } from '../middleware/security.js';
import { supabase } from '../models/supabase.js';
import logger from '../utils/logger.js';

const router = Router();
router.use(requireAuth);
router.use(requireAdmin);

function valErr(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    res.status(400).json({ error: 'Validation failed', details: errors.array().map((e) => e.msg) });
    return true;
  }
  return false;
}

async function audit(actorId, action, opts = {}) {
  const { error } = await supabase.from('vk_audit_log').insert({
    actor_id: actorId,
    action,
    target_type: opts.targetType || null,
    target_id: opts.targetId || null,
    details: opts.details || null,
    ip_address: opts.ip || null,
  });
  if (error) logger.warn(`audit log error: ${error.message}`);
}

// ═══════════════════════════════════════════════
//  USER MANAGEMENT
// ═══════════════════════════════════════════════

// GET /api/admin/users — list all users
router.get('/users', async (_req, res) => {
  const { data: users, error } = await supabase
    .from('vk_users')
    .select('id, username, role, tier, is_active, totp_enabled, last_login, created_at')
    .order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: 'Failed to fetch users' });
  res.json({ users });
});

// PATCH /api/admin/users/:id/active — toggle active
router.patch(
  '/users/:id/active',
  [param('id').isUUID(), body('active').isBoolean()],
  async (req, res) => {
    if (valErr(req, res)) return;

    // Don't let an admin disable themselves
    if (req.params.id === req.user.id) {
      return res.status(400).json({ error: 'Cannot disable your own account' });
    }

    // Don't let non-superadmins touch superadmins
    const { data: target } = await supabase
      .from('vk_users')
      .select('role')
      .eq('id', req.params.id)
      .maybeSingle();
    if (!target) return res.status(404).json({ error: 'User not found' });
    if (target.role === 'superadmin' && req.user.role !== 'superadmin') {
      return res.status(403).json({ error: 'Cannot modify a superadmin' });
    }

    const { error } = await supabase
      .from('vk_users')
      .update({ is_active: req.body.active, updated_at: new Date().toISOString() })
      .eq('id', req.params.id);
    if (error) return res.status(500).json({ error: 'Failed to update user' });

    await audit(req.user.id, req.body.active ? 'user_activated' : 'user_deactivated', {
      targetType: 'user',
      targetId: req.params.id,
      ip: req.ip,
    });
    res.json({ message: `User ${req.body.active ? 'activated' : 'deactivated'}` });
  },
);

// PATCH /api/admin/users/:id/role — change role (superadmin only for promoting to superadmin)
router.patch(
  '/users/:id/role',
  [param('id').isUUID(), body('role').isIn(['user', 'admin', 'superadmin'])],
  async (req, res) => {
    if (valErr(req, res)) return;
    const newRole = req.body.role;

    if (req.params.id === req.user.id) {
      return res.status(400).json({ error: 'Cannot change your own role' });
    }
    if (newRole === 'superadmin' && req.user.role !== 'superadmin') {
      return res.status(403).json({ error: 'Only superadmins can promote to superadmin' });
    }

    const { data: target } = await supabase
      .from('vk_users')
      .select('role')
      .eq('id', req.params.id)
      .maybeSingle();
    if (!target) return res.status(404).json({ error: 'User not found' });
    if (target.role === 'superadmin' && req.user.role !== 'superadmin') {
      return res.status(403).json({ error: 'Cannot modify a superadmin' });
    }

    const { error } = await supabase
      .from('vk_users')
      .update({ role: newRole, updated_at: new Date().toISOString() })
      .eq('id', req.params.id);
    if (error) return res.status(500).json({ error: 'Failed to update role' });

    await audit(req.user.id, 'user_role_changed', {
      targetType: 'user',
      targetId: req.params.id,
      details: { newRole, oldRole: target.role },
      ip: req.ip,
    });
    res.json({ message: `Role changed to ${newRole}` });
  },
);

// PATCH /api/admin/users/:id/tier — change tier
router.patch(
  '/users/:id/tier',
  [param('id').isUUID(), body('tier').isIn(['free', 'basic', 'pro', 'unlimited'])],
  async (req, res) => {
    if (valErr(req, res)) return;
    const { error } = await supabase
      .from('vk_users')
      .update({ tier: req.body.tier, updated_at: new Date().toISOString() })
      .eq('id', req.params.id);
    if (error) return res.status(500).json({ error: 'Failed to update tier' });

    await audit(req.user.id, 'user_tier_changed', {
      targetType: 'user',
      targetId: req.params.id,
      details: { tier: req.body.tier },
      ip: req.ip,
    });
    res.json({ message: `Tier set to ${req.body.tier}` });
  },
);

// ═══════════════════════════════════════════════
//  CREDITS
// ═══════════════════════════════════════════════

// GET /api/admin/users/:id/credits
router.get('/users/:id/credits', [param('id').isUUID()], async (req, res) => {
  if (valErr(req, res)) return;
  const { data, error } = await supabase
    .from('vk_credits')
    .select('balance_microdollars, lifetime_purchased, lifetime_used, updated_at')
    .eq('user_id', req.params.id)
    .maybeSingle();
  if (error) return res.status(500).json({ error: 'Failed to fetch credits' });
  res.json({ credits: data || { balance_microdollars: 0, lifetime_purchased: 0, lifetime_used: 0 } });
});

// POST /api/admin/users/:id/credits — add to balance
router.post(
  '/users/:id/credits',
  requireSuperadmin,
  [param('id').isUUID(), body('amount').isInt({ min: 1 })],
  async (req, res) => {
    if (valErr(req, res)) return;
    const amount = req.body.amount;

    // Upsert: if no row exists, create one with this balance
    const { data: existing } = await supabase
      .from('vk_credits')
      .select('balance_microdollars, lifetime_purchased')
      .eq('user_id', req.params.id)
      .maybeSingle();

    const newBalance = (existing?.balance_microdollars || 0) + amount;
    const newLifetime = (existing?.lifetime_purchased || 0) + amount;

    const { error } = await supabase
      .from('vk_credits')
      .upsert(
        {
          user_id: req.params.id,
          balance_microdollars: newBalance,
          lifetime_purchased: newLifetime,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'user_id' },
      );

    if (error) return res.status(500).json({ error: 'Failed to add credits' });

    await audit(req.user.id, 'credits_added', {
      targetType: 'user',
      targetId: req.params.id,
      details: { amount },
      ip: req.ip,
    });
    res.json({ message: `Added ${amount} microdollars` });
  },
);

// PUT /api/admin/users/:id/credits — set exact balance
router.put(
  '/users/:id/credits',
  requireSuperadmin,
  [param('id').isUUID(), body('balance').isInt({ min: 0 })],
  async (req, res) => {
    if (valErr(req, res)) return;
    const balance = req.body.balance;

    const { error } = await supabase
      .from('vk_credits')
      .upsert(
        {
          user_id: req.params.id,
          balance_microdollars: balance,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'user_id' },
      );

    if (error) return res.status(500).json({ error: 'Failed to set credits' });

    await audit(req.user.id, 'credits_set', {
      targetType: 'user',
      targetId: req.params.id,
      details: { balance },
      ip: req.ip,
    });
    res.json({ message: `Balance set to ${balance} microdollars` });
  },
);

// ═══════════════════════════════════════════════
//  TIER CONFIG
// ═══════════════════════════════════════════════

// GET /api/admin/tiers
router.get('/tiers', async (_req, res) => {
  const { data: tiers, error } = await supabase
    .from('vk_tier_config')
    .select('*')
    .order('tier');
  if (error) return res.status(500).json({ error: 'Failed to fetch tiers' });

  // Normalize allowed_models — Supabase returns JSONB as array already, but be defensive
  const normalized = (tiers || []).map((t) => ({
    ...t,
    allowed_models: Array.isArray(t.allowed_models)
      ? t.allowed_models
      : JSON.parse(t.allowed_models || '["*"]'),
  }));
  res.json({ tiers: normalized });
});

// PUT /api/admin/tiers/:tier — update tier config
router.put(
  '/tiers/:tier',
  requireSuperadmin,
  [
    param('tier').isIn(['free', 'basic', 'pro', 'unlimited']),
    body('rateLimitRpm').isInt({ min: 1 }),
    body('rateLimitRpd').isInt({ min: 1 }),
    body('maxMessagesPerDay').isInt({ min: 0 }),
    body('maxContextTokens').isInt({ min: 1 }),
    body('allowedModels').isArray(),
    body('priceMultiplier').isFloat({ min: 0.1, max: 10 }),
  ],
  async (req, res) => {
    if (valErr(req, res)) return;
    const { error } = await supabase
      .from('vk_tier_config')
      .update({
        rate_limit_rpm: req.body.rateLimitRpm,
        rate_limit_rpd: req.body.rateLimitRpd,
        max_messages_per_day: req.body.maxMessagesPerDay,
        max_context_tokens: req.body.maxContextTokens,
        allowed_models: req.body.allowedModels,
        price_multiplier: req.body.priceMultiplier,
      })
      .eq('tier', req.params.tier);
    if (error) return res.status(500).json({ error: 'Failed to update tier' });

    await audit(req.user.id, 'tier_updated', {
      targetType: 'tier',
      targetId: req.params.tier,
      details: req.body,
      ip: req.ip,
    });
    res.json({ message: `Tier ${req.params.tier} updated` });
  },
);

// ═══════════════════════════════════════════════
//  DAILY COUNTERS
// ═══════════════════════════════════════════════

// GET /api/admin/daily-counters — list active counters (today only)
router.get('/daily-counters', async (_req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  const { data: counters, error } = await supabase
    .from('vk_daily_counters')
    .select('*')
    .eq('reset_date', today)
    .order('cost_microdollars', { ascending: false })
    .limit(200);
  if (error) return res.status(500).json({ error: 'Failed to fetch counters' });
  res.json({ counters });
});

// POST /api/admin/daily-counters/reset — force prune stale counters
router.post('/daily-counters/reset', requireSuperadmin, async (req, res) => {
  const { data, error } = await supabase.rpc('vk_reset_stale_counters');
  if (error) return res.status(500).json({ error: 'Failed to reset counters' });
  await audit(req.user.id, 'counters_reset', { details: { rowsDeleted: data }, ip: req.ip });
  res.json({ message: `Reset ${data || 0} stale counter(s)` });
});

// ═══════════════════════════════════════════════
//  CONTENT SAFETY
// ═══════════════════════════════════════════════

// GET /api/admin/safety/stats
router.get('/safety/stats', async (_req, res) => {
  const [pendingRes, totalRes, confirmedRes, dismissedRes] = await Promise.all([
    supabase.from('vk_content_flags').select('id', { count: 'exact', head: true }).eq('status', 'pending'),
    supabase.from('vk_content_flags').select('id', { count: 'exact', head: true }),
    supabase.from('vk_content_flags').select('id', { count: 'exact', head: true }).eq('status', 'confirmed'),
    supabase.from('vk_content_flags').select('id', { count: 'exact', head: true }).eq('status', 'dismissed'),
  ]);

  res.json({
    stats: {
      pending: pendingRes.count || 0,
      total: totalRes.count || 0,
      confirmed: confirmedRes.count || 0,
      dismissed: dismissedRes.count || 0,
    },
  });
});

// GET /api/admin/safety/flags
router.get('/safety/flags', async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 50, 200);
  const offset = parseInt(req.query.offset) || 0;
  let query = supabase
    .from('vk_content_flags')
    .select('*, vk_users!vk_content_flags_user_id_fkey(username)')
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (req.query.status) query = query.eq('status', req.query.status);

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: 'Failed to fetch flags' });

  const flags = (data || []).map((f) => ({
    ...f,
    username: f.vk_users?.username || 'unknown',
    matched_patterns: Array.isArray(f.matched_patterns)
      ? f.matched_patterns
      : JSON.parse(f.matched_patterns || '[]'),
  }));
  res.json({ flags });
});

// PATCH /api/admin/safety/flags/:id — review (confirm/dismiss)
router.patch(
  '/safety/flags/:id',
  [
    param('id').isUUID(),
    body('status').isIn(['reviewed', 'dismissed', 'confirmed']),
    body('notes').optional().isString().isLength({ max: 1000 }),
  ],
  async (req, res) => {
    if (valErr(req, res)) return;
    const { error } = await supabase
      .from('vk_content_flags')
      .update({
        status: req.body.status,
        reviewed_by: req.user.id,
        reviewed_at: new Date().toISOString(),
        notes: req.body.notes || null,
      })
      .eq('id', req.params.id);
    if (error) return res.status(500).json({ error: 'Failed to update flag' });

    await audit(req.user.id, 'content_flag_reviewed', {
      targetType: 'content_flag',
      targetId: req.params.id,
      details: { status: req.body.status },
      ip: req.ip,
    });
    res.json({ message: `Flag marked as ${req.body.status}` });
  },
);

// ═══════════════════════════════════════════════
//  INVITE CODES
// ═══════════════════════════════════════════════

// POST /api/admin/invite-codes — generate
router.post(
  '/invite-codes',
  requireSuperadmin,
  [body('role').isIn(['admin', 'superadmin']), body('expiresInHours').optional().isInt({ min: 1, max: 720 })],
  async (req, res) => {
    if (valErr(req, res)) return;
    const code = 'inv_' + crypto.randomBytes(16).toString('hex');
    const expiresAt = req.body.expiresInHours
      ? new Date(Date.now() + req.body.expiresInHours * 3600 * 1000).toISOString()
      : null;

    const { error } = await supabase.from('vk_invite_codes').insert({
      code,
      role: req.body.role,
      created_by: req.user.id,
      expires_at: expiresAt,
    });
    if (error) return res.status(500).json({ error: 'Failed to generate code' });

    await audit(req.user.id, 'invite_code_created', {
      targetType: 'invite_code',
      details: { role: req.body.role, expiresAt },
      ip: req.ip,
    });
    res.status(201).json({ code, role: req.body.role, expiresAt });
  },
);

// GET /api/admin/invite-codes
router.get('/invite-codes', requireSuperadmin, async (_req, res) => {
  const { data, error } = await supabase
    .from('vk_invite_codes')
    .select('*, used_by_user:vk_users!vk_invite_codes_used_by_fkey(username)')
    .order('code');
  if (error) return res.status(500).json({ error: 'Failed to fetch codes' });

  const codes = (data || []).map((c) => ({
    ...c,
    used_by_name: c.used_by_user?.username || null,
  }));
  res.json({ codes });
});

// DELETE /api/admin/invite-codes/:code
router.delete('/invite-codes/:code', requireSuperadmin, async (req, res) => {
  const { error } = await supabase
    .from('vk_invite_codes')
    .delete()
    .eq('code', req.params.code)
    .eq('is_used', false);
  if (error) return res.status(500).json({ error: 'Failed to revoke code' });
  await audit(req.user.id, 'invite_code_revoked', {
    targetType: 'invite_code',
    targetId: req.params.code,
    ip: req.ip,
  });
  res.json({ message: 'Code revoked' });
});

// ═══════════════════════════════════════════════
//  AUDIT LOG
// ═══════════════════════════════════════════════

router.get('/audit-log', async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 100, 500);
  const offset = parseInt(req.query.offset) || 0;
  const { data, error } = await supabase
    .from('vk_audit_log')
    .select('*, vk_users!vk_audit_log_actor_id_fkey(username)')
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);
  if (error) return res.status(500).json({ error: 'Failed to fetch audit log' });

  const logs = (data || []).map((l) => ({
    ...l,
    actor_name: l.vk_users?.username || 'unknown',
  }));
  res.json({ logs });
});

export default router;
