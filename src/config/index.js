import 'dotenv/config';
import crypto from 'crypto';

function optional(key, fallback) {
  return process.env[key] || fallback;
}

const isDev = optional('NODE_ENV', 'development') === 'development';

function autoSecret(envKey, bytes) {
  const val = process.env[envKey];
  if (val && !val.startsWith('CHANGE_ME')) return val;
  const generated = crypto.randomBytes(bytes).toString('hex');
  console.warn(`⚠  ${isDev ? 'DEV' : 'WARNING'}: Auto-generated ${envKey} (not persisted across restarts)`);
  if (!isDev) {
    console.warn('⚠  Existing JWTs will be invalidated on every restart. Set a real JWT_SECRET in production.');
  }
  return generated;
}

const config = {
  port: parseInt(optional('PORT', '3000')),
  env: optional('NODE_ENV', 'development'),
  isDev,
  baseUrl: optional('BASE_URL', 'http://localhost:3000'),

  // Extra origins allowed by the dashboard CORS policy.
  // BASE_URL is always implicitly included.
  allowedOrigins: optional('ALLOWED_ORIGINS', '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  supabase: {
    url: optional('SUPABASE_URL', ''),
    anonKey: optional('SUPABASE_ANON_KEY', ''),
    serviceKey: optional('SUPABASE_SERVICE_KEY', ''),
  },

  newApi: {
    url: optional('NEW_API_URL', 'http://localhost:3001'),
    adminToken: optional('NEW_API_ADMIN_TOKEN', ''),
  },

  jwt: {
    secret: autoSecret('JWT_SECRET', 64),
    expiry: optional('JWT_EXPIRY', '24h'),
  },

  rateLimit: {
    login: {
      windowMs: parseInt(optional('LOGIN_RATE_LIMIT_WINDOW_MS', '900000')),
      max: parseInt(optional('LOGIN_RATE_LIMIT_MAX', '5')),
    },
    api: {
      windowMs: parseInt(optional('API_RATE_LIMIT_WINDOW_MS', '60000')),
      max: parseInt(optional('API_RATE_LIMIT_MAX', '300')),
    },
  },
};

export default config;
