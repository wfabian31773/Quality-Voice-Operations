import { describe, it, expect } from 'vitest';

import {
  CHECKLIST_STEP_TRANSLATIONS,
  DEFAULT_CHECKLIST_LOCALE,
  SUPPORTED_CHECKLIST_LOCALES,
  getChecklistStepCopy,
  normalizeChecklistLocale,
  type ChecklistLocale,
} from '../../platform/marketplace/ChecklistService';

const STEP_KEYS = [
  'assign_phone',
  'enable_widget',
  'attach_knowledge',
  'customize_greeting',
  'test_call',
  'publish_agent',
] as const;

describe('marketplace ChecklistService locale normalization', () => {
  it('exposes the five supported tenant-portal locales', () => {
    expect([...SUPPORTED_CHECKLIST_LOCALES]).toEqual(['en', 'es', 'pt-BR', 'fr', 'de']);
    expect(DEFAULT_CHECKLIST_LOCALE).toBe('en');
  });

  it('returns the default locale for empty / null / unknown input', () => {
    expect(normalizeChecklistLocale(undefined)).toBe('en');
    expect(normalizeChecklistLocale(null)).toBe('en');
    expect(normalizeChecklistLocale('')).toBe('en');
    expect(normalizeChecklistLocale('   ')).toBe('en');
    expect(normalizeChecklistLocale('klingon')).toBe('en');
    expect(normalizeChecklistLocale('zh-CN')).toBe('en');
  });

  it('returns exact-match locales as-is', () => {
    for (const code of SUPPORTED_CHECKLIST_LOCALES) {
      expect(normalizeChecklistLocale(code)).toBe(code);
    }
  });

  it('matches case-insensitively (e.g. pt-br → pt-BR, EN → en)', () => {
    expect(normalizeChecklistLocale('pt-br')).toBe('pt-BR');
    expect(normalizeChecklistLocale('PT-BR')).toBe('pt-BR');
    expect(normalizeChecklistLocale('EN')).toBe('en');
  });

  it('maps regional variants to the closest supported locale', () => {
    expect(normalizeChecklistLocale('en-US')).toBe('en');
    expect(normalizeChecklistLocale('en-GB')).toBe('en');
    expect(normalizeChecklistLocale('es-MX')).toBe('es');
    expect(normalizeChecklistLocale('fr-CA')).toBe('fr');
    expect(normalizeChecklistLocale('de-AT')).toBe('de');
    expect(normalizeChecklistLocale('pt-PT')).toBe('pt-BR');
    expect(normalizeChecklistLocale('pt')).toBe('pt-BR');
  });
});

describe('marketplace ChecklistService translation parity', () => {
  it('every supported locale defines a label + description for every step', () => {
    for (const locale of SUPPORTED_CHECKLIST_LOCALES) {
      const table = CHECKLIST_STEP_TRANSLATIONS[locale];
      expect(table, `missing translation table for locale "${locale}"`).toBeTruthy();

      for (const key of STEP_KEYS) {
        const entry = table[key];
        expect(entry, `locale "${locale}" missing entry for step "${key}"`).toBeTruthy();
        expect(typeof entry.label, `label for ${locale}/${key} must be a string`).toBe('string');
        expect(typeof entry.description, `description for ${locale}/${key} must be a string`).toBe('string');
        expect(entry.label.trim().length, `label for ${locale}/${key} must not be blank`).toBeGreaterThan(0);
        expect(entry.description.trim().length, `description for ${locale}/${key} must not be blank`).toBeGreaterThan(0);
      }
    }
  });

  it('non-English locales actually translate the step copy (no English leakage)', () => {
    const englishLabels = new Set(STEP_KEYS.map((k) => CHECKLIST_STEP_TRANSLATIONS.en[k].label));
    const nonEnglishLocales: ChecklistLocale[] = ['es', 'pt-BR', 'fr', 'de'];

    for (const locale of nonEnglishLocales) {
      for (const key of STEP_KEYS) {
        const localized = CHECKLIST_STEP_TRANSLATIONS[locale][key].label;
        expect(
          englishLabels.has(localized),
          `locale "${locale}" step "${key}" still uses the English label "${localized}"`,
        ).toBe(false);
      }
    }
  });
});

describe('marketplace ChecklistService getChecklistStepCopy', () => {
  it('returns the matching translation for a known locale (Spanish)', () => {
    const copy = getChecklistStepCopy('es', 'assign_phone');
    expect(copy.label).toBe('Asignar número de teléfono');
    expect(copy.description).toBe(
      'Vincula un número de teléfono a tu agente para que pueda recibir llamadas',
    );
  });

  it('returns the matching translation for German', () => {
    const copy = getChecklistStepCopy('de', 'enable_widget');
    expect(copy.label).toBe('Web-Widget aktivieren');
    expect(copy.description).toBe(
      'Richten Sie ein Chat- oder Sprach-Widget für Ihre Website ein',
    );
  });

  it('returns the matching translation for Brazilian Portuguese', () => {
    const copy = getChecklistStepCopy('pt-BR', 'publish_agent');
    expect(copy.label).toBe('Publicar agente');
    expect(copy.description).toBe('Ative seu agente e comece a atender chamadas reais');
  });

  it('returns the matching translation for French', () => {
    const copy = getChecklistStepCopy('fr', 'test_call');
    expect(copy.label).toBe('Lancer un appel de test');
    expect(copy.description).toBe(
      'Passez un appel de test pour vérifier que votre agent fonctionne correctement',
    );
  });

  it('falls back to a safe placeholder when the step key is unknown', () => {
    const copy = getChecklistStepCopy('es', 'never_seen_before');
    expect(copy.label).toBe('never_seen_before');
    expect(copy.description).toBe('');
  });
});
