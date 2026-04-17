import crypto from 'crypto';
import helmet from 'helmet';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import hpp from 'hpp';
import jwt from 'jsonwebtoken';
import config from '../config/index.js';
import logger from '../utils/logger.js';
import { supabase } from '../models/supabase.js';

// ─── Helmet ──────────────────────────────────────────
export const securityHeaders = helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com'],
      imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'"],
      frameSrc: ["'none'"],
      objectSrc: ["'none'"],
    },
  },
  crossOriginEmbedderPolicy: false,
});

// ─── CORS — Dashboard (strict) ───────────────────────
// Build the allowed-origin set at boot. BASE_URL is always allowed,
// plus any origins explicitly listed in ALLOWED_ORIGINS.
function buildAllowedOrigins() {
  const set = new Set();
  if (config.baseUrl) {
    set.add(config.baseUrl);
    // Auto-add the https variant if BASE_URL is http (and vice versa) for dev convenience.
    if (config.baseUrl.startsWith('http://')) set.add(config.baseUrl.replace('http://', 'https://'));
    if (config.baseUrl.startsWith('https://')) set.add(config.baseUrl.replace('https://', 'http://'));
  }
  for (const o of config.allowedOrigins) set.add(o);
  return set;
}

const ALLOWED_ORIGINS = buildAllowedOrigins();

export const corsPolicy = cors({
  origin(origin, cb) {
    // Same-origin / server-to-server requests have no Origin header — always allow.
    if (!origin) return cb(null, true);
    if (ALLOWED_ORIGINS.has(origin)) return cb(null, true);
    logger.warn(`CORS blocked origin: ${origin}`);
    cb(null, false);
  },
  credentials: true,
});

// ─── CORS for /v1 — permissive (SillyTavern, Risu, etc.) ──
export const v1Cors = cors({
  origin: true,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
});

// ─── Rate Limiters ───────────────────────────────────
export const loginLimiter = rateLimit({
  windowMs: config.rateLimit.login.windowMs,
  max: config.rateLimit.login.max,
  message: { error: 'Too many login attempts. Try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

export const apiLimiter = rateLimit({
  windowMs: config.rateLimit.api.windowMs,
  max: config.rateLimit.api.max,
  message: { error: 'Rate limit exceeded' },
  standardHeaders: true,
  legacyHeaders: false,
});

export const globalLimiter = rateLimit({
  windowMs: 60000,
  max: 600,
  standardHeaders: true,
  legacyHeaders: false,
});

// ─── HPP ─────────────────────────────────────────────
export const paramProtection = hpp();

// ─── Request metadata ────────────────────────────────
export function requestMeta(req, _res, next) {
  req._startTime = Date.now();
  req.id = crypto.randomUUID();
  next();
}

// ─── JWT Auth middleware (for dashboard / API routes) ─
export async function requireAuth(req, res, next) {
  const token = extractToken(req);
  if (!token) return res.status(401).json({ error: 'Authentication required' });

  try {
    const payload = jwt.verify(token, config.jwt.secret);
    const { data: user, error } = await supabase
      .from('vk_users')
      .select('id, username, role, tier, is_active, totp_enabled')
      .eq('id', payload.sub)
      .single();

    if (error || !user) return res.status(401).json({ error: 'User not found' });
    if (!user.is_active) return res.status(403).json({ error: 'Account disabled' });

    req.user = user;
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') return res.status(401).json({ error: 'Token expired' });
    return res.status(401).json({ error: 'Invalid token' });
  }
}

// ─── Admin-only guard ────────────────────────────────
export function requireAdmin(req, res, next) {
  if (!req.user || !['admin', 'superadmin'].includes(req.user.role)) {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

export function requireSuperadmin(req, res, next) {
  if (!req.user || req.user.role !== 'superadmin') {
    return res.status(403).json({ error: 'Superadmin access required' });
  }
  next();
}

// ─── Global error handler ────────────────────────────
export function globalErrorHandler(err, req, res, _next) {
  const status = err.statusCode || 500;
  const message = status === 500 ? 'Internal server error' : err.message;
  if (status >= 500) logger.error(`[${req.id}] ${err.stack || err.message}`);
  res.status(status).json({ error: message, code: err.code });
}

// ─── Helpers ─────────────────────────────────────────
function extractToken(req) {
  // Check Authorization header first (Bearer token)
  const auth = req.headers.authorization;
  if (auth?.startsWith('Bearer ')) return auth.slice(7).trim();
  // Check cookie
  if (req.cookies?.vk_token) return req.cookies.vk_token;
  return null;
}
