import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

const DB_PATH = process.env.DB_PATH || './data/vixproxy.db';
const dir = path.dirname(DB_PATH);
if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'user',
    email TEXT,
    totp_secret TEXT,
    totp_enabled INTEGER DEFAULT 0,
    failed_logins INTEGER DEFAULT 0,
    locked_until INTEGER,
    daily_request_limit INTEGER DEFAULT 200,
    requests_used_today INTEGER DEFAULT 0,
    last_reset_at INTEGER DEFAULT (unixepoch()),
    is_banned INTEGER DEFAULT 0,
    ban_reason TEXT,
    created_at INTEGER DEFAULT (unixepoch()),
    updated_at INTEGER DEFAULT (unixepoch())
  );
  CREATE TABLE IF NOT EXISTS master_keys (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    provider TEXT NOT NULL,
    encrypted_key TEXT NOT NULL,
    key_iv TEXT NOT NULL,
    key_tag TEXT NOT NULL,
    models TEXT DEFAULT '[]',
    base_url TEXT,
    is_active INTEGER DEFAULT 1,
    daily_quota INTEGER DEFAULT 50000,
    daily_used INTEGER DEFAULT 0,
    last_reset_at INTEGER DEFAULT (unixepoch()),
    created_by TEXT REFERENCES users(id),
    created_at INTEGER DEFAULT (unixepoch()),
    updated_at INTEGER DEFAULT (unixepoch())
  );
  CREATE TABLE IF NOT EXISTS proxy_keys (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    key_value TEXT UNIQUE NOT NULL,
    key_prefix TEXT NOT NULL,
    user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
    master_key_id TEXT REFERENCES master_keys(id) ON DELETE CASCADE,
    status TEXT DEFAULT 'active',
    daily_limit INTEGER DEFAULT 100,
    daily_used INTEGER DEFAULT 0,
    last_reset_at INTEGER DEFAULT (unixepoch()),
    context_lock_enabled INTEGER DEFAULT 0,
    allowed_contexts TEXT DEFAULT '["general","creative","roleplay"]',
    csam_scan_enabled INTEGER DEFAULT 1,
    expires_at INTEGER,
    last_used_at INTEGER,
    created_at INTEGER DEFAULT (unixepoch())
  );
  CREATE TABLE IF NOT EXISTS request_logs (
    id TEXT PRIMARY KEY,
    proxy_key_id TEXT,
    user_id TEXT,
    master_key_id TEXT,
    provider TEXT,
    model TEXT,
    status TEXT,
    prompt_tokens INTEGER DEFAULT 0,
    completion_tokens INTEGER DEFAULT 0,
    total_tokens INTEGER DEFAULT 0,
    latency_ms INTEGER,
    csam_flagged INTEGER DEFAULT 0,
    csam_score REAL,
    ip_address TEXT,
    user_agent TEXT,
    error_message TEXT,
    created_at INTEGER DEFAULT (unixepoch())
  );
  CREATE TABLE IF NOT EXISTS audit_logs (
    id TEXT PRIMARY KEY,
    actor_id TEXT,
    actor_username TEXT,
    action TEXT NOT NULL,
    target_type TEXT,
    target_id TEXT,
    details TEXT,
    ip_address TEXT,
    created_at INTEGER DEFAULT (unixepoch())
  );
  CREATE TABLE IF NOT EXISTS invite_codes (
    id TEXT PRIMARY KEY,
    code TEXT UNIQUE NOT NULL,
    type TEXT NOT NULL DEFAULT 'admin',
    created_by TEXT REFERENCES users(id),
    used_by TEXT REFERENCES users(id),
    status TEXT DEFAULT 'pending',
    expires_at INTEGER,
    created_at INTEGER DEFAULT (unixepoch()),
    used_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS csam_cache (
    content_hash TEXT PRIMARY KEY,
    is_flagged INTEGER NOT NULL,
    confidence_score REAL,
    scanned_at INTEGER DEFAULT (unixepoch())
  );
  CREATE INDEX IF NOT EXISTS idx_proxy_keys_value ON proxy_keys(key_value);
  CREATE INDEX IF NOT EXISTS idx_proxy_keys_user ON proxy_keys(user_id);
  CREATE INDEX IF NOT EXISTS idx_request_logs_user ON request_logs(user_id);
  CREATE INDEX IF NOT EXISTS idx_request_logs_created ON request_logs(created_at);
  CREATE INDEX IF NOT EXISTS idx_audit_logs_actor ON audit_logs(actor_id);
`);

export default db;
