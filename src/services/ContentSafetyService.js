import { supabase } from '../models/supabase.js';
import logger from '../utils/logger.js';

// Prohibited content patterns (high-severity).
// NOTE: This regex layer is intentionally narrow and will both false-positive on
// adult RP and miss any modest obfuscation. See README "Known limitations" — for
// production you should replace this with a real classifier (OpenAI moderations,
// Perspective API, or similar). Keeping it as a defense-in-depth signal only.
const PROHIBITED_PATTERNS = [
  /\b(?:child|kid|minor|underage|preteen|toddler|infant|loli|shota)\b.{0,200}\b(?:sex|nude|naked|rape|molest|abuse|exploit|erotic|hentai)\b/i,
  /\b(?:sex|nude|naked|rape|molest|abuse|exploit|erotic|hentai)\b.{0,200}\b(?:child|kid|minor|underage|preteen|toddler|infant|loli|shota)\b/i,
  /\b(?:csam|cp|pedo|paedo|pedophil)\b/i,
];

/**
 * Scan messages for prohibited content. Logs matches asynchronously.
 * @returns {{ flagged: boolean }}
 */
export function checkAndFlag(userId, messages, model) {
  if (!Array.isArray(messages)) return { flagged: false };

  const combined = messages
    .map((m) => {
      if (typeof m.content === 'string') return m.content;
      if (Array.isArray(m.content)) {
        return m.content.map((p) => (typeof p?.text === 'string' ? p.text : '')).join(' ');
      }
      return '';
    })
    .join(' ');

  const matched = [];
  for (const pat of PROHIBITED_PATTERNS) {
    if (pat.test(combined)) {
      matched.push(pat.source.slice(0, 60));
    }
  }

  if (matched.length === 0) return { flagged: false };

  // Fire-and-forget log to DB. Don't block the request on this insert.
  supabase
    .from('vk_content_flags')
    .insert({
      user_id: userId,
      flag_type: 'csam',
      severity: 'critical',
      matched_patterns: matched,
      message_content: combined.slice(0, 5000),
      model: model || 'unknown',
      status: 'pending',
    })
    .then(({ error }) => {
      if (error) logger.error(`Failed to log content flag: ${error.message}`);
      else logger.warn(`Content safety flag: user=${userId}, patterns=${matched.length}`);
    });

  return { flagged: true };
}
