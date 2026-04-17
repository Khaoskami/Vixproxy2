import { Router } from 'express';
import { requireAuth } from '../middleware/security.js';
import { supabase } from '../models/supabase.js';

const router = Router();
router.use(requireAuth);

function todayUTC() {
  return new Date().toISOString().slice(0, 10);
}

// GET /api/logs/usage — recent usage logs (last 100)
router.get('/usage', async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 100, 200);
  const { data: logs, error } = await supabase
    .from('vk_usage_logs')
    .select(
      'id, model, endpoint, prompt_tokens, completion_tokens, total_tokens, cost_microdollars, latency_ms, status_code, created_at',
    )
    .eq('user_id', req.user.id)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) return res.status(500).json({ error: 'Failed to fetch logs' });
  res.json({ logs });
});

// GET /api/logs/stats — dashboard stats
router.get('/stats', async (req, res) => {
  try {
    const [creditsRes, tierConfigRes, userCounterRes, todayUsageRes] = await Promise.all([
      supabase
        .from('vk_credits')
        .select('balance_microdollars, lifetime_purchased, lifetime_used')
        .eq('user_id', req.user.id)
        .maybeSingle(),
      supabase.from('vk_tier_config').select('*').eq('tier', req.user.tier).maybeSingle(),
      supabase
        .from('vk_daily_counters')
        .select('request_count, message_count, tokens_used, cost_microdollars')
        .eq('id', req.user.id)
        .eq('counter_type', 'user')
        .eq('reset_date', todayUTC())
        .maybeSingle(),
      supabase
        .from('vk_usage_logs')
        .select('cost_microdollars')
        .eq('user_id', req.user.id)
        .gte('created_at', `${todayUTC()}T00:00:00Z`),
    ]);

    const credits = creditsRes.data || { balance_microdollars: 0, lifetime_purchased: 0, lifetime_used: 0 };
    const tier = tierConfigRes.data;
    const counter = userCounterRes.data || { request_count: 0, message_count: 0, tokens_used: 0, cost_microdollars: 0 };
    const todayCost = (todayUsageRes.data || []).reduce((sum, r) => sum + (r.cost_microdollars || 0), 0);

    res.json({
      tier: req.user.tier,
      credits: {
        balance: credits.balance_microdollars,
        lifetimePurchased: credits.lifetime_purchased,
        lifetimeUsed: credits.lifetime_used,
      },
      dailyCounters: {
        requests: counter.request_count,
        messages: counter.message_count,
        tokens: counter.tokens_used,
        cost: counter.cost_microdollars,
      },
      today: { cost_today: todayCost },
      limits: tier
        ? {
            rpm: tier.rate_limit_rpm,
            rpd: tier.rate_limit_rpd,
            maxMessagesPerDay: tier.max_messages_per_day || 0,
            maxContextTokens: tier.max_context_tokens,
          }
        : null,
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

export default router;
