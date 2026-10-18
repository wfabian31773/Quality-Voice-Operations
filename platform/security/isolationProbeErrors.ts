/**
 * Pure classification of errors raised by tenant-isolation probes. No DB
 * imports, so it can be unit-tested and shared with tests/security.
 */

/**
 * A missing grant or refused role switch (SQLSTATE 42501). RLS filters rows
 * and never raises on SELECT, so this means the probe could not do its job:
 * the check must fail, never count as "blocked".
 */
export function isPermissionDenied(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === '42501' || String(err).includes('permission denied');
}

export type IsolationProbeErrorKind = 'permission_denied' | 'rls_blocked' | 'unexpected';

/**
 * permission_denied: nothing was proven (fail). rls_blocked: a genuine RLS
 * policy error (counts as isolated). unexpected: anything else (fail).
 * Permission denied wins when a message matches both.
 */
export function classifyIsolationProbeError(err: unknown): IsolationProbeErrorKind {
  if (isPermissionDenied(err)) return 'permission_denied';
  const errStr = String(err);
  if (errStr.includes('row_security') || errStr.includes('policy')) return 'rls_blocked';
  return 'unexpected';
}
