/**
 * The queued writes that don't go through callPersistence (ToolExecutionService's
 * tool_invocations rows, UsageRecorder's meter, TrialGuard) run with the
 * bookkeeping statement timeout: SET LOCAL right after their own BEGIN, in
 * the same transaction. Real writers over a recording pool; one client per
 * checkout, so each transaction's statements are grouped by client.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const g = vi.hoisted(() => ({
  log: [] as Array<{ conn: number; sql: string }>,
  conns: 0,
  /** Throws for a statement, like Postgres cancelling it. */
  failOn: null as RegExp | null,
  /** Hands out this client on every checkout when set (a pooled connection reused). */
  shared: null as { query: (sql: string) => Promise<unknown>; release: () => void } | null,
}));

vi.mock('../../../platform/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../platform/db')>();
  const client = () => {
    const conn = ++g.conns;
    return {
      query: async (sql: string) => {
        g.log.push({ conn, sql: sql.replace(/\s+/g, ' ').trim() });
        if (g.failOn?.test(sql)) throw Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' });
        return { rows: [], rowCount: 0 };
      },
      release: () => {},
    };
  };
  const pool = {
    query: async () => ({ rows: [], rowCount: 0 }),
    connect: async () => g.shared ?? client(),
  };
  return { ...actual, getPlatformPool: () => pool };
});
vi.mock('../../../platform/core/logger', () => ({ createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }) }));
vi.mock('../../../platform/core/observability/traceLogger', () => ({ recordTrace: async () => {} }));
vi.mock('../../../platform/activation/ActivationService', () => ({ recordActivationEvent: async () => {} }));
vi.mock('../../../platform/core/observability', () => ({ logError: () => {} }));

import { getPlatformPool } from '../../../platform/db';
import { createToolExecution } from '../../../platform/tools/ToolExecutionService';
import { BOOKKEEPING_STATEMENT_TIMEOUT_SQL, BookkeepingQueue } from './bookkeepingQueue';
import { withBookkeepingStatementTimeout } from './bookkeepingStatementTimeout';
import { beginToolRun, finishToolRun, type ToolRunCall } from './toolBookkeeping';

const CALL: ToolRunCall = { tenantId: 't-1' as never, callSessionId: 'cs-1', agentId: 'ag-1', toolName: 'lookup_customer', args: { q: 'x' }, isTrial: true };

/** Each checkout's statements, in order. */
function transactions(): string[][] {
  const byConn = new Map<number, string[]>();
  for (const { conn, sql } of g.log) byConn.set(conn, [...(byConn.get(conn) ?? []), sql]);
  return [...byConn.values()];
}

function logger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

beforeEach(() => {
  g.log.length = 0;
  g.failOn = null;
  g.shared = null;
});

describe('bookkeeping statement timeout for the platform writers', () => {
  it('tool_invocations create + complete, the meter and the trial check each SET LOCAL the timeout right after their BEGIN', async () => {
    const queue = new BookkeepingQueue({ log: logger() });
    const run = beginToolRun(CALL, queue);
    finishToolRun(CALL, { run, startTime: Date.now(), result: { ok: false }, status: 'failed', errorMessage: 'nope' }, queue);
    expect(await queue.flush()).toBe('drained');

    const txs = transactions();
    const writer = (pattern: RegExp) => txs.find((tx) => tx.some((sql) => pattern.test(sql)));
    for (const pattern of [/^INSERT INTO tool_invocations/, /^UPDATE tool_invocations/, /^INSERT INTO usage_metrics/, /FROM subscriptions/]) {
      const tx = writer(pattern);
      expect(tx, String(pattern)).toBeDefined();
      expect(tx!.slice(0, 2)).toEqual(['BEGIN', BOOKKEEPING_STATEMENT_TIMEOUT_SQL]);
    }
    // callPersistence's own transactions keep theirs (once, not twice).
    for (const tx of txs) expect(tx.filter((sql) => sql === BOOKKEEPING_STATEMENT_TIMEOUT_SQL)).toHaveLength(1);
  });

  it('outside a queue write the writers are untouched, and a pooled client goes back to plain after release', async () => {
    await createToolExecution({ tenantId: 't-1' as never, toolName: 'x', parameters: {} });
    await withBookkeepingStatementTimeout(() => createToolExecution({ tenantId: 't-1' as never, toolName: 'x', parameters: {} }));
    expect(g.log.map((l) => l.sql)).not.toContain(BOOKKEEPING_STATEMENT_TIMEOUT_SQL);

    const sql: string[] = [];
    g.shared = { query: async (s: string) => { sql.push(s); return { rows: [] }; }, release: () => {} };
    const queue = new BookkeepingQueue({ log: logger() });
    await queue.enqueue('tool_invocations.create', () => withBookkeepingStatementTimeout(() =>
      createToolExecution({ tenantId: 't-1' as never, toolName: 'x', parameters: {} })));
    expect(sql.filter((s) => s === BOOKKEEPING_STATEMENT_TIMEOUT_SQL)).toHaveLength(1);
    sql.length = 0;
    await createToolExecution({ tenantId: 't-1' as never, toolName: 'x', parameters: {} });
    expect(sql).not.toContain(BOOKKEEPING_STATEMENT_TIMEOUT_SQL);
  });

  it('a statement Postgres cancels fails the write like any other: the queue logs its code only and moves on', async () => {
    const log = logger();
    const queue = new BookkeepingQueue({ log });
    g.failOn = /^SELECT pg_sleep/;
    const ran: string[] = [];
    void queue.enqueue('platform.write', () => withBookkeepingStatementTimeout(async () => {
      const client = await getPlatformPool().connect();
      try {
        await client.query('BEGIN');
        await client.query('SELECT pg_sleep(30)');
      } finally {
        client.release();
      }
    }));
    // The meter swallows its own DB errors (UsageRecorder logs and returns), so the next write runs too.
    g.failOn = /^SELECT pg_sleep|INSERT INTO usage_metrics/;
    void queue.enqueue('meter.tool_execution', async () => {
      const { recordToolExecution } = await import('../../../platform/billing/usage/UsageRecorder');
      await withBookkeepingStatementTimeout(() => recordToolExecution('t-1', 1));
      ran.push('meter');
    });
    await queue.enqueue('after', async () => { ran.push('after'); });

    expect(ran).toEqual(['meter', 'after']);
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledWith('Bookkeeping write failed; the queue moves on', { write: 'platform.write', error: '57014' });
    expect(JSON.stringify(log.warn.mock.calls)).not.toContain('canceling statement');
  });
});
