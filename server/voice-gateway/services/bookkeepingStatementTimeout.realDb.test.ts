// @vitest-environment node
//
// #143 review P3: a queued write outside callPersistence (here the real
// UsageRecorder meter) gets the bookkeeping statement timeout, so a statement
// stuck in its transaction is cancelled by Postgres and the call's queue moves
// on. Runs against a real Postgres on a session-local TEMP table (no
// migration, no shared data); the stuck statement is a pg_sleep run inside the
// writer's transaction, on its connection. Skips cleanly when DATABASE_URL is
// unset or unreachable, like the other real-DB suites.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Client } from 'pg';

const db = vi.hoisted(() => ({
  client: null as import('pg').Client | null,
  /** Runs on the test connection before each statement the code under test sends. */
  beforeQuery: null as ((sql: string) => Promise<void>) | null,
}));

vi.mock('../../../platform/db', () => {
  // Every transaction runs on the one test connection, which owns the TEMP table.
  const pool = {
    connect: async () => ({
      query: async (sql: string, values?: unknown[]) => {
        await db.beforeQuery?.(sql);
        return db.client!.query(sql, values);
      },
      release: () => {},
    }),
  };
  return {
    getPlatformPool: () => pool,
    withTenantContext: async (_c: unknown, _t: string, cb: () => Promise<void>) => cb(),
  };
});
vi.mock('../../../platform/core/logger', () => ({ createLogger: () => ({ debug: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn() }) }));

import { recordToolExecution } from '../../../platform/billing/usage/UsageRecorder';
import { BOOKKEEPING_STATEMENT_TIMEOUT_MS, BookkeepingQueue } from './bookkeepingQueue';
import { withBookkeepingStatementTimeout } from './bookkeepingStatementTimeout';

const URL_RAW = process.env.DATABASE_URL ?? '';

async function connectOrNull(): Promise<Client | null> {
  if (!URL_RAW) return null;
  const client = new Client({ connectionString: URL_RAW, connectionTimeoutMillis: 2_000 });
  try {
    await client.connect();
    await client.query('SELECT 1');
    return client;
  } catch {
    await client.end().catch(() => {});
    return null;
  }
}

db.client = await connectOrNull();

describe.skipIf(!db.client)('bookkeeping statement timeout on a platform writer (real Postgres)', () => {
  beforeAll(async () => {
    await db.client!.query(`CREATE TYPE pg_temp.usage_metric_type AS ENUM ('tool_executions')`);
    await db.client!.query(`CREATE TEMP TABLE usage_metrics (
      id UUID PRIMARY KEY, tenant_id TEXT NOT NULL, metric_type usage_metric_type NOT NULL,
      period_start TIMESTAMPTZ NOT NULL, period_end TIMESTAMPTZ NOT NULL, quantity INT NOT NULL,
      unit_cost_cents INT, total_cost_cents INT, updated_at TIMESTAMPTZ,
      UNIQUE (tenant_id, metric_type, period_start)
    )`);
  });

  afterAll(async () => {
    await db.client?.end().catch(() => {});
  });

  it('a meter statement stuck past the timeout is cancelled, the meter rolls back, and the queue runs the next write', async () => {
    const queue = new BookkeepingQueue({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } });
    db.beforeQuery = async (sql) => {
      if (sql.trim().startsWith('INSERT INTO usage_metrics')) await db.client!.query('SELECT pg_sleep(8)');
    };
    const ran: string[] = [];
    const startedAt = Date.now();
    try {
      void queue.enqueue('meter.tool_execution', async () => {
        await withBookkeepingStatementTimeout(() => recordToolExecution('t-1', 1));
        ran.push('meter');
      });
      await queue.enqueue('after', async () => { ran.push('after'); });
    } finally {
      db.beforeQuery = null;
    }

    const waited = Date.now() - startedAt;
    expect(ran).toEqual(['meter', 'after']);
    expect(waited).toBeGreaterThanOrEqual(BOOKKEEPING_STATEMENT_TIMEOUT_MS - 100);
    expect(waited).toBeLessThan(BOOKKEEPING_STATEMENT_TIMEOUT_MS + 2_000);
    // Rolled back: nothing metered.
    expect((await db.client!.query(`SELECT 1 FROM usage_metrics`)).rows).toEqual([]);
    // SET LOCAL ended with the transaction: the connection is back to its default.
    const { rows } = await db.client!.query(`SHOW statement_timeout`);
    expect(rows[0].statement_timeout).not.toBe('4s');
  }, 15_000);

  it('the same meter outside the scope is not bounded by it (the write lands)', async () => {
    db.beforeQuery = async (sql) => {
      if (sql.trim().startsWith('INSERT INTO usage_metrics')) await db.client!.query('SELECT pg_sleep(0.2)');
    };
    try {
      await recordToolExecution('t-1', 1);
    } finally {
      db.beforeQuery = null;
    }
    expect((await db.client!.query(`SELECT quantity FROM usage_metrics`)).rows).toEqual([{ quantity: 1 }]);
  });
});
