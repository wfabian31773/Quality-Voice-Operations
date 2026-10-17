import type { ZodTypeAny } from 'zod';

type JsonSchema = Record<string, unknown>;

export function zodToJsonSchema(schema: ZodTypeAny): JsonSchema {
  return convert(schema);
}

function convert(schema: ZodTypeAny): JsonSchema {
  const { inner, nullable } = unwrap(schema);
  const typeName = String(inner._def.typeName);
  let json: JsonSchema;

  switch (typeName) {
    case 'ZodString':
      json = stringSchema(inner);
      break;
    case 'ZodNumber':
      json = numberSchema(inner);
      break;
    case 'ZodBoolean':
      json = { type: 'boolean' };
      break;
    case 'ZodLiteral':
      json = { type: literalType(inner._def.value), const: inner._def.value };
      break;
    case 'ZodEnum':
      json = { type: 'string', enum: [...(inner._def.values as string[])] };
      break;
    case 'ZodNativeEnum': {
      json = { enum: nativeEnumValues(inner._def.values as Record<string, string | number>) };
      break;
    }
    case 'ZodArray':
      json = {
        type: 'array',
        items: convert(inner._def.type as ZodTypeAny),
      };
      break;
    case 'ZodObject':
      json = objectSchema(inner);
      break;
    case 'ZodRecord':
      json = {
        type: 'object',
        additionalProperties: convert((inner._def.valueType ?? inner._def.values) as ZodTypeAny),
      };
      break;
    case 'ZodUnion':
    case 'ZodDiscriminatedUnion': {
      const options = (inner._def.options as ZodTypeAny[]) ?? [];
      json = { anyOf: options.map(convert) };
      break;
    }
    case 'ZodTuple':
      json = {
        type: 'array',
        prefixItems: ((inner._def.items as ZodTypeAny[]) ?? []).map(convert),
      };
      break;
    case 'ZodDate':
      json = { type: 'string', format: 'date-time' };
      break;
    case 'ZodNull':
      json = { type: 'null' };
      break;
    case 'ZodUndefined':
    case 'ZodVoid':
    case 'ZodNever':
      json = {};
      break;
    case 'ZodAny':
    case 'ZodUnknown':
      json = {};
      break;
    default:
      json = {};
  }

  if (nullable) {
    return { anyOf: [json, { type: 'null' }] };
  }
  return json;
}

function unwrap(schema: ZodTypeAny): { inner: ZodTypeAny; optional: boolean; nullable: boolean } {
  let inner = schema;
  let optional = false;
  let nullable = false;
  for (;;) {
    const typeName = String(inner._def.typeName);
    if (typeName === 'ZodOptional' || typeName === 'ZodDefault') {
      optional = true;
      inner = inner._def.innerType as ZodTypeAny;
      continue;
    }
    if (typeName === 'ZodNullable') {
      nullable = true;
      inner = inner._def.innerType as ZodTypeAny;
      continue;
    }
    if (typeName === 'ZodEffects') {
      inner = inner._def.schema as ZodTypeAny;
      continue;
    }
    if (typeName === 'ZodBranded') {
      inner = inner._def.type as ZodTypeAny;
      continue;
    }
    if (typeName === 'ZodCatch') {
      inner = inner._def.innerType as ZodTypeAny;
      continue;
    }
    if (typeName === 'ZodPipeline') {
      inner = inner._def.out as ZodTypeAny;
      continue;
    }
    if (typeName === 'ZodReadonly') {
      inner = inner._def.innerType as ZodTypeAny;
      continue;
    }
    break;
  }
  return { inner, optional, nullable };
}

function objectSchema(schema: ZodTypeAny): JsonSchema {
  const raw = schema._def.shape;
  const shape = typeof raw === 'function' ? raw() : raw;
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];
  for (const [key, child] of Object.entries(shape as Record<string, ZodTypeAny>)) {
    const meta = unwrap(child);
    properties[key] = convert(child);
    if (!meta.optional) required.push(key);
  }
  return {
    type: 'object',
    properties,
    ...(required.length ? { required } : {}),
    additionalProperties: false,
  };
}

function stringSchema(schema: ZodTypeAny): JsonSchema {
  const json: JsonSchema = { type: 'string' };
  const checks = (schema._def.checks as Array<{ kind: string; value?: unknown }>) ?? [];
  for (const check of checks) {
    if (check.kind === 'min' && typeof check.value === 'number') json.minLength = check.value;
    if (check.kind === 'max' && typeof check.value === 'number') json.maxLength = check.value;
    if (check.kind === 'email') json.format = 'email';
    if (check.kind === 'url') json.format = 'uri';
    if (check.kind === 'uuid') json.format = 'uuid';
    if (check.kind === 'regex' && check.value instanceof RegExp) json.pattern = check.value.source;
  }
  return json;
}

function numberSchema(schema: ZodTypeAny): JsonSchema {
  const json: JsonSchema = { type: schema._def.checks?.some((c: { kind: string }) => c.kind === 'int') ? 'integer' : 'number' };
  const checks = (schema._def.checks as Array<{ kind: string; value?: unknown }>) ?? [];
  for (const check of checks) {
    if (check.kind === 'min' && typeof check.value === 'number') json.minimum = check.value;
    if (check.kind === 'max' && typeof check.value === 'number') json.maximum = check.value;
  }
  return json;
}

function nativeEnumValues(enumObject: Record<string, string | number>): Array<string | number> {
  // Numeric TypeScript enums include reverse mappings (`1: "A"`). Keep only the
  // named members, which are the values Zod actually accepts.
  return Object.keys(enumObject)
    .filter((key) => Number.isNaN(Number(key)))
    .map((key) => enumObject[key]);
}

function literalType(value: unknown): string {
  if (typeof value === 'string') return 'string';
  if (typeof value === 'number') return 'number';
  if (typeof value === 'boolean') return 'boolean';
  return 'string';
}
