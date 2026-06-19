import { describe, it, expect, vi, beforeEach } from 'vitest';

const a = vi.hoisted(() => ({ clientQueryMock: vi.fn(), releaseMock: vi.fn() }));

vi.mock('../db', () => ({
  getPlatformPool: () => ({ connect: async () => ({ query: a.clientQueryMock, release: a.releaseMock }) }),
  withTenantContext: async (_c: unknown, _t: string, cb: () => Promise<unknown>) => cb(),
}));
vi.mock('../core/logger', () => ({ createLogger: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn() }) }));

import { recordConversionStage, getConversionFunnel, getConversionTrends, FUNNEL_STAGES } from './ConversionFunnelService';

const FROM = new Date('2026-01-01T00:00:00Z');
const TO = new Date('2026-02-01T00:00:00Z');

beforeEach(() => {
  a.clientQueryMock.mockReset().mockResolvedValue({ rows: [] });
  a.releaseMock.mockReset();
});

describe('recordConversionStage', () => {
  it('inserts a stage row', async () => {
    await recordConversionStage('t1', 'cs1', 'call_received', { foo: 'bar' });
    const call = a.clientQueryMock.mock.calls.find(([s]) => String(s).includes('INSERT INTO call_conversion_stages'));
    expect(call).toBeTruthy();
    expect(a.releaseMock).toHaveBeenCalled();
  });
  it('swallows errors (best-effort)', async () => {
    a.clientQueryMock.mockRejectedValue(new Error('boom'));
    await expect(recordConversionStage('t1', 'cs1', 'call_received')).resolves.toBeUndefined();
  });
});

describe('getConversionFunnel', () => {
  it('builds per-stage counts, drop-off, and overall conversion', async () => {
    a.clientQueryMock.mockImplementation(async (sql: string) => {
      if (sql.includes('AS total')) return { rows: [{ total: 10 }] };
      if (sql.includes('GROUP BY ccs.stage')) return { rows: [{ stage: 'confirmed', count: 4 }] };
      return { rows: [] };
    });
    const res = await getConversionFunnel('t1', FROM, TO);
    expect(res.totalCalls).toBe(10);
    expect(res.overallConversionRate).toBeCloseTo(0.4);
    // call_received is seeded from totalCalls
    const received = res.stages.find((s) => s.stage === 'call_received');
    expect(received?.count).toBe(10);
    expect(res.stages).toHaveLength(FUNNEL_STAGES.length);
  });
  it('returns zeroes for an empty range', async () => {
    a.clientQueryMock.mockResolvedValue({ rows: [] });
    const res = await getConversionFunnel('t1', FROM, TO);
    expect(res.totalCalls).toBe(0);
    expect(res.overallConversionRate).toBe(0);
  });
  it('rolls back and rethrows on error', async () => {
    a.clientQueryMock.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM call_sessions')) throw new Error('boom');
      return { rows: [] };
    });
    await expect(getConversionFunnel('t1', FROM, TO)).rejects.toThrow('boom');
    expect(a.clientQueryMock).toHaveBeenCalledWith('ROLLBACK');
  });
});

describe('getConversionTrends', () => {
  it('groups counts by date and stage', async () => {
    a.clientQueryMock.mockResolvedValue({ rows: [
      { date: '2026-01-02', stage: 'call_received', count: 5 },
      { date: '2026-01-02', stage: 'confirmed', count: 2 },
      { date: '2026-01-03', stage: 'call_received', count: 3 },
    ] });
    const res = await getConversionTrends('t1', FROM, TO);
    expect(res).toHaveLength(2);
    expect(res[0]).toMatchObject({ date: '2026-01-02', stages: { call_received: 5, confirmed: 2 } });
  });
  it('returns [] on error', async () => {
    a.clientQueryMock.mockRejectedValue(new Error('boom'));
    expect(await getConversionTrends('t1', FROM, TO)).toEqual([]);
  });
});
