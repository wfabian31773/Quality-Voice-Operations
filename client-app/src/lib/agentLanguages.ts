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

export const RECOMMENDED_VOICES_BY_LANGUAGE: Readonly<Record<string, readonly string[]>> = {
  en: ['alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'onyx', 'nova', 'sage', 'shimmer', 'verse'],
  es: ['coral', 'nova', 'shimmer', 'sage', 'alloy', 'verse'],
  fr: ['nova', 'shimmer', 'sage', 'alloy', 'coral', 'verse'],
  de: ['alloy', 'nova', 'sage', 'shimmer', 'verse'],
  pt: ['nova', 'shimmer', 'alloy', 'coral', 'sage'],
  it: ['nova', 'shimmer', 'sage', 'alloy', 'coral', 'verse'],
  nl: ['alloy', 'nova', 'shimmer', 'sage'],
  zh: ['alloy', 'nova', 'shimmer'],
  ja: ['alloy', 'nova', 'shimmer'],
  ko: ['alloy', 'nova', 'shimmer'],
  ar: ['alloy', 'nova', 'shimmer'],
  hi: ['alloy', 'nova', 'shimmer'],
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
