import { Router } from 'express';
import { requireProxyKey } from '../middleware/auth.js';
import { scanContent, checkContextLock } from '../services/csam.js';
import { proxyRequest } from '../services/proxy.js';
import { logRequest } from '../utils/audit.js';
import db from '../models/database.js';
import logger from '../utils/logger.js';

const router = Router();

router.post('/v1/chat/completions', requireProxyKey, async (req, res) => {
  const pk = req.proxyKey;
  const start = Date.now();
  const logData = { proxyKeyId: pk.id, userId: pk.user_id, masterKeyId: pk.master_key_id, provider: null, model: req.body.model||'unknown', ip: req.ip, userAgent: req.headers['user-agent'] };

  try {
    const { messages } = req.body;
    if (!messages || !Array.isArray(messages)) return res.status(400).json({ error: 'messages array required' });
    const mk = db.prepare('SELECT * FROM master_keys WHERE id = ? AND is_active = 1').get(pk.master_key_id);
    if (!mk) { logData.status='error'; logData.error='Master key unavailable'; logRequest(logData); return res.status(503).json({ error: 'Provider key unavailable' }); }
    logData.provider = mk.provider;

    if (pk.csam_scan_enabled) {
      const scan = await scanContent(messages);
      if (scan.flagged) { logData.status='blocked_csam'; logData.csamFlagged=true; logData.csamScore=scan.score; logData.latency=Date.now()-start; logRequest(logData); return res.status(451).json({ error: 'Content blocked by safety filter' }); }
    }

    if (pk.context_lock_enabled) {
      const ctxCheck = checkContextLock(messages, JSON.parse(pk.allowed_contexts||'["general"]'));
      if (!ctxCheck.allowed) { logData.status='context_locked'; logData.error=ctxCheck.reason; logData.latency=Date.now()-start; logRequest(logData); return res.status(403).json({ error: ctxCheck.reason }); }
    }

    db.prepare('UPDATE proxy_keys SET daily_used = daily_used + 1, last_used_at = unixepoch() WHERE id = ?').run(pk.id);
    db.prepare('UPDATE users SET requests_used_today = requests_used_today + 1 WHERE id = ?').run(pk.user_id);

    if (req.body.stream) {
      const result = await proxyRequest(pk.master_key_id, mk.provider, req.body);
      if (result.streaming) {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        result.response.body.pipe(res);
        result.response.body.on('end', () => { logData.status='success'; logData.latency=Date.now()-start; logRequest(logData); });
        result.response.body.on('error', (err) => { logData.status='error'; logData.error=err.message; logData.latency=Date.now()-start; logRequest(logData); });
        return;
      }
    }

    const result = await proxyRequest(pk.master_key_id, mk.provider, req.body);
    logData.status='success'; logData.promptTokens=result.tokens?.prompt||0; logData.completionTokens=result.tokens?.completion||0; logData.latency=result.latency;
    logRequest(logData);
    res.json(result.data);
  } catch (err) {
    logger.error('Proxy request failed', { error: err.message });
    logData.status='error'; logData.error=err.message; logData.latency=Date.now()-start;
    logRequest(logData);
    res.status(502).json({ error: 'Proxy request failed', message: err.message });
  }
});

router.get('/v1/models', requireProxyKey, (req, res) => {
  const pk = req.proxyKey;
  const mk = db.prepare('SELECT provider, models FROM master_keys WHERE id = ?').get(pk.master_key_id);
  if (!mk) return res.status(503).json({ error: 'Provider unavailable' });
  let models = [];
  try { models = JSON.parse(mk.models||'[]'); } catch {}
  if (!models.length) {
    const defaults = { openai:['gpt-4o','gpt-4o-mini','gpt-4-turbo'], anthropic:['claude-opus-4-5','claude-sonnet-4-5','claude-haiku-4-5'], openrouter:['openrouter/auto'], groq:['llama-3.3-70b-versatile','mixtral-8x7b-32768'], google:['gemini-1.5-pro','gemini-1.5-flash'], mistral:['mistral-large-latest'], deepseek:['deepseek-chat'] };
    models = defaults[mk.provider]||[];
  }
  res.json({ object: 'list', data: models.map(id => ({ id, object: 'model', created: 1700000000, owned_by: mk.provider })) });
});

export default router;
