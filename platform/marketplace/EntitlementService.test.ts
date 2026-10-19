/**
 * checkEntitlement: every plan includes every template (docs/shop/tools-spec.md,
 * "Plans and entitlements"). Plan tier never blocks an install; billing state,
 * missing integrations and the trial's agent limit still do.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

interface Scenario {
  subscription: { plan: string; status: string } | null;
  agentCount: number;
  enabledConnectors?: string[];
}

let scenario: Scenario;

const client = {
  query: vi.fn(async (sql: string) => {
    const trimmed = sql.trim();
    if (trimmed.startsWith('SELECT plan, status FROM subscriptions')) {
      return { rows: scenario.subscription ? [scenario.subscription] : [] };
    }
    if (trimmed.startsWith('SELECT COUNT(*) AS count FROM agents')) {
      return { rows: [{ count: String(scenario.agentCount) }] };
    }
    return { rows: [] };
  }),
  release: vi.fn(),
};

vi.mock('../db', () => ({
  getPlatformPool: () => ({ connect: async () => client }),
  withTenantContext: vi.fn(async () => {}),
}));

vi.mock('../integrations/connectors/db', () => ({
  listConnectorConfigs: vi.fn(async () =>
    (scenario.enabledConnectors ?? []).map((connectorType) => ({ connectorType, isEnabled: true })),
  ),
}));

vi.mock('../core/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { checkEntitlement } from './EntitlementService';

const TENANT = 'tenant-starter' as unknown as Parameters<typeof checkEntitlement>[0];

// What callers built from a template_registry row before this change. The
// stored min_plan is passed through on purpose: it must be ignored.
const enterpriseOnlyTemplate = { minPlan: 'enterprise', requiredIntegrations: [] as string[] };
const proTemplate = { minPlan: 'pro', requiredIntegrations: [] as string[] };

beforeEach(() => {
  client.query.mockClear();
  scenario = { subscription: { plan: 'starter', status: 'active' }, agentCount: 0 };
});

describe('checkEntitlement — plan tier never gates a template', () => {
  it('lets an active starter tenant install a template whose stored min_plan is enterprise', async () => {
    const result = await checkEntitlement(TENANT, enterpriseOnlyTemplate);
    expect(result.errors).toEqual([]);
    expect(result.allowed).toBe(true);
    expect(result.plan).toBe('starter');
  });

  it('lets an active starter tenant install a pro template', async () => {
    const result = await checkEntitlement(TENANT, proTemplate);
    expect(result.allowed).toBe(true);
  });
});

describe('checkEntitlement — no agent-count cap on any paid plan', () => {
  it.each([2, 3, 25])('does not refuse an active starter tenant that already has %i agents', async (agentCount) => {
    scenario.agentCount = agentCount;
    const result = await checkEntitlement(TENANT, enterpriseOnlyTemplate);
    expect(result.errors).toEqual([]);
    expect(result.allowed).toBe(true);
    expect(result.agentCount).toBe(agentCount);
    expect(result.maxAgents).toBeNull();
  });

  it.each(['pro', 'enterprise'])('does not cap agents on an active %s tenant either', async (plan) => {
    scenario = { subscription: { plan, status: 'active' }, agentCount: 1500 };
    const result = await checkEntitlement(TENANT, proTemplate);
    expect(result.allowed).toBe(true);
    expect(result.maxAgents).toBeNull();
  });
});

describe('checkEntitlement — trial keeps its 2-agent limit', () => {
  const trialStates: Array<[string, Scenario['subscription']]> = [
    ['a trialing subscription', { plan: 'starter', status: 'trialing' }],
    ['no subscription row', null],
  ];
  it.each(trialStates)('holds %s to 2 agents', async (_label, subscription) => {
    scenario = { subscription, agentCount: 2 };
    const blocked = await checkEntitlement(TENANT, proTemplate);
    expect(blocked.allowed).toBe(false);
    expect(blocked.maxAgents).toBe(2);
    expect(blocked.errors).toEqual([expect.stringContaining('Trial agent limit reached (2/2)')]);

    scenario = { subscription, agentCount: 1 };
    const allowed = await checkEntitlement(TENANT, proTemplate);
    expect(allowed.allowed).toBe(true);
    expect(allowed.maxAgents).toBe(2);
  });
});

describe('checkEntitlement — real errors still block', () => {
  it.each(['cancelled', 'past_due'])('blocks a %s subscription', async (status) => {
    scenario = { subscription: { plan: 'enterprise', status }, agentCount: 0 };
    const result = await checkEntitlement(TENANT, { requiredIntegrations: [] });
    expect(result.allowed).toBe(false);
    expect(result.errors).toEqual([`Subscription is ${status}. Please update your billing to install templates.`]);
  });

  it('blocks when a required integration is not configured', async () => {
    scenario.enabledConnectors = ['hubspot'];
    const result = await checkEntitlement(TENANT, { requiredIntegrations: ['hubspot', 'salesforce'] });
    expect(result.allowed).toBe(false);
    expect(result.errors).toEqual([
      'Required integration "salesforce" is not configured. Please set it up before installing this template.',
    ]);
  });

  it('allows when every required integration is configured', async () => {
    scenario.enabledConnectors = ['hubspot'];
    const result = await checkEntitlement(TENANT, { requiredIntegrations: ['hubspot'] });
    expect(result.allowed).toBe(true);
  });
});
