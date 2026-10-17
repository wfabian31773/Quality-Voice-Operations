import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * What the restricted pool (`getPlatformPool()`) does in the current async
 * context once it connects as qvo_app (NOBYPASSRLS):
 *   - `tenant`: an authenticated tenant request. Set once by the auth guard
 *     (`requireTenantContext`, API-key auth) so the many handlers that call
 *     `getPlatformPool()` directly are bound to `app.tenant_id` and RLS is
 *     enforced for them.
 *   - `restricted`: use the restricted pool as-is (the isolation suite).
 *   - `privileged` or no scope (webhooks, public routes, voice gateway,
 *     platform admins, schedulers, timers): calls go to the privileged pool,
 *     which is how every query ran before the role switch.
 * Kept apart from `./index` so tests that mock the pool module still get the
 * real scope.
 */
type DbScope = { kind: 'tenant'; tenantId: string } | { kind: 'privileged' } | { kind: 'restricted' };

const dbScope = new AsyncLocalStorage<DbScope>();

/** Run `fn` with `tenantId` as the request tenant for restricted-pool queries. */
export function runWithTenantScope<T>(tenantId: string, fn: () => T): T {
  return dbScope.run({ kind: 'tenant', tenantId }, fn);
}

/**
 * Run `fn` (and every timer / callback it schedules) as cross-tenant work:
 * restricted-pool calls go to the privileged pool. Same as no scope, but
 * explicit and it overrides an outer tenant scope.
 */
export function runWithPrivilegedScope<T>(fn: () => T): T {
  return dbScope.run({ kind: 'privileged' }, fn);
}

/**
 * Run `fn` on the plain restricted pool with no tenant bound. The tenant
 * isolation suite needs this to test the real app role, whatever scope it
 * was started from.
 */
export function runWithRestrictedScope<T>(fn: () => T): T {
  return dbScope.run({ kind: 'restricted' }, fn);
}

export function getScopedTenantId(): string | undefined {
  const scope = dbScope.getStore();
  return scope?.kind === 'tenant' ? scope.tenantId : undefined;
}

/** True when restricted-pool calls should go to the privileged pool. */
export function isPrivilegedScope(): boolean {
  const kind = dbScope.getStore()?.kind;
  return kind === undefined || kind === 'privileged';
}
