import { TRIAL_LIMITS } from '../../billing/stripe/plans';

const AGENT_MAX_DURATION_MS: Record<string, number> = {
  'appointment-confirmation': 3 * 60 * 1000,
  'after-hours': 7 * 60 * 1000,
  'answering-service': 7 * 60 * 1000,
};

const DEFAULT_MAX_DURATION_MS = 10 * 60 * 1000;

const DEMO_MAX_DURATION_MS = 3 * 60 * 1000;
const DEMO_WARNING_MS = 2 * 60 * 1000 + 30 * 1000;

export function getMaxDurationMs(agentSlug?: string, tenantOverrideMs?: number, isTrial?: boolean): number {
  if (isTrial) {
    return TRIAL_LIMITS.maxCallDurationMs;
  }
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
