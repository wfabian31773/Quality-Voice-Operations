import { describe, it, expect, vi, beforeEach } from 'vitest';

const a = vi.hoisted(() => ({ clientQueryMock: vi.fn(), releaseMock: vi.fn() }));

vi.mock('../db', () => ({
  getPlatformPool: () => ({ connect: async () => ({ query: a.clientQueryMock, release: a.releaseMock }) }),
  withTenantContext: async (_c: unknown, _t: string, cb: () => Promise<void>) => cb(),
}));

import { getCallAnalytics, getCampaignAnalytics, getAgentAnalytics, getCostAnalytics } from './AnalyticsService';

function dispatch(matchers: Array<[string, unknown[]]>) {
  a.clientQueryMock.mockImplementation(async (sql: string) => {
    for (const [needle, rows] of matchers) {
      if (sql.includes(needle)) return { rows };
    }
    return { rows: [] };
  });
}

const FROM = new Date('2026-01-01T00:00:00Z');
const TO = new Date('2026-02-01T00:00:00Z');

beforeEach(() => {
  a.clientQueryMock.mockReset().mockResolvedValue({ rows: [] });
  a.releaseMock.mockReset();
});

describe('getCallAnalytics', () => {
  it('aggregates summary, daily, and language breakdowns and derives rates', async () => {
    dispatch([
      ['AS total_calls', [{ total_calls: 10, inbound_calls: 6, outbound_calls: 4, avg_duration: 120, completed_calls: 8, failed_calls: 1, escalated_calls: 2, total_cost_cents: 500 }]],
      ['GROUP BY DATE(created_at)', [{ day: '2026-01-02', calls: 3, avg_duration: 100, inbound: 2, outbound: 1 }]],
      ['COALESCE(cs.language, a.language)', [{ language: 'en', calls: 7 }, { language: null, calls: 3 }]],
    ]);
    const res = await getCallAnalytics('t1', FROM, TO);
    expect(res.totalCalls).toBe(10);
    expect(res.automationRate).toBeCloseTo(0.8);
    expect(res.costPerCallCents).toBe(50);
    expect(res.dailyBreakdown[0]).toMatchObject({ date: '2026-01-02', calls: 3 });
    expect(res.languageBreakdown).toEqual([{ language: 'en', calls: 7 }, { language: null, calls: 3 }]);
  });
  it('handles an empty range with zeroed rates', async () => {
    dispatch([]);
    const res = await getCallAnalytics('t1', FROM, TO);
    expect(res).toMatchObject({ totalCalls: 0, automationRate: 0, costPerCallCents: 0 });
  });
  it('rolls back and rethrows on a query error', async () => {
    a.clientQueryMock.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM call_sessions')) throw new Error('boom');
      return { rows: [] };
    });
    await expect(getCallAnalytics('t1', FROM, TO)).rejects.toThrow('boom');
    expect(a.clientQueryMock).toHaveBeenCalledWith('ROLLBACK');
    expect(a.releaseMock).toHaveBeenCalled();
  });
});

describe('getCampaignAnalytics', () => {
  it('computes per-campaign rates, duration, and cost-per-contact', async () => {
    dispatch([
      ['JOIN campaign_contacts cc ON cc.campaign_id', [{ campaign_id: 'c1', campaign_name: 'Spring', total_contacts: 10, completed_contacts: 5, pending_contacts: 2, failed_contacts: 1, opted_out_contacts: 0, voicemail_contacts: 2, no_answer_contacts: 1, answered_contacts: 4 }]],
      ['campaign_contact_attempts', [{ campaign_id: 'c1', avg_dur: 90 }]],
      ["context->>'campaignId'", [{ campaign_id: 'c1', total_cost: 800 }]],
    ]);
    const res = await getCampaignAnalytics('t1', FROM, TO);
    const c = res.campaigns[0];
    expect(c).toMatchObject({ campaignId: 'c1', totalContacts: 10, completedContacts: 5, avgDurationSeconds: 90 });
    expect(c.completionRate).toBeCloseTo(0.5);
    expect(c.costPerContactCents).toBe(80); // 800 / 10
  });
  it('returns an empty list when there are no campaigns', async () => {
    dispatch([]);
    expect((await getCampaignAnalytics('t1', FROM, TO)).campaigns).toEqual([]);
  });
});

describe('getAgentAnalytics', () => {
  it('merges per-agent call stats with quality scores', async () => {
    dispatch([
      ['FROM agents a', [{ agent_id: 'ag1', agent_name: 'Bot', total_calls: 4, avg_duration: 110, completed_calls: 3, failed_calls: 1 }]],
      ['call_quality_scores', [{ agent_id: 'ag1', avg_score: 8.5 }]],
    ]);
    const res = await getAgentAnalytics('t1', FROM, TO);
    expect(res.agents[0]).toMatchObject({ agentId: 'ag1', totalCalls: 4, avgQualityScore: 8.5 });
  });
});

describe('getCostAnalytics', () => {
  it('merges AI + telephony cost-by-day with call counts', async () => {
    dispatch([
      ["metric_type = 'ai_minutes'", [{ day: '2026-01-02', cost_cents: 300 }]],
      ["metric_type IN ('calls_inbound', 'calls_outbound')", [{ day: '2026-01-02', cost_cents: 200 }]],
      ['COUNT(*)::int AS calls', [{ day: '2026-01-02', calls: 5 }]],
    ]);
    const res = await getCostAnalytics('t1', FROM, TO);
    expect(res).toMatchObject({ totalOpenaiCostCents: 300, totalTwilioCostCents: 200, totalCostCents: 500, totalCalls: 5, costPerCallCents: 100 });
    expect(res.dailyBreakdown[0]).toMatchObject({ date: '2026-01-02', openaiCostCents: 300, twilioCostCents: 200, totalCostCents: 500, calls: 5 });
  });
  it('returns zeroes for an empty range', async () => {
    dispatch([]);
    expect(await getCostAnalytics('t1', FROM, TO)).toMatchObject({ totalCostCents: 0, totalCalls: 0, costPerCallCents: 0, dailyBreakdown: [] });
  });
});
