import { hashContent } from '../utils/crypto.js';
import db from '../models/database.js';
import logger from '../utils/logger.js';

const HARD_BLOCKED_PATTERNS = [
  /\b(loli|shota|cp|child\s*porn|kiddie\s*porn|pedo(phile)?|underage\s*sex|minor\s*sex)\b/i,
  /\b(preteen|pre-teen)\b.{0,50}\b(sex|nude|naked|porn|explicit|lewd)\b/i,
  /\b(sex|nude|naked|porn|explicit|lewd)\b.{0,50}\b(preteen|pre-teen|child|minor|kid)\b.{0,20}\b(sex|nude|naked|porn)\b/i,
  /\b(\d{1,2})\s*year\s*old\b.{0,80}\b(sex|nude|naked|porn|explicit|aroused|horny)\b/i,
  /\b(sex|nude|naked|porn|explicit)\b.{0,80}\b(\d{1,2})\s*year\s*old\b/i,
];

const HIGH_RISK_MINOR_WORDS = ['child','minor','underage','kid','toddler','infant','baby','elementary school','middle school','junior high','12 year','13 year','14 year','15 year','16 year','17 year','grade school'];
const SEXUAL_WORDS = ['sex','sexual','nude','naked','porn','erotic','explicit','nsfw','aroused','orgasm','penetrat','genitals','masturbat','intercourse'];

function scoreContent(text) {
  if (!text || typeof text !== 'string') return { score: 0, flagged: false };
  const lower = text.toLowerCase();
  for (const pattern of HARD_BLOCKED_PATTERNS) {
    if (pattern.test(lower)) return { score: 1.0, flagged: true, reason: 'hard_pattern_match' };
  }
  const hasMinorWord = HIGH_RISK_MINOR_WORDS.some(w => lower.includes(w));
  const hasSexualWord = SEXUAL_WORDS.some(w => lower.includes(w));
  if (hasMinorWord && hasSexualWord) return { score: 0.85, flagged: true, reason: 'minor_sexual_combo' };
  return { score: 0, flagged: false };
}

export async function scanContent(messages) {
  if (!messages || !Array.isArray(messages)) return { flagged: false, score: 0 };
  const fullText = messages.map(m => typeof m.content === 'string' ? m.content : JSON.stringify(m.content)).join('\n');
  const contentHash = hashContent(fullText);
  const cached = db.prepare('SELECT * FROM csam_cache WHERE content_hash = ?').get(contentHash);
  if (cached) return { flagged: !!cached.is_flagged, score: cached.confidence_score, cached: true };
  const result = scoreContent(fullText);
  db.prepare(`INSERT OR REPLACE INTO csam_cache (content_hash, is_flagged, confidence_score, scanned_at) VALUES (?, ?, ?, unixepoch())`).run(contentHash, result.flagged?1:0, result.score);
  if (result.flagged) logger.warn('CSAM detection triggered', { score: result.score, reason: result.reason });
  return result;
}

export function checkContextLock(messages, allowedContexts) {
  if (!allowedContexts || allowedContexts.includes('*')) return { allowed: true };
  const fullText = messages.map(m => typeof m.content === 'string' ? m.content : '').join('\n').toLowerCase();
  if (!allowedContexts.includes('nsfw')) {
    const isNsfw = SEXUAL_WORDS.slice(0,8).some(w => fullText.includes(w));
    if (isNsfw) return { allowed: false, reason: 'context_locked: nsfw content not permitted for this key' };
  }
  return { allowed: true };
}
