import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Request-scoped tenant. Set once by the auth guard (`requireTenantContext`,
 * API-key auth) so the many handlers that call `getPlatformPool().query()`
 * directly are bound to `app.tenant_id` without each opening a transaction.
 * Kept apart from `./index` so tests that mock the pool module still get the
 * real scope.
 */
const tenantScope = new AsyncLocalStorage<string>();

/** Run `fn` with `tenantId` as the request tenant for restricted-pool queries. */
export function runWithTenantScope<T>(tenantId: string, fn: () => T): T {
  return tenantScope.run(tenantId, fn);
}

export function getScopedTenantId(): string | undefined {
  return tenantScope.getStore();
}
