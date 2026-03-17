export interface ModelRate {
  inputPer1kTokens: number;
  outputPer1kTokens: number;
}

export const MODEL_RATES: Record<string, ModelRate> = {
  'gpt-4o': { inputPer1kTokens: 0.25, outputPer1kTokens: 1.0 },
  'gpt-4o-mini': { inputPer1kTokens: 0.015, outputPer1kTokens: 0.06 },
  'gpt-4-turbo': { inputPer1kTokens: 1.0, outputPer1kTokens: 3.0 },
  'gpt-3.5-turbo': { inputPer1kTokens: 0.05, outputPer1kTokens: 0.15 },
};

export const STT_COST_PER_MINUTE_CENTS = parseFloat(process.env.STT_COST_PER_MINUTE_CENTS ?? '0.6');
export const TTS_COST_PER_1K_CHARS_CENTS = parseFloat(process.env.TTS_COST_PER_1K_CHARS_CENTS ?? '1.5');
export const INFRA_COST_PER_MINUTE_CENTS = parseFloat(process.env.INFRA_COST_PER_MINUTE_CENTS ?? '0.5');

export type ModelTier = 'economy' | 'standard' | 'premium';

export const TIER_MODEL_MAP: Record<ModelTier, string> = {
  economy: 'gpt-4o-mini',
  standard: 'gpt-4o',
  premium: 'gpt-4-turbo',
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
