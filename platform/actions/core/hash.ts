import { createHash } from 'node:crypto';

export function canonicalize(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function tagOf(value: unknown): string {
  return Object.prototype.toString.call(value);
}

function isPlainObject(value: object): boolean {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function isDateValue(value: unknown): value is Date {
  return tagOf(value) === '[object Date]';
}

function serializeDate(value: Date): string {
  const time = value.getTime();
  return Number.isFinite(time) ? value.toISOString() : 'Invalid Date';
}

function sortValue(value: unknown): unknown {
  if (isDateValue(value) || value instanceof Date) return serializeDate(value as Date);
  if (typeof value === 'bigint') return `${value.toString()}n`;
  if (typeof value === 'symbol') return value.toString();
  if (typeof value === 'function') return `[Function ${value.name || 'anonymous'}]`;
  if (typeof value === 'number' && !Number.isFinite(value)) return String(value);
  if (value instanceof Map) {
    return {
      __type: 'Map',
      entries: [...value.entries()].map(([key, entry]) => [sortValue(key), sortValue(entry)]),
    };
  }
  if (value instanceof Set) {
    return { __type: 'Set', values: [...value].map(sortValue) };
  }
  if (value instanceof ArrayBuffer) {
    return { __type: 'ArrayBuffer', bytes: Array.from(new Uint8Array(value)) };
  }
  if (ArrayBuffer.isView(value)) {
    return {
      __type: value.constructor.name,
      bytes: Array.from(new Uint8Array(value.buffer, value.byteOffset, value.byteLength)),
    };
  }
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === 'object') {
    if (isDateValue(value) || value instanceof Date) return serializeDate(value as Date);
    if (!isPlainObject(value) && typeof (value as { toJSON?: unknown }).toJSON === 'function') {
      return sortValue((value as { toJSON: () => unknown }).toJSON());
    }
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) {
      const child = obj[key];
      out[key] = isDateValue(child) || child instanceof Date ? serializeDate(child as Date) : sortValue(child);
    }
    return out;
  }
  return value;
}

export function requestHash(value: unknown): string {
  return createHash('sha256').update(canonicalize(value)).digest('hex');
}
