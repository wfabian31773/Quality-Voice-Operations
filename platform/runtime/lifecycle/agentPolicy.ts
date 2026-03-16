/**
 * Per-agent-type max call duration policies.
 *
 * Tenant-overridable: the platform provides sensible defaults here.
 * A tenant's AgentConfig can include a `maxDurationMs` field to override these.
 */

const AGENT_MAX_DURATION_MS: Record<string, number> = {
  'appointment-confirmation': 3 * 60 * 1000,
  'after-hours': 7 * 60 * 1000,
  'answering-service': 7 * 60 * 1000,
};

const DEFAULT_MAX_DURATION_MS = 10 * 60 * 1000;

const DEMO_MAX_DURATION_MS = 3 * 60 * 1000;
const DEMO_WARNING_MS = 2 * 60 * 1000 + 30 * 1000;

export function getMaxDurationMs(agentSlug?: string, tenantOverrideMs?: number): number {
  if (tenantOverrideMs && tenantOverrideMs > 0) return tenantOverrideMs;
  if (agentSlug && agentSlug in AGENT_MAX_DURATION_MS) {
    return AGENT_MAX_DURATION_MS[agentSlug];
  }
  return DEFAULT_MAX_DURATION_MS;
}

export function getDemoMaxDurationMs(): number {
  return DEMO_MAX_DURATION_MS;
}

export function getDemoWarningMs(): number {
  return DEMO_WARNING_MS;
}
