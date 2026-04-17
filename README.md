# VixKnight v2

AI roleplay key proxy. Sits in front of [new-api](https://github.com/Calcium-Ion/new-api) and adds: user accounts, JWT auth, vxk_ proxy keys, tier-based rate limits, credit billing, content safety scanning, and an admin dashboard.

## Stack

- **Node.js 20 + Express** (ES modules)
- **Supabase** (Postgres) — all persistent data
- **bcrypt** — password hashing
- **JWT** — session auth
- **new-api** — upstream LLM relay (40+ providers)

## Layout

```
src/
├── config/index.js          env + secrets
├── middleware/security.js   helmet, CORS, JWT auth, rate limits
├── models/supabase.js       Supabase clients
├── routes/
│   ├── auth.js              register / login / change password
│   ├── proxykeys.js         vxk_ key CRUD
│   ├── personas.js          system prompt configs
│   ├── logs.js              usage history + dashboard stats
│   ├── admin.js             user / tier / credit / safety / invite admin
│   └── v1.js                OpenAI-compatible relay (the hot path)
├── services/
│   ├── AuthService.js       register / authenticate / generate vxk_
│   ├── ContentSafetyService.js  regex CSAM scan (see Limitations)
│   ├── NewApiService.js     forwarder to new-api
│   └── pricing.js           model cost lookup + tier model gates
├── utils/
│   ├── errors.js            AppError + subclasses
│   ├── logger.js            winston
│   └── tokenizer.js         char/4 estimator
└── server.js                wiring
public/index.html            single-file dashboard SPA
supabase/migration.sql       schema — run in Supabase SQL editor
```

## Quick start

```bash
cp .env.example .env
# Fill in SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_KEY,
# NEW_API_URL, NEW_API_ADMIN_TOKEN, JWT_SECRET

# Apply schema once via Supabase dashboard SQL editor:
# paste supabase/migration.sql and run.

npm install
npm run dev
```

Open <http://localhost:3000>.

For Railway deployment see `DEPLOY-RAILWAY.md`.

For the local docker-compose stack (VixKnight + new-api + Redis) see `docker-compose.yml`.

## How auth works

- **Dashboard users** authenticate with username + password → JWT in `Authorization: Bearer` header (or `vk_token` httpOnly cookie).
- **RP frontends** authenticate with a `vxk_<hex>` proxy key against `/v1/*`. The raw key is shown once at creation; only the SHA-256 hash is stored.
- **First superadmin** is bootstrapped via a manual invite code insert in Supabase. See `DEPLOY-RAILWAY.md`.

## How billing works

- Credits are stored in microdollars (1 microdollar = $0.000001) in `vk_credits`.
- After each request, cost is calculated from `services/pricing.js` × the tier's `price_multiplier` and deducted via the atomic `vk_deduct_credits` Postgres function.
- The `unlimited` tier skips credit deduction.
- Daily request / message / token counters live in `vk_daily_counters`. They use the `vk_increment_counter` Postgres function for atomic upserts. Counter rows are partitioned by `reset_date` and pruned at midnight UTC.

---

## Known limitations

These were flagged during the build but not addressed. Plan to fix before scaling beyond a small user base.

### 1. Content safety regex is weak

`services/ContentSafetyService.js` uses three regex patterns to detect CSAM-related content. This is **defense theater** for any sophisticated bypass — l33tspeak, spacing, synonyms, and language switches all defeat it. It will also false-positive on legitimate adult RP that mentions characters' ages and sexuality in nearby sentences.

**Recommended fix:** replace with a real classifier. Options ranked by effort:

- **OpenAI Moderations API** — free, fast, decent recall. Add a pre-call to `/v1/moderations` before relaying to new-api.
- **Perspective API** (Google Jigsaw) — broader categories.
- **Self-hosted classifier** — heaviest, most control.

The current implementation should be treated as a logging signal, not a real defense. Real defense is takedown response + the Trust & Safety review queue (`/admin/safety`).

### 2. No per-key spending caps or scope

A `vxk_` key inherits all of its owning user's tier permissions. There's no way to:

- Cap a single key's spend (e.g. "$5/day on this key only")
- Restrict a key to a subset of allowed models
- Issue read-only or rate-restricted keys
- Enforce `expires_at` (the column exists; nothing reads it on the hot path — wait, actually `routes/v1.js` `authenticateProxyKey` does check it. So this is partially addressed, but no UI to set it.)

For users who want to share a key with a friend or use one key per RP frontend, this is a gap. Add per-key overrides in `vk_proxy_keys` (`max_spend_microdollars_per_day`, `allowed_models JSONB`) and check them in `enforceRateLimit` and `checkCredits`.

### 3. Credits deducted after the response — fail-open on crashes

The flow is: serve the request → deduct credits in the `finally` block. If the VixKnight process is killed mid-stream (Railway redeploy, OOM, network blip on the Supabase side), the user got the response but wasn't billed.

**Recommended fix:** double-entry ledger. Pre-authorize an estimated cost before relaying, settle the actual cost after. Failed pre-auth blocks the request; un-settled holds expire after 5 minutes. Schema sketch:

```sql
CREATE TABLE vk_credit_holds (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES vk_users(id),
  amount_microdollars BIGINT NOT NULL,
  status TEXT CHECK (status IN ('held', 'settled', 'released', 'expired')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ DEFAULT NOW() + INTERVAL '5 minutes'
);
```

Until that's implemented, the revenue leak is bounded by tier caps + how often the process crashes mid-stream — small for a stable deploy, non-trivial at scale.

### 4. Streaming token estimation is rough

When the upstream stream doesn't include a final `usage` object (most clients don't enable `stream_options.include_usage`), completion tokens are estimated from raw SSE byte count × 0.6 (content fraction) ÷ 4 (chars/token). That's correct within ±25% for typical English RP responses; worse for non-Latin scripts and code-heavy responses.

The honest fix is to count tokens on the response with the actual model's tokenizer. Since this proxy has no tokenizer per upstream model, the practical fix is: ask new-api to inject `stream_options.include_usage` server-side (it has the model context), or run a tiktoken pass on the assembled response in a worker.

### 5. 2FA endpoints are stubs

`AuthService.authenticateUser` checks `user.totp_enabled` and returns `{ requires2FA: true }` if a code is missing, but there are no `/api/auth/2fa/setup` or `/api/auth/2fa/verify` endpoints. The frontend setting page acknowledges this.

### 6. Models endpoint requires a vxk_ key

The `/v1/models` route is auth-gated by proxy key, which means the dashboard can't list available models without one. The current dashboard just tells users to query `/v1/models` programmatically. A small unauth `/api/models` endpoint that proxies to new-api with the admin token would be friendlier.

### 7. JWT revocation

JWTs are stateless and valid until `expiry`. There's no blocklist. If a token is leaked, your only options are: rotate `JWT_SECRET` (invalidates all tokens), or wait it out. For dashboard sessions this is acceptable; for higher-stakes accounts you'd want a `jti` claim + a Supabase `vk_revoked_jtis` table.

### 8. No CSRF token on state-changing dashboard requests

Dashboard requests use `Authorization: Bearer` headers from `localStorage`, which is not vulnerable to classic CSRF (cookies aren't auto-sent). But if you switch to cookie-only auth in the future, add a CSRF token.

---

## Operational

- **Logs:** stdout via Winston. Capture however your platform captures stdout.
- **Health check:** `GET /api/health` — returns `{ status, upstream: { newApi } }`.
- **Schema changes:** edit `supabase/migration.sql` and apply changed sections via the Supabase SQL editor. There's no migration runner.
- **Daily counter pruning:** `setInterval` inside the process, midnight UTC. Idempotent across replicas.

## License

Internal / proprietary. Adjust as you see fit.
