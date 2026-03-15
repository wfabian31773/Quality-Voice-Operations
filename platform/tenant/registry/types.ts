import type { AgentType, TenantId } from '../../core/types';

export type AgentFactory = (...args: unknown[]) => unknown | Promise<unknown>;

export interface AgentConfig {
  id: string;
  tenantId: TenantId;
  factory: AgentFactory;
  enabled: boolean;
  description: string;
  agentType: AgentType;
  version?: string;
  voice?: string;
  language?: string;
  greeting?: string;
  /** Max call duration override in ms. If unset, platform defaults apply. */
  maxDurationMs?: number;
  /** Phone numbers that route to this agent (managed by telephony layer). */
  phoneNumbers?: string[];
  /** Extra config passed to the factory at instantiation. */
  metadata?: Record<string, unknown>;
}

export interface AgentRegistrySnapshot {
  tenantId: TenantId;
  agents: Omit<AgentConfig, 'factory'>[];
}
