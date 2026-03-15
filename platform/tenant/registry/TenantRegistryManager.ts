import { AgentRegistry } from './AgentRegistry';
import type { TenantId } from '../../core/types';

/**
 * Platform-level manager holding one AgentRegistry per tenant.
 * This is the multi-tenant replacement for the old global `agentRegistry` singleton.
 */
export class TenantRegistryManager {
  private registries = new Map<TenantId, AgentRegistry>();

  getOrCreate(tenantId: TenantId): AgentRegistry {
    if (!this.registries.has(tenantId)) {
      this.registries.set(tenantId, new AgentRegistry(tenantId));
    }
    return this.registries.get(tenantId)!;
  }

  get(tenantId: TenantId): AgentRegistry | undefined {
    return this.registries.get(tenantId);
  }

  teardown(tenantId: TenantId): void {
    this.registries.delete(tenantId);
  }

  listTenants(): TenantId[] {
    return Array.from(this.registries.keys());
  }

  getTotalAgentCount(): number {
    let total = 0;
    for (const registry of this.registries.values()) {
      total += registry.getAllAgents().length;
    }
    return total;
  }
}

export const tenantRegistryManager = new TenantRegistryManager();
