import db from '../models/database.js';
import { generateId } from './crypto.js';

export function audit(actorId, actorUsername, action, targetType, targetId, details, ip) {
  try {
    db.prepare(`
      INSERT INTO audit_logs (id, actor_id, actor_username, action, target_type, target_id, details, ip_address, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, unixepoch())
    `).run(generateId(), actorId, actorUsername, action, targetType, targetId, JSON.stringify(details), ip);
  } catch {}
}

export function logRequest(data) {
  try {
    db.prepare(`
      INSERT INTO request_logs (id, proxy_key_id, user_id, master_key_id, provider, model, status,
        prompt_tokens, completion_tokens, total_tokens, latency_ms, csam_flagged, csam_score,
        ip_address, user_agent, error_message, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch())
    `).run(
      generateId(), data.proxyKeyId||null, data.userId||null, data.masterKeyId||null,
      data.provider||null, data.model||null, data.status,
      data.promptTokens||0, data.completionTokens||0,
      (data.promptTokens||0)+(data.completionTokens||0),
      data.latency||null, data.csamFlagged?1:0, data.csamScore||null,
      data.ip||null, data.userAgent||null, data.error||null
    );
  } catch {}
}
