// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, Pool } from 'pg';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { postgresActionStore, runActionDefinition, type ActionContext, type ActionResult, type TenantTx } from '../core';
import { createTicketsActions, OPEN_COMMIT, OPEN_PREPARE } from './actions';

const ADMIN_URL_RAW = process.env.DATABASE_URL ?? process.env.DATABASE_URL_PRIVILEGED ?? 'postgresql://ubuntu@127.0.0.1:5432/postgres';

function adminUrl(database?: string): string | null {
  try {
    const url = new URL(ADMIN_URL_RAW);
    if (database) url.pathname = `/${database}`;
    return url.toString();
  } catch {
    return null;
  }
}

async function probeReachable(): Promise<boolean> {
  const url = adminUrl();
  if (!url) return false;
  const probe = new Client({ connectionString: url, connectionTimeoutMillis: 2_000 });
  try {
    await probe.connect();
    await probe.query('SELECT 1');
    return true;
  } catch {
    return false;
  } finally {
    await probe.end().catch(() => {});
  }
}

const dbReachable = await probeReachable();

const MIGRATIONS_DIR = path.join(process.cwd(), 'migrations');
const MIGRATION_123 = '123_tickets_v2.sql';

/** Same ordering rules as platform/actions/core/postgres.integration.test.ts. */
function loadMigrations(filter: (name: string) => boolean): { name: string; sql: string }[] {
  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d{3}_/.test(f) && f.endsWith('.sql'))
    .sort();
  const pins = files.indexOf('063_call_saved_view_pins.sql');
  const pinOrder = files.indexOf('063_call_saved_views_pin_order.sql');
  if (pins >= 0 && pinOrder >= 0 && pins < pinOrder) {
    files.splice(pinOrder, 1);
    files.splice(pins, 0, '063_call_saved_views_pin_order.sql');
  }
  return files.filter(filter).map((name) => ({ name, sql: fs.readFileSync(path.join(MIGRATIONS_DIR, name), 'utf8') }));
}

async function applyMigrations(pool: Pool, migrations: { name: string; sql: string }[]): Promise<void> {
  for (const m of migrations) {
    try {
      await pool.query(m.sql);
    } catch (err) {
      throw new Error(`Migration ${m.name} failed: ${(err as Error).message}`);
    }
  }
}

async function adminQuery(sql: string): Promise<void> {
  const admin = new Client({ connectionString: adminUrl()! });
  await admin.connect();
  try {
    await admin.query(sql);
  } finally {
    await admin.end();
  }
}

async function createDatabase(name: string): Promise<Pool> {
  await adminQuery(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
  await adminQuery(`CREATE DATABASE "${name}"`);
  return new Pool({ connectionString: adminUrl(name)!, max: 8 });
}

async function dropDatabase(name: string, pool?: Pool): Promise<void> {
  if (pool) await pool.end().catch(() => {});
  await adminQuery(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`).catch(() => {});
}

async function ensureRlsTester(pool: Pool): Promise<void> {
  await pool.query(`
    DO $$ BEGIN
      CREATE ROLE platform_rls_tester NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE;
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $$;
  `);
  await pool.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO platform_rls_tester`);
  await pool.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO platform_rls_tester`);
  await pool.query(`REVOKE UPDATE, DELETE ON action_audit_log FROM platform_rls_tester`);
  await pool.query(`GRANT platform_rls_tester TO CURRENT_USER`);
}

async function insertTenant(pool: Pool): Promise<string> {
  const id = randomUUID();
  await pool.query(`INSERT INTO tenants (id, name, slug) VALUES ($1, $2, $3)`, [id, `T ${id.slice(0, 4)}`, `t-${id}`]);
  return id;
}

/** Tenant transaction as the non-bypass RLS role, like withTenantClient on qvo_app. */
async function withRlsTx<T>(pool: Pool, tenantId: string, fn: (tx: TenantTx) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE platform_rls_tester');
    await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);
    const result = await fn(client as unknown as TenantTx);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

describe.skipIf(!dbReachable)('tickets v2 postgres integration (migration 123)', () => {
  const suffix = randomUUID().replace(/-/g, '').slice(0, 12);
  const CLEAN_DB = `qvo_tix_clean_${suffix}`;
  const COPY_DB = `qvo_tix_copy_${suffix}`;
  let cleanPool: Pool;
  let copyPool: Pool;
  let legacyTenant: string;
  let legacyTicketId: string;

  beforeAll(async () => {
    cleanPool = await createDatabase(CLEAN_DB);
    await applyMigrations(cleanPool, loadMigrations((name) => name.slice(0, 3) <= '123'));

    // Schema copy: everything before 123, with an existing ticket written the old way.
    copyPool = await createDatabase(COPY_DB);
    await applyMigrations(copyPool, loadMigrations((name) => name.slice(0, 3) < '123'));
    legacyTenant = await insertTenant(copyPool);
    const { rows } = await copyPool.query<{ id: string }>(
      `INSERT INTO tickets (tenant_id, subject, description, status, priority, source, contact_phone)
       VALUES ($1, 'Legacy', 'Before v2', 'open', 'high', 'phone', '555-010-0001') RETURNING id`,
      [legacyTenant],
    );
    legacyTicketId = rows[0].id;
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, MIGRATION_123), 'utf8');
    await copyPool.query(sql);
    await copyPool.query(sql);
    await ensureRlsTester(copyPool);
  }, 300_000);

  afterAll(async () => {
    await dropDatabase(CLEAN_DB, cleanPool);
    await dropDatabase(COPY_DB, copyPool);
  }, 60_000);

  it('applies on a clean Postgres with every migration', async () => {
    const { rows } = await cleanPool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'tickets' AND column_name = ANY($1) ORDER BY column_name`,
      [['callback_due_at', 'intake', 'kind', 'source_call_ref', 'urgency']],
    );
    expect(rows.map((r) => r.column_name)).toEqual(['callback_due_at', 'intake', 'kind', 'source_call_ref', 'urgency']);
    const { rows: idx } = await cleanPool.query(
      `SELECT 1 FROM pg_indexes WHERE tablename = 'tickets' AND indexname = 'idx_tickets_tenant_status_callback_due'`,
    );
    expect(idx).toHaveLength(1);
  });

  it('applies twice on a schema copy and backfills defaults on existing rows', async () => {
    const { rows } = await copyPool.query(
      `SELECT kind, urgency, intake, callback_due_at, source_call_ref, priority FROM tickets WHERE id = $1`,
      [legacyTicketId],
    );
    expect(rows[0]).toEqual({
      kind: 'message',
      urgency: 'normal',
      intake: {},
      callback_due_at: null,
      source_call_ref: null,
      priority: 'high',
    });
    await expect(
      copyPool.query(`UPDATE tickets SET kind = 'lawsuit' WHERE id = $1`, [legacyTicketId]),
    ).rejects.toThrow(/tickets_kind_check/);
    await expect(
      copyPool.query(`UPDATE tickets SET urgency = 'asap' WHERE id = $1`, [legacyTicketId]),
    ).rejects.toThrow(/tickets_urgency_check/);
  });

  it('keeps RLS forced on tickets and denies cross-tenant access', async () => {
    const { rows: rls } = await copyPool.query(
      `SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'tickets'`,
    );
    expect(rls[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });

    const tenantA = await insertTenant(copyPool);
    const tenantB = await insertTenant(copyPool);
    const { rows } = await copyPool.query<{ id: string; tenant_id: string }>(
      `INSERT INTO tickets (tenant_id, subject, kind, urgency) VALUES ($1, 'A', 'callback', 'urgent'), ($2, 'B', 'callback', 'urgent')
       RETURNING id, tenant_id`,
      [tenantA, tenantB],
    );
    const ticketB = rows.find((r) => r.tenant_id === tenantB)!.id;

    await withRlsTx(copyPool, tenantA, async (tx) => {
      const visible = await tx.query(`SELECT tenant_id FROM tickets`);
      expect(visible.rows.length).toBeGreaterThan(0);
      expect(visible.rows.every((r) => r.tenant_id === tenantA)).toBe(true);
      const updated = await tx.query(`UPDATE tickets SET callback_due_at = NOW() WHERE id = $1`, [ticketB]);
      expect(updated.rowCount).toBe(0);
      await tx.query('SAVEPOINT cross_insert');
      await expect(tx.query(`INSERT INTO tickets (tenant_id, subject) VALUES ($1, 'sneaky')`, [tenantB])).rejects.toThrow();
      await tx.query('ROLLBACK TO SAVEPOINT cross_insert');
    });

    await withRlsTx(copyPool, '', async (tx) => {
      const none = await tx.query(`SELECT 1 FROM tickets`);
      expect(none.rows).toHaveLength(0);
    });
  });

  it('opens, dedupes and reads tickets through the SQL repo under RLS', async () => {
    const tenantId = await insertTenant(copyPool);
    const callId = randomUUID();
    await copyPool.query(`INSERT INTO call_sessions (id, tenant_id) VALUES ($1, $2)`, [callId, tenantId]);
    await copyPool.query(
      `INSERT INTO ticket_sla_policies (tenant_id, name, priority, first_response_minutes) VALUES ($1, 'Callbacks', 'medium', 90)`,
      [tenantId],
    );

    const registry = createTicketsActions();
    const byName = new Map(registry.map((def) => [def.name, def]));
    const now = new Date();
    const ctx: ActionContext = {
      tenantId,
      actor: { type: 'agent', id: 'agent-1' },
      now,
      tenantTimezone: 'America/New_York',
      callId,
    };
    const runtime = { store: postgresActionStore, withTenantTx: <T>(id: string, fn: (tx: TenantTx) => Promise<T>) => withRlsTx(copyPool, id, fn) };
    const run = (name: string, c: ActionContext, input: unknown) => runActionDefinition(byName.get(name)!, c, input, runtime);
    const ok = <T>(result: ActionResult): T => {
      if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
      return result.data as T;
    };

    const open = async (subject: string) => {
      const prepared = ok<{ confirmationToken: string; payloadHash: string }>(
        await run(OPEN_PREPARE, { ...ctx, idempotencyKey: randomUUID() }, {
          kind: 'callback',
          subject,
          customer: { name: 'Luis', phone: '+1 555 010 0142' },
        }),
      );
      return run(OPEN_COMMIT, ctx, prepared);
    };

    const first = await open('the leaking sink');
    const firstData = ok<{ ticketId: string; dueAt: string | null; deduped: boolean }>(first);
    expect(firstData.deduped).toBe(false);
    expect(new Date(firstData.dueAt!).getTime()).toBe(now.getTime() + 90 * 60_000);
    expect(first.ok && first.effects?.[0]?.type).toBe('ticket.opened');

    const again = ok<{ ticketId: string; deduped: boolean }>(await open('the sink, again'));
    expect(again).toMatchObject({ ticketId: firstData.ticketId, deduped: true });

    const { rows } = await copyPool.query(`SELECT count(*)::int AS n FROM tickets WHERE tenant_id = $1`, [tenantId]);
    expect(rows[0].n).toBe(1);

    const owner: ActionContext = { ...ctx, actor: { type: 'system', id: 'test' }, callId: undefined };
    const detail = ok<{ callId: string; sourceCallRef: string; notes: unknown[]; source?: string }>(
      await run('tickets.get', owner, { ticketId: firstData.ticketId }),
    );
    expect(detail).toMatchObject({ callId, sourceCallRef: callId });
    expect(detail.notes).toHaveLength(1);

    const listed = ok<{ tickets: Array<{ id: string }> }>(await run('tickets.list', owner, { status: 'open', kind: 'callback' }));
    expect(listed.tickets.map((t) => t.id)).toEqual([firstData.ticketId]);

    const updated = ok<{ status: string }>(
      await run('tickets.update', { ...owner, idempotencyKey: randomUUID() }, { ticketId: firstData.ticketId, status: 'resolved' }),
    );
    expect(updated.status).toBe('resolved');
    const rejected = await run('tickets.update', { ...owner, idempotencyKey: randomUUID() }, {
      ticketId: firstData.ticketId,
      status: 'in_progress',
    });
    expect(!rejected.ok && rejected.error.code).toBe('VALIDATION_FAILED');

    const other = await insertTenant(copyPool);
    const foreign = await run('tickets.get', { ...owner, tenantId: other }, { ticketId: firstData.ticketId });
    expect(!foreign.ok && foreign.error.code).toBe('NOT_FOUND');
  });
});
