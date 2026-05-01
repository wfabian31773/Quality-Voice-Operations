import { getPlatformPool } from '../db';
import { VOICES } from '../../client-app/src/lib/agentVoices';
import {
  DEFAULT_CHECKLIST_LOCALE,
  type ChecklistLocale,
} from './ChecklistService';

export type FieldGroup = 'general' | 'voice' | 'workflow' | 'escalation' | 'knowledge';

export interface FieldSchema {
  key: string;
  label: string;
  type: 'text' | 'textarea' | 'select' | 'number' | 'toggle' | 'json';
  locked: boolean;
  lockReason?: string;
  options?: { value: string; label: string }[];
  group: FieldGroup;
  groupTitle: string;
}

export interface TemplateCustomizationSchema {
  customizableFields: FieldSchema[];
  lockedFields: FieldSchema[];
}

// Derived from the canonical `VOICES` list in `client-app/src/lib/agentVoices.ts`
// so adding/removing a voice there is reflected here automatically. Exported for
// the parity test in `tests/marketplace/customizationSchemaSupportedVoices.test.ts`.
export const VALID_VOICES: ReadonlySet<string> = new Set<string>(VOICES);

const VOICE_OPTIONS = VOICES.map((value) => ({
  value,
  label: value.charAt(0).toUpperCase() + value.slice(1),
}));

interface FieldShape {
  key: string;
  type: FieldSchema['type'];
  locked: boolean;
  group: FieldGroup;
  options?: { value: string; label: string }[];
}

const ALL_FIELD_SHAPES: FieldShape[] = [
  { key: 'name', type: 'text', locked: false, group: 'general' },
  { key: 'welcome_greeting', type: 'textarea', locked: false, group: 'general' },
  { key: 'business_details', type: 'textarea', locked: false, group: 'general' },
  { key: 'working_hours', type: 'json', locked: false, group: 'general' },
  { key: 'voice', type: 'select', locked: false, group: 'voice', options: VOICE_OPTIONS },
  { key: 'temperature', type: 'number', locked: false, group: 'general' },
  { key: 'escalation_config', type: 'json', locked: false, group: 'escalation' },
  { key: 'enabled_tools', type: 'json', locked: false, group: 'workflow' },
  { key: 'knowledge_base', type: 'json', locked: false, group: 'knowledge' },
  { key: 'type', type: 'text', locked: true, group: 'workflow' },
  { key: 'model', type: 'text', locked: true, group: 'workflow' },
  { key: 'system_prompt', type: 'textarea', locked: true, group: 'workflow' },
];

const ALL_FIELD_SHAPES_MAP = new Map(ALL_FIELD_SHAPES.map((f) => [f.key, f]));

/**
 * Localized labels for every well-known field key. Mirrors the
 * `CHECKLIST_STEP_TRANSLATIONS` pattern in `ChecklistService.ts` so the
 * Customize Agent tab renders parity copy across the five tenant locales.
 */
export const CUSTOMIZATION_FIELD_LABEL_TRANSLATIONS: Record<
  ChecklistLocale,
  Record<string, string>
> = {
  en: {
    name: 'Display Name',
    welcome_greeting: 'Greeting Message',
    business_details: 'Business Details',
    working_hours: 'Working Hours',
    voice: 'Voice Profile',
    temperature: 'Temperature',
    escalation_config: 'Escalation Contacts',
    enabled_tools: 'Enabled Optional Tools',
    knowledge_base: 'Knowledge Base Attachments',
    type: 'Agent Type',
    model: 'AI Model',
    system_prompt: 'System Prompt',
  },
  es: {
    name: 'Nombre para mostrar',
    welcome_greeting: 'Mensaje de saludo',
    business_details: 'Detalles del negocio',
    working_hours: 'Horario de atención',
    voice: 'Perfil de voz',
    temperature: 'Temperatura',
    escalation_config: 'Contactos de escalamiento',
    enabled_tools: 'Herramientas opcionales activadas',
    knowledge_base: 'Adjuntos de la base de conocimientos',
    type: 'Tipo de agente',
    model: 'Modelo de IA',
    system_prompt: 'Indicación del sistema',
  },
  'pt-BR': {
    name: 'Nome de exibição',
    welcome_greeting: 'Mensagem de saudação',
    business_details: 'Detalhes do negócio',
    working_hours: 'Horário de funcionamento',
    voice: 'Perfil de voz',
    temperature: 'Temperatura',
    escalation_config: 'Contatos de escalonamento',
    enabled_tools: 'Ferramentas opcionais ativadas',
    knowledge_base: 'Anexos da base de conhecimento',
    type: 'Tipo de agente',
    model: 'Modelo de IA',
    system_prompt: 'Prompt do sistema',
  },
  fr: {
    name: 'Nom d’affichage',
    welcome_greeting: 'Message d’accueil',
    business_details: 'Informations sur l’entreprise',
    working_hours: 'Heures d’ouverture',
    voice: 'Profil vocal',
    temperature: 'Température',
    escalation_config: 'Contacts d’escalade',
    enabled_tools: 'Outils facultatifs activés',
    knowledge_base: 'Pièces jointes de la base de connaissances',
    type: 'Type d’agent',
    model: 'Modèle d’IA',
    system_prompt: 'Invite système',
  },
  de: {
    name: 'Anzeigename',
    welcome_greeting: 'Begrüßungsnachricht',
    business_details: 'Geschäftsdetails',
    working_hours: 'Arbeitszeiten',
    voice: 'Stimmprofil',
    temperature: 'Temperatur',
    escalation_config: 'Eskalationskontakte',
    enabled_tools: 'Aktivierte optionale Tools',
    knowledge_base: 'Anhänge der Wissensdatenbank',
    type: 'Agententyp',
    model: 'KI-Modell',
    system_prompt: 'System-Prompt',
  },
};

/**
 * Localized lock reasons. Includes a `__default` fallback used when a
 * template manifest declares a custom locked field without its own
 * `lockReason` override.
 */
export const CUSTOMIZATION_LOCK_REASON_TRANSLATIONS: Record<
  ChecklistLocale,
  Record<string, string>
> = {
  en: {
    type: 'Set by template — changing the agent type would break workflow guardrails',
    model: 'Controlled by template to ensure consistent performance',
    system_prompt: 'Core prompt is managed by the template to maintain guardrails and compliance',
    __default: 'Controlled by template',
  },
  es: {
    type: 'Establecido por la plantilla; cambiar el tipo de agente rompería las protecciones del flujo',
    model: 'Controlado por la plantilla para garantizar un rendimiento constante',
    system_prompt:
      'La indicación principal es gestionada por la plantilla para mantener las protecciones y el cumplimiento',
    __default: 'Controlado por la plantilla',
  },
  'pt-BR': {
    type: 'Definido pelo modelo — alterar o tipo de agente romperia as proteções do fluxo',
    model: 'Controlado pelo modelo para garantir desempenho consistente',
    system_prompt:
      'O prompt principal é gerenciado pelo modelo para manter as proteções e a conformidade',
    __default: 'Controlado pelo modelo',
  },
  fr: {
    type: 'Défini par le modèle — modifier le type d’agent compromettrait les garde-fous du flux',
    model: 'Contrôlé par le modèle pour garantir des performances constantes',
    system_prompt:
      'L’invite principale est gérée par le modèle pour maintenir les garde-fous et la conformité',
    __default: 'Contrôlé par le modèle',
  },
  de: {
    type: 'Durch die Vorlage festgelegt — eine Änderung des Agententyps würde die Workflow-Schutzmaßnahmen aufheben',
    model: 'Wird von der Vorlage gesteuert, um eine gleichbleibende Leistung zu gewährleisten',
    system_prompt:
      'Der Kern-Prompt wird von der Vorlage verwaltet, um Schutzmaßnahmen und Compliance zu gewährleisten',
    __default: 'Durch die Vorlage gesteuert',
  },
};

/**
 * Localized titles for the field groups rendered as section headings on
 * the Customize Agent tab.
 */
export const CUSTOMIZATION_GROUP_TITLE_TRANSLATIONS: Record<
  ChecklistLocale,
  Record<FieldGroup, string>
> = {
  en: {
    general: 'General',
    voice: 'Voice',
    workflow: 'Workflow',
    escalation: 'Escalation',
    knowledge: 'Knowledge',
  },
  es: {
    general: 'General',
    voice: 'Voz',
    workflow: 'Flujo de trabajo',
    escalation: 'Escalamiento',
    knowledge: 'Conocimiento',
  },
  'pt-BR': {
    general: 'Geral',
    voice: 'Voz',
    workflow: 'Fluxo de trabalho',
    escalation: 'Escalonamento',
    knowledge: 'Conhecimento',
  },
  fr: {
    general: 'Général',
    voice: 'Voix',
    workflow: 'Flux de travail',
    escalation: 'Escalade',
    knowledge: 'Connaissances',
  },
  de: {
    general: 'Allgemein',
    voice: 'Stimme',
    workflow: 'Workflow',
    escalation: 'Eskalation',
    knowledge: 'Wissen',
  },
};

/** Look up a localized field label, falling back to English then the raw key. */
export function getCustomizationFieldLabel(locale: ChecklistLocale, key: string): string {
  return (
    CUSTOMIZATION_FIELD_LABEL_TRANSLATIONS[locale]?.[key] ??
    CUSTOMIZATION_FIELD_LABEL_TRANSLATIONS[DEFAULT_CHECKLIST_LOCALE][key] ??
    key
  );
}

/** Look up a localized lock reason, falling back to the per-locale default. */
export function getCustomizationLockReason(locale: ChecklistLocale, key: string): string {
  const table = CUSTOMIZATION_LOCK_REASON_TRANSLATIONS[locale] ??
    CUSTOMIZATION_LOCK_REASON_TRANSLATIONS[DEFAULT_CHECKLIST_LOCALE];
  return table[key] ?? table.__default ??
    CUSTOMIZATION_LOCK_REASON_TRANSLATIONS[DEFAULT_CHECKLIST_LOCALE].__default;
}

/** Look up a localized group title, falling back to English then the group key. */
export function getCustomizationGroupTitle(locale: ChecklistLocale, group: FieldGroup): string {
  return (
    CUSTOMIZATION_GROUP_TITLE_TRANSLATIONS[locale]?.[group] ??
    CUSTOMIZATION_GROUP_TITLE_TRANSLATIONS[DEFAULT_CHECKLIST_LOCALE][group] ??
    group
  );
}

interface ConfigSchemaField {
  key: string;
  locked?: boolean;
  lockReason?: string;
  label?: string;
  type?: string;
  group?: string;
}

interface ConfigSchemaManifest {
  customizable?: string[] | ConfigSchemaField[];
  locked?: string[] | ConfigSchemaField[];
}

interface FieldOverrides {
  label?: string;
  lockReason?: string;
  type?: FieldSchema['type'];
  group?: FieldGroup;
}

function normalizeField(entry: string | ConfigSchemaField): { key: string; overrides: FieldOverrides } {
  if (typeof entry === 'string') return { key: entry, overrides: {} };
  return {
    key: entry.key,
    overrides: {
      ...(entry.lockReason ? { lockReason: entry.lockReason } : {}),
      ...(entry.label ? { label: entry.label } : {}),
      ...(entry.type ? { type: entry.type as FieldSchema['type'] } : {}),
      ...(entry.group ? { group: entry.group as FieldGroup } : {}),
    },
  };
}

const DEFAULT_CUSTOMIZABLE_KEYS = new Set([
  'name', 'welcome_greeting', 'business_details', 'voice', 'temperature',
  'escalation_config', 'enabled_tools', 'knowledge_base', 'working_hours',
]);

const DEFAULT_LOCKED_KEYS = new Set(['type', 'model', 'system_prompt']);

function buildCustomizableField(
  shape: FieldShape,
  overrides: FieldOverrides,
  locale: ChecklistLocale,
): FieldSchema {
  const group = overrides.group ?? shape.group;
  return {
    key: shape.key,
    type: overrides.type ?? shape.type,
    locked: false,
    group,
    groupTitle: getCustomizationGroupTitle(locale, group),
    label: overrides.label ?? getCustomizationFieldLabel(locale, shape.key),
    ...(shape.options ? { options: shape.options } : {}),
  };
}

function buildLockedField(
  shape: FieldShape,
  overrides: FieldOverrides,
  locale: ChecklistLocale,
): FieldSchema {
  const group = overrides.group ?? shape.group;
  return {
    key: shape.key,
    type: overrides.type ?? shape.type,
    locked: true,
    group,
    groupTitle: getCustomizationGroupTitle(locale, group),
    label: overrides.label ?? getCustomizationFieldLabel(locale, shape.key),
    lockReason: overrides.lockReason ?? getCustomizationLockReason(locale, shape.key),
    ...(shape.options ? { options: shape.options } : {}),
  };
}

function buildAdHocCustomizable(
  key: string,
  overrides: FieldOverrides,
  locale: ChecklistLocale,
): FieldSchema {
  const group = overrides.group ?? 'general';
  return {
    key,
    label: overrides.label ?? getCustomizationFieldLabel(locale, key),
    type: overrides.type ?? 'text',
    locked: false,
    group,
    groupTitle: getCustomizationGroupTitle(locale, group),
  };
}

function buildAdHocLocked(
  key: string,
  overrides: FieldOverrides,
  locale: ChecklistLocale,
): FieldSchema {
  const group = overrides.group ?? 'workflow';
  return {
    key,
    label: overrides.label ?? getCustomizationFieldLabel(locale, key),
    type: overrides.type ?? 'text',
    locked: true,
    lockReason: overrides.lockReason ?? getCustomizationLockReason(locale, key),
    group,
    groupTitle: getCustomizationGroupTitle(locale, group),
  };
}

export function buildCustomizationSchema(
  configSchema: ConfigSchemaManifest | null | undefined,
  locale: ChecklistLocale = DEFAULT_CHECKLIST_LOCALE,
): TemplateCustomizationSchema {
  if (!configSchema || (typeof configSchema !== 'object')) {
    const customizableFields = ALL_FIELD_SHAPES
      .filter((f) => DEFAULT_CUSTOMIZABLE_KEYS.has(f.key))
      .map((shape) => buildCustomizableField(shape, {}, locale));
    const lockedFields = ALL_FIELD_SHAPES
      .filter((f) => DEFAULT_LOCKED_KEYS.has(f.key))
      .map((shape) => buildLockedField(shape, {}, locale));
    return { customizableFields, lockedFields };
  }

  const customizableEntries = (configSchema.customizable ?? []).map(normalizeField);
  const lockedEntries = (configSchema.locked ?? []).map(normalizeField);

  const explicitCustomizable = new Set(customizableEntries.map((e) => e.key));
  const explicitLocked = new Set(lockedEntries.map((e) => e.key));

  const customizableFields: FieldSchema[] = [];
  const lockedFields: FieldSchema[] = [];

  for (const entry of customizableEntries) {
    const base = ALL_FIELD_SHAPES_MAP.get(entry.key);
    if (base) {
      customizableFields.push(buildCustomizableField(base, entry.overrides, locale));
    } else {
      customizableFields.push(buildAdHocCustomizable(entry.key, entry.overrides, locale));
    }
  }

  for (const entry of lockedEntries) {
    const base = ALL_FIELD_SHAPES_MAP.get(entry.key);
    if (base) {
      lockedFields.push(buildLockedField(base, entry.overrides, locale));
    } else {
      lockedFields.push(buildAdHocLocked(entry.key, entry.overrides, locale));
    }
  }

  for (const shape of ALL_FIELD_SHAPES) {
    if (explicitCustomizable.has(shape.key) || explicitLocked.has(shape.key)) continue;
    if (DEFAULT_LOCKED_KEYS.has(shape.key)) {
      lockedFields.push(buildLockedField(shape, {}, locale));
    } else if (DEFAULT_CUSTOMIZABLE_KEYS.has(shape.key)) {
      customizableFields.push(buildCustomizableField(shape, {}, locale));
    }
  }

  return { customizableFields, lockedFields };
}

export async function getCustomizationSchemaForTemplate(
  templateId: string,
  locale: ChecklistLocale = DEFAULT_CHECKLIST_LOCALE,
): Promise<{
  schema: TemplateCustomizationSchema;
  configSchema: ConfigSchemaManifest | null;
}> {
  const pool = getPlatformPool();
  const { rows } = await pool.query(
    `SELECT config_schema FROM template_registry WHERE id = $1`,
    [templateId],
  );

  const configSchema = rows.length > 0 ? (rows[0].config_schema as ConfigSchemaManifest | null) : null;
  const schema = buildCustomizationSchema(configSchema, locale);
  return { schema, configSchema };
}

export function getCustomizableFieldKeys(configSchema: ConfigSchemaManifest | null | undefined): Set<string> {
  // Locale doesn't affect which keys are customizable, only labels, so use the
  // default to avoid forcing callers to thread a locale they don't care about.
  const schema = buildCustomizationSchema(configSchema);
  return new Set(schema.customizableFields.map((f) => f.key));
}

export function validateCustomizationUpdate(
  configSchema: ConfigSchemaManifest | null | undefined,
  updates: Record<string, unknown>,
): { valid: boolean; rejectedFields: string[]; valueErrors: string[] } {
  const allowedKeys = getCustomizableFieldKeys(configSchema);
  const rejectedFields: string[] = [];
  const valueErrors: string[] = [];

  for (const key of Object.keys(updates)) {
    if (!allowedKeys.has(key)) {
      rejectedFields.push(key);
      continue;
    }

    const val = updates[key];

    if (key === 'name') {
      if (typeof val !== 'string' || val.trim().length === 0) {
        valueErrors.push('name must be a non-empty string');
      } else if (val.length > 255) {
        valueErrors.push('name must be 255 characters or fewer');
      }
    }

    if (key === 'welcome_greeting') {
      if (val !== null && typeof val !== 'string') {
        valueErrors.push('welcome_greeting must be a string or null');
      } else if (typeof val === 'string' && val.length > 2000) {
        valueErrors.push('welcome_greeting must be 2000 characters or fewer');
      }
    }

    if (key === 'voice') {
      if (typeof val !== 'string' || !VALID_VOICES.has(val)) {
        valueErrors.push(`voice must be one of: ${[...VALID_VOICES].join(', ')}`);
      }
    }

    if (key === 'temperature') {
      const num = Number(val);
      if (typeof val !== 'number' || isNaN(num) || num < 0 || num > 1) {
        valueErrors.push('temperature must be a number between 0 and 1');
      }
    }

    if (key === 'escalation_config' || key === 'working_hours' || key === 'enabled_tools' || key === 'knowledge_base') {
      if (val !== null && typeof val !== 'object') {
        valueErrors.push(`${key} must be a JSON object/array or null`);
      }
    }

    if (key === 'business_details') {
      if (val !== null && typeof val !== 'string') {
        valueErrors.push('business_details must be a string or null');
      } else if (typeof val === 'string' && val.length > 5000) {
        valueErrors.push('business_details must be 5000 characters or fewer');
      }
    }
  }

  return {
    valid: rejectedFields.length === 0 && valueErrors.length === 0,
    rejectedFields,
    valueErrors,
  };
}
