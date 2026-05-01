import { describe, it, expect } from 'vitest';

import {
  SUPPORTED_CHECKLIST_LOCALES,
  type ChecklistLocale,
} from '../../platform/marketplace/ChecklistService';
import {
  CUSTOMIZATION_FIELD_LABEL_TRANSLATIONS,
  CUSTOMIZATION_GROUP_TITLE_TRANSLATIONS,
  CUSTOMIZATION_LOCK_REASON_TRANSLATIONS,
  buildCustomizationSchema,
  getCustomizationFieldLabel,
  getCustomizationGroupTitle,
  getCustomizationLockReason,
  type FieldGroup,
} from '../../platform/marketplace/CustomizationSchema';

const FIELD_KEYS = [
  'name',
  'welcome_greeting',
  'business_details',
  'working_hours',
  'voice',
  'temperature',
  'escalation_config',
  'enabled_tools',
  'knowledge_base',
  'type',
  'model',
  'system_prompt',
] as const;

const LOCKED_KEYS = ['type', 'model', 'system_prompt'] as const;

const GROUP_KEYS: FieldGroup[] = ['general', 'voice', 'workflow', 'escalation', 'knowledge'];

const NON_ENGLISH_LOCALES: ChecklistLocale[] = ['es', 'pt-BR', 'fr', 'de'];

describe('marketplace CustomizationSchema translation parity', () => {
  it('every supported locale defines a label for every field key', () => {
    for (const locale of SUPPORTED_CHECKLIST_LOCALES) {
      const table = CUSTOMIZATION_FIELD_LABEL_TRANSLATIONS[locale];
      expect(table, `missing label table for locale "${locale}"`).toBeTruthy();

      for (const key of FIELD_KEYS) {
        const entry = table[key];
        expect(typeof entry, `label for ${locale}/${key} must be a string`).toBe('string');
        expect(entry.trim().length, `label for ${locale}/${key} must not be blank`).toBeGreaterThan(0);
      }
    }
  });

  it('every supported locale defines a lock reason for every locked key plus a default fallback', () => {
    for (const locale of SUPPORTED_CHECKLIST_LOCALES) {
      const table = CUSTOMIZATION_LOCK_REASON_TRANSLATIONS[locale];
      expect(table, `missing lock-reason table for locale "${locale}"`).toBeTruthy();

      for (const key of LOCKED_KEYS) {
        const entry = table[key];
        expect(typeof entry, `lock reason for ${locale}/${key} must be a string`).toBe('string');
        expect(entry.trim().length, `lock reason for ${locale}/${key} must not be blank`).toBeGreaterThan(0);
      }

      expect(typeof table.__default, `default lock reason for "${locale}" must be a string`).toBe('string');
      expect(table.__default.trim().length, `default lock reason for "${locale}" must not be blank`).toBeGreaterThan(0);
    }
  });

  it('every supported locale defines a title for every group', () => {
    for (const locale of SUPPORTED_CHECKLIST_LOCALES) {
      const table = CUSTOMIZATION_GROUP_TITLE_TRANSLATIONS[locale];
      expect(table, `missing group-title table for locale "${locale}"`).toBeTruthy();

      for (const group of GROUP_KEYS) {
        const entry = table[group];
        expect(typeof entry, `group title for ${locale}/${group} must be a string`).toBe('string');
        expect(entry.trim().length, `group title for ${locale}/${group} must not be blank`).toBeGreaterThan(0);
      }
    }
  });

  it('non-English locales actually translate the field labels (no English leakage)', () => {
    const englishLabels = new Set(FIELD_KEYS.map((k) => CUSTOMIZATION_FIELD_LABEL_TRANSLATIONS.en[k]));

    for (const locale of NON_ENGLISH_LOCALES) {
      for (const key of FIELD_KEYS) {
        const localized = CUSTOMIZATION_FIELD_LABEL_TRANSLATIONS[locale][key];
        expect(
          englishLabels.has(localized),
          `locale "${locale}" field "${key}" still uses the English label "${localized}"`,
        ).toBe(false);
      }
    }
  });

  it('non-English locales actually translate the lock reasons (no English leakage)', () => {
    const englishReasons = new Set(
      LOCKED_KEYS.map((k) => CUSTOMIZATION_LOCK_REASON_TRANSLATIONS.en[k]).concat(
        CUSTOMIZATION_LOCK_REASON_TRANSLATIONS.en.__default,
      ),
    );

    for (const locale of NON_ENGLISH_LOCALES) {
      for (const key of [...LOCKED_KEYS, '__default'] as const) {
        const localized = CUSTOMIZATION_LOCK_REASON_TRANSLATIONS[locale][key];
        expect(
          englishReasons.has(localized),
          `locale "${locale}" lock reason "${key}" still uses the English copy "${localized}"`,
        ).toBe(false);
      }
    }
  });
});

describe('marketplace CustomizationSchema getCustomizationFieldLabel', () => {
  it('returns the matching translation for a known locale (Spanish)', () => {
    expect(getCustomizationFieldLabel('es', 'voice')).toBe('Perfil de voz');
    expect(getCustomizationFieldLabel('es', 'system_prompt')).toBe('Indicación del sistema');
  });

  it('returns the matching translation for German', () => {
    expect(getCustomizationFieldLabel('de', 'name')).toBe('Anzeigename');
    expect(getCustomizationFieldLabel('de', 'model')).toBe('KI-Modell');
  });

  it('returns the matching translation for Brazilian Portuguese', () => {
    expect(getCustomizationFieldLabel('pt-BR', 'welcome_greeting')).toBe('Mensagem de saudação');
    expect(getCustomizationFieldLabel('pt-BR', 'knowledge_base')).toBe('Anexos da base de conhecimento');
  });

  it('returns the matching translation for French', () => {
    expect(getCustomizationFieldLabel('fr', 'temperature')).toBe('Température');
    expect(getCustomizationFieldLabel('fr', 'escalation_config')).toBe('Contacts d’escalade');
  });

  it('falls back to the raw key when neither the locale nor English have it', () => {
    expect(getCustomizationFieldLabel('es', 'never_seen_before')).toBe('never_seen_before');
  });
});

describe('marketplace CustomizationSchema getCustomizationLockReason', () => {
  it('returns the matching translation for a known locked key (German)', () => {
    expect(getCustomizationLockReason('de', 'system_prompt')).toBe(
      'Der Kern-Prompt wird von der Vorlage verwaltet, um Schutzmaßnahmen und Compliance zu gewährleisten',
    );
  });

  it('falls back to the per-locale default for unknown locked keys', () => {
    expect(getCustomizationLockReason('es', 'some_custom_locked_field')).toBe(
      'Controlado por la plantilla',
    );
    expect(getCustomizationLockReason('fr', 'some_custom_locked_field')).toBe(
      'Contrôlé par le modèle',
    );
  });
});

describe('marketplace CustomizationSchema getCustomizationGroupTitle', () => {
  it('returns the matching translation for a known locale (French)', () => {
    expect(getCustomizationGroupTitle('fr', 'workflow')).toBe('Flux de travail');
    expect(getCustomizationGroupTitle('fr', 'voice')).toBe('Voix');
  });

  it('returns the matching translation for German', () => {
    expect(getCustomizationGroupTitle('de', 'escalation')).toBe('Eskalation');
    expect(getCustomizationGroupTitle('de', 'knowledge')).toBe('Wissen');
  });
});

describe('marketplace buildCustomizationSchema with non-English locale', () => {
  it('renders default-schema field labels in Spanish', () => {
    const schema = buildCustomizationSchema(null, 'es');
    const byKey = new Map(
      [...schema.customizableFields, ...schema.lockedFields].map((f) => [f.key, f]),
    );

    expect(byKey.get('name')?.label).toBe('Nombre para mostrar');
    expect(byKey.get('voice')?.label).toBe('Perfil de voz');
    expect(byKey.get('system_prompt')?.label).toBe('Indicación del sistema');
  });

  it('renders default-schema lock reasons in Spanish', () => {
    const schema = buildCustomizationSchema(null, 'es');
    const byKey = new Map(schema.lockedFields.map((f) => [f.key, f]));

    expect(byKey.get('type')?.lockReason).toBe(
      'Establecido por la plantilla; cambiar el tipo de agente rompería las protecciones del flujo',
    );
    expect(byKey.get('model')?.lockReason).toBe(
      'Controlado por la plantilla para garantizar un rendimiento constante',
    );
  });

  it('attaches the localized group title to every field', () => {
    const schema = buildCustomizationSchema(null, 'pt-BR');
    const fields = [...schema.customizableFields, ...schema.lockedFields];

    for (const field of fields) {
      const expected = CUSTOMIZATION_GROUP_TITLE_TRANSLATIONS['pt-BR'][field.group];
      expect(field.groupTitle, `field "${field.key}" should carry localized group title`).toBe(expected);
    }
  });

  it('honours per-field manifest overrides while still localizing the rest', () => {
    const schema = buildCustomizationSchema(
      {
        customizable: [
          { key: 'name', label: 'Custom Display Name From Template' },
          'voice',
        ],
        locked: [
          { key: 'system_prompt', lockReason: 'Custom lock reason from template' },
          'model',
        ],
      },
      'fr',
    );

    const customizableByKey = new Map(schema.customizableFields.map((f) => [f.key, f]));
    expect(customizableByKey.get('name')?.label).toBe('Custom Display Name From Template');
    // Voice has no override → falls back to the localized label.
    expect(customizableByKey.get('voice')?.label).toBe('Profil vocal');

    const lockedByKey = new Map(schema.lockedFields.map((f) => [f.key, f]));
    expect(lockedByKey.get('system_prompt')?.lockReason).toBe('Custom lock reason from template');
    // Model has no override → falls back to the localized lock reason.
    expect(lockedByKey.get('model')?.lockReason).toBe(
      'Contrôlé par le modèle pour garantir des performances constantes',
    );
    // Group title still localized.
    expect(lockedByKey.get('model')?.groupTitle).toBe('Flux de travail');
  });

  it('preserves unknown manifest-declared group values and still attaches the localized group title', () => {
    const schema = buildCustomizationSchema(
      {
        customizable: [
          // Unknown group value coming from a template manifest.
          { key: 'custom_field', label: 'Custom field', group: 'compliance' as unknown as FieldGroup },
        ],
      },
      'es',
    );

    const customField = schema.customizableFields.find((f) => f.key === 'custom_field');
    expect(customField).toBeDefined();
    expect(customField?.group).toBe('compliance');
    // No translation entry for this group → falls back to the group key itself
    // rather than being silently dropped.
    expect(customField?.groupTitle).toBe('compliance');
  });

  it('defaults to English when no locale is supplied (backward compatibility)', () => {
    const schema = buildCustomizationSchema(null);
    const byKey = new Map(
      [...schema.customizableFields, ...schema.lockedFields].map((f) => [f.key, f]),
    );

    expect(byKey.get('name')?.label).toBe('Display Name');
    expect(byKey.get('system_prompt')?.lockReason).toBe(
      'Core prompt is managed by the template to maintain guardrails and compliance',
    );
    expect(byKey.get('voice')?.groupTitle).toBe('Voice');
  });
});
