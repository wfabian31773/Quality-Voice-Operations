// RT-09: the composer runs only behind an agent's `metadata.runtime:
// 'composer'`. With the flag off, a barbershop or salon agent must load
// exactly as it did before the composer existed. The snapshot was recorded
// against main (2ecf9e11) before agentLoader.ts changed; do not update it to
// make a change pass.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { loadAgentConfig, type AgentLoadContext } from './agentLoader';

const SHOP_PROMPT = 'Sharp Line Barbers. Cuts $30, beard trims $15. Open Tue-Sat 9-7, closed Sun and Mon. 412 Main Street.';

function shopCtx(agentType: string, metadata: Record<string, unknown> = {}): AgentLoadContext {
  return {
    tenantId: 't-shop' as never,
    agentId: 'ag-shop',
    agentType,
    callerPhone: '+15555550142',
    dbAgent: {
      name: 'Front desk',
      system_prompt: SHOP_PROMPT,
      voice: 'ara',
      language: 'en',
      tenant_timezone: 'America/New_York',
      metadata: { businessName: 'Sharp Line Barbers', ...metadata },
    },
  };
}

beforeAll(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-20T14:00:00Z'));
});

afterAll(() => {
  vi.useRealTimers();
});

describe('agentLoader with the composer flag off (pinned to main)', () => {
  const cases: Array<[string, AgentLoadContext]> = [
    ['barbershop, no flag', shopCtx('barbershop')],
    ['salon, no flag', shopCtx('salon')],
    ['barbershop, runtime set to another value', shopCtx('barbershop', { runtime: 'legacy' })],
    ['salon, runtime composer (only barbershop@1 has a composer template)', shopCtx('salon', { runtime: 'composer' })],
  ];

  for (const [label, ctx] of cases) {
    it(`${label}: config output is unchanged`, () => {
      expect(loadAgentConfig(ctx)).toMatchSnapshot();
    });
  }

  it('barbershop still maps to the legacy salon role package and its library tools', () => {
    const cfg = loadAgentConfig(shopCtx('barbershop'));
    expect(cfg.rolePackageId).toBe('salon');
    expect(cfg.tools.map((t) => t.name)).toContain('create_booking');
  });
});
