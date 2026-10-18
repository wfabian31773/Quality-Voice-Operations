/**
 * Shared shape of a runtime agent template (RT-08, moved here in RT-09 so
 * every vertical uses one type). A template is pure data: the persona and the
 * EN/ES phrasing for the askIds its contracts return, plus the lines spoken
 * after a write. The generic composer (platform/agent-runtime/composer) reads
 * it; nothing here names a vertical.
 *
 * A Phrase has the same shape as a contract slot's `defaultAsk`, so a
 * template line and a contract fallback are interchangeable, and its
 * languages are the ones the action readbacks speak (ReadbackLang).
 */
import type { SlotSpec } from '../../callcore/contracts';

export type Phrase = Readonly<SlotSpec['defaultAsk']>;

/** 'en' | 'es': the keys of a contract's defaultAsk. */
export type TemplateLanguage = keyof SlotSpec['defaultAsk'];

export const TEMPLATE_LANGUAGES: readonly TemplateLanguage[] = ['en', 'es'];

/**
 * Post-write lines. `{{readback}}` is the commit result's `readback`, exactly
 * as the server returned it; the template formats no date, time or name.
 */
export interface AfterWriteLines {
  booked: Phrase;
  rescheduled: Phrase;
  cancelled: Phrase;
  /** Said after any of the above while SMS is off. */
  textWillFollow: Phrase;
}

export type AfterWriteKey = Exclude<keyof AfterWriteLines, 'textWillFollow'>;

/** Which after-write line a contract's commit gets, by the contract's intent. */
export const AFTER_WRITE_BY_INTENT: Readonly<Record<string, AfterWriteKey>> = {
  book: 'booked',
  reschedule: 'rescheduled',
  cancel: 'cancelled',
};

export interface AgentTemplate {
  id: string;
  version: number;
  languages: readonly TemplateLanguage[];
  /** Contracts this template phrases, pinned as 'id@version'. */
  contracts: readonly string[];
  /** System text: who the agent is and how it talks. */
  persona: Phrase;
  /** Spoken first. `{{businessName}}` is the business's own name. */
  greeting: Phrase;
  /** askId → what the agent says when that slot is missing. */
  asks: Readonly<Record<string, Phrase>>;
  afterWrite: AfterWriteLines;
}

export function templateKey(template: Pick<AgentTemplate, 'id' | 'version'>): string {
  return `${template.id}@${template.version}`;
}

/** The template language for a locale ('es-MX' → 'es'); anything else is English, as in the action readbacks. */
export function templateLanguage(locale: string | null | undefined): TemplateLanguage {
  return locale?.trim().toLowerCase().startsWith('es') ? 'es' : 'en';
}

/** The template's phrasing for an askId, or undefined so the caller can fall back to the contract's defaultAsk. */
export function phraseAsk(template: Pick<AgentTemplate, 'asks'>, askId: string, language: TemplateLanguage): string | undefined {
  return template.asks[askId]?.[language];
}

/** Fills `{{name}}` placeholders; an unknown placeholder is left as is. */
export function fillPlaceholders(text: string, values: Readonly<Record<string, string>>): string {
  return text.replace(/\{\{(\w+)\}\}/g, (match, name: string) => values[name] ?? match);
}
