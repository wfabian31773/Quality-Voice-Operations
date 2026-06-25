import { describe, it, expect } from 'vitest';

import {
  RECOMMENDED_VOICES_BY_LANGUAGE,
  getRecommendedVoicesForLanguage,
  isVoiceRecommendedForLanguage,
  getDefaultVoiceForLanguage,
  AGENT_LANGUAGES,
} from '../../client-app/src/lib/agentLanguages';
import { VOICES } from '../../client-app/src/lib/agentVoices';
import { VOICES as PICKER_VOICES } from '../../client-app/src/components/VoicePicker';

describe('voice/language recommendations', () => {
  it('has a recommendation list for every supported agent language', () => {
    for (const lang of AGENT_LANGUAGES) {
      const recs = RECOMMENDED_VOICES_BY_LANGUAGE[lang.code];
      expect(recs, `missing recommended voices for ${lang.code}`).toBeDefined();
      expect(recs!.length).toBeGreaterThan(0);
    }
  });

  it('every recommended voice exists in the canonical VOICES list', () => {
    const canonical = new Set<string>(VOICES);
    for (const [lang, recs] of Object.entries(RECOMMENDED_VOICES_BY_LANGUAGE)) {
      for (const voice of recs) {
        expect(
          canonical.has(voice),
          `voice "${voice}" recommended for "${lang}" is not in the canonical VOICES list (client-app/src/lib/agentVoices.ts). ` +
            `If OpenAI removed the voice, drop it from RECOMMENDED_VOICES_BY_LANGUAGE; if it's a typo, fix it.`,
        ).toBe(true);
      }
    }
  });

  it('VoicePicker re-exports the same canonical VOICES list (single source of truth)', () => {
    expect(PICKER_VOICES).toBe(VOICES);
  });

  it('canonical VOICES list has no duplicates', () => {
    expect(new Set(VOICES).size).toBe(VOICES.length);
  });

  it('falls back to English recommendations for unknown languages', () => {
    expect(getRecommendedVoicesForLanguage('xx')).toEqual(
      RECOMMENDED_VOICES_BY_LANGUAGE.en,
    );
  });

  it('isVoiceRecommendedForLanguage flags mismatched pairs', () => {
    expect(isVoiceRecommendedForLanguage('alloy', 'ja')).toBe(true);
    expect(isVoiceRecommendedForLanguage('fable', 'ja')).toBe(false);
    expect(isVoiceRecommendedForLanguage('onyx', 'zh')).toBe(false);
    expect(isVoiceRecommendedForLanguage('shimmer', 'es')).toBe(true);
  });

  it('treats empty voice as recommended (no warning before a voice is picked)', () => {
    expect(isVoiceRecommendedForLanguage('', 'ja')).toBe(true);
  });

  it('getDefaultVoiceForLanguage picks a voice from the recommended list', () => {
    for (const lang of AGENT_LANGUAGES) {
      const def = getDefaultVoiceForLanguage(lang.code);
      expect(getRecommendedVoicesForLanguage(lang.code)).toContain(def);
    }
  });

  it('non-Latin-script languages restrict recommendations to the broadly multilingual voices', () => {
    const restricted = ['zh', 'ja', 'ko', 'ar', 'hi'];
    for (const code of restricted) {
      const recs = getRecommendedVoicesForLanguage(code);
      // `marin` replaced `nova` here on 2026-06-25 after OpenAI dropped
      // nova from the Realtime GA catalog. Same broad-multilingual tier.
      expect(recs).toEqual(['alloy', 'marin', 'shimmer']);
    }
  });
});
