// Exercises sqlTicketsRepo's SQL through the real actions on pg-mem, so the
// queries run locally without Postgres. RLS is covered by
// postgres.integration.test.ts; pg-mem has no policies.
import { randomUUID } from 'node:crypto';
import { DataType, newDb } from 'pg-mem';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMemoryStore, runAction, type ActionContext, type ActionResult, type TenantTx } from '../core';
import { createTicketsActions, OPEN_COMMIT, OPEN_PREPARE } from './actions';

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
    first_response_minutes INT NOT NULL DEFAULT 480, is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
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
    await tx.query(`INSERT INTO call_sessions (id, tenant_id) VALUES ('call-1', $1)`, [TENANT]);
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
      "I'll pass this to Dana: a callback request about the leaking sink, callback at the number ending 0142, usually within 2 business hours.",
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
  });

  it('dedupes a repeat within the call into a note and leaves call_id null for unknown calls', async () => {
    const again = await open({ kind: 'callback', subject: 'sink again', customer: { phone: '555-010-0142' }, urgency: 'urgent' });
    expect(ok(again.committed)).toMatchObject({ ticketId, deduped: true });
    const { rows } = await tx.query(`SELECT count(*)::int AS n FROM tickets WHERE tenant_id = $1`, [TENANT]);
    expect(Number(rows[0].n)).toBe(1);
    const { rows: urgent } = await tx.query(`SELECT urgency, priority FROM tickets WHERE id = $1`, [ticketId]);
    expect(urgent[0]).toMatchObject({ urgency: 'urgent', priority: 'urgent' });

    const unknownCall = await open(
      { kind: 'message', subject: 'hours', customer: { phone: '555-010-7777' } },
      agent({ callId: 'not-a-session' }),
    );
    const { ticketId: otherId } = ok<{ ticketId: string }>(unknownCall.committed);
    const { rows: linked } = await tx.query(`SELECT call_id, source_call_ref FROM tickets WHERE id = $1`, [otherId]);
    expect(linked[0]).toMatchObject({ call_id: null, source_call_ref: 'not-a-session' });
  });

  it('adds notes, updates with transitions and reads back with notes', async () => {
    ok(await run('tickets.add_note', owner({ idempotencyKey: 'n1' }), { ticketId, note: 'Left a voicemail' }));
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
});
