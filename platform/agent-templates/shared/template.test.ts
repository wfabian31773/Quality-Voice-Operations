import { describe, expect, expectTypeOf, it } from 'vitest';
import { readbackLang, type ReadbackLang } from '../../actions/scheduling/readback';
import type { SlotSpec } from '../../callcore/contracts';
import {
  AFTER_WRITE_BY_INTENT,
  TEMPLATE_LANGUAGES,
  fillPlaceholders,
  phraseAsk,
  templateKey,
  templateLanguage,
  type Phrase,
  type TemplateLanguage,
} from './index';

describe('shared agent-template types', () => {
  it('a Phrase is a contract defaultAsk, and its languages are the readback languages', () => {
    expectTypeOf<Phrase>().toEqualTypeOf<Readonly<SlotSpec['defaultAsk']>>();
    expectTypeOf<TemplateLanguage>().toEqualTypeOf<ReadbackLang>();
    expect(TEMPLATE_LANGUAGES).toEqual(['en', 'es']);
  });

  it('maps a locale to a language exactly as the action readbacks do', () => {
    for (const locale of [undefined, '', 'en', 'en-US', 'es', 'es-MX', 'ES', 'fr', 'pt-BR']) {
      expect(templateLanguage(locale), String(locale)).toBe(readbackLang(locale));
    }
  });

  it('fills known placeholders and leaves unknown ones', () => {
    expect(fillPlaceholders('Hi {{name}}, {{other}}', { name: 'Luis' })).toBe('Hi Luis, {{other}}');
  });

  it('phraseAsk returns undefined for an unphrased askId', () => {
    const t = { asks: { 'ask.x': { en: 'X?', es: '¿X?' } } };
    expect(phraseAsk(t, 'ask.x', 'es')).toBe('¿X?');
    expect(phraseAsk(t, 'ask.y', 'en')).toBeUndefined();
  });

  it('templateKey pins id@version', () => {
    expect(templateKey({ id: 'front-desk', version: 3 })).toBe('front-desk@3');
  });

  it('after-write lines are keyed by contract intent', () => {
    expect(AFTER_WRITE_BY_INTENT).toEqual({ book: 'booked', reschedule: 'rescheduled', cancel: 'cancelled' });
  });
});
