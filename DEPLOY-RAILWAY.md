# Deploying VixKnight v2 on Railway

VixKnight v2 needs three things in production:

1. **Supabase** — Postgres for users, keys, credits, logs
2. **new-api** — the actual LLM relay (Go service, runs as its own Railway app)
3. **VixKnight** — this app, the user-facing dashboard + auth + billing layer

## 1. Set up Supabase

1. Create a new Supabase project at <https://supabase.com>.
2. Open the SQL editor and paste the contents of `supabase/migration.sql`. Run it.
3. From **Settings → API**, copy:
   - `SUPABASE_URL` (Project URL)
   - `SUPABASE_ANON_KEY` (anon public key)
   - `SUPABASE_SERVICE_KEY` (service_role secret key — **never expose this to the browser**)

## 2. Deploy new-api on Railway

new-api is the upstream relay. VixKnight forwards `/v1/chat/completions` requests to it.

1. New Railway project → **Deploy from Docker Image** → `calciumion/new-api:latest`.
2. Set these variables:
   - `SQL_DSN` = `sqlite:///data/new-api.db` (or hook up a managed Postgres if you want — see new-api docs)
   - `REDIS_CONN_STRING` = Railway Redis plugin URL if you provision one
   - `TZ` = `UTC`
3. Add a Railway volume mounted at `/data` so the SQLite DB survives redeploys.
4. Once it boots, open the new-api dashboard (Railway gives you a URL like `https://new-api-production-xxxx.up.railway.app`).
5. Log in with the default admin credentials (check new-api's docs — usually `root` / `123456`, **change immediately**).
6. In new-api: add your provider channels (OpenAI, Anthropic, OpenRouter, etc.), create at least one **token** for VixKnight to use as its admin token.
7. Copy that token — it's `NEW_API_ADMIN_TOKEN` for VixKnight.

## 3. Deploy VixKnight on Railway

1. Connect this repo to a new Railway service.
2. Railway auto-detects Node + the Dockerfile. Confirm it uses the Dockerfile (not Nixpacks) — it builds faster.
3. Set environment variables:

   ```
   PORT=3000
   NODE_ENV=production
   BASE_URL=https://your-vixknight-domain.up.railway.app
   ALLOWED_ORIGINS=
   SUPABASE_URL=https://xxxx.supabase.co
   SUPABASE_ANON_KEY=eyJ...
   SUPABASE_SERVICE_KEY=eyJ...
   NEW_API_URL=https://new-api-production-xxxx.up.railway.app
   NEW_API_ADMIN_TOKEN=sk-xxxxxxxx
   JWT_SECRET=<generate with: openssl rand -hex 64>
   JWT_EXPIRY=24h
   ```

   `ALLOWED_ORIGINS` is only needed if your dashboard frontend lives on a different domain than the API. Most Railway deployments serve both from the same origin — leave it blank.

4. **Generate a real `JWT_SECRET`.** If you don't, the app will auto-generate one on every restart, which logs all your users out every deploy.

5. Deploy. First boot will:
   - Verify the Supabase schema is present (errors out if you skipped step 1).
   - Print the dashboard URL and proxy URL to logs.

## 4. Bootstrap the first superadmin

You need a way to create the first superadmin since registration only allows the `user` role by default.

1. In Railway, run a one-off shell on the VixKnight service.
2. Connect to your Supabase project's SQL editor and insert an invite code:

   ```sql
   INSERT INTO vk_invite_codes (code, role)
   VALUES ('inv_BOOTSTRAP_change_me', 'superadmin');
   ```

3. Open `https://your-domain/` → Register → use that invite code with your username + password.
4. The code is consumed on use. Delete or revoke it from the dashboard afterward.

## 5. Connect a roleplay frontend

In SillyTavern / Risu / Agnai:

- **API Type:** OpenAI / Chat Completions
- **API URL:** `https://your-vixknight-domain.up.railway.app/v1`
- **API Key:** generate a `vxk_...` key from the VixKnight dashboard (Proxy Keys page)

## Operational notes

- **Schema migrations:** if you change `migration.sql`, you have to re-run the changed parts manually in Supabase. There's no automatic migration runner.
- **Logs:** Railway captures stdout. Use the logs tab.
- **Daily counter pruning:** runs automatically at midnight UTC inside the VixKnight process. If you have multiple replicas, all of them try — that's fine, it's idempotent.
- **Streaming:** Railway supports streaming HTTP responses (SSE). VixKnight pipes new-api's stream straight through.

## When something breaks

- **Dashboard returns 502:** VixKnight crashed at boot. Check logs — usually a missing Supabase env var or migration not run.
- **`/v1/chat/completions` returns 502 "Upstream connection failed":** VixKnight can't reach new-api. Check `NEW_API_URL` is correct and new-api is up.
- **`/v1/chat/completions` returns 401:** the `vxk_` key is wrong, expired, or revoked — or the user is disabled.
- **`/v1/chat/completions` returns 402:** user is out of credits. Top up via the admin dashboard.
- **CORS error in browser:** check `BASE_URL` and `ALLOWED_ORIGINS` match the actual origin the dashboard is loaded from.
