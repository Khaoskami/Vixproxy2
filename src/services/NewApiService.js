import config from '../config/index.js';
import logger from '../utils/logger.js';
import { UpstreamProviderError } from '../utils/errors.js';

const BASE = config.newApi.url.replace(/\/+$/, '');

/**
 * Forward a chat completions request to new-api.
 * Returns the raw Response (supports streaming passthrough via response.body).
 */
export async function relayChatCompletions(body, apiKey) {
  const url = `${BASE}/v1/chat/completions`;
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey || config.newApi.adminToken}`,
  };

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(180000), // 3 min for long generations
    });

    return response;
  } catch (err) {
    if (err.name === 'TimeoutError') {
      throw new UpstreamProviderError('Upstream request timed out', 504);
    }
    throw new UpstreamProviderError(`Upstream connection failed: ${err.message}`, 502);
  }
}

/**
 * Fetch available models from new-api.
 */
export async function fetchModels(apiKey) {
  try {
    const res = await fetch(`${BASE}/v1/models`, {
      headers: { Authorization: `Bearer ${apiKey || config.newApi.adminToken}` },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return [];
    const data = await res.json();
    return data.data || [];
  } catch {
    logger.warn('Failed to fetch models from new-api');
    return [];
  }
}

/**
 * Check new-api health.
 */
export async function checkHealth() {
  try {
    const res = await fetch(`${BASE}/api/status`, {
      signal: AbortSignal.timeout(5000),
    });
    return res.ok;
  } catch {
    return false;
  }
}
