import type { IntakeSchema } from './schemas';

export type IntakeCheck = { ok: true; value: Record<string, unknown> } | { ok: false; field: string; message: string };

const MAX_INTAKE_BYTES = 8 * 1024;

/**
 * Validates `intake` against the server-resolved intake schema for the ticket
 * kind (intakeSchemaFor). The tenant/template decides which fields exist,
 * never the caller.
 */
export function validateIntake(intake: Record<string, unknown> | undefined, schema: IntakeSchema): IntakeCheck {
  const value = intake ?? {};
  for (const key of schema.required ?? []) {
    const entry = value[key];
    if (entry === undefined || entry === null || (typeof entry === 'string' && entry.trim() === '')) {
      return { ok: false, field: `intake.${key}`, message: `Intake field ${key} is required` };
    }
  }

  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    const field = schema.properties[key];
    if (!field) {
      if (schema.additionalProperties === true) continue;
      return { ok: false, field: `intake.${key}`, message: `Intake field ${key} is not in the template schema` };
    }
    if (entry === undefined || entry === null) continue;
    const problem = checkField(entry, field);
    if (problem) return { ok: false, field: `intake.${key}`, message: `Intake field ${key} ${problem}` };
    out[key] = typeof entry === 'string' ? entry.trim() : entry;
  }

  if (Buffer.byteLength(JSON.stringify(out), 'utf8') > MAX_INTAKE_BYTES) {
    return { ok: false, field: 'intake', message: 'Intake is too large' };
  }
  return { ok: true, value: out };
}

function checkField(entry: unknown, field: IntakeSchema['properties'][string]): string | null {
  switch (field.type) {
    case 'string': {
      if (typeof entry !== 'string') return 'must be text';
      if (entry.length > (field.maxLength ?? 2000)) return 'is too long';
      break;
    }
    case 'number':
    case 'integer': {
      if (typeof entry !== 'number' || !Number.isFinite(entry)) return 'must be a number';
      if (field.type === 'integer' && !Number.isInteger(entry)) return 'must be a whole number';
      if (field.minimum !== undefined && entry < field.minimum) return `must be at least ${field.minimum}`;
      if (field.maximum !== undefined && entry > field.maximum) return `must be at most ${field.maximum}`;
      break;
    }
    case 'boolean': {
      if (typeof entry !== 'boolean') return 'must be yes or no';
      break;
    }
    case 'array': {
      if (!Array.isArray(entry)) return 'must be a list';
      if (entry.length > (field.maxItems ?? 20)) return 'has too many entries';
      const max = field.items?.maxLength ?? 500;
      if (!entry.every((item) => typeof item === 'string' && item.length <= max)) {
        return 'must be a list of short text entries';
      }
      return null;
    }
  }
  if (field.enum && !field.enum.includes(entry as string | number)) return 'is not one of the allowed values';
  return null;
}
