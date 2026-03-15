import { tenantRegistryManager } from '../../tenant/registry';
import type { AgentConfig } from '../../tenant/registry/types';
import type { TenantId } from '../../core/types';

/**
 * Route an inbound Twilio number to a tenant + agent.
 *
 * The number-to-tenant mapping is maintained in the platform phone_number_routes table.
 * This module handles the second leg: resolving the agent within the tenant's registry.
 */
export function resolveAgentForNumber(
  tenantId: TenantId,
  phoneNumber: string,
  defaultAgentId = 'answering-service',
): AgentConfig | undefined {
  const registry = tenantRegistryManager.get(tenantId);
  if (!registry) return undefined;

  const inboundAgents = registry.getInboundAgents();
  const byNumber = inboundAgents.find((a) => a.phoneNumbers?.includes(phoneNumber));
  return byNumber ?? registry.getConfig(defaultAgentId);
}
