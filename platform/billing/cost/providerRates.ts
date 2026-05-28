export interface ModelRate {
  inputPer1kTokens: number;
  outputPer1kTokens: number;
  /**
   * Cents per 1K cached input tokens. OpenAI bills repeat-context
   * (prompt caching) at a steep discount — typically ~80–90% off the
   * normal input rate on Realtime SKUs. When not supplied, falls back
   * to the regular input rate (which over-bills cached tokens; safer
   * than under-billing).
   *
   * Captured separately from the regular input rate so the analytics
   * dashboards can show actual cache savings instead of inferring
   * them from hit-rate × average cost.
   */
  cachedInputPer1kTokens?: number;
}

export const MODEL_RATES: Record<string, ModelRate> = {
  'gpt-4o': { inputPer1kTokens: 0.25, outputPer1kTokens: 1.0 },
  'gpt-4o-mini': { inputPer1kTokens: 0.015, outputPer1kTokens: 0.06 },
  'gpt-4-turbo': { inputPer1kTokens: 1.0, outputPer1kTokens: 3.0 },
  'gpt-3.5-turbo': { inputPer1kTokens: 0.05, outputPer1kTokens: 0.15 },
  // Realtime models — what the voice gateway actually opens WS sessions with.
  // Non-realtime model names (e.g. 'gpt-4o', 'gpt-4o-mini') are rejected by
  // OpenAI's Realtime API with `invalid_model`, so TIER_MODEL_MAP below must
  // only point at Realtime SKUs.
  //
  // Current default: `gpt-realtime-2` (released 2026-05-07). Brings
  // GPT-5-class reasoning, a configurable `reasoning.effort` knob
  // (low/medium/high), 128K context, parallel tool calls with spoken
  // preambles, and two new exclusive voices (`marin`, `cedar`). The audio
  // token rates below are the published list prices ($32/1M input,
  // $64/1M output) expressed as cents per 1K tokens; text token traffic
  // through the Realtime API is billed at the same rates.
  //
  // Cached input rate is OpenAI's published "audio input cached" price
  // for gpt-realtime-2 ($0.40/1M = 0.04¢/1k), an 80× discount vs the
  // full input rate. This is what `input_token_details.cached_tokens`
  // from the response.done.usage payload should be billed at.
  //
  // Older Realtime SKUs are kept in the map only so cost analytics for
  // legacy DB rows that still reference them continue to compute.
  'gpt-realtime-2': { inputPer1kTokens: 3.2, outputPer1kTokens: 6.4, cachedInputPer1kTokens: 0.04 },
  'gpt-realtime': { inputPer1kTokens: 0.4, outputPer1kTokens: 1.6, cachedInputPer1kTokens: 0.04 },
  'gpt-realtime-mini': { inputPer1kTokens: 0.05, outputPer1kTokens: 0.2, cachedInputPer1kTokens: 0.03 },
  'gpt-4o-realtime-preview': { inputPer1kTokens: 0.5, outputPer1kTokens: 2.0, cachedInputPer1kTokens: 0.25 },
  'gpt-4o-mini-realtime-preview': { inputPer1kTokens: 0.06, outputPer1kTokens: 0.24, cachedInputPer1kTokens: 0.03 },
};

export const STT_COST_PER_MINUTE_CENTS = parseFloat(process.env.STT_COST_PER_MINUTE_CENTS ?? '0.6');
export const TTS_COST_PER_1K_CHARS_CENTS = parseFloat(process.env.TTS_COST_PER_1K_CHARS_CENTS ?? '1.5');
export const INFRA_COST_PER_MINUTE_CENTS = parseFloat(process.env.INFRA_COST_PER_MINUTE_CENTS ?? '0.5');

export type ModelTier = 'economy' | 'standard' | 'premium';

// IMPORTANT: every entry here must be a model that OpenAI's Realtime API
// accepts. Voice sessions open with this exact string and OpenAI returns
// `invalid_model` (and the call goes silent until the silence timeout
// kills it) for any non-realtime model. Pinned to OpenAI's latest GA
// Realtime release (`gpt-realtime-2`, 2026-05-07) for both standard and
// premium — this is a quality-voice-ops product, so the default has to
// be the newest GPT-5-class model. Economy stays on `gpt-realtime-mini`
// (smaller, ~10× cheaper) for budget-downgrade scenarios; mini hasn't
// been refreshed in the May 2026 release, so we keep the Aug 2025 GA
// mini until OpenAI ships a v2 mini.
export const TIER_MODEL_MAP: Record<ModelTier, string> = {
  economy: 'gpt-realtime-mini',
  standard: 'gpt-realtime-2',
  premium: 'gpt-realtime-2',
};

// Reasoning effort knob is exclusive to `gpt-realtime-2`. OpenAI's
// guidance: start at "low" for most production voice agents and only
// raise it for multi-step tasks or escalations. QVO defaults to
// "medium" on standard (quality positioning, a bit more headroom for
// tool-calling and slot-filling) and "high" on premium (deep planning,
// complex workflows). Economy maps to "low" but is a no-op while the
// economy tier uses the mini SKU — the field is ignored by mini.
export const TIER_REASONING_EFFORT: Record<ModelTier, 'low' | 'medium' | 'high'> = {
  economy: 'low',
  standard: 'medium',
  premium: 'high',
};

// Returns true when the model accepts the `reasoning.effort` session
// parameter. Sending it to a model that doesn't support it (e.g. the
// mini SKU or the legacy preview) is rejected with `invalid_request_error`,
// so callers must gate on this before adding the knob to session.update.
export function modelSupportsReasoningEffort(model: string): boolean {
  return model === 'gpt-realtime-2' || model.startsWith('gpt-realtime-2-');
}

export function getModelRate(model: string): ModelRate {
  return MODEL_RATES[model] ?? MODEL_RATES['gpt-4o'];
}

export function calculateLlmCostCents(
  model: string,
  inputTokens: number,
  outputTokens: number,
  cachedInputTokens: number = 0,
): number {
  const rate = getModelRate(model);
  // OpenAI's response.done.usage shape: `input_tokens` is the TOTAL
  // including cached, with `input_token_details.cached_tokens` calling
  // out the cached subset. Bill the non-cached portion at the regular
  // rate and the cached portion at the cached rate (typically ~80×
  // cheaper on Realtime SKUs). If the rate table doesn't carry a
  // cached rate for this model, fall back to the regular rate — over-
  // billing cached tokens is safer than under-billing.
  const safeCached = Math.max(0, Math.min(cachedInputTokens, inputTokens));
  const nonCachedInput = inputTokens - safeCached;
  const cachedRate = rate.cachedInputPer1kTokens ?? rate.inputPer1kTokens;
  const inputCost = (nonCachedInput / 1000) * rate.inputPer1kTokens
                  + (safeCached     / 1000) * cachedRate;
  const outputCost = (outputTokens / 1000) * rate.outputPer1kTokens;
  return Math.ceil(inputCost + outputCost);
}

export function calculateSttCostCents(durationSeconds: number): number {
  const minutes = Math.ceil(durationSeconds / 60);
  return Math.ceil(minutes * STT_COST_PER_MINUTE_CENTS);
}

export function calculateTtsCostCents(characterCount: number): number {
  return Math.ceil((characterCount / 1000) * TTS_COST_PER_1K_CHARS_CENTS);
}

export function calculateInfraCostCents(durationSeconds: number): number {
  const minutes = Math.ceil(durationSeconds / 60);
  return Math.ceil(minutes * INFRA_COST_PER_MINUTE_CENTS);
}
