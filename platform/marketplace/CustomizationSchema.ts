import { getPlatformPool } from '../db';

export interface FieldSchema {
  key: string;
  label: string;
  type: 'text' | 'textarea' | 'select' | 'number' | 'toggle' | 'json';
  locked: boolean;
  lockReason?: string;
  options?: { value: string; label: string }[];
  group: 'general' | 'voice' | 'workflow' | 'escalation' | 'knowledge';
}

export interface TemplateCustomizationSchema {
  customizableFields: FieldSchema[];
  lockedFields: FieldSchema[];
}

const VALID_VOICES = new Set([
  'alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'onyx', 'nova', 'sage', 'shimmer', 'verse',
]);

const VOICE_OPTIONS = [
  { value: 'alloy', label: 'Alloy' }, { value: 'ash', label: 'Ash' }, { value: 'ballad', label: 'Ballad' },
  { value: 'coral', label: 'Coral' }, { value: 'echo', label: 'Echo' }, { value: 'fable', label: 'Fable' },
  { value: 'onyx', label: 'Onyx' }, { value: 'nova', label: 'Nova' }, { value: 'sage', label: 'Sage' },
  { value: 'shimmer', label: 'Shimmer' }, { value: 'verse', label: 'Verse' },
];

const ALL_FIELDS: FieldSchema[] = [
  { key: 'name', label: 'Display Name', type: 'text', locked: false, group: 'general' },
  { key: 'welcome_greeting', label: 'Greeting Message', type: 'textarea', locked: false, group: 'general' },
  { key: 'business_details', label: 'Business Details', type: 'textarea', locked: false, group: 'general' },
  { key: 'working_hours', label: 'Working Hours', type: 'json', locked: false, group: 'general' },
  { key: 'voice', label: 'Voice Profile', type: 'select', locked: false, group: 'voice', options: VOICE_OPTIONS },
  { key: 'temperature', label: 'Temperature', type: 'number', locked: false, group: 'general' },
  { key: 'escalation_config', label: 'Escalation Contacts', type: 'json', locked: false, group: 'escalation' },
  { key: 'enabled_tools', label: 'Enabled Optional Tools', type: 'json', locked: false, group: 'workflow' },
  { key: 'knowledge_base', label: 'Knowledge Base Attachments', type: 'json', locked: false, group: 'knowledge' },
  { key: 'type', label: 'Agent Type', type: 'text', locked: true, lockReason: 'Set by template — changing the agent type would break workflow guardrails', group: 'workflow' },
  { key: 'model', label: 'AI Model', type: 'text', locked: true, lockReason: 'Controlled by template to ensure consistent performance', group: 'workflow' },
  { key: 'system_prompt', label: 'System Prompt', type: 'textarea', locked: true, lockReason: 'Core prompt is managed by the template to maintain guardrails and compliance', group: 'workflow' },
];

const ALL_FIELDS_MAP = new Map(ALL_FIELDS.map((f) => [f.key, f]));

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

function normalizeField(entry: string | ConfigSchemaField): { key: string; overrides: Partial<FieldSchema> } {
  if (typeof entry === 'string') return { key: entry, overrides: {} };
  return {
    key: entry.key,
    overrides: {
      ...(entry.lockReason ? { lockReason: entry.lockReason } : {}),
      ...(entry.label ? { label: entry.label } : {}),
      ...(entry.type ? { type: entry.type as FieldSchema['type'] } : {}),
      ...(entry.group ? { group: entry.group as FieldSchema['group'] } : {}),
    },
  };
}

const DEFAULT_CUSTOMIZABLE_KEYS = new Set([
  'name', 'welcome_greeting', 'business_details', 'voice', 'temperature',
  'escalation_config', 'enabled_tools', 'knowledge_base', 'working_hours',
]);

const DEFAULT_LOCKED_KEYS = new Set(['type', 'model', 'system_prompt']);

export function buildCustomizationSchema(configSchema: ConfigSchemaManifest | null | undefined): TemplateCustomizationSchema {
  if (!configSchema || (typeof configSchema !== 'object')) {
    const customizableFields = ALL_FIELDS.filter((f) => DEFAULT_CUSTOMIZABLE_KEYS.has(f.key));
    const lockedFields = ALL_FIELDS.filter((f) => DEFAULT_LOCKED_KEYS.has(f.key)).map((f) => ({ ...f, locked: true as const }));
    return { customizableFields, lockedFields };
  }

  const customizableEntries = (configSchema.customizable ?? []).map(normalizeField);
  const lockedEntries = (configSchema.locked ?? []).map(normalizeField);

  const explicitCustomizable = new Set(customizableEntries.map((e) => e.key));
  const explicitLocked = new Set(lockedEntries.map((e) => e.key));

  const customizableFields: FieldSchema[] = [];
  const lockedFields: FieldSchema[] = [];

  for (const entry of customizableEntries) {
    const base = ALL_FIELDS_MAP.get(entry.key);
    if (base) {
      customizableFields.push({ ...base, ...entry.overrides, locked: false });
    } else {
      customizableFields.push({
        key: entry.key,
        label: entry.overrides.label ?? entry.key,
        type: entry.overrides.type ?? 'text',
        locked: false,
        group: entry.overrides.group ?? 'general',
      } as FieldSchema);
    }
  }

  for (const entry of lockedEntries) {
    const base = ALL_FIELDS_MAP.get(entry.key);
    if (base) {
      lockedFields.push({
        ...base,
        ...entry.overrides,
        locked: true,
        lockReason: entry.overrides.lockReason ?? base.lockReason ?? 'Controlled by template',
      });
    } else {
      lockedFields.push({
        key: entry.key,
        label: entry.overrides.label ?? entry.key,
        type: entry.overrides.type ?? 'text',
        locked: true,
        lockReason: entry.overrides.lockReason ?? 'Controlled by template',
        group: entry.overrides.group ?? 'workflow',
      } as FieldSchema);
    }
  }

  for (const field of ALL_FIELDS) {
    if (explicitCustomizable.has(field.key) || explicitLocked.has(field.key)) continue;
    if (DEFAULT_LOCKED_KEYS.has(field.key)) {
      lockedFields.push({ ...field, locked: true });
    } else if (DEFAULT_CUSTOMIZABLE_KEYS.has(field.key)) {
      customizableFields.push({ ...field, locked: false });
    }
  }

  return { customizableFields, lockedFields };
}

export async function getCustomizationSchemaForTemplate(templateId: string): Promise<{
  schema: TemplateCustomizationSchema;
  configSchema: ConfigSchemaManifest | null;
}> {
  const pool = getPlatformPool();
  const { rows } = await pool.query(
    `SELECT config_schema FROM template_registry WHERE id = $1`,
    [templateId],
  );

  const configSchema = rows.length > 0 ? (rows[0].config_schema as ConfigSchemaManifest | null) : null;
  const schema = buildCustomizationSchema(configSchema);
  return { schema, configSchema };
}

export function getCustomizableFieldKeys(configSchema: ConfigSchemaManifest | null | undefined): Set<string> {
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
