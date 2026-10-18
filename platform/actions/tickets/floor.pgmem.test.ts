// Runs tickets.file_floor through sqlTicketsRepo on pg-mem, so the floor's
// queries (call artifact check, caller number, insert) execute locally without
// Postgres. RLS is covered by postgres.integration.test.ts; pg-mem has no policies.
import { randomUUID } from 'node:crypto';
import { DataType, newDb } from 'pg-mem';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMemoryStore, runAction, type ActionContext, type ActionResult, type TenantTx } from '../core';
import { createTicketsActions } from './actions';
import { FILE_FLOOR, FLOOR_SUBJECT, floorIdempotencyKey } from './floor';
import { sqlTicketsRepo } from './repo';

const TENANT = 'tenant-a';
const OTHER = 'tenant-b';
const NOW = new Date('2026-10-17T15:00:00.000Z');

const SCHEMA = `
  CREATE TABLE tenants (id TEXT PRIMARY KEY, name TEXT NOT NULL, settings JSONB DEFAULT '{}');
  CREATE TABLE users (id TEXT PRIMARY KEY);
  CREATE TABLE call_sessions (
    id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, call_sid TEXT, caller_number TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE TABLE ticket_sla_policies (
    id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
    tenant_id TEXT NOT NULL, name TEXT NOT NULL, priority TEXT NOT NULL, category_id TEXT,
    first_response_minutes INT NOT NULL DEFAULT 480, resolution_minutes INT NOT NULL DEFAULT 2880,
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE TABLE ticket_sla_instances (
    id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid()::text,
    tenant_id VARCHAR NOT NULL, ticket_id VARCHAR NOT NULL, policy_id VARCHAR NOT NULL,
    response_due_at TIMESTAMPTZ, resolution_due_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
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
    contact_name TEXT DEFAULT '',
    contact_phone TEXT DEFAULT '',
    created_by_user_id TEXT REFERENCES users(id),
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
  CREATE TABLE ticket_outbox (
    id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid()::text,
    tenant_id VARCHAR,
    event_type VARCHAR(100) NOT NULL,
    payload JSONB NOT NULL DEFAULT '{}',
    status VARCHAR(20) NOT NULL DEFAULT 'pending'
  );
  CREATE TABLE bookings (
    id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
    tenant_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'confirmed',
    cancellation_reason TEXT DEFAULT '',
    intake_data JSONB DEFAULT '{}'
  );
`;

describe('tickets.file_floor on pg-mem (sqlTicketsRepo)', () => {
  const mem = newDb();
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
    tx = {
      query: async (sql, values) => {
        const result = await client.query(sql, values);
        return { rows: result.rows as Record<string, unknown>[], rowCount: result.rowCount };
      },
    };
    await tx.query(`INSERT INTO tenants (id, name) VALUES ($1, 'Sharp Line'), ($2, 'Other')`, [TENANT, OTHER]);
  });

  afterAll(async () => {
    release();
    await pool.end();
  });

  const decrypted: string[] = [];
  function floor(callId: string, input: Record<string, unknown>, tenantId = TENANT) {
    const store = createMemoryStore();
    const registry = createTicketsActions({
      decryptCallerNumber: async (_tenant, stored) => {
        decrypted.push(stored);
        return stored === 'enc:caller' ? '+15550100142' : null;
      },
    });
    const ctx: ActionContext = {
      tenantId,
      actor: { type: 'system', id: 'voice-runtime' },
      now: NOW,
      tenantTimezone: 'America/New_York',
      callId,
      idempotencyKey: floorIdempotencyKey(callId),
    };
    return runAction(FILE_FLOOR, ctx, { callId, ...input }, { store, registry, withTenantTx: async (_t, fn) => fn(tx) });
  }

  function ok(result: ActionResult): { filed: boolean; reason: string; ticketId?: string } {
    if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
    return result.data as { filed: boolean; reason: string; ticketId?: string };
  }

  it('files one message ticket with call_id, caller phone from call_sessions and an outbox row', async () => {
    await tx.query(
      `INSERT INTO call_sessions (id, tenant_id, call_sid, caller_number) VALUES ('sess-1', $1, 'CA-1', 'enc:caller')`,
      [TENANT],
    );
    const out = ok(await floor('sess-1', { callerLines: ['I need a fade Friday'], callerName: 'Luis' }));
    expect(out).toMatchObject({ filed: true, reason: 'filed' });
    const { rows } = await tx.query(
      `SELECT tenant_id, call_id, source_call_ref, kind, urgency, priority, source, subject, description, contact_name, contact_phone
         FROM tickets WHERE id = $1`,
      [out.ticketId],
    );
    expect(rows[0]).toEqual({
      tenant_id: TENANT,
      call_id: 'sess-1',
      source_call_ref: 'sess-1',
      kind: 'message',
      urgency: 'normal',
      priority: 'medium',
      source: 'ai_agent',
      subject: FLOOR_SUBJECT,
      description: 'I need a fade Friday',
      contact_name: 'Luis',
      contact_phone: '+15550100142',
    });
    expect(decrypted).toEqual(['enc:caller']);
    const { rows: outbox } = await tx.query(`SELECT tenant_id, event_type, payload FROM ticket_outbox`);
    expect(outbox).toHaveLength(1);
    expect(outbox[0]).toMatchObject({ tenant_id: TENANT, event_type: 'ticket.opened' });
    expect(outbox[0].payload).toMatchObject({ ticketId: out.ticketId, callId: 'sess-1', floor: true });
  });

  it('counts a ticket linked by call_id through the call_sid as already filed', async () => {
    // A ticket whose call_id is the session row, while the runtime passes the Twilio CallSid.
    expect(ok(await floor('CA-1', { callerLines: ['I need a fade Friday'] }))).toEqual({
      filed: false,
      reason: 'already_filed',
    });
  });

  it('counts a booking from the call, but not a hold that never became one', async () => {
    await tx.query(
      `INSERT INTO bookings (tenant_id, status, cancellation_reason, intake_data) VALUES
         ($1, 'held', '', $2::jsonb),
         ($1, 'cancelled', 'hold_expired', $2::jsonb),
         ($1, 'cancelled', 'hold_superseded', $2::jsonb)`,
      [TENANT, JSON.stringify({ qvo: { session: 'CA-held', serviceIds: [] } })],
    );
    expect(ok(await floor('CA-held', { callerLines: ['I need a fade Friday'] }))).toMatchObject({ reason: 'filed' });

    await tx.query(`INSERT INTO bookings (tenant_id, status, intake_data) VALUES ($1, 'confirmed', $2::jsonb)`, [
      TENANT,
      JSON.stringify({ qvo: { session: 'CA-booked', serviceIds: [] } }),
    ]);
    expect(ok(await floor('CA-booked', { callerLines: ['I need a fade Friday'] }))).toEqual({
      filed: false,
      reason: 'already_filed',
    });
  });

  it("ignores another tenant's tickets, bookings and call row for the same call id", async () => {
    await tx.query(
      `INSERT INTO call_sessions (id, tenant_id, call_sid, caller_number) VALUES ('sess-b', $1, 'CA-shared', '+1 555 010 9999')`,
      [OTHER],
    );
    await tx.query(`INSERT INTO bookings (tenant_id, status, intake_data) VALUES ($1, 'confirmed', $2::jsonb)`, [
      OTHER,
      JSON.stringify({ qvo: { session: 'CA-shared' } }),
    ]);
    const out = ok(await floor('CA-shared', { callerLines: ['I need a fade Friday'] }));
    expect(out).toMatchObject({ filed: true });
    const { rows } = await tx.query(`SELECT tenant_id, call_id, contact_phone FROM tickets WHERE id = $1`, [out.ticketId]);
    expect(rows[0]).toEqual({ tenant_id: TENANT, call_id: null, contact_phone: '' });
    expect(await sqlTicketsRepo(tx, OTHER).get(out.ticketId!)).toBeNull();
  });
});
