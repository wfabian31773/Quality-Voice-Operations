import type { IntakeSchema } from './schemas';

export type IntakeCheck = { ok: true; value: Record<string, unknown> } | { ok: false; field: string; message: string };

const MAX_INTAKE_BYTES = 8 * 1024;
const MAX_EXTRA_KEYS = 20;
const MAX_EXTRA_STRING = 2000;
const MAX_EXTRA_ITEMS = 20;
const EXTRA_KEY = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

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
  let extras = 0;
  for (const [key, entry] of Object.entries(value)) {
    const field = schema.properties[key];
    if (!field) {
      if (schema.additionalProperties !== true) {
        return { ok: false, field: `intake.${key}`, message: `Intake field ${key} is not in the template schema` };
      }
      // Undeclared fields the schema allows are kept, but only as small plain JSON.
      if (!EXTRA_KEY.test(key)) return { ok: false, field: 'intake', message: 'Intake field names must be simple identifiers' };
      if (++extras > MAX_EXTRA_KEYS) return { ok: false, field: 'intake', message: 'Intake has too many extra fields' };
      if (entry === undefined) continue;
      const extra = plainExtra(entry, 0);
      if (!extra.ok) return { ok: false, field: `intake.${key}`, message: `Intake field ${key} ${extra.problem}` };
      out[key] = extra.value;
      continue;
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

type Extra = { ok: true; value: unknown } | { ok: false; problem: string };

/** Scalars, or one level of small arrays/objects of scalars. Strings are trimmed. */
function plainExtra(entry: unknown, depth: number): Extra {
  if (entry === null || typeof entry === 'boolean') return { ok: true, value: entry };
  if (typeof entry === 'number') return Number.isFinite(entry) ? { ok: true, value: entry } : { ok: false, problem: 'must be a finite number' };
  if (typeof entry === 'string') {
    const trimmed = entry.trim();
    return trimmed.length > MAX_EXTRA_STRING ? { ok: false, problem: 'is too long' } : { ok: true, value: trimmed };
  }
  if (depth > 0 || typeof entry !== 'object') return { ok: false, problem: 'must be text, a number, yes/no or a short list' };
  if (Array.isArray(entry)) {
    if (entry.length > MAX_EXTRA_ITEMS) return { ok: false, problem: 'has too many entries' };
    const items: unknown[] = [];
    for (const item of entry) {
      const checked = plainExtra(item, depth + 1);
      if (!checked.ok) return checked;
      items.push(checked.value);
    }
    return { ok: true, value: items };
  }
  if (Object.getPrototypeOf(entry) !== Object.prototype) return { ok: false, problem: 'must be plain JSON' };
  const pairs = Object.entries(entry as Record<string, unknown>);
  if (pairs.length > MAX_EXTRA_ITEMS) return { ok: false, problem: 'has too many entries' };
  const obj: Record<string, unknown> = {};
  for (const [key, item] of pairs) {
    if (!EXTRA_KEY.test(key)) return { ok: false, problem: 'has an invalid key' };
    const checked = plainExtra(item, depth + 1);
    if (!checked.ok) return checked;
    obj[key] = checked.value;
  }
  return { ok: true, value: obj };
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
