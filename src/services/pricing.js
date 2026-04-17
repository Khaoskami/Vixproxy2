// ─────────────────────────────────────────────
//  Model pricing per 1M tokens (USD).
//  Update periodically — these values are reference only;
//  upstream new-api may apply its own pricing.
// ─────────────────────────────────────────────
const MODEL_PRICING = {
  'openai/gpt-4o': { input: 2.5, output: 10.0 },
  'openai/gpt-4o-mini': { input: 0.15, output: 0.6 },
  'openai/gpt-3.5-turbo': { input: 0.5, output: 1.5 },
  'openai/gpt-4-turbo': { input: 10.0, output: 30.0 },
  'anthropic/claude-3.5-sonnet': { input: 3.0, output: 15.0 },
  'anthropic/claude-3-opus': { input: 15.0, output: 75.0 },
  'anthropic/claude-3-haiku': { input: 0.25, output: 1.25 },
  'anthropic/claude-3.5-haiku': { input: 0.8, output: 4.0 },
  'meta-llama/llama-3.1-70b-instruct': { input: 0.52, output: 0.75 },
  'meta-llama/llama-3.1-8b-instruct': { input: 0.055, output: 0.055 },
  'meta-llama/llama-3.1-405b-instruct': { input: 2.0, output: 2.0 },
  'google/gemini-pro-1.5': { input: 2.5, output: 10.0 },
  'google/gemini-flash-1.5': { input: 0.075, output: 0.3 },
  'mistralai/mistral-large': { input: 2.0, output: 6.0 },
  'mistralai/mistral-small': { input: 0.2, output: 0.6 },
};

const DEFAULT_PRICING = { input: 1.0, output: 3.0 };

/**
 * Find pricing for a model. Tries exact match first, then a prefix match
 * (e.g. "anthropic/claude-3.5-sonnet:beta" -> "anthropic/claude-3.5-sonnet").
 */
function findPricing(model) {
  if (MODEL_PRICING[model]) return MODEL_PRICING[model];
  for (const [key, val] of Object.entries(MODEL_PRICING)) {
    if (model.startsWith(key)) return val;
  }
  return DEFAULT_PRICING;
}

/**
 * Calculate cost in microdollars (1 microdollar = $0.000001).
 */
export function calculateCostMicrodollars(model, promptTokens, completionTokens, priceMultiplier = 1.0) {
  const pricing = findPricing(model);
  const inputCost = (promptTokens / 1_000_000) * pricing.input * priceMultiplier;
  const outputCost = (completionTokens / 1_000_000) * pricing.output * priceMultiplier;
  return Math.ceil((inputCost + outputCost) * 1_000_000);
}

/**
 * Wildcard-aware pattern matching.
 * Patterns: "*", exact strings, or strings ending in "*" (prefix match).
 */
export function isModelAllowed(model, allowedPatterns) {
  if (!Array.isArray(allowedPatterns) || allowedPatterns.length === 0) return false;
  return allowedPatterns.some((pattern) => {
    if (pattern === '*') return true;
    if (pattern.endsWith('*')) return model.startsWith(pattern.slice(0, -1));
    return model === pattern;
  });
}

export function formatUSD(microdollars) {
  return `$${(microdollars / 1_000_000).toFixed(4)}`;
}
