import { describe, it, expect } from 'vitest';

import {
  RECOMMENDED_VOICES_BY_LANGUAGE,
  getRecommendedVoicesForLanguage,
  isVoiceRecommendedForLanguage,
  getDefaultVoiceForLanguage,
  AGENT_LANGUAGES,
} from '../../client-app/src/lib/agentLanguages';

describe('voice/language recommendations', () => {
  it('has a recommendation list for every supported agent language', () => {
    for (const lang of AGENT_LANGUAGES) {
      const recs = RECOMMENDED_VOICES_BY_LANGUAGE[lang.code];
      expect(recs, `missing recommended voices for ${lang.code}`).toBeDefined();
      expect(recs!.length).toBeGreaterThan(0);
    }
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
      expect(recs).toEqual(['alloy', 'nova', 'shimmer']);
    }
  });
});
