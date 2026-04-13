import fetch from 'node-fetch';
import { decrypt } from '../utils/crypto.js';
import db from '../models/database.js';
import logger from '../utils/logger.js';

const PROVIDER_URLS = {
  openai: 'https://api.openai.com/v1/chat/completions',
  anthropic: 'https://api.anthropic.com/v1/messages',
  openrouter: 'https://openrouter.ai/api/v1/chat/completions',
  groq: 'https://api.groq.com/openai/v1/chat/completions',
  google: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
  mistral: 'https://api.mistral.ai/v1/chat/completions',
  deepseek: 'https://api.deepseek.com/v1/chat/completions',
};

const ALLOWED_HOSTS = new Set(['api.openai.com','api.anthropic.com','openrouter.ai','api.groq.com','generativelanguage.googleapis.com','api.mistral.ai','api.deepseek.com']);

export function getMasterKey(masterKeyId) {
  const mk = db.prepare('SELECT * FROM master_keys WHERE id = ? AND is_active = 1').get(masterKeyId);
  if (!mk) return null;
  try {
    const rawKey = decrypt(mk.encrypted_key, mk.key_iv, mk.key_tag);
    return { ...mk, rawKey };
  } catch { logger.error('Failed to decrypt master key', { id: masterKeyId }); return null; }
}

function buildProviderRequest(provider, rawKey) {
  const baseUrl = PROVIDER_URLS[provider];
  if (!baseUrl) throw new Error(`Unsupported provider: ${provider}`);
  const hostname = new URL(baseUrl).hostname;
  if (!ALLOWED_HOSTS.has(hostname)) throw new Error(`SSRF blocked: ${hostname}`);
  let headers = { 'Content-Type': 'application/json', 'User-Agent': 'VixProxy/2.0' };
  if (provider === 'anthropic') { headers['x-api-key'] = rawKey; headers['anthropic-version'] = '2023-06-01'; }
  else headers['Authorization'] = `Bearer ${rawKey}`;
  if (provider === 'openrouter') { headers['HTTP-Referer'] = process.env.BASE_URL||'https://vixproxy.app'; headers['X-Title'] = 'VixProxy'; }
  return { url: baseUrl, headers };
}

export async function proxyRequest(masterKeyId, provider, requestBody) {
  const mk = getMasterKey(masterKeyId);
  if (!mk) throw new Error('Master key not found or inactive');
  if (mk.daily_used >= mk.daily_quota) throw new Error('Master key daily quota exceeded');

  const { url, headers } = buildProviderRequest(provider, mk.rawKey);
  let providerBody = requestBody;

  if (provider === 'anthropic') {
    const { model, messages, max_tokens, stream, ...rest } = requestBody;
    const systemMsg = messages?.find(m => m.role === 'system')?.content;
    const userMsgs = messages?.filter(m => m.role !== 'system') || [];
    providerBody = { model: model||'claude-sonnet-4-5', messages: userMsgs, max_tokens: max_tokens||4096, stream: stream||false, ...(systemMsg?{system:systemMsg}:{}), ...rest };
  }

  const startTime = Date.now();
  let response;
  try {
    response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(providerBody), signal: AbortSignal.timeout(120000) });
  } catch (err) { throw new Error(`Provider request failed: ${err.message}`); }

  const latency = Date.now() - startTime;
  if (!response.ok) { const errText = await response.text(); throw new Error(`Provider error ${response.status}: ${errText.slice(0,200)}`); }
  if (requestBody.stream) return { streaming: true, response, latency };

  const data = await response.json();
  let promptTokens = 0, completionTokens = 0;
  if (data.usage) { promptTokens = data.usage.input_tokens||data.usage.prompt_tokens||0; completionTokens = data.usage.output_tokens||data.usage.completion_tokens||0; }

  let normalized = data;
  if (provider === 'anthropic') {
    normalized = { id: data.id, object: 'chat.completion', model: data.model, choices: [{ index: 0, message: { role: 'assistant', content: data.content?.[0]?.text||'' }, finish_reason: data.stop_reason||'stop' }], usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens+completionTokens } };
  }

  db.prepare('UPDATE master_keys SET daily_used = daily_used + ? WHERE id = ?').run(promptTokens+completionTokens, masterKeyId);
  return { streaming: false, data: normalized, latency, tokens: { prompt: promptTokens, completion: completionTokens } };
}
