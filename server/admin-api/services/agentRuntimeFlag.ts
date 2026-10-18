/**
 * Who may flip an agent's runtime (RT-14 prereq). `agents.metadata.runtime`
 * picks the voice runtime an agent runs on (RT-09: "composer" puts a
 * barbershop agent on the generic composer). Only QVO platform staff
 * (`req.user.isPlatformAdmin`) may set, change or clear it.
 *
 * Every admin-api path that writes agents.metadata goes through here:
 * - a write that carries metadata (create, PATCH, marketplace install) uses
 *   guardRuntimeFlag: a non-platform-admin who sends a different runtime gets
 *   403; metadata that simply omits it keeps the stored value, so a tenant
 *   edit can't turn it off either. A platform admin sets it with a value and
 *   clears it with `runtime: null`; omitting it keeps it for them too.
 * - a write that rebuilds metadata itself (publish, version rollback,
 *   marketplace customization) uses keepStoredRuntime: it never changes it.
 *
 * Pure: no I/O. The key matches agentLoader's COMPOSER_RUNTIME_KEY (tested).
 */

export const RUNTIME_METADATA_KEY = 'runtime';

export const RUNTIME_FLAG_FORBIDDEN =
  'Only QVO platform staff can set, change or remove the agent runtime (metadata.runtime).';

export type RuntimeFlagCheck =
  | { ok: true; metadata: Record<string, unknown>; runtimeChanged: boolean }
  | { ok: false; status: 400 | 403; error: string };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** Stored metadata as an object (the column may come back as a JSON string or null). */
export function storedMetadata(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value);
      return isPlainObject(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return isPlainObject(value) ? value : {};
}

function hasRuntime(meta: Record<string, unknown>): boolean {
  return Object.prototype.hasOwnProperty.call(meta, RUNTIME_METADATA_KEY);
}

/** null and absent both mean "no runtime set". */
function runtimeOf(meta: Record<string, unknown>): unknown {
  return meta[RUNTIME_METADATA_KEY] ?? undefined;
}

function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function withRuntime(meta: Record<string, unknown>, runtime: unknown): Record<string, unknown> {
  const rest = { ...meta };
  delete rest[RUNTIME_METADATA_KEY];
  return runtime === undefined ? rest : { ...rest, [RUNTIME_METADATA_KEY]: runtime };
}

/**
 * The metadata to write when a request sends `requested` over the agent's
 * `stored` metadata (undefined on create). Sending the stored value back
 * unchanged is not a change, so a client that round-trips metadata still works.
 */
export function guardRuntimeFlag(opts: {
  isPlatformAdmin: boolean;
  stored: unknown;
  requested: unknown;
}): RuntimeFlagCheck {
  if (!isPlainObject(opts.requested)) return { ok: false, status: 400, error: 'metadata must be an object' };
  const stored = storedMetadata(opts.stored);
  const current = runtimeOf(stored);
  const next = hasRuntime(opts.requested) ? runtimeOf(opts.requested) : current;
  const changed = !sameValue(current, next);
  if (changed && !opts.isPlatformAdmin) return { ok: false, status: 403, error: RUNTIME_FLAG_FORBIDDEN };
  return { ok: true, metadata: withRuntime(opts.requested, next), runtimeChanged: changed };
}

/** `next` with the stored runtime put back exactly (kept, or left absent): for writes that must never change it. */
export function keepStoredRuntime(stored: unknown, next: Record<string, unknown>): Record<string, unknown> {
  return withRuntime(next, runtimeOf(storedMetadata(stored)));
}
