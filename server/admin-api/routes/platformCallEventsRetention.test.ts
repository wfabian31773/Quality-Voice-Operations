import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const a = vi.hoisted(() => ({
  user: { userId: 'u1', tenantId: 't1', email: 'e@x.com', role: 'operations_manager', isPlatformAdmin: true },
  queryMock: vi.fn(),
}));

vi.mock('../middleware/auth', () => ({
  requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    req.user = a.user as never;
    next();
  },
}));
vi.mock('../../../platform/db', () => ({ getPlatformPool: () => ({ query: a.queryMock }) }));
vi.mock('../../../platform/billing/CallEventsRetentionScheduler', () => ({
  CALL_EVENTS_RETENTION_DEFAULTS: { intervalMs: 86_400_000, retainDays: 90 },
}));

import router from './platformCallEventsRetention';

function app() {
  const app = express();
  app.use(router);
  return app;
}

// Mirror expectedPartitionName() so the test sets up partitions matching the
// month the handler computes at runtime.
function partName(offset: number): string {
  const t = new Date();
  t.setUTCDate(1);
  t.setUTCHours(0, 0, 0, 0);
  t.setUTCMonth(t.getUTCMonth() + offset);
  return `call_events_${t.getUTCFullYear()}_${String(t.getUTCMonth() + 1).padStart(2, '0')}`;
}
const CURRENT = partName(0);
const NEXT = partName(1);

function setup(opts: { partitions?: string[]; runs?: Record<string, unknown>[] }) {
  const partitions = opts.partitions ?? [CURRENT, NEXT];
  a.queryMock.mockImplementation(async (sql: string) => {
    if (sql.includes('pg_inherits')) {
      return { rows: partitions.map((name) => ({ name, bounds: `FOR VALUES FROM ('2026-06-01') TO ('2026-07-01')` })) };
    }
    if (sql.includes('call_events_retention_runs')) {
      return { rows: opts.runs ?? [] };
    }
    return { rows: [] };
  });
}

beforeEach(() => {
  a.user.isPlatformAdmin = true;
  a.queryMock.mockReset();
});

describe('GET /platform/call-events-retention', () => {
  it('rejects a non-platform-admin with 403', async () => {
    a.user.isPlatformAdmin = false;
    setup({});
    expect((await request(app()).get('/platform/call-events-retention')).status).toBe(403);
  });

  it('reports healthy when partitions exist and a recent cycle succeeded', async () => {
    setup({ runs: [{ id: '1', started_at: new Date().toISOString(), finished_at: new Date().toISOString(), status: 'success', retention_days: 90, ensured_partitions: [], dropped_partitions: [], error_message: null }] });
    const res = await request(app()).get('/platform/call-events-retention');
    expect(res.status).toBe(200);
    expect(res.body.status.healthy).toBe(true);
    expect(res.body.partitionsExist).toEqual({ currentMonth: true, nextMonth: true });
    expect(res.body.partitions[0]).toMatchObject({ lower_bound: '2026-06-01', upper_bound: '2026-07-01' });
  });

  it('flags a missing next-month partition', async () => {
    setup({ partitions: [CURRENT], runs: [{ id: '1', started_at: new Date().toISOString(), finished_at: new Date().toISOString(), status: 'success', retention_days: 90, ensured_partitions: [], dropped_partitions: [], error_message: null }] });
    const res = await request(app()).get('/platform/call-events-retention');
    expect(res.body.status.missingNextMonth).toBe(true);
    expect(res.body.status.healthy).toBe(false);
    expect(res.body.status.reasons.join(' ')).toContain(NEXT);
  });

  it('flags never-ran when there is no recorded cycle', async () => {
    setup({ runs: [] });
    const res = await request(app()).get('/platform/call-events-retention');
    expect(res.body.status.neverRan).toBe(true);
    expect(res.body.status.stale).toBe(true);
  });

  it('flags a failed last run and staleness for an old success', async () => {
    const old = new Date(Date.now() - 1000 * 60 * 60 * 48).toISOString();
    setup({ runs: [
      { id: '2', started_at: new Date().toISOString(), finished_at: new Date().toISOString(), status: 'failure', retention_days: 90, ensured_partitions: [], dropped_partitions: [], error_message: 'boom' },
      { id: '1', started_at: old, finished_at: old, status: 'success', retention_days: 90, ensured_partitions: [], dropped_partitions: [], error_message: null },
    ] });
    const res = await request(app()).get('/platform/call-events-retention');
    expect(res.body.status.lastRunFailed).toBe(true);
    expect(res.body.status.stale).toBe(true);
  });

  it('returns 500 when a query throws', async () => {
    a.queryMock.mockRejectedValue(new Error('db down'));
    expect((await request(app()).get('/platform/call-events-retention')).status).toBe(500);
  });
});
