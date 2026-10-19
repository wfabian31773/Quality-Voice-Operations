import { describe, it, expect, vi, beforeEach } from 'vitest';

const a = vi.hoisted(() => ({ clientQueryMock: vi.fn(), releaseMock: vi.fn(), recordStageMock: vi.fn() }));

vi.mock('../../../platform/db', () => ({
  getPlatformPool: () => ({ connect: async () => ({ query: a.clientQueryMock, release: a.releaseMock }) }),
  withTenantContext: async (_c: unknown, _t: string, cb: () => Promise<void>) => cb(),
}));
vi.mock('../../../platform/core/logger', () => ({ createLogger: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn() }) }));
vi.mock('../../../platform/analytics/ConversionFunnelService', () => ({ recordConversionStage: a.recordStageMock }));
vi.mock('../../../platform/security/FieldEncryption', () => ({
  encryptTranscript: vi.fn(async (_t: string, v: string) => `enc:${v}`),
  encryptSensitiveField: vi.fn(async (_t: string, v: string) => `enc:${v}`),
  decryptSensitiveField: vi.fn(async (_t: string, v: string) => v.replace(/^enc:/, '')),
}));

import {
  createCallSession,
  writeCallEvent,
  updateCallState,
  updateCallStateWithEvent,
  finalizeCallSession,
  persistCallOutcome,
  PERSIST_CALL_OUTCOME_SQL,
  KEEP_TERMINAL_STATE_SQL,
  TERMINAL_LIFECYCLE_STATES,
} from './callPersistence';
import { BOOKKEEPING_STATEMENT_TIMEOUT_MS, BOOKKEEPING_WRITE_TIMEOUT_MS, BookkeepingQueue } from './bookkeepingQueue';

beforeEach(() => {
  a.clientQueryMock.mockReset().mockResolvedValue({ rows: [] });
  a.releaseMock.mockReset();
  a.recordStageMock.mockReset().mockResolvedValue(undefined);
  process.env.QVO_PII_LOOKUP_HMAC_KEY = 'a-secure-lookup-key-with-at-least-32-characters';
  process.env.QVO_PII_LOOKUP_HMAC_KEY_VERSION = '2026-07-blue';
});

describe('createCallSession', () => {
  it('inserts an encrypted caller number and records the conversion stage', async () => {
    const id = await createCallSession({ tenantId: 't1', agentId: 'ag1', callSid: 'CA1', direction: 'inbound', callerNumber: '+15551230000', calledNumber: '+15559990000', language: 'en' });
    expect(typeof id).toBe('string');
    const insert = a.clientQueryMock.mock.calls.find(([s]) => String(s).includes('INSERT INTO call_sessions'));
    expect(insert).toBeTruthy();
    expect(insert?.[1]).toContain('enc:+15551230000');
    expect(insert?.[1]).toContainEqual(expect.stringMatching(/^[a-f0-9]{64}$/));
    expect(String(insert?.[0])).toContain('caller_lookup_hash');
    expect(String(insert?.[0])).toContain('caller_lookup_key_version');
    expect(insert?.[1]).toContain('2026-07-blue');
    expect(insert?.[1]).toContain(JSON.stringify({ recordingPolicy: { policy: 'disabled', status: 'not_recorded' } }));
    expect(a.recordStageMock).toHaveBeenCalledWith('t1', id, 'call_received', expect.objectContaining({ direction: 'inbound' }));
  });
  it('stores a null caller number when none is given', async () => {
    await createCallSession({ tenantId: 't1', agentId: 'ag1', callSid: 'CA1', direction: 'outbound', callerNumber: '', calledNumber: '+1' });
    const insert = a.clientQueryMock.mock.calls.find(([s]) => String(s).includes('INSERT INTO call_sessions'));
    expect(insert?.[1]?.[6]).toBeNull();
  });
});

describe('transcript persistence', () => {
  it('persists normalized transcript lines as tenant-scoped dashboard evidence', async () => {
    const adapter = (await import('./callPersistence')).createPlatformPersistenceAdapter('t1');
    await adapter.updateTranscript('t1', 'cs1', 'User: Necesito una cita\nAssistant: Claro, puedo tomar la solicitud.');
    const deleteCall = a.clientQueryMock.mock.calls.find(([s]) => String(s).includes('DELETE FROM call_transcripts'));
    const insertCalls = a.clientQueryMock.mock.calls.filter(([s]) => String(s).includes('INSERT INTO call_transcripts'));
    expect(deleteCall?.[1]).toEqual(['t1', 'cs1']);
    expect(insertCalls).toHaveLength(2);
    expect(insertCalls[0][1]).toEqual(expect.arrayContaining(['t1', 'cs1', 'user', 'Necesito una cita', 0]));
    expect(insertCalls[1][1]).toEqual(expect.arrayContaining(['t1', 'cs1', 'assistant', 'Claro, puedo tomar la solicitud.', 1]));
  });
});

describe('writeCallEvent', () => {
  it('inserts a call event row', async () => {
    await writeCallEvent('t1', 'cs1', 'state_change', 'CALL_RECEIVED', 'ESCALATED', { reason: 'x' });
    expect(a.clientQueryMock.mock.calls.some(([s]) => String(s).includes('INSERT INTO call_events'))).toBe(true);
  });
});

describe('updateCallState', () => {
  it('assembles the SET clause for the provided extras', async () => {
    await updateCallState('t1', 'cs1', 'ACTIVE_CONVERSATION', { workflowId: 'wf1', context: { a: 1 }, agentId: 'ag2' });
    const upd = a.clientQueryMock.mock.calls.find(([s]) => String(s).includes('UPDATE call_sessions SET'));
    expect(String(upd?.[0])).toContain('workflow_id =');
    expect(String(upd?.[0])).toContain('context =');
    expect(String(upd?.[0])).toContain('agent_id =');
  });
  it('auto-creates a ticket on escalation when none exists', async () => {
    a.clientQueryMock.mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT id FROM tickets')) return { rows: [] };
      return { rows: [] };
    });
    await updateCallState('t1', 'cs1', 'ESCALATED', { escalationReason: 'angry caller' });
    expect(a.clientQueryMock.mock.calls.some(([s]) => String(s).includes('INSERT INTO tickets'))).toBe(true);
  });
  it('does not create a duplicate ticket when one already exists', async () => {
    a.clientQueryMock.mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT id FROM tickets')) return { rows: [{ id: 'tk1' }] };
      return { rows: [] };
    });
    await updateCallState('t1', 'cs1', 'ESCALATED');
    expect(a.clientQueryMock.mock.calls.some(([s]) => String(s).includes('INSERT INTO tickets'))).toBe(false);
  });
});

describe('terminal-state guard (Codex P1/P2 on #135)', () => {
  const stateUpdate = () => a.clientQueryMock.mock.calls.find(([s]) => String(s).includes('UPDATE call_sessions SET'));

  /**
   * One call_sessions row that applies an UPDATE's SET list the way Postgres
   * would: `col = $n` assignments, the KEEP_TERMINAL_STATE_SQL CASE, and (to
   * fail on 5ac743e0) its whole-row `AND lifecycle_state NOT IN (...)` guard.
   */
  function fakeRow(initial: Record<string, unknown>) {
    const row: Record<string, unknown> = { ...initial };
    const terminal = () => (TERMINAL_LIFECYCLE_STATES as readonly unknown[]).includes(row.lifecycle_state);
    a.clientQueryMock.mockImplementation(async (sql: string, values: unknown[] = []) => {
      if (!sql.startsWith('UPDATE call_sessions SET')) return { rows: [], rowCount: 1 };
      const [setList, where] = sql.slice('UPDATE call_sessions SET '.length).split(' WHERE ');
      if (where.includes('lifecycle_state NOT IN') && terminal()) return { rows: [], rowCount: 0 };
      const keepTerminal = setList.includes(KEEP_TERMINAL_STATE_SQL);
      const wasTerminal = terminal();
      for (const [, col, n] of setList.matchAll(/(\w+) = \$(\d+)/g)) row[col] = values[Number(n) - 1];
      if (keepTerminal && !wasTerminal) row.lifecycle_state = values[2];
      return { rows: [], rowCount: 1 };
    });
    return row;
  }

  it('the terminal states are CALL_COMPLETED and CALL_FAILED; only the state column is guarded', () => {
    expect([...TERMINAL_LIFECYCLE_STATES]).toEqual(['CALL_COMPLETED', 'CALL_FAILED']);
    expect(KEEP_TERMINAL_STATE_SQL).toBe("lifecycle_state = CASE WHEN lifecycle_state IN ('CALL_COMPLETED', 'CALL_FAILED') THEN lifecycle_state ELSE $3 END");
  });

  it('updateCallState and updateCallStateWithEvent set the state through the guard, with no row filter', async () => {
    await updateCallState('t1', 'cs1', 'ESCALATED', { escalationTarget: '+15550001111', escalationReason: 'caller asked' });
    const sql = String(stateUpdate()?.[0]);
    expect(sql.startsWith(`UPDATE call_sessions SET ${KEEP_TERMINAL_STATE_SQL}, updated_at = NOW(), escalation_target = $4, escalation_reason = $5`)).toBe(true);
    expect(sql.endsWith('WHERE tenant_id = $1 AND id = $2')).toBe(true);
    a.clientQueryMock.mockClear();
    await updateCallStateWithEvent('t1', 'cs1', 'ACTIVE_CONVERSATION', { type: 'tool_end', from: 'TOOL_EXECUTION', to: 'ACTIVE_CONVERSATION' });
    expect(String(stateUpdate()?.[0])).toContain(KEEP_TERMINAL_STATE_SQL);
  });

  it('a state move on a call not yet final still moves it', async () => {
    const row = fakeRow({ lifecycle_state: 'TOOL_EXECUTION' });
    await updateCallStateWithEvent('t1', 'cs1', 'ACTIVE_CONVERSATION', { type: 'tool_end', from: 'TOOL_EXECUTION', to: 'ACTIVE_CONVERSATION' });
    expect(row.lifecycle_state).toBe('ACTIVE_CONVERSATION');
  });

  it('a transfer landing after session_closed keeps CALL_COMPLETED but writes escalation_target / escalation_reason and files the ESCALATED ticket', async () => {
    const row = fakeRow({ lifecycle_state: 'ACTIVE_CONVERSATION' });
    // Teardown queues session_closed first (the transport emits 'close' synchronously) ...
    await updateCallStateWithEvent('t1', 'cs1', 'CALL_COMPLETED', { type: 'session_closed', from: 'ACTIVE_CONVERSATION', to: 'CALL_COMPLETED' });
    // ... then the transfer's ESCALATED (stream.ts onEscalation / call_state.escalated) lands.
    await updateCallState('t1', 'cs1', 'ESCALATED', { escalationTarget: '+15550001111', escalationReason: 'caller asked for a person' });
    expect(row.lifecycle_state).toBe('CALL_COMPLETED');
    expect(row.escalation_target).toBe('+15550001111');
    expect(row.escalation_reason).toBe('caller asked for a person');
    const ticket = a.clientQueryMock.mock.calls.find(([s]) => String(s).includes('INSERT INTO tickets'));
    expect(ticket?.[1]).toEqual(['t1', 'cs1', 'Escalated call: caller asked for a person', expect.stringContaining('Reason: caller asked for a person')]);
  });

  it('a late tool_end on a final call still writes its event row (history), not the state', async () => {
    const row = fakeRow({ lifecycle_state: 'CALL_COMPLETED' });
    await updateCallStateWithEvent('t1', 'cs1', 'ACTIVE_CONVERSATION', { type: 'tool_end', from: 'TOOL_EXECUTION', to: 'ACTIVE_CONVERSATION' });
    expect(row.lifecycle_state).toBe('CALL_COMPLETED');
    expect(a.clientQueryMock.mock.calls.some(([s]) => String(s).includes('INSERT INTO call_events'))).toBe(true);
    expect(a.clientQueryMock.mock.calls.map(([s]) => s)).toContain('COMMIT');
  });

  it('finalizeCallSession still writes the final state over any state (no guard)', async () => {
    await finalizeCallSession('t1', 'cs1', 'failed');
    expect(String(stateUpdate()?.[0])).not.toContain('CASE WHEN');
  });
});

describe('bookkeeping statement timeout (P2 option b)', () => {
  const statementTimeouts = () => a.clientQueryMock.mock.calls.filter(([s]) => String(s).startsWith('SET LOCAL statement_timeout'));

  it('is SET LOCAL right after BEGIN on a transaction a bookkeeping queue write runs', async () => {
    const queue = new BookkeepingQueue({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } });
    await queue.enqueue('call_state.tool_end', () => updateCallStateWithEvent('t1', 'cs1', 'ACTIVE_CONVERSATION', { type: 'tool_end', from: 'TOOL_EXECUTION', to: 'ACTIVE_CONVERSATION' }));
    expect(statementTimeouts()).toEqual([[`SET LOCAL statement_timeout = ${BOOKKEEPING_STATEMENT_TIMEOUT_MS}`]]);
    const sqls = a.clientQueryMock.mock.calls.map(([s]) => String(s));
    expect(sqls.indexOf('BEGIN')).toBe(sqls.findIndex((s) => s.startsWith('SET LOCAL statement_timeout')) - 1);
    expect(BOOKKEEPING_STATEMENT_TIMEOUT_MS).toBeLessThan(BOOKKEEPING_WRITE_TIMEOUT_MS);
  });

  it('is never set for the same helpers called outside the queue', async () => {
    await updateCallState('t1', 'cs1', 'ACTIVE_CONVERSATION');
    await updateCallStateWithEvent('t1', 'cs1', 'TOOL_EXECUTION', { type: 'tool_start', from: 'ACTIVE_CONVERSATION', to: 'TOOL_EXECUTION' });
    await writeCallEvent('t1', 'cs1', 'call_completed', 'ACTIVE_CONVERSATION', 'CALL_COMPLETED');
    await finalizeCallSession('t1', 'cs1', 'completed');
    expect(statementTimeouts()).toEqual([]);
  });
});

describe('persistCallOutcome', () => {
  it('merges context.callEndOutcome in a tenant transaction, keeping other keys and any existing outcome', async () => {
    await persistCallOutcome('t1', 'cs1', 'never_heard');
    const upd = a.clientQueryMock.mock.calls.find(([s]) => String(s).includes('UPDATE call_sessions'));
    expect(upd?.[0]).toBe(PERSIST_CALL_OUTCOME_SQL);
    expect(upd?.[1]).toEqual(['t1', 'cs1', 'never_heard']);
    expect(PERSIST_CALL_OUTCOME_SQL).toContain("COALESCE(context, '{}'::jsonb) || jsonb_build_object('callEndOutcome'");
    expect(PERSIST_CALL_OUTCOME_SQL).toContain("NOT (COALESCE(context, '{}'::jsonb) ? 'callEndOutcome')");
    // The record_call_outcome tool's key is never written or tested here.
    expect(PERSIST_CALL_OUTCOME_SQL).not.toMatch(/'callOutcome'/);
    expect(a.clientQueryMock.mock.calls.map(([s]) => s)).toEqual(expect.arrayContaining(['BEGIN', 'COMMIT']));
  });
});

describe('finalizeCallSession', () => {
  it('maps a failed status to CALL_FAILED', async () => {
    await finalizeCallSession('t1', 'cs1', 'failed', 30, 100);
    const upd = a.clientQueryMock.mock.calls.find(([s]) => String(s).includes('UPDATE call_sessions SET'));
    expect(upd?.[1]).toContain('CALL_FAILED');
  });
  it('maps any other status to CALL_COMPLETED', async () => {
    await finalizeCallSession('t1', 'cs1', 'completed');
    const upd = a.clientQueryMock.mock.calls.find(([s]) => String(s).includes('UPDATE call_sessions SET'));
    expect(upd?.[1]).toContain('CALL_COMPLETED');
  });
});
