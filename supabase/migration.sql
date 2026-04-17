-- ═══════════════════════════════════════════════════════
--  VixKnight v2 — Supabase Migration
--  Run this in the Supabase SQL Editor (Dashboard → SQL)
--  All tables prefixed with vk_ to avoid collisions
-- ═══════════════════════════════════════════════════════

-- Users
CREATE TABLE IF NOT EXISTS vk_users (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username        TEXT UNIQUE NOT NULL,
  password_hash   TEXT NOT NULL,
  role            TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin', 'superadmin')),
  tier            TEXT NOT NULL DEFAULT 'free' CHECK (tier IN ('free', 'basic', 'pro', 'unlimited')),
  is_active       BOOLEAN DEFAULT TRUE,
  totp_secret     TEXT,
  totp_enabled    BOOLEAN DEFAULT FALSE,
  failed_logins   INTEGER DEFAULT 0,
  locked_until    TIMESTAMPTZ,
  last_login      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_vk_users_username ON vk_users (lower(username));

-- Tier configuration
-- max_messages_per_day: 0 = unlimited
CREATE TABLE IF NOT EXISTS vk_tier_config (
  tier                  TEXT PRIMARY KEY,
  rate_limit_rpm        INTEGER NOT NULL,
  rate_limit_rpd        INTEGER NOT NULL,
  max_messages_per_day  INTEGER NOT NULL DEFAULT 0,
  max_context_tokens    INTEGER NOT NULL,
  allowed_models        JSONB NOT NULL DEFAULT '["*"]',
  price_multiplier      REAL DEFAULT 1.0
);

INSERT INTO vk_tier_config (tier, rate_limit_rpm, rate_limit_rpd, max_messages_per_day, max_context_tokens, allowed_models, price_multiplier) VALUES
  ('free',      10,   100,   200,    4096,   '["openai/gpt-3.5-turbo","meta-llama/*"]'::jsonb, 1.50),
  ('basic',     30,   1000,  2000,   8192,   '["openai/gpt-4o-mini","anthropic/claude-3-haiku*","meta-llama/*"]'::jsonb, 1.30),
  ('pro',       60,   5000,  10000,  32000,  '["openai/gpt-4o","anthropic/claude-3.5-sonnet*","anthropic/claude-3-opus*"]'::jsonb, 1.15),
  ('unlimited', 120,  50000, 0,      128000, '["*"]'::jsonb, 1.00)
ON CONFLICT (tier) DO NOTHING;

-- Proxy keys (vxk_ prefix)
CREATE TABLE IF NOT EXISTS vk_proxy_keys (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES vk_users(id) ON DELETE CASCADE,
  key_hash        TEXT UNIQUE NOT NULL,
  key_prefix      TEXT NOT NULL,
  label           TEXT DEFAULT 'Default Key',
  is_active       BOOLEAN DEFAULT TRUE,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  last_used       TIMESTAMPTZ,
  expires_at      TIMESTAMPTZ,
  rate_limit_rpm  INTEGER,
  rate_limit_rpd  INTEGER
);

CREATE INDEX IF NOT EXISTS idx_vk_proxy_keys_user ON vk_proxy_keys (user_id);
CREATE INDEX IF NOT EXISTS idx_vk_proxy_keys_hash ON vk_proxy_keys (key_hash);

-- Credits / balance (microdollars)
CREATE TABLE IF NOT EXISTS vk_credits (
  user_id              UUID PRIMARY KEY REFERENCES vk_users(id) ON DELETE CASCADE,
  balance_microdollars BIGINT NOT NULL DEFAULT 0,
  lifetime_purchased   BIGINT NOT NULL DEFAULT 0,
  lifetime_used        BIGINT NOT NULL DEFAULT 0,
  updated_at           TIMESTAMPTZ DEFAULT NOW()
);

-- Daily counters
-- PK includes reset_date so concurrent requests at midnight UTC can't race
-- on the SELECT-then-UPDATE pattern. Old rows are pruned by vk_reset_stale_counters().
CREATE TABLE IF NOT EXISTS vk_daily_counters (
  id                TEXT NOT NULL,
  counter_type      TEXT NOT NULL DEFAULT 'key' CHECK (counter_type IN ('key', 'user')),
  reset_date        DATE NOT NULL DEFAULT CURRENT_DATE,
  request_count     INTEGER NOT NULL DEFAULT 0,
  message_count     INTEGER NOT NULL DEFAULT 0,
  tokens_used       BIGINT NOT NULL DEFAULT 0,
  cost_microdollars BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (id, counter_type, reset_date)
);

CREATE INDEX IF NOT EXISTS idx_vk_daily_counters_reset ON vk_daily_counters (reset_date);

-- Atomic upsert function for incrementing daily counters.
-- Caller passes deltas; row is created if missing.
CREATE OR REPLACE FUNCTION vk_increment_counter(
  p_id              TEXT,
  p_counter_type    TEXT,
  p_request_delta   INTEGER,
  p_message_delta   INTEGER,
  p_tokens_delta    BIGINT,
  p_cost_delta      BIGINT
) RETURNS VOID AS $$
BEGIN
  INSERT INTO vk_daily_counters (id, counter_type, reset_date, request_count, message_count, tokens_used, cost_microdollars)
  VALUES (p_id, p_counter_type, CURRENT_DATE, p_request_delta, p_message_delta, p_tokens_delta, p_cost_delta)
  ON CONFLICT (id, counter_type, reset_date) DO UPDATE SET
    request_count     = vk_daily_counters.request_count + EXCLUDED.request_count,
    message_count     = vk_daily_counters.message_count + EXCLUDED.message_count,
    tokens_used       = vk_daily_counters.tokens_used + EXCLUDED.tokens_used,
    cost_microdollars = vk_daily_counters.cost_microdollars + EXCLUDED.cost_microdollars;
END;
$$ LANGUAGE plpgsql;

-- Atomic credit deduction. Returns the new balance or NULL if insufficient funds.
CREATE OR REPLACE FUNCTION vk_deduct_credits(
  p_user_id UUID,
  p_amount  BIGINT
) RETURNS BIGINT AS $$
DECLARE
  new_balance BIGINT;
BEGIN
  UPDATE vk_credits
  SET balance_microdollars = balance_microdollars - p_amount,
      lifetime_used = lifetime_used + p_amount,
      updated_at = NOW()
  WHERE user_id = p_user_id
    AND balance_microdollars >= p_amount
  RETURNING balance_microdollars INTO new_balance;
  RETURN new_balance;
END;
$$ LANGUAGE plpgsql;

-- Usage logs
CREATE TABLE IF NOT EXISTS vk_usage_logs (
  id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  api_key_id        UUID NOT NULL REFERENCES vk_proxy_keys(id) ON DELETE CASCADE,
  user_id           UUID NOT NULL REFERENCES vk_users(id) ON DELETE CASCADE,
  model             TEXT NOT NULL,
  endpoint          TEXT NOT NULL DEFAULT '/chat/completions',
  prompt_tokens     INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens      INTEGER NOT NULL DEFAULT 0,
  cost_microdollars BIGINT NOT NULL DEFAULT 0,
  request_id        TEXT,
  latency_ms        INTEGER,
  status_code       INTEGER,
  error_type        TEXT,
  created_at        TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_vk_usage_logs_user ON vk_usage_logs (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_vk_usage_logs_key ON vk_usage_logs (api_key_id, created_at DESC);

-- Personas
CREATE TABLE IF NOT EXISTS vk_personas (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES vk_users(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  system_prompt TEXT NOT NULL,
  model         TEXT DEFAULT 'openai/gpt-4o',
  temperature   REAL DEFAULT 0.8,
  max_tokens    INTEGER DEFAULT 2048,
  is_default    BOOLEAN DEFAULT FALSE,
  is_public     BOOLEAN DEFAULT FALSE,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_vk_personas_user ON vk_personas (user_id);
CREATE INDEX IF NOT EXISTS idx_vk_personas_public ON vk_personas (is_public) WHERE is_public = TRUE;

-- Invite codes
CREATE TABLE IF NOT EXISTS vk_invite_codes (
  code        TEXT PRIMARY KEY,
  role        TEXT NOT NULL DEFAULT 'admin' CHECK (role IN ('admin', 'superadmin')),
  created_by  UUID REFERENCES vk_users(id),
  used_by     UUID REFERENCES vk_users(id),
  used_at     TIMESTAMPTZ,
  expires_at  TIMESTAMPTZ,
  is_used     BOOLEAN DEFAULT FALSE
);

-- Audit log
CREATE TABLE IF NOT EXISTS vk_audit_log (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id    UUID NOT NULL REFERENCES vk_users(id),
  action      TEXT NOT NULL,
  target_type TEXT,
  target_id   TEXT,
  details     JSONB,
  ip_address  TEXT,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_vk_audit_log_actor ON vk_audit_log (actor_id, created_at DESC);

-- Content safety flags
CREATE TABLE IF NOT EXISTS vk_content_flags (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          UUID NOT NULL REFERENCES vk_users(id) ON DELETE CASCADE,
  flag_type        TEXT NOT NULL DEFAULT 'csam' CHECK (flag_type IN ('csam', 'violence', 'other')),
  severity         TEXT NOT NULL DEFAULT 'high' CHECK (severity IN ('low', 'medium', 'high', 'critical')),
  matched_patterns JSONB NOT NULL DEFAULT '[]',
  message_content  TEXT NOT NULL,
  model            TEXT,
  status           TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'reviewed', 'dismissed', 'confirmed')),
  reviewed_by      UUID REFERENCES vk_users(id),
  reviewed_at      TIMESTAMPTZ,
  notes            TEXT,
  created_at       TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_vk_content_flags_user ON vk_content_flags (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_vk_content_flags_status ON vk_content_flags (status);

-- ═══════════════════════════════════════════════════════
--  Helper: prune stale daily counters
-- ═══════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION vk_reset_stale_counters()
RETURNS INTEGER AS $$
DECLARE
  affected INTEGER;
BEGIN
  DELETE FROM vk_daily_counters WHERE reset_date < CURRENT_DATE;
  GET DIAGNOSTICS affected = ROW_COUNT;
  RETURN affected;
END;
$$ LANGUAGE plpgsql;

-- ═══════════════════════════════════════════════════════
--  RLS Policies (optional — VixKnight uses service key)
--  Enable these if you want defense-in-depth row-level security
-- ═══════════════════════════════════════════════════════
-- ALTER TABLE vk_users ENABLE ROW LEVEL SECURITY;
-- etc.
