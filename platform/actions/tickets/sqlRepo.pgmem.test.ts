// Exercises sqlTicketsRepo's SQL through the real actions on pg-mem, so the
// queries run locally without Postgres. RLS is covered by
// postgres.integration.test.ts; pg-mem has no policies.
import { randomUUID } from 'node:crypto';
import { DataType, newDb } from 'pg-mem';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMemoryStore, runAction, type ActionContext, type ActionResult, type TenantTx } from '../core';
import { createTicketsActions, OPEN_COMMIT, OPEN_PREPARE } from './actions';
import { sqlTicketsRepo } from './repo';

const TENANT = 'tenant-a';
const OTHER = 'tenant-b';
const NOW = new Date('2026-10-17T15:00:00.000Z');

const SCHEMA = `
  CREATE TABLE tenants (id TEXT PRIMARY KEY, name TEXT NOT NULL, settings JSONB DEFAULT '{}');
  CREATE TABLE users (id TEXT PRIMARY KEY);
  CREATE TABLE user_roles (user_id TEXT NOT NULL, tenant_id TEXT NOT NULL, role TEXT);
  CREATE TABLE call_sessions (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL);
  CREATE TABLE ticket_sla_policies (
    id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
    tenant_id TEXT NOT NULL, name TEXT NOT NULL, priority TEXT NOT NULL, category_id TEXT,
    first_response_minutes INT NOT NULL DEFAULT 480, resolution_minutes INT NOT NULL DEFAULT 2880,
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE TABLE ticket_sla_instances (
    id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid()::text,
    tenant_id VARCHAR NOT NULL,
    ticket_id VARCHAR NOT NULL,
    policy_id VARCHAR NOT NULL REFERENCES ticket_sla_policies(id),
    response_due_at TIMESTAMPTZ,
    resolution_due_at TIMESTAMPTZ,
    response_met BOOLEAN DEFAULT NULL,
    resolution_met BOOLEAN DEFAULT NULL,
    paused_at TIMESTAMPTZ,
    total_paused_minutes INT DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE TABLE tickets (
    id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
    tenant_id TEXT NOT NULL,
    call_id TEXT REFERENCES call_sessions(id),
    subject TEXT NOT NULL,
    description TEXT DEFAULT '',
    status TEXT NOT NULL DEFAULT 'open',
    priority TEXT NOT NULL DEFAULT 'medium',
    assignee_user_id TEXT,
    source TEXT DEFAULT 'manual',
    ticket_number SERIAL,
    resolved_at TIMESTAMPTZ,
    closed_at TIMESTAMPTZ,
    reopened_count INT DEFAULT 0,
    contact_name TEXT DEFAULT '',
    contact_phone TEXT DEFAULT '',
    created_by_user_id TEXT REFERENCES users(id),
    archived_at TIMESTAMPTZ,
    kind TEXT NOT NULL DEFAULT 'message',
    callback_due_at TIMESTAMPTZ,
    intake JSONB NOT NULL DEFAULT '{}',
    urgency TEXT NOT NULL DEFAULT 'normal',
    source_call_ref VARCHAR(128),
    first_response_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE TABLE ticket_activity_log (
    id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
    tenant_id TEXT NOT NULL,
    ticket_id TEXT NOT NULL REFERENCES tickets(id),
    user_id TEXT REFERENCES users(id),
    activity_type TEXT NOT NULL,
    content TEXT DEFAULT '', old_value TEXT DEFAULT '', new_value TEXT DEFAULT '', field_name TEXT DEFAULT '',
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE TABLE ticket_outbox (
    id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid()::text,
    tenant_id VARCHAR,
    event_type VARCHAR(100) NOT NULL,
    payload JSONB NOT NULL DEFAULT '{}',
    status VARCHAR(20) NOT NULL DEFAULT 'pending',
    attempts INT NOT NULL DEFAULT 0,
    last_error TEXT,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
  );
`;

/** pg-mem lacks row locks; strip FOR UPDATE at the client boundary only. */
function pgMemTx(client: { query: (sql: string, values?: unknown[]) => Promise<{ rows: unknown[]; rowCount?: number | null }> }): TenantTx {
  return {
    query: async (sql, values) => {
      const result = await client.query(sql.replace(/\s+FOR UPDATE\b/g, ''), values);
      return { rows: result.rows as Record<string, unknown>[], rowCount: result.rowCount };
    },
  };
}

describe('sqlTicketsRepo on pg-mem', () => {
  const mem = newDb();
  const locks: string[] = [];
  mem.public.registerFunction({
    name: 'pg_advisory_xact_lock',
    args: [DataType.bigint],
    returns: DataType.text,
    implementation: (key: unknown) => {
      locks.push(String(key));
      return '';
    },
  });
  mem.public.registerFunction({
    name: 'gen_random_uuid',
    returns: DataType.uuid,
    implementation: () => randomUUID(),
    impure: true,
  });
  mem.public.none(SCHEMA);
  const { Pool } = mem.adapters.createPg();
  const pool = new Pool();
  let tx: TenantTx;
  let release: () => void;

  beforeAll(async () => {
    const client = await pool.connect();
    release = () => client.release();
    tx = pgMemTx(client);
    await tx.query(
      `INSERT INTO tenants (id, name, settings) VALUES ($1, 'Dana Plumbing', $2::jsonb), ($3, 'Other', '{}'::jsonb)`,
      [TENANT, JSON.stringify({ tickets: { ownerName: 'Dana', slaText: 'usually within 2 business hours' } }), OTHER],
    );
    await tx.query(`INSERT INTO users (id) VALUES ('owner-1'), ('staff-1')`);
    await tx.query(`INSERT INTO user_roles (user_id, tenant_id, role) VALUES ('staff-1', $1, 'technician')`, [TENANT]);
    await tx.query(`INSERT INTO call_sessions (id, tenant_id) VALUES ('call-1', $1), ('call-foreign', $2)`, [TENANT, OTHER]);
    await tx.query(
      `INSERT INTO ticket_sla_policies (tenant_id, name, priority, first_response_minutes) VALUES ($1, 'Callbacks', 'medium', 90)`,
      [TENANT],
    );
  });

  afterAll(async () => {
    release();
    await pool.end();
  });

  function run(name: string, ctx: ActionContext, input: unknown) {
    const store = createMemoryStore();
    return runAction(name, ctx, input, {
      store,
      registry: createTicketsActions(),
      withTenantTx: async (_tenantId, fn) => fn(tx),
    });
  }

  function ok<T>(result: ActionResult): T {
    if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
    return result.data as T;
  }

  const agent = (overrides: Partial<ActionContext> = {}): ActionContext => ({
    tenantId: TENANT,
    actor: { type: 'agent', id: 'agent-1' },
    now: NOW,
    tenantTimezone: 'America/New_York',
    callId: 'call-1',
    ...overrides,
  });
  const owner = (overrides: Partial<ActionContext> = {}): ActionContext =>
    agent({ actor: { type: 'user', id: 'owner-1', role: 'tenant_owner' }, callId: undefined, ...overrides });

  // One shared action store per prepare/commit pair keeps the proposal visible to commit.
  async function open(input: Record<string, unknown>, ctx = agent()) {
    const store = createMemoryStore();
    const deps = { store, registry: createTicketsActions(), withTenantTx: async <T>(_t: string, fn: (t: TenantTx) => Promise<T>) => fn(tx) };
    const prepared = await runAction(OPEN_PREPARE, { ...ctx, idempotencyKey: randomUUID() }, input, deps);
    const data = ok<{ confirmationToken: string; payloadHash: string; readback: string }>(prepared);
    const committed = await runAction(OPEN_COMMIT, ctx, { confirmationToken: data.confirmationToken, payloadHash: data.payloadHash }, deps);
    return { readback: data.readback, committed };
  }

  let ticketId = '';

  it('opens a ticket with tenant settings, SLA policy due time and the linked call', async () => {
    const { readback, committed } = await open({
      kind: 'callback',
      subject: 'the leaking sink',
      customer: { name: 'Luis', phone: '+1 555 010 0142' },
    });
    expect(readback).toBe(
      "I'll pass this to Dana: a callback request about the leaking sink, callback at 555, 010, 0142, usually within 2 business hours.",
    );
    const data = ok<{ ticketId: string; ticketNumber: number; dueAt: string; deduped: boolean }>(committed);
    expect(data).toMatchObject({ deduped: false, dueAt: '2026-10-17T16:30:00.000Z' });
    expect(typeof data.ticketNumber).toBe('number');
    ticketId = data.ticketId;

    const { rows } = await tx.query(
      `SELECT call_id, source_call_ref, kind, urgency, source, priority, intake FROM tickets WHERE id = $1`,
      [ticketId],
    );
    expect(rows[0]).toMatchObject({
      call_id: 'call-1',
      source_call_ref: 'call-1',
      kind: 'callback',
      urgency: 'normal',
      source: 'ai_agent',
      priority: 'medium',
    });
    expect(locks).toHaveLength(1);

    const { rows: outbox } = await tx.query(`SELECT tenant_id, event_type, status, payload FROM ticket_outbox`);
    expect(outbox).toHaveLength(1);
    expect(outbox[0]).toMatchObject({ tenant_id: TENANT, event_type: 'ticket.opened', status: 'pending' });
    expect(outbox[0].payload).toMatchObject({ ticketId, kind: 'callback', callId: 'call-1' });

    // The policy that set the due time also gets an SLA instance on the same clock.
    const { rows: sla } = await tx.query(
      `SELECT i.tenant_id, i.response_due_at, i.resolution_due_at, p.name
         FROM ticket_sla_instances i JOIN ticket_sla_policies p ON p.id = i.policy_id
        WHERE i.ticket_id = $1`,
      [ticketId],
    );
    expect(sla).toHaveLength(1);
    expect(sla[0]).toMatchObject({ tenant_id: TENANT, name: 'Callbacks' });
    expect(new Date(sla[0].response_due_at as string).toISOString()).toBe(data.dueAt);
    expect(new Date(sla[0].resolution_due_at as string).getTime()).toBe(NOW.getTime() + 2880 * 60_000);
  });

  it('writes no SLA instance when the due time comes from tenant settings', async () => {
    await tx.query(`UPDATE tenants SET settings = $2::jsonb WHERE id = $1`, [OTHER, JSON.stringify({ tickets: { callbackSlaMinutes: 120 } })]);
    await tx.query(
      `INSERT INTO ticket_sla_policies (tenant_id, name, priority, first_response_minutes) VALUES ($1, 'Unused', 'medium', 15)`,
      [OTHER],
    );
    const { committed } = await open(
      { kind: 'callback', subject: 'settings deadline', customer: { phone: '555-010-3333' } },
      agent({ tenantId: OTHER, callId: undefined }),
    );
    const { ticketId: otherId, dueAt } = ok<{ ticketId: string; dueAt: string }>(committed);
    expect(dueAt).toBe('2026-10-17T17:00:00.000Z');
    const { rows } = await tx.query(`SELECT count(*)::int AS n FROM ticket_sla_instances WHERE tenant_id = $1`, [OTHER]);
    expect(Number(rows[0].n)).toBe(0);
    // Keep the other tenant empty for the list checks below.
    await tx.query(`DELETE FROM ticket_outbox WHERE tenant_id = $1`, [OTHER]);
    await tx.query(`DELETE FROM ticket_activity_log WHERE ticket_id = $1`, [otherId]);
    await tx.query(`DELETE FROM tickets WHERE id = $1`, [otherId]);
  });

  it('dedupes a repeat within the call into a note and leaves call_id null for unknown calls', async () => {
    await tx.query(
      `INSERT INTO ticket_sla_policies (tenant_id, name, priority, first_response_minutes, resolution_minutes)
       VALUES ($1, 'Urgent', 'urgent', 30, 240)`,
      [TENANT],
    );
    const again = await open({ kind: 'callback', subject: 'sink again', customer: { phone: '555-010-0142' }, urgency: 'urgent' });
    // The urgent policy moves the deadline earlier (16:30 -> 15:30).
    expect(ok(again.committed)).toMatchObject({ ticketId, deduped: true, dueAt: '2026-10-17T15:30:00.000Z' });
    const { rows } = await tx.query(`SELECT count(*)::int AS n FROM tickets WHERE tenant_id = $1`, [TENANT]);
    expect(Number(rows[0].n)).toBe(1);
    const { rows: urgent } = await tx.query(`SELECT urgency, priority FROM tickets WHERE id = $1`, [ticketId]);
    expect(urgent[0]).toMatchObject({ urgency: 'urgent', priority: 'urgent' });
    // The dedupe tightened the existing SLA instance instead of adding one.
    const { rows: sla } = await tx.query(`SELECT response_due_at, resolution_due_at FROM ticket_sla_instances WHERE ticket_id = $1`, [ticketId]);
    expect(sla).toHaveLength(1);
    expect(new Date(sla[0].response_due_at as string).toISOString()).toBe('2026-10-17T15:30:00.000Z');
    expect(new Date(sla[0].resolution_due_at as string).toISOString()).toBe('2026-10-17T19:00:00.000Z');

    const unknownCall = await open(
      { kind: 'message', subject: 'hours', customer: { phone: '555-010-7777' } },
      agent({ callId: 'not-a-session' }),
    );
    const { ticketId: otherId } = ok<{ ticketId: string }>(unknownCall.committed);
    const { rows: linked } = await tx.query(`SELECT call_id, source_call_ref FROM tickets WHERE id = $1`, [otherId]);
    expect(linked[0]).toMatchObject({ call_id: null, source_call_ref: 'not-a-session' });

    // Deduped repeat wrote no outbox row; the two new tickets wrote one each.
    const { rows: outbox } = await tx.query(`SELECT payload FROM ticket_outbox WHERE event_type = 'ticket.opened'`);
    expect(outbox.map((row) => (row.payload as { ticketId: string }).ticketId).sort()).toEqual([ticketId, otherId].sort());
  });

  it("never links another tenant's call as tickets.call_id (no RLS here, like the postgres role)", async () => {
    const foreign = await open(
      { kind: 'message', subject: 'wrong tenant call', customer: { phone: '555-010-8888' } },
      agent({ callId: 'call-foreign' }),
    );
    const { ticketId: foreignId } = ok<{ ticketId: string }>(foreign.committed);
    const { rows } = await tx.query(`SELECT tenant_id, call_id, source_call_ref FROM tickets WHERE id = $1`, [foreignId]);
    expect(rows[0]).toMatchObject({ tenant_id: TENANT, call_id: null, source_call_ref: 'call-foreign' });
    // Keep later list counts unchanged.
    await tx.query(`DELETE FROM ticket_activity_log WHERE ticket_id = $1`, [foreignId]);
    await tx.query(`DELETE FROM tickets WHERE id = $1`, [foreignId]);
  });

  it('adds notes, updates with transitions and reads back with notes', async () => {
    const later = new Date(NOW.getTime() + 60_000);
    ok(await run('tickets.add_note', owner({ idempotencyKey: 'n1', now: later }), { ticketId, note: 'Left a voicemail' }));
    const assigned = ok<{ assigneeId: string; status: string }>(
      await run('tickets.update', owner({ idempotencyKey: 'u1' }), {
        ticketId,
        assigneeId: 'staff-1',
        status: 'in_progress',
        dueAt: '2026-10-17T14:00:00Z',
      }),
    );
    expect(assigned).toMatchObject({ assigneeId: 'staff-1', status: 'in_progress' });
    const bad = await run('tickets.update', owner({ idempotencyKey: 'u2' }), { ticketId, assigneeId: 'owner-1' });
    expect(!bad.ok && bad.error.field).toBe('assigneeId');
    ok(await run('tickets.update', owner({ idempotencyKey: 'u3' }), { ticketId, status: 'resolved' }));
    const { rows } = await tx.query(`SELECT resolved_at, status FROM tickets WHERE id = $1`, [ticketId]);
    expect(rows[0].status).toBe('resolved');
    expect(rows[0].resolved_at).not.toBeNull();
    ok(await run('tickets.update', owner({ idempotencyKey: 'u4' }), { ticketId, status: 'reopened' }));

    const detail = ok<{ callId: string; notes: Array<{ content: string }>; overdue: boolean; status: string }>(
      await run('tickets.get', owner(), { ticketId }),
    );
    expect(detail).toMatchObject({ callId: 'call-1', status: 'reopened', overdue: true });
    expect(detail.notes.map((n) => n.content)).toEqual([
      expect.stringContaining('Repeated during the same call: sink again'),
      'Left a voicemail',
    ]);

    const { rows: activity } = await tx.query(
      `SELECT activity_type, user_id FROM ticket_activity_log WHERE ticket_id = $1 ORDER BY created_at, activity_type`,
      [ticketId],
    );
    expect(activity.map((a) => a.activity_type)).toContain('status_change');
    expect(activity.find((a) => a.activity_type === 'assigned')?.user_id).toBe('owner-1');
  });

  it('reads back the newest 50 notes in chronological order', async () => {
    await tx.query(`DELETE FROM ticket_activity_log WHERE ticket_id = $1 AND activity_type = 'note'`, [ticketId]);
    for (let i = 0; i < 55; i++) {
      await tx.query(
        `INSERT INTO ticket_activity_log (tenant_id, ticket_id, activity_type, content, created_at) VALUES ($1, $2, 'note', $3, $4)`,
        [TENANT, ticketId, `note ${i}`, new Date(NOW.getTime() + i * 1000)],
      );
    }
    const detail = ok<{ notes: Array<{ content: string }> }>(await run('tickets.get', owner(), { ticketId }));
    expect(detail.notes.map((n) => n.content)).toEqual(Array.from({ length: 50 }, (_, i) => `note ${i + 5}`));
  });

  it('lists open, overdue and kind filters scoped to the tenant', async () => {
    const ids = async (input: Record<string, unknown>, ctx = owner()) =>
      ok<{ tickets: Array<{ id: string; kind: string }> }>(await run('tickets.list', ctx, input)).tickets;
    expect((await ids({ status: 'overdue' })).map((t) => t.id)).toEqual([ticketId]);
    expect((await ids({ kind: 'message' })).every((t) => t.kind === 'message')).toBe(true);
    expect(await ids({ status: 'all' })).toHaveLength(2);
    expect(await ids({ status: 'all' }, owner({ tenantId: OTHER }))).toEqual([]);
    const foreign = await run('tickets.get', owner({ tenantId: OTHER }), { ticketId });
    expect(!foreign.ok && foreign.error.code).toBe('NOT_FOUND');
  });

  it('keeps SLA instances in sync on pending, first assignment and resolve, tenant-scoped', async () => {
    const at = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000);
    const iso = (value: unknown) => (value ? new Date(value as string).toISOString() : null);
    const { committed } = await open({ kind: 'message', subject: 'sla sync', customer: { phone: '555-010-4444' } }, owner());
    const { ticketId: slaId } = ok<{ ticketId: string }>(committed);

    // Another tenant's ticket and instance that nothing below may touch.
    const { rows: otherPolicy } = await tx.query(`SELECT id FROM ticket_sla_policies WHERE tenant_id = $1 LIMIT 1`, [OTHER]);
    await tx.query(`INSERT INTO tickets (id, tenant_id, subject) VALUES ('other-sla', $1, 'other')`, [OTHER]);
    await tx.query(
      `INSERT INTO ticket_sla_instances (tenant_id, ticket_id, policy_id, response_due_at, resolution_due_at)
       VALUES ($1, 'other-sla', $2, $3, $4)`,
      [OTHER, otherPolicy[0].id, at(90), at(2880)],
    );
    const instance = async (id: string) => {
      const { rows } = await tx.query(
        `SELECT response_due_at, resolution_due_at, response_met, resolution_met, paused_at, total_paused_minutes
           FROM ticket_sla_instances WHERE ticket_id = $1`,
        [id],
      );
      expect(rows).toHaveLength(1);
      const row = rows[0];
      return {
        response: iso(row.response_due_at),
        resolution: iso(row.resolution_due_at),
        responseMet: row.response_met,
        resolutionMet: row.resolution_met,
        pausedAt: iso(row.paused_at),
        pausedMinutes: Number(row.total_paused_minutes),
      };
    };
    const otherBefore = await instance('other-sla');
    let key = 0;
    const update = (input: Record<string, unknown>, now: Date) =>
      run('tickets.update', owner({ idempotencyKey: `sla${(key += 1)}`, now }), { ticketId: slaId, ...input });

    ok(await update({ status: 'pending' }, at(10)));
    expect(await instance(slaId)).toMatchObject({ pausedAt: at(10).toISOString(), response: at(90).toISOString() });

    // Out of pending 30 min later, assigned for the first time and resolved in one update.
    ok(await update({ status: 'resolved', assigneeId: 'staff-1' }, at(40)));
    expect(await instance(slaId)).toEqual({
      response: at(120).toISOString(),
      resolution: at(2910).toISOString(),
      responseMet: true,
      resolutionMet: true,
      pausedAt: null,
      pausedMinutes: 30,
    });
    const { rows: ticketRows } = await tx.query(`SELECT first_response_at FROM tickets WHERE id = $1`, [slaId]);
    expect(iso(ticketRows[0].first_response_at)).toBe(at(40).toISOString());

    // A foreign tenant scope cannot reach this tenant's instance, even with its ticket id.
    const foreign = sqlTicketsRepo(tx, OTHER);
    await foreign.pauseSla(slaId, at(50));
    await foreign.recordFirstResponse(slaId, true, at(50));
    expect((await instance(slaId)).pausedAt).toBeNull();
    expect(await instance('other-sla')).toEqual(otherBefore);
    const { rows: otherTicket } = await tx.query(`SELECT first_response_at FROM tickets WHERE id = 'other-sla'`);
    expect(otherTicket[0].first_response_at).toBeNull();
  });
});
