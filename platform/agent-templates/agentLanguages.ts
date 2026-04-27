export interface AgentLanguage {
  code: string;
  label: string;
  nativeLabel: string;
}

export const AGENT_LANGUAGES: readonly AgentLanguage[] = [
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

export function isSupportedAgentLanguage(code: unknown): code is string {
  return typeof code === 'string' && LANGUAGE_CODE_SET.has(code);
}

export function getAgentLanguageLabel(code: string): string {
  return AGENT_LANGUAGES.find((l) => l.code === code)?.label ?? 'English';
}

export function normalizeAgentLanguage(value: unknown): string {
  if (typeof value !== 'string') return DEFAULT_AGENT_LANGUAGE;
  const trimmed = value.trim();
  if (!trimmed) return DEFAULT_AGENT_LANGUAGE;
  if (LANGUAGE_CODE_SET.has(trimmed)) return trimmed;
  const fromLabel = LABEL_TO_CODE.get(trimmed.toLowerCase());
  if (fromLabel) return fromLabel;
  return DEFAULT_AGENT_LANGUAGE;
}
