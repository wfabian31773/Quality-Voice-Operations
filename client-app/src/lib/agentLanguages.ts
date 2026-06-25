/**
 * Agent language options + per-language voice recommendations.
 *
 * The `RECOMMENDED_VOICES_BY_LANGUAGE` map below is hand-curated against the
 * canonical OpenAI Realtime voice list in `./agentVoices.ts`. Voice quality
 * per language drifts as OpenAI ships new voices and improves existing ones,
 * so we re-grade on a fixed cadence:
 *
 *   • Review cadence: quarterly (or sooner if OpenAI announces new/removed
 *     Realtime voices on the changelog).
 *   • Auto-detect (additions): the daily GitHub Action
 *     `.github/workflows/check-openai-realtime-voices.yml` probes the
 *     OpenAI Realtime API and opens a tracking issue when the upstream
 *     voice set drifts from `VOICES` in `./agentVoices.ts`. When that
 *     issue fires, run the per-language listening test below for the
 *     newly-shipped voice and update the relevant arrays in
 *     `RECOMMENDED_VOICES_BY_LANGUAGE` instead of waiting for the next
 *     quarterly review.
 *   • Listening test: see the rubric in `./agentVoices.ts` (4-line script,
 *     two reviewers, must average ≥ 3.5 on pronunciation, prosody, and
 *     comfort to be added to a language's recommended list).
 *
 * Guard rails:
 *   • Every voice id in `RECOMMENDED_VOICES_BY_LANGUAGE` MUST appear in
 *     `VOICES` from `./agentVoices.ts`. The test in
 *     `tests/components/voiceLanguageRecommendations.test.ts` enforces this,
 *     so removing a voice from the canonical list will fail CI rather than
 *     silently dangling here.
 *   • Every language in `AGENT_LANGUAGES` must have a non-empty entry in
 *     `RECOMMENDED_VOICES_BY_LANGUAGE` (also asserted by the test).
 */
export interface AgentLanguageOption {
  code: string;
  label: string;
  nativeLabel: string;
}

export const AGENT_LANGUAGES: readonly AgentLanguageOption[] = [
  { code: 'en', label: 'English', nativeLabel: 'English' },
  { code: 'es', label: 'Spanish', nativeLabel: 'Español' },
  { code: 'fr', label: 'French', nativeLabel: 'Français' },
  { code: 'de', label: 'German', nativeLabel: 'Deutsch' },
  { code: 'pt', label: 'Portuguese', nativeLabel: 'Português' },
  { code: 'it', label: 'Italian', nativeLabel: 'Italiano' },
  { code: 'nl', label: 'Dutch', nativeLabel: 'Nederlands' },
  { code: 'zh', label: 'Chinese', nativeLabel: '中文' },
  { code: 'ja', label: 'Japanese', nativeLabel: '日本語' },
  { code: 'ko', label: 'Korean', nativeLabel: '한국어' },
  { code: 'ar', label: 'Arabic', nativeLabel: 'العربية' },
  { code: 'hi', label: 'Hindi', nativeLabel: 'हिन्दी' },
] as const;

export const DEFAULT_AGENT_LANGUAGE = 'en';

const LANGUAGE_CODE_SET = new Set(AGENT_LANGUAGES.map((l) => l.code));
const LABEL_TO_CODE = new Map(AGENT_LANGUAGES.map((l) => [l.label.toLowerCase(), l.code]));

export function normalizeAgentLanguage(value: unknown): string {
  if (typeof value !== 'string') return DEFAULT_AGENT_LANGUAGE;
  const trimmed = value.trim();
  if (!trimmed) return DEFAULT_AGENT_LANGUAGE;
  if (LANGUAGE_CODE_SET.has(trimmed)) return trimmed;
  const fromLabel = LABEL_TO_CODE.get(trimmed.toLowerCase());
  if (fromLabel) return fromLabel;
  return DEFAULT_AGENT_LANGUAGE;
}

export function getAgentLanguageLabel(code: string): string {
  const normalized = normalizeAgentLanguage(code);
  return AGENT_LANGUAGES.find((l) => l.code === normalized)?.label ?? 'English';
}

// Per-language recommended voices, ordered by speech quality grade
// for that language. The first entry is the default suggestion.
//
// Updated 2026-06-25: OpenAI's GA Realtime voice catalog dropped
// `fable`, `nova`, `onyx` and added `cedar` + `marin` (gpt-realtime-2
// exclusives). `nova` was the top non-English recommendation across
// 11 of 12 language buckets; we remap it 1:1 to `marin`, which is a
// same-tier premium voice with broad multilingual coverage. `fable`
// and `onyx` only appeared in the English bucket and are dropped
// without replacement. `cedar` joins the English bucket since we
// don't have per-language quality grades for the new voices outside
// English yet — keep the multilingual buckets conservative until the
// next per-language grading sweep.
export const RECOMMENDED_VOICES_BY_LANGUAGE: Readonly<Record<string, readonly string[]>> = {
  en: ['alloy', 'ash', 'ballad', 'cedar', 'coral', 'echo', 'marin', 'sage', 'shimmer', 'verse'],
  es: ['coral', 'marin', 'shimmer', 'sage', 'alloy', 'verse'],
  fr: ['marin', 'shimmer', 'sage', 'alloy', 'coral', 'verse'],
  de: ['alloy', 'marin', 'sage', 'shimmer', 'verse'],
  pt: ['marin', 'shimmer', 'alloy', 'coral', 'sage'],
  it: ['marin', 'shimmer', 'sage', 'alloy', 'coral', 'verse'],
  nl: ['alloy', 'marin', 'shimmer', 'sage'],
  zh: ['alloy', 'marin', 'shimmer'],
  ja: ['alloy', 'marin', 'shimmer'],
  ko: ['alloy', 'marin', 'shimmer'],
  ar: ['alloy', 'marin', 'shimmer'],
  hi: ['alloy', 'marin', 'shimmer'],
};

export function getRecommendedVoicesForLanguage(languageCode: string): readonly string[] {
  const normalized = normalizeAgentLanguage(languageCode);
  return RECOMMENDED_VOICES_BY_LANGUAGE[normalized] ?? RECOMMENDED_VOICES_BY_LANGUAGE[DEFAULT_AGENT_LANGUAGE];
}

export function isVoiceRecommendedForLanguage(voice: string, languageCode: string): boolean {
  if (!voice) return true;
  return getRecommendedVoicesForLanguage(languageCode).includes(voice);
}

export function getDefaultVoiceForLanguage(languageCode: string): string {
  const recommended = getRecommendedVoicesForLanguage(languageCode);
  return recommended[0] ?? 'alloy';
}
