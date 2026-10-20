// @vitest-environment node
//
// Codex P1/P2 on #135: a state move written after the final call state (a
// tool run still open at hangup, a transfer, a bookkeeping write that landed
// late) must not take the call out of CALL_COMPLETED / CALL_FAILED, and its
// other columns are still written. Runs the real callPersistence code against
// a real Postgres, on session-local TEMP tables with the columns it touches
// and a session-local copy of the call_lifecycle_state enum (migrations 005 +
// 043; no migration, no shared data). Skips cleanly when DATABASE_URL is unset
// or unreachable, like the other real-DB suites.
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

/** call_lifecycle_state as migrations 005 and 043 define it. */
const LIFECYCLE_STATES = [
  'CALL_RECEIVED', 'SESSION_INITIALIZED', 'AGENT_CONNECTED', 'ACTIVE_CONVERSATION', 'WORKFLOW_EXECUTION',
  'TOOL_EXECUTION', 'ESCALATION_CHECK', 'ESCALATED', 'CALL_COMPLETED', 'CALL_FAILED', 'WORKFLOW_FAILED',
  'ESCALATION_FAILED', 'HANDOFF',
];

describe.skipIf(!db.client)('terminal-state guard (real Postgres)', () => {
  beforeAll(async () => {
    // In pg_temp: unqualified type names resolve there first, so the TEMP
    // tables (and the guard's CASE / $3) use this enum, not a migrated one.
    await db.client!.query(`CREATE TYPE pg_temp.call_lifecycle_state AS ENUM (${LIFECYCLE_STATES.map((s) => `'${s}'`).join(', ')})`);
    await db.client!.query(`CREATE TEMP TABLE call_sessions (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      lifecycle_state call_lifecycle_state NOT NULL DEFAULT 'CALL_RECEIVED',
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
      from_state call_lifecycle_state, to_state call_lifecycle_state, payload JSONB, occurred_at TIMESTAMPTZ
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

  it('a transfer landing after session_closed keeps CALL_COMPLETED, writes its other columns and files the ESCALATED ticket', async () => {
    await updateCallStateWithEvent('t-1', 'cs-1', 'CALL_COMPLETED', { type: 'session_closed', from: 'ACTIVE_CONVERSATION', to: 'CALL_COMPLETED' });
    await db.client!.query(`UPDATE call_sessions SET updated_at = NULL WHERE id = 'cs-1'`);
    await updateCallState('t-1', 'cs-1', 'ESCALATED', {
      escalationTarget: '+15550001111', escalationReason: 'caller asked for a person',
      workflowId: 'wf-1', context: { transfer: true }, agentId: 'a-2',
    });
    const { rows } = await db.client!.query(
      `SELECT lifecycle_state, escalation_target, escalation_reason, workflow_id, context, agent_id, updated_at FROM call_sessions WHERE id = 'cs-1'`,
    );
    expect(rows[0]).toMatchObject({
      lifecycle_state: 'CALL_COMPLETED',
      escalation_target: '+15550001111',
      escalation_reason: 'caller asked for a person',
      workflow_id: 'wf-1',
      context: { transfer: true },
      agent_id: 'a-2',
    });
    expect(rows[0].updated_at).not.toBeNull();
    const tickets = await db.client!.query(`SELECT subject FROM tickets WHERE call_id = 'cs-1'`);
    expect(tickets.rows).toEqual([{ subject: 'Escalated call: caller asked for a person' }]);
  });

  it('a failed ticket INSERT does not roll back escalation_target / escalation_reason (savepoint)', async () => {
    await finalizeCallSession('t-1', 'cs-1', 'completed');
    await db.client!.query(`ALTER TABLE tickets ADD CONSTRAINT tickets_reject_all CHECK (false) NOT VALID`);
    try {
      await updateCallState('t-1', 'cs-1', 'ESCALATED', { escalationTarget: '+15550001111', escalationReason: 'caller asked for a person' });
      await updateCallStateWithEvent('t-1', 'cs-1', 'ESCALATED', { type: 'escalated', from: 'ACTIVE_CONVERSATION', to: 'ESCALATED' });
    } finally {
      await db.client!.query(`ALTER TABLE tickets DROP CONSTRAINT tickets_reject_all`);
    }
    const { rows } = await db.client!.query(
      `SELECT lifecycle_state, escalation_target, escalation_reason FROM call_sessions WHERE id = 'cs-1'`,
    );
    expect(rows[0]).toEqual({
      lifecycle_state: 'CALL_COMPLETED',
      escalation_target: '+15550001111',
      escalation_reason: 'caller asked for a person',
    });
    expect((await db.client!.query(`SELECT 1 FROM tickets`)).rows).toEqual([]);
    // The event written after the failed ticket, in the same transaction, is kept too.
    const events = await db.client!.query(`SELECT event_type FROM call_events WHERE call_session_id = 'cs-1'`);
    expect(events.rows.map((r) => r.event_type)).toEqual(['escalated']);
  });

  it('CALL_FAILED is terminal too', async () => {
    await finalizeCallSession('t-1', 'cs-1', 'failed');
    await updateCallState('t-1', 'cs-1', 'ACTIVE_CONVERSATION');
    expect(await stateOf('cs-1')).toBe('CALL_FAILED');
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
