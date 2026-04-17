import { Router } from 'express';
import crypto from 'crypto';
import { supabase } from '../models/supabase.js';
import { apiLimiter, v1Cors } from '../middleware/security.js';
import { relayChatCompletions, fetchModels } from '../services/NewApiService.js';
import { calculateCostMicrodollars, isModelAllowed } from '../services/pricing.js';
import { checkAndFlag } from '../services/ContentSafetyService.js';
import { countMessageTokens, estimateCompletionTokensFromStream } from '../utils/tokenizer.js';
import logger from '../utils/logger.js';

const router = Router();

// Permissive CORS for /v1 — RP frontends connect cross-origin
router.use(v1Cors);
router.options('*', v1Cors);
router.use(apiLimiter);

// In-memory RPM cache (per key). Lost on restart, which is acceptable —
// daily counters are persisted, and RPM windows are short.
const rpmCache = new Map();

// ─── Helpers ─────────────────────────────────────────

function hashKey(raw) {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

function todayUTC() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Authenticate a vxk_ proxy key. Returns the joined key + user + tier_config row,
 * or null if invalid / expired / inactive.
 */
async function authenticateProxyKey(rawToken) {
  if (!rawToken || !rawToken.startsWith('vxk_')) return null;
  const hash = hashKey(rawToken);

  const { data: key, error } = await supabase
    .from('vk_proxy_keys')
    .select(
      `
      id, user_id, is_active, expires_at, rate_limit_rpm, rate_limit_rpd,
      vk_users!inner ( id, username, role, tier, is_active )
    `,
    )
    .eq('key_hash', hash)
    .maybeSingle();

  if (error || !key) return null;
  if (!key.is_active) return null;
  if (key.expires_at && new Date(key.expires_at) < new Date()) return null;

  const user = key.vk_users;
  if (!user || !user.is_active) return null;

  const { data: tierConfig } = await supabase
    .from('vk_tier_config')
    .select('*')
    .eq('tier', user.tier)
    .maybeSingle();

  if (!tierConfig) return null;

  // Update last_used asynchronously — don't block the request
  supabase
    .from('vk_proxy_keys')
    .update({ last_used: new Date().toISOString() })
    .eq('id', key.id)
    .then(({ error: updErr }) => {
      if (updErr) logger.warn(`Failed to update last_used: ${updErr.message}`);
    });

  return {
    keyId: key.id,
    userId: user.id,
    username: user.username,
    tier: user.tier,
    role: user.role,
    perKeyRpm: key.rate_limit_rpm,
    perKeyRpd: key.rate_limit_rpd,
    tierConfig: {
      rateLimitRpm: key.rate_limit_rpm || tierConfig.rate_limit_rpm,
      rateLimitRpd: key.rate_limit_rpd || tierConfig.rate_limit_rpd,
      maxMessagesPerDay: tierConfig.max_messages_per_day,
      maxContextTokens: tierConfig.max_context_tokens,
      allowedModels: Array.isArray(tierConfig.allowed_models)
        ? tierConfig.allowed_models
        : JSON.parse(tierConfig.allowed_models || '["*"]'),
      priceMultiplier: tierConfig.price_multiplier || 1.0,
    },
  };
}

/**
 * Fetch today's daily counters for a given id (key or user). Returns zeros if missing.
 */
async function getDailyCounters(id, type) {
  const { data, error } = await supabase
    .from('vk_daily_counters')
    .select('request_count, message_count, tokens_used, cost_microdollars')
    .eq('id', id)
    .eq('counter_type', type)
    .eq('reset_date', todayUTC())
    .maybeSingle();

  if (error) {
    logger.warn(`getDailyCounters error: ${error.message}`);
    return { request_count: 0, message_count: 0, tokens_used: 0, cost_microdollars: 0 };
  }
  return data || { request_count: 0, message_count: 0, tokens_used: 0, cost_microdollars: 0 };
}

/**
 * Atomic counter increment via the vk_increment_counter SQL function.
 * Falls back silently on error — never blocks the user request.
 */
async function incrementCounter(id, type, deltas) {
  const { error } = await supabase.rpc('vk_increment_counter', {
    p_id: id,
    p_counter_type: type,
    p_request_delta: deltas.requests || 0,
    p_message_delta: deltas.messages || 0,
    p_tokens_delta: deltas.tokens || 0,
    p_cost_delta: deltas.cost || 0,
  });
  if (error) logger.warn(`incrementCounter error: ${error.message}`);
}

/**
 * Atomic credit deduction. Returns true if deducted, false if insufficient.
 */
async function deductCredits(userId, amount) {
  if (amount <= 0) return true;
  const { data, error } = await supabase.rpc('vk_deduct_credits', {
    p_user_id: userId,
    p_amount: amount,
  });
  if (error) {
    logger.warn(`deductCredits error: ${error.message}`);
    return false;
  }
  return data !== null;
}

/**
 * Check user has at least 1 microdollar of credit (skipped for unlimited tier).
 */
async function hasSufficientCredits(userId, tier) {
  if (tier === 'unlimited') return true;
  const { data } = await supabase
    .from('vk_credits')
    .select('balance_microdollars')
    .eq('user_id', userId)
    .maybeSingle();
  return (data?.balance_microdollars || 0) > 0;
}

async function logUsage(entry) {
  const { error } = await supabase.from('vk_usage_logs').insert({
    api_key_id: entry.apiKeyId,
    user_id: entry.userId,
    model: entry.model,
    endpoint: entry.endpoint || '/chat/completions',
    prompt_tokens: entry.promptTokens || 0,
    completion_tokens: entry.completionTokens || 0,
    total_tokens: entry.totalTokens || 0,
    cost_microdollars: entry.costMicrodollars || 0,
    request_id: entry.requestId,
    latency_ms: entry.latencyMs,
    status_code: entry.statusCode,
    error_type: entry.errorType,
  });
  if (error) logger.warn(`logUsage error: ${error.message}`);
}

// ─── Middleware ──────────────────────────────────────

async function requireProxyKey(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) {
    return res.status(401).json({
      error: { message: 'Missing Authorization header', type: 'auth_error' },
    });
  }
  const token = auth.slice(7).trim();
  const keyInfo = await authenticateProxyKey(token);
  if (!keyInfo) {
    return res.status(401).json({
      error: { message: 'Invalid or expired API key', type: 'auth_error' },
    });
  }
  req.proxyAuth = keyInfo;
  next();
}

async function enforceRateLimit(req, res, next) {
  const { keyId, userId, tierConfig } = req.proxyAuth;
  const now = Date.now();

  // ── RPM (in-memory, per key) ───────────────
  const rpmKey = `rpm:${keyId}`;
  let rpmData = rpmCache.get(rpmKey);
  if (!rpmData || rpmData.resetAt < now) {
    rpmData = { count: 0, resetAt: now + 60_000 };
  }
  if (rpmData.count >= tierConfig.rateLimitRpm) {
    const retryAfter = Math.ceil((rpmData.resetAt - now) / 1000);
    res.set('Retry-After', String(retryAfter));
    res.set('X-RateLimit-Limit-RPM', String(tierConfig.rateLimitRpm));
    res.set('X-RateLimit-Remaining-RPM', '0');
    return res.status(429).json({
      error: { message: `Rate limit exceeded. Retry after ${retryAfter}s.`, type: 'rate_limit_error' },
    });
  }

  // ── RPD (per key) ──────────────────────────
  const keyCounters = await getDailyCounters(keyId, 'key');
  if (keyCounters.request_count >= tierConfig.rateLimitRpd) {
    return res.status(429).json({
      error: {
        message: 'Daily request limit exceeded. Resets at midnight UTC.',
        type: 'rate_limit_error',
        limit: tierConfig.rateLimitRpd,
        used: keyCounters.request_count,
      },
    });
  }

  // ── Messages/day (per user) ────────────────
  if (tierConfig.maxMessagesPerDay > 0) {
    const userCounters = await getDailyCounters(userId, 'user');
    const messageCount = Array.isArray(req.body?.messages) ? req.body.messages.length : 0;
    if (userCounters.message_count + messageCount > tierConfig.maxMessagesPerDay) {
      return res.status(429).json({
        error: {
          message: 'Daily message limit exceeded. Resets at midnight UTC.',
          type: 'rate_limit_error',
          limit: tierConfig.maxMessagesPerDay,
          used: userCounters.message_count,
        },
      });
    }
  }

  rpmData.count++;
  rpmCache.set(rpmKey, rpmData);

  res.set('X-RateLimit-Limit-RPM', String(tierConfig.rateLimitRpm));
  res.set('X-RateLimit-Remaining-RPM', String(Math.max(0, tierConfig.rateLimitRpm - rpmData.count)));
  res.set('X-RateLimit-Limit-RPD', String(tierConfig.rateLimitRpd));
  res.set(
    'X-RateLimit-Remaining-RPD',
    String(Math.max(0, tierConfig.rateLimitRpd - keyCounters.request_count - 1)),
  );
  if (tierConfig.maxMessagesPerDay > 0) {
    res.set('X-RateLimit-Limit-Messages', String(tierConfig.maxMessagesPerDay));
  }

  next();
}

async function checkCredits(req, res, next) {
  const { userId, tier } = req.proxyAuth;
  const ok = await hasSufficientCredits(userId, tier);
  if (!ok) {
    return res.status(402).json({
      error: {
        message: 'Insufficient credits. Please add funds to continue.',
        type: 'insufficient_credits',
      },
    });
  }
  next();
}

// ─── GET /v1/models ──────────────────────────────────
router.get('/models', requireProxyKey, async (req, res) => {
  try {
    const all = await fetchModels();
    const allowed = all.filter((m) => isModelAllowed(m.id, req.proxyAuth.tierConfig.allowedModels));
    res.json({ object: 'list', data: allowed });
  } catch {
    res.status(502).json({ error: { message: 'Failed to fetch models', type: 'proxy_error' } });
  }
});

// ─── POST /v1/chat/completions ───────────────────────
router.post('/chat/completions', requireProxyKey, enforceRateLimit, checkCredits, async (req, res) => {
  const { keyId, userId, tier, tierConfig } = req.proxyAuth;
  const startTime = Date.now();

  // Trim model — clipboard whitespace silently breaks tier-allow checks.
  const model = typeof req.body?.model === 'string' ? req.body.model.trim() : req.body?.model;
  const { messages, stream } = req.body || {};

  if (!Array.isArray(messages) || messages.length === 0) {
    return res
      .status(400)
      .json({ error: { message: 'messages array is required', type: 'invalid_request_error' } });
  }
  if (!model) {
    return res.status(400).json({ error: { message: 'model is required', type: 'invalid_request_error' } });
  }
  if (!isModelAllowed(model, tierConfig.allowedModels)) {
    return res.status(403).json({
      error: {
        message: `Model '${model}' is not available on your tier. Upgrade to access.`,
        type: 'model_not_allowed',
      },
    });
  }

  const inputTokens = countMessageTokens(messages);
  if (inputTokens > tierConfig.maxContextTokens) {
    return res.status(400).json({
      error: {
        message: `Input too long (${inputTokens} tokens). Your tier allows ${tierConfig.maxContextTokens} max.`,
        type: 'context_length_exceeded',
      },
    });
  }

  const safety = checkAndFlag(userId, messages, model);
  if (safety.flagged) {
    return res
      .status(451)
      .json({ error: { message: 'Request blocked by content safety filter.', type: 'content_policy_violation' } });
  }

  // Increment request + message counters before proxying (counts the attempt)
  const messageCount = messages.length;
  await Promise.all([
    incrementCounter(keyId, 'key', { requests: 1, messages: messageCount }),
    incrementCounter(userId, 'user', { requests: 1, messages: messageCount }),
  ]);

  const isStreaming = stream === true;

  // Build relay body with model trimmed.
  const relayBody = { ...req.body, model };

  try {
    const response = await relayChatCompletions(relayBody);

    if (!response.ok) {
      const errData = await response.json().catch(() => ({}));
      const latencyMs = Date.now() - startTime;
      await logUsage({
        apiKeyId: keyId,
        userId,
        model,
        latencyMs,
        statusCode: response.status,
        errorType: errData.error?.type || 'upstream_error',
      });
      return res.status(response.status).json(errData);
    }

    if (isStreaming) {
      // Stream SSE response straight through to the client.
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let usage = null;
      let totalBytes = 0;

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          totalBytes += value.byteLength;
          const chunk = decoder.decode(value, { stream: true });
          res.write(chunk);

          // Try to extract usage if upstream included it (requires stream_options.include_usage from client).
          const lines = chunk.split('\n');
          for (const line of lines) {
            if (line.startsWith('data: ') && line.trim() !== 'data: [DONE]') {
              try {
                const data = JSON.parse(line.slice(6));
                if (data.usage) usage = data.usage;
              } catch {
                /* skip unparseable chunk */
              }
            }
          }
        }
      } catch (streamErr) {
        logger.warn(`Stream relay error: ${streamErr.message}`);
      } finally {
        res.end();

        // Settle billing after stream completes.
        const latencyMs = Date.now() - startTime;
        const promptTokens = usage?.prompt_tokens ?? inputTokens;
        const completionTokens =
          usage?.completion_tokens ?? estimateCompletionTokensFromStream(totalBytes);
        const totalTokens = promptTokens + completionTokens;
        const cost = calculateCostMicrodollars(model, promptTokens, completionTokens, tierConfig.priceMultiplier);

        await Promise.all([
          logUsage({
            apiKeyId: keyId,
            userId,
            model,
            promptTokens,
            completionTokens,
            totalTokens,
            costMicrodollars: cost,
            latencyMs,
            statusCode: 200,
          }),
          incrementCounter(keyId, 'key', { tokens: totalTokens, cost }),
          incrementCounter(userId, 'user', { tokens: totalTokens, cost }),
          tier === 'unlimited' ? Promise.resolve() : deductCredits(userId, cost),
        ]);
      }
    } else {
      // Non-streaming
      const data = await response.json();
      const latencyMs = Date.now() - startTime;

      const promptTokens = data.usage?.prompt_tokens ?? inputTokens;
      const completionTokens = data.usage?.completion_tokens ?? 0;
      const totalTokens = promptTokens + completionTokens;
      const cost = calculateCostMicrodollars(model, promptTokens, completionTokens, tierConfig.priceMultiplier);

      await Promise.all([
        logUsage({
          apiKeyId: keyId,
          userId,
          model,
          promptTokens,
          completionTokens,
          totalTokens,
          costMicrodollars: cost,
          requestId: data.id,
          latencyMs,
          statusCode: 200,
        }),
        incrementCounter(keyId, 'key', { tokens: totalTokens, cost }),
        incrementCounter(userId, 'user', { tokens: totalTokens, cost }),
        tier === 'unlimited' ? Promise.resolve() : deductCredits(userId, cost),
      ]);

      res.json(data);
    }
  } catch (err) {
    const latencyMs = Date.now() - startTime;
    const errMsg = err.name === 'TimeoutError' ? 'Provider request timed out' : err.message || 'Internal proxy error';
    await logUsage({
      apiKeyId: keyId,
      userId,
      model,
      latencyMs,
      statusCode: err.statusCode || 502,
      errorType: errMsg,
    });
    if (!res.headersSent) {
      res.status(err.statusCode || 502).json({ error: { message: errMsg, type: 'proxy_error' } });
    } else {
      res.end();
    }
  }
});

export default router;
