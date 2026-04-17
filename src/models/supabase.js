import { createClient } from '@supabase/supabase-js';
import config from '../config/index.js';
import logger from '../utils/logger.js';

const hasSupabaseCreds = Boolean(config.supabase.url && config.supabase.serviceKey);
if (!hasSupabaseCreds) {
  logger.error('SUPABASE_URL and SUPABASE_SERVICE_KEY are not set. The app will start but database calls will fail.');
}

// Service-role client — bypasses RLS, used for all server-side operations.
// Use placeholder values when creds are missing so imports don't throw;
// ensureSchema() will report the problem through /api/health instead.
export const supabase = createClient(
  config.supabase.url || 'http://localhost',
  config.supabase.serviceKey || 'missing',
  { auth: { autoRefreshToken: false, persistSession: false } },
);

// Anon client — for operations that should respect RLS (if you enable it later)
export const supabaseAnon = createClient(
  config.supabase.url || 'http://localhost',
  config.supabase.anonKey || 'missing',
);

/**
 * Verify the schema exists. Idempotent — safe to run on every boot.
 * Migration is applied via supabase/migration.sql in the dashboard SQL editor.
 */
export async function ensureSchema() {
  if (!hasSupabaseCreds) return false;
  logger.info('Checking Supabase schema...');

  const { error } = await supabase.from('vk_users').select('id').limit(1);

  if (error && error.code === '42P01') {
    logger.warn('Schema not found. Run the migration SQL in your Supabase dashboard.');
    logger.warn('See: supabase/migration.sql');
    return false;
  }

  if (error && error.code !== 'PGRST116') {
    logger.error(`Schema check failed: ${error.message}`);
    return false;
  }

  logger.info('Supabase schema verified');
  return true;
}

export default supabase;
