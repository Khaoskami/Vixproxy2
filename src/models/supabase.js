import { createClient } from '@supabase/supabase-js';
import config from '../config/index.js';
import logger from '../utils/logger.js';

if (!config.supabase.url || !config.supabase.serviceKey) {
  console.error('FATAL: SUPABASE_URL and SUPABASE_SERVICE_KEY are required');
  process.exit(1);
}

// Service-role client — bypasses RLS, used for all server-side operations
export const supabase = createClient(config.supabase.url, config.supabase.serviceKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

// Anon client — for operations that should respect RLS (if you enable it later)
export const supabaseAnon = createClient(config.supabase.url, config.supabase.anonKey);

/**
 * Verify the schema exists. Idempotent — safe to run on every boot.
 * Migration is applied via supabase/migration.sql in the dashboard SQL editor.
 */
export async function ensureSchema() {
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
