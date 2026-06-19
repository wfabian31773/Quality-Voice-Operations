import { describe, it, expect, vi, beforeEach } from 'vitest';

const a = vi.hoisted(() => ({ clientQueryMock: vi.fn(), releaseMock: vi.fn() }));

vi.mock('../db', () => ({
  getPlatformPool: () => ({ connect: async () => ({ query: a.clientQueryMock, release: a.releaseMock }) }),
  withTenantContext: async (_c: unknown, _t: string, cb: () => Promise<void>) => cb(),
}));
vi.mock('../core/logger', () => ({ createLogger: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn() }) }));

import { getRevenueAttribution } from './RevenueAttributionService';

function dispatch(matchers: Array<[string, unknown[]]>) {
  a.clientQueryMock.mockImplementation(async (sql: string) => {
    for (const [needle, rows] of matchers) if (sql.includes(needle)) return { rows };
    return { rows: [] };
  });
}

const FROM = new Date('2026-01-01T00:00:00Z');
const TO = new Date('2026-02-01T00:00:00Z');

beforeEach(() => {
  a.clientQueryMock.mockReset().mockResolvedValue({ rows: [] });
  a.releaseMock.mockReset();
});

describe('getRevenueAttribution', () => {
  it('derives revenue, booking rates, missed revenue, and daily totals', async () => {
    dispatch([
      ['FROM agents a', [{ agent_id: 'ag1', agent_name: 'Bot', calls_handled: 10, appointments_booked: 4 }]],
      ['AS missed_opportunities', [{ missed_opportunities: 3 }]],
      ['AS prevented', [{ prevented: 7 }]],
      ['GROUP BY DATE(cs.created_at)', [{ day: '2026-01-02', appointments_booked: 2 }]],
    ]);
    const res = await getRevenueAttribution('t1', FROM, TO, 10000);
    expect(res.totalAppointmentsBooked).toBe(4);
    expect(res.totalRevenueCents).toBe(40000); // 4 * 10000
    expect(res.revenueByAgent[0]).toMatchObject({ agentId: 'ag1', revenueCents: 40000, bookingRate: 0.4 });
    expect(res.missedOpportunities).toBe(3);
    expect(res.missedRevenueCents).toBe(30000);
    expect(res.missedCallsPrevented).toBe(7);
    expect(res.dailyRevenue[0]).toMatchObject({ date: '2026-01-02', appointmentsBooked: 2, revenueCents: 20000 });
  });

  it('uses the default ticket value and zeroes for an empty range', async () => {
    dispatch([]);
    const res = await getRevenueAttribution('t1', FROM, TO);
    expect(res).toMatchObject({ totalRevenueCents: 0, totalAppointmentsBooked: 0, avgTicketValueCents: 15000, revenueByAgent: [], dailyRevenue: [] });
  });

  it('rolls back and rethrows on a query error', async () => {
    a.clientQueryMock.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM agents a')) throw new Error('boom');
      return { rows: [] };
    });
    await expect(getRevenueAttribution('t1', FROM, TO)).rejects.toThrow('boom');
    expect(a.clientQueryMock).toHaveBeenCalledWith('ROLLBACK');
    expect(a.releaseMock).toHaveBeenCalled();
  });
});
