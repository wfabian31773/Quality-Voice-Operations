/**
 * Verifies the /platform/call-events-retention read-only admin endpoint
 * surfaces the right shape for the Platform Admin retention tile.
 *
 * The route joins:
 *   - the bookkeeping table written by CallEventsRetentionScheduler
 *   - pg_inherits/pg_class for the live partition list
 *   - CALL_EVENTS_RETENTION_DEFAULTS for the staleness threshold
 *
 * We mock the platform pool so the test exercises the endpoint's
 * status-derivation logic (stale vs. fresh, missing-next-month, last
 * failure) without depending on Postgres.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import express, { type Request, type Response } from 'express';
import request from 'supertest';

interface MockPool {
  query: ReturnType<typeof vi.fn>;
}

const mockPool: MockPool = { query: vi.fn() };

vi.mock('../../platform/db', () => ({
  getPlatformPool: () => mockPool,
}));

vi.mock('../../platform/core/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('../../server/admin-api/middleware/auth', () => ({
  requireAuth: (_req: Request, _res: Response, next: () => void) => next(),
}));

vi.mock('../../server/admin-api/middleware/rbac', () => ({
  requirePlatformAdmin: (_req: Request, _res: Response, next: () => void) => next(),
}));

async function buildApp() {
  const router = (await import('../../server/admin-api/routes/platformCallEventsRetention')).default;
  const app = express();
  app.use(express.json());
  app.use(router);
  return app;
}

function thisMonthName(): string {
  const d = new Date();
  d.setUTCDate(1);
  d.setUTCHours(0, 0, 0, 0);
  return `call_events_${d.getUTCFullYear()}_${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function nextMonthName(): string {
  const d = new Date();
  d.setUTCDate(1);
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCMonth(d.getUTCMonth() + 1);
  return `call_events_${d.getUTCFullYear()}_${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function thisMonthBoundsExpr(): string {
  const start = new Date();
  start.setUTCDate(1);
  start.setUTCHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setUTCMonth(end.getUTCMonth() + 1);
  return `FOR VALUES FROM ('${start.toISOString().slice(0, 10)}') TO ('${end.toISOString().slice(0, 10)}')`;
}

function nextMonthBoundsExpr(): string {
  const start = new Date();
  start.setUTCDate(1);
  start.setUTCHours(0, 0, 0, 0);
  start.setUTCMonth(start.getUTCMonth() + 1);
  const end = new Date(start);
  end.setUTCMonth(end.getUTCMonth() + 1);
  return `FOR VALUES FROM ('${start.toISOString().slice(0, 10)}') TO ('${end.toISOString().slice(0, 10)}')`;
}

beforeEach(() => {
  mockPool.query.mockReset();
});

describe('GET /platform/call-events-retention', () => {
  it('returns healthy status when last cycle is fresh and both partitions exist', async () => {
    const app = await buildApp();

    mockPool.query
      .mockResolvedValueOnce({
        rows: [
          { name: thisMonthName(), bounds: thisMonthBoundsExpr() },
          { name: nextMonthName(), bounds: nextMonthBoundsExpr() },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            id: '1',
            started_at: new Date(Date.now() - 60_000).toISOString(),
            finished_at: new Date(Date.now() - 50_000).toISOString(),
            status: 'success',
            retention_days: 90,
            ensured_partitions: [thisMonthName(), nextMonthName()],
            dropped_partitions: [],
            error_message: null,
          },
        ],
      });

    const res = await request(app).get('/platform/call-events-retention');

    expect(res.status).toBe(200);
    expect(res.body.status.healthy).toBe(true);
    expect(res.body.status.stale).toBe(false);
    expect(res.body.status.missingNextMonth).toBe(false);
    expect(res.body.status.lastRunFailed).toBe(false);
    expect(res.body.partitionsExist.currentMonth).toBe(true);
    expect(res.body.partitionsExist.nextMonth).toBe(true);
    expect(res.body.partitions).toHaveLength(2);
    expect(res.body.partitions[0].lower_bound).toMatch(/^\d{4}-\d{2}-\d{2}/);
    expect(res.body.lastSuccessfulRun).not.toBeNull();
    expect(res.body.recentRuns).toHaveLength(1);
    expect(res.body.expected.currentMonthPartition).toBe(thisMonthName());
    expect(res.body.expected.nextMonthPartition).toBe(nextMonthName());
  });

  it('flags stale and missing-next-month when applicable', async () => {
    const app = await buildApp();

    // Only this month's partition exists; last successful run is 30 hours old.
    mockPool.query
      .mockResolvedValueOnce({
        rows: [{ name: thisMonthName(), bounds: thisMonthBoundsExpr() }],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            id: '1',
            started_at: new Date(Date.now() - 30 * 60 * 60 * 1000).toISOString(),
            finished_at: new Date(Date.now() - 30 * 60 * 60 * 1000 + 1000).toISOString(),
            status: 'success',
            retention_days: 90,
            ensured_partitions: [thisMonthName()],
            dropped_partitions: [],
            error_message: null,
          },
        ],
      });

    const res = await request(app).get('/platform/call-events-retention');

    expect(res.status).toBe(200);
    expect(res.body.status.healthy).toBe(false);
    expect(res.body.status.stale).toBe(true);
    expect(res.body.status.missingNextMonth).toBe(true);
    expect(res.body.status.reasons).toContain(
      `Next month's partition (${nextMonthName()}) is missing`,
    );
  });

  it('flags neverRan when no bookkeeping rows exist', async () => {
    const app = await buildApp();

    mockPool.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    const res = await request(app).get('/platform/call-events-retention');

    expect(res.status).toBe(200);
    expect(res.body.status.neverRan).toBe(true);
    expect(res.body.status.stale).toBe(true);
    expect(res.body.status.healthy).toBe(false);
    expect(res.body.lastRun).toBeNull();
    expect(res.body.lastSuccessfulRun).toBeNull();
  });

  it('parses partition bounds even when pg_get_expr emits casts and extra parens', async () => {
    const app = await buildApp();

    mockPool.query
      .mockResolvedValueOnce({
        rows: [
          {
            name: thisMonthName(),
            bounds:
              "FOR VALUES FROM (('2025-07-01'::date)) TO (('2025-08-01'::date))",
          },
          {
            name: nextMonthName(),
            bounds:
              "FOR VALUES FROM ('2025-08-01 00:00:00+00'::timestamp with time zone) TO ('2025-09-01 00:00:00+00'::timestamp with time zone)",
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] });

    const res = await request(app).get('/platform/call-events-retention');

    expect(res.status).toBe(200);
    expect(res.body.partitions[0].lower_bound).toBe('2025-07-01');
    expect(res.body.partitions[0].upper_bound).toBe('2025-08-01');
    expect(res.body.partitions[1].lower_bound).toBe('2025-08-01 00:00:00+00');
    expect(res.body.partitions[1].upper_bound).toBe('2025-09-01 00:00:00+00');
  });

  it('flags lastRunFailed when most recent row is a failure', async () => {
    const app = await buildApp();

    mockPool.query
      .mockResolvedValueOnce({
        rows: [
          { name: thisMonthName(), bounds: thisMonthBoundsExpr() },
          { name: nextMonthName(), bounds: nextMonthBoundsExpr() },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            id: '2',
            started_at: new Date(Date.now() - 60_000).toISOString(),
            finished_at: new Date(Date.now() - 50_000).toISOString(),
            status: 'failure',
            retention_days: 90,
            ensured_partitions: [],
            dropped_partitions: [],
            error_message: 'connection reset',
          },
          {
            id: '1',
            started_at: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
            finished_at: new Date(Date.now() - 9 * 60 * 1000).toISOString(),
            status: 'success',
            retention_days: 90,
            ensured_partitions: [thisMonthName(), nextMonthName()],
            dropped_partitions: [],
            error_message: null,
          },
        ],
      });

    const res = await request(app).get('/platform/call-events-retention');

    expect(res.status).toBe(200);
    expect(res.body.status.lastRunFailed).toBe(true);
    expect(res.body.status.healthy).toBe(false);
    expect(res.body.lastRun.status).toBe('failure');
    expect(res.body.lastSuccessfulRun.status).toBe('success');
  });
});
