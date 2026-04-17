import express from 'express';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import path from 'path';
import { fileURLToPath } from 'url';
import config from './config/index.js';
import logger, { logRequest } from './utils/logger.js';
import {
  securityHeaders,
  corsPolicy,
  v1Cors,
  globalLimiter,
  requestMeta,
  paramProtection,
  globalErrorHandler,
} from './middleware/security.js';
import { ensureSchema, supabase } from './models/supabase.js';
import { checkHealth as checkNewApiHealth } from './services/NewApiService.js';

import authRoutes from './routes/auth.js';
import proxyKeysRoutes from './routes/proxykeys.js';
import personasRoutes from './routes/personas.js';
import logsRoutes from './routes/logs.js';
import adminRoutes from './routes/admin.js';
import v1Routes from './routes/v1.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

// Trust X-Forwarded-* headers from Railway / proxies
app.set('trust proxy', 1);
app.disable('x-powered-by');

// ─── Middleware stack (order matters) ──────────────
app.use(compression());
app.use(requestMeta);
app.use(securityHeaders);
app.use(globalLimiter);
app.use(cookieParser());

// /v1 needs raw permissive CORS BEFORE the strict dashboard policy.
// We mount v1Cors at the route level inside v1.js, but we also need OPTIONS
// preflight to be handled before any auth middleware. Express handles this
// because v1.js registers v1Cors first.

// Apply strict dashboard CORS to everything else.
// /v1 routes apply v1Cors themselves and override this when they match first.
app.use((req, res, next) => {
  if (req.path.startsWith('/v1/') || req.path === '/v1') return next();
  return corsPolicy(req, res, next);
});

// JSON body parsing — only for /api routes. /v1 forwards bodies as-is, but we
// still need to parse them to inspect messages, so apply globally with a reasonable cap.
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: false, limit: '2mb' }));
app.use(paramProtection);

// Request logging
app.use((req, res, next) => {
  res.on('finish', () => logRequest(req, res));
  next();
});

// ─── Routes ────────────────────────────────────────
app.use('/api/auth', authRoutes);
app.use('/api/proxy-keys', proxyKeysRoutes);
app.use('/api/personas', personasRoutes);
app.use('/api/logs', logsRoutes);
app.use('/api/admin', adminRoutes);
app.use('/v1', v1Routes);

// Health check
app.get('/api/health', async (_req, res) => {
  const newApiOk = await checkNewApiHealth();
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    version: '2.0.0',
    upstream: { newApi: newApiOk ? 'ok' : 'unreachable' },
  });
});

// ─── Static frontend ───────────────────────────────
const publicDir = path.join(__dirname, '..', 'public');
app.use(
  express.static(publicDir, {
    maxAge: config.isDev ? 0 : '1d',
    etag: true,
  }),
);

// SPA fallback — non-API routes return index.html
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/') || req.path.startsWith('/v1/')) {
    return res.status(404).json({ error: 'Not found' });
  }
  res.sendFile(path.join(publicDir, 'index.html'));
});

// Global error handler — must be last
app.use(globalErrorHandler);

// ─── Background tasks ──────────────────────────────

/**
 * Schedule pruning of stale daily counter rows at midnight UTC.
 * The vk_increment_counter SQL function creates per-day rows, so old rows
 * accumulate. This keeps the table small.
 */
function scheduleMidnightPrune() {
  const now = new Date();
  const nextMidnight = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0),
  );
  const msUntilMidnight = nextMidnight.getTime() - now.getTime();

  logger.info(`Daily counter prune scheduled in ${Math.round(msUntilMidnight / 60000)} min (midnight UTC)`);

  setTimeout(async () => {
    await pruneStaleCounters();
    setInterval(pruneStaleCounters, 24 * 60 * 60 * 1000);
  }, msUntilMidnight);
}

async function pruneStaleCounters() {
  try {
    const { data, error } = await supabase.rpc('vk_reset_stale_counters');
    if (error) logger.warn(`Counter prune failed: ${error.message}`);
    else logger.info(`Midnight UTC: pruned ${data || 0} stale counter row(s)`);
  } catch (err) {
    logger.warn(`Counter prune error: ${err.message}`);
  }
}

// ─── Boot ──────────────────────────────────────────
async function start() {
  const schemaOk = await ensureSchema();
  if (!schemaOk) {
    logger.error('Schema check failed. Apply supabase/migration.sql before starting.');
    process.exit(1);
  }

  scheduleMidnightPrune();

  app.listen(config.port, () => {
    logger.info(`VixKnight v2 listening on :${config.port} [${config.env}]`);
    logger.info(`Dashboard:    ${config.baseUrl}`);
    logger.info(`Proxy URL:    ${config.baseUrl}/v1`);
    logger.info(`Upstream:     ${config.newApi.url}`);
  });
}

start().catch((err) => {
  logger.error(`Boot failed: ${err.message}`);
  process.exit(1);
});

export default app;
