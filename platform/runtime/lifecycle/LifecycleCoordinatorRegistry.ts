import { CallLifecycleCoordinator } from './CallLifecycleCoordinator';
import type { CallPersistenceAdapter } from './CallLifecycleCoordinator';
import type { TenantId } from '../../core/types';

/**
 * Holds one CallLifecycleCoordinator per tenant.
 * The registry is a platform-level singleton; coordinators are tenant-scoped.
 */
export class LifecycleCoordinatorRegistry {
  private coordinators = new Map<TenantId, CallLifecycleCoordinator>();

  constructor(private readonly persistence: CallPersistenceAdapter) {}

  getOrCreate(tenantId: TenantId): CallLifecycleCoordinator {
    if (!this.coordinators.has(tenantId)) {
      this.coordinators.set(
        tenantId,
        new CallLifecycleCoordinator(tenantId, this.persistence),
      );
    }
    return this.coordinators.get(tenantId)!;
  }

  get(tenantId: TenantId): CallLifecycleCoordinator | undefined {
    return this.coordinators.get(tenantId);
  }

  getActiveCallCounts(): Record<TenantId, number> {
    const result: Record<TenantId, number> = {};
    for (const [id, coordinator] of this.coordinators) {
      result[id] = coordinator.getActiveCallCount();
    }
    return result;
  }

  teardown(tenantId: TenantId): void {
    this.coordinators.delete(tenantId);
  }
}
