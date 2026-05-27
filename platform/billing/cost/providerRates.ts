export interface ModelRate {
  inputPer1kTokens: number;
  outputPer1kTokens: number;
}

export const MODEL_RATES: Record<string, ModelRate> = {
  'gpt-4o': { inputPer1kTokens: 0.25, outputPer1kTokens: 1.0 },
  'gpt-4o-mini': { inputPer1kTokens: 0.015, outputPer1kTokens: 0.06 },
  'gpt-4-turbo': { inputPer1kTokens: 1.0, outputPer1kTokens: 3.0 },
  'gpt-3.5-turbo': { inputPer1kTokens: 0.05, outputPer1kTokens: 0.15 },
  // Realtime models — what the voice gateway actually opens WS sessions with.
  // Non-realtime model names (e.g. 'gpt-4o', 'gpt-4o-mini') are rejected by
  // OpenAI's Realtime API with `invalid_model`, so TIER_MODEL_MAP below must
  // only point at Realtime SKUs (current GA line: `gpt-realtime` /
  // `gpt-realtime-mini`; legacy `*-realtime-preview` kept for back-compat
  // with existing DB rows that still reference them).
  'gpt-realtime': { inputPer1kTokens: 0.4, outputPer1kTokens: 1.6 },
  'gpt-realtime-mini': { inputPer1kTokens: 0.05, outputPer1kTokens: 0.2 },
  'gpt-4o-realtime-preview': { inputPer1kTokens: 0.5, outputPer1kTokens: 2.0 },
  'gpt-4o-mini-realtime-preview': { inputPer1kTokens: 0.06, outputPer1kTokens: 0.24 },
};

export const STT_COST_PER_MINUTE_CENTS = parseFloat(process.env.STT_COST_PER_MINUTE_CENTS ?? '0.6');
export const TTS_COST_PER_1K_CHARS_CENTS = parseFloat(process.env.TTS_COST_PER_1K_CHARS_CENTS ?? '1.5');
export const INFRA_COST_PER_MINUTE_CENTS = parseFloat(process.env.INFRA_COST_PER_MINUTE_CENTS ?? '0.5');

export type ModelTier = 'economy' | 'standard' | 'premium';

// IMPORTANT: every entry here must be a model that OpenAI's Realtime API
// accepts. Voice sessions open with this exact string and OpenAI returns
// `invalid_model` (and the call goes silent until the silence timeout
// kills it) for any non-realtime model. Pinned to OpenAI's latest GA
// Realtime line (`gpt-realtime` / `gpt-realtime-mini`, released Aug
// 2025) — this is a quality-voice-ops product, so the default has to
// be the newest available model, not a preview.
export const TIER_MODEL_MAP: Record<ModelTier, string> = {
  economy: 'gpt-realtime-mini',
  standard: 'gpt-realtime',
  premium: 'gpt-realtime',
};

export function getModelRate(model: string): ModelRate {
  return MODEL_RATES[model] ?? MODEL_RATES['gpt-4o'];
}

export function calculateLlmCostCents(model: string, inputTokens: number, outputTokens: number): number {
  const rate = getModelRate(model);
  const inputCost = (inputTokens / 1000) * rate.inputPer1kTokens;
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
