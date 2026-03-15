import { createLogger } from '../../core/logger';
import type { AgentConfig, AgentRegistrySnapshot } from './types';
import type { AgentType, TenantId } from '../../core/types';

const logger = createLogger('AGENT_REGISTRY');

/**
 * Per-tenant agent registry.
 *
 * Stores AgentConfig objects keyed by agentId. Agents are registered by ID;
 * phone-number routing is handled by the telephony layer which queries this
 * registry via getInboundAgents().
 *
 * Lifecycle: one AgentRegistry per tenant, managed by TenantRegistryManager.
 */
export class AgentRegistry {
  private agents = new Map<string, AgentConfig>();

  constructor(private readonly tenantId: TenantId) {}

  register(config: AgentConfig): void {
    if (config.tenantId !== this.tenantId) {
      throw new Error(`AgentConfig tenantId mismatch: expected ${this.tenantId}, got ${config.tenantId}`);
    }
    this.agents.set(config.id, config);
    logger.info(`Registered agent: ${config.id}`, {
      tenantId: this.tenantId,
      version: config.version,
      type: config.agentType,
    });
  }

  getFactory(agentId: string): AgentConfig['factory'] | undefined {
    const config = this.agents.get(agentId);
    return config?.enabled ? config.factory : undefined;
  }

  getConfig(agentId: string): AgentConfig | undefined {
    return this.agents.get(agentId);
  }

  getByType(agentType: AgentType): AgentConfig[] {
    return Array.from(this.agents.values()).filter(
      (c) => c.enabled && c.agentType === agentType,
    );
  }

  getInboundAgents(): AgentConfig[] {
    return this.getByType('inbound');
  }

  getOutboundAgents(): AgentConfig[] {
    return this.getByType('outbound');
  }

  getAllAgents(): AgentConfig[] {
    return Array.from(this.agents.values());
  }

  enable(agentId: string): boolean {
    const config = this.agents.get(agentId);
    if (!config) return false;
    this.agents.set(agentId, { ...config, enabled: true });
    return true;
  }

  disable(agentId: string): boolean {
    const config = this.agents.get(agentId);
    if (!config) return false;
    this.agents.set(agentId, { ...config, enabled: false });
    return true;
  }

  update(agentId: string, updates: Partial<Omit<AgentConfig, 'id' | 'tenantId'>>): boolean {
    const config = this.agents.get(agentId);
    if (!config) return false;
    this.agents.set(agentId, { ...config, ...updates });
    return true;
  }

  snapshot(): AgentRegistrySnapshot {
    return {
      tenantId: this.tenantId,
      agents: Array.from(this.agents.values()).map(({ factory: _factory, ...rest }) => rest),
    };
  }
}
