import { AsyncLocalStorage } from 'node:async_hooks';
import { withTenantClient } from '../../db';
import { postgresActionStore } from './postgresStore';
import type { ActionStore } from './store';
import type { AnyActionDefinition, TenantTx } from './types';

const storeContext = new AsyncLocalStorage<ActionStore>();

export type ActionRegistry = Map<string, AnyActionDefinition> | Iterable<AnyActionDefinition>;

export interface ActionRuntime {
  store?: ActionStore;
  registry?: ActionRegistry;
  withTenantTx?: <T>(tenantId: string, fn: (tx: TenantTx) => Promise<T>) => Promise<T>;
}

export function getActionStore(): ActionStore {
  return storeContext.getStore() ?? postgresActionStore;
}

export function runWithActionStore<T>(store: ActionStore, fn: () => T): T {
  return storeContext.run(store, fn);
}

export function resolveRegistry(registry: ActionRegistry | undefined): Map<string, AnyActionDefinition> {
  if (!registry) return new Map();
  if (registry instanceof Map) return registry;
  return new Map(Array.from(registry, (def) => [def.name, def]));
}

export async function defaultWithTenantTx<T>(
  tenantId: string,
  fn: (tx: TenantTx) => Promise<T>,
): Promise<T> {
  return withTenantClient(tenantId, (client) => fn(client as TenantTx));
}
