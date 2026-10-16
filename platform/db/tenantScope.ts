import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Who the restricted pool is acting for in the current async context:
 *   - `tenant`: an authenticated request. Set once by the auth guard
 *     (`requireTenantContext`, API-key auth) so the many handlers that call
 *     `getPlatformPool()` directly are bound to `app.tenant_id` without each
 *     opening a transaction.
 *   - `privileged`: background schedulers / nightly jobs, which work across
 *     tenants. Restricted-pool calls are sent to the privileged pool.
 * Kept apart from `./index` so tests that mock the pool module still get the
 * real scope.
 */
type DbScope = { kind: 'tenant'; tenantId: string } | { kind: 'privileged' };

const dbScope = new AsyncLocalStorage<DbScope>();

/** Run `fn` with `tenantId` as the request tenant for restricted-pool queries. */
export function runWithTenantScope<T>(tenantId: string, fn: () => T): T {
  return dbScope.run({ kind: 'tenant', tenantId }, fn);
}

/**
 * Run `fn` (and every timer / callback it schedules) as cross-tenant
 * background work: restricted-pool calls go to the privileged pool.
 */
export function runWithPrivilegedScope<T>(fn: () => T): T {
  return dbScope.run({ kind: 'privileged' }, fn);
}

export function getScopedTenantId(): string | undefined {
  const scope = dbScope.getStore();
  return scope?.kind === 'tenant' ? scope.tenantId : undefined;
}

export function isPrivilegedScope(): boolean {
  return dbScope.getStore()?.kind === 'privileged';
}

/**
 * Run `fn` with no DB scope, so `getPlatformPool()` is the plain restricted
 * pool. The tenant isolation suite needs this: started from a scheduler it
 * would otherwise be sent to the privileged pool and test the wrong role.
 */
export function runOutsideDbScope<T>(fn: () => T): T {
  return dbScope.exit(fn);
}
