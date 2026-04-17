/**
 * Lightweight token estimator. Uses ~4 chars/token heuristic.
 * Good enough for budget gates; actual billing uses provider-reported usage.
 */
export function countMessageTokens(messages) {
  if (!Array.isArray(messages)) return 0;
  let chars = 0;
  for (const m of messages) {
    if (typeof m?.content === 'string') chars += m.content.length;
    else if (Array.isArray(m?.content)) {
      for (const part of m.content) {
        if (typeof part?.text === 'string') chars += part.text.length;
      }
    }
    chars += 8; // role + delimiter overhead per message
  }
  return Math.ceil(chars / 4);
}

/**
 * Estimate completion tokens from raw SSE byte count.
 * Used as a fallback when upstream doesn't include usage in the stream.
 * Subtracts overhead for SSE framing (`data: {...}\n\n`) and JSON wrapping.
 * Empirically ~30-40% of bytes are framing for OpenAI-style streams.
 */
export function estimateCompletionTokensFromStream(byteLength) {
  if (!byteLength || byteLength <= 0) return 0;
  const contentBytes = Math.floor(byteLength * 0.6);
  return Math.max(1, Math.ceil(contentBytes / 4));
}
