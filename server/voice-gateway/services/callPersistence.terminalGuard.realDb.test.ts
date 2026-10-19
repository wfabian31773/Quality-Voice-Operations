// @vitest-environment node
//
// Codex P1/P2 on #135: a state move written after the final call state (a
// tool run still open at hangup, a bookkeeping write that landed late) must
// not take the call out of CALL_COMPLETED / CALL_FAILED. Runs the real
// callPersistence code against a real Postgres, on session-local TEMP tables
// with the columns it touches (no migration, no shared data). Skips cleanly
// when DATABASE_URL is unset or unreachable, like the other real-DB suites.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from 'pg';

const db = vi.hoisted(() => ({ client: null as import('pg').Client | null }));

vi.mock('../../../platform/db', () => ({
  // Every transaction runs on the one test connection, which owns the TEMP tables.
  getPlatformPool: () => ({
    connect: async () => ({
      query: (sql: string, values?: unknown[]) => db.client!.query(sql, values),
      release: () => {},
    }),
  }),
  withTenantContext: async (_c: unknown, _t: string, cb: () => Promise<void>) => cb(),
}));
vi.mock('../../../platform/core/logger', () => ({ createLogger: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn() }) }));
vi.mock('../../../platform/analytics/ConversionFunnelService', () => ({ recordConversionStage: vi.fn(async () => {}) }));

import { finalizeCallSession, updateCallState, updateCallStateWithEvent } from './callPersistence';
import { BookkeepingQueue } from './bookkeepingQueue';

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

async function stateOf(id: string): Promise<string> {
  const { rows } = await db.client!.query(`SELECT lifecycle_state FROM call_sessions WHERE id = $1`, [id]);
  return rows[0].lifecycle_state as string;
}

describe.skipIf(!db.client)('terminal-state guard (real Postgres)', () => {
  beforeAll(async () => {
    await db.client!.query(`CREATE TEMP TABLE call_sessions (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      lifecycle_state TEXT NOT NULL DEFAULT 'CALL_RECEIVED',
      escalation_target TEXT,
      escalation_reason TEXT,
      workflow_id TEXT,
      context JSONB DEFAULT '{}',
      agent_id TEXT,
      end_time TIMESTAMPTZ,
      duration_seconds INT,
      total_cost_cents INT,
      updated_at TIMESTAMPTZ
    )`);
    await db.client!.query(`CREATE TEMP TABLE call_events (
      id TEXT PRIMARY KEY, tenant_id TEXT, call_session_id TEXT, event_type TEXT,
      from_state TEXT, to_state TEXT, payload JSONB, occurred_at TIMESTAMPTZ
    )`);
    await db.client!.query(`CREATE TEMP TABLE tickets (
      id TEXT PRIMARY KEY, tenant_id TEXT, call_id TEXT, subject TEXT, description TEXT, status TEXT, priority TEXT
    )`);
  });

  beforeEach(async () => {
    await db.client!.query(`TRUNCATE call_sessions, call_events, tickets`);
    await db.client!.query(`INSERT INTO call_sessions (id, tenant_id, lifecycle_state) VALUES ('cs-1', 't-1', 'TOOL_EXECUTION')`);
  });

  afterAll(async () => {
    await db.client?.end().catch(() => {});
  });

  it('a tool_end landing after finalize leaves CALL_COMPLETED; its event row is still written', async () => {
    await finalizeCallSession('t-1', 'cs-1', 'completed', 42, 7);
    await updateCallStateWithEvent('t-1', 'cs-1', 'ACTIVE_CONVERSATION', { type: 'tool_end', from: 'TOOL_EXECUTION', to: 'ACTIVE_CONVERSATION' });
    expect(await stateOf('cs-1')).toBe('CALL_COMPLETED');
    const { rows } = await db.client!.query(`SELECT event_type FROM call_events WHERE call_session_id = 'cs-1'`);
    expect(rows.map((r) => r.event_type)).toEqual(['tool_end']);
  });

  it('CALL_FAILED is terminal too, and a late ESCALATED files no ticket', async () => {
    await finalizeCallSession('t-1', 'cs-1', 'failed');
    await updateCallState('t-1', 'cs-1', 'ESCALATED', { escalationReason: 'late' });
    expect(await stateOf('cs-1')).toBe('CALL_FAILED');
    const { rowCount } = await db.client!.query(`SELECT 1 FROM tickets`);
    expect(rowCount).toBe(0);
  });

  it('a call not yet final still moves, and finalize may overwrite one terminal state with another', async () => {
    await updateCallState('t-1', 'cs-1', 'ACTIVE_CONVERSATION');
    expect(await stateOf('cs-1')).toBe('ACTIVE_CONVERSATION');
    await finalizeCallSession('t-1', 'cs-1', 'failed');
    await finalizeCallSession('t-1', 'cs-1', 'completed');
    expect(await stateOf('cs-1')).toBe('CALL_COMPLETED');
  });

  it('a write run from the bookkeeping queue gets a DB statement timeout and still hits the guard', async () => {
    await finalizeCallSession('t-1', 'cs-1', 'completed');
    const queue = new BookkeepingQueue({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } });
    const spy = vi.spyOn(db.client!, 'query');
    let failed = false;
    await queue.enqueue('call_state.tool_end', async () => {
      try {
        await updateCallStateWithEvent('t-1', 'cs-1', 'ACTIVE_CONVERSATION', {
          type: 'tool_end', from: 'TOOL_EXECUTION', to: 'ACTIVE_CONVERSATION',
        });
      } catch {
        failed = true;
      }
    });
    expect(failed).toBe(false);
    expect(spy.mock.calls.map((c) => c[0])).toContain('SET LOCAL statement_timeout = 4000');
    spy.mockRestore();
    expect(await stateOf('cs-1')).toBe('CALL_COMPLETED');
    // SET LOCAL ends with its transaction: the connection is back to its default.
    const { rows } = await db.client!.query(`SHOW statement_timeout`);
    expect(rows[0].statement_timeout).not.toBe('4s');
  });
});
