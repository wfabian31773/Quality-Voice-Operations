// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, Pool, type PoolClient } from 'pg';
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

/**
 * Role catalogs are shared by every database in the cluster, so role DDL here races the role DDL that
 * platform/actions/core/postgres.integration.test.ts runs at the same time (migrations 015/120 and its
 * own ensureRlsTester): "tuple concurrently updated", or a duplicate pg_authid key. Each role-touching
 * step therefore runs in one transaction that first locks those catalogs in SHARE ROW EXCLUSIVE mode.
 * That conflicts with the ROW EXCLUSIVE lock every CREATE/ALTER/COMMENT/GRANT ROLE takes, so the other
 * file's role DDL waits for our commit (and ours waits for its open migration transaction) instead of
 * updating the same tuple concurrently. The lock protects both files even though the core file takes
 * no lock of its own; the retry below only backs up this file.
 */
const ROLE_DDL = /\b(?:CREATE|ALTER|DROP)\s+ROLE\b|\bCOMMENT\s+ON\s+ROLE\b|\bGRANT\s+\w+\s+TO\b/i;
const SHARED_ROLE_CATALOGS = 'pg_catalog.pg_authid, pg_catalog.pg_auth_members, pg_catalog.pg_shdescription';
const ROLE_DDL_ATTEMPTS = 5;
let lockRoleCatalogs = true;

function isRoleCatalogRace(err: unknown): boolean {
  const e = err as { code?: string; message?: string; table?: string; constraint?: string };
  if (e.code === '40001' || e.code === '40P01') return true;
  if (e.code === 'XX000') return /tuple concurrently (updated|deleted)/.test(e.message ?? '');
  if (e.code === '23505') return /^pg_auth/.test(e.table ?? e.constraint ?? '');
  return false;
}

async function withRoleCatalogLock(pool: Pool, fn: (client: PoolClient) => Promise<unknown>): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    const client = await pool.connect();
    let locking = false;
    try {
      await client.query('BEGIN');
      if (lockRoleCatalogs) {
        locking = true;
        await client.query(`LOCK TABLE ${SHARED_ROLE_CATALOGS} IN SHARE ROW EXCLUSIVE MODE`);
        locking = false;
      }
      await fn(client);
      await client.query('COMMIT');
      return;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      if (locking) {
        // Admin role can't lock shared catalogs (not superuser): fall back to retry-only.
        lockRoleCatalogs = false;
        attempt -= 1;
        continue;
      }
      if (attempt >= ROLE_DDL_ATTEMPTS || !isRoleCatalogRace(err)) throw err;
      await new Promise((resolve) => setTimeout(resolve, 100 * attempt + Math.floor(Math.random() * 100)));
    } finally {
      client.release();
    }
  }
}

async function applyMigrations(pool: Pool, migrations: { name: string; sql: string }[]): Promise<void> {
  for (const m of migrations) {
    try {
      if (ROLE_DDL.test(m.sql)) await withRoleCatalogLock(pool, (client) => client.query(m.sql));
      else await pool.query(m.sql);
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
  await withRoleCatalogLock(pool, async (client) => {
    await client.query(`
      DO $$ BEGIN
        CREATE ROLE platform_rls_tester NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE;
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$;
    `);
    await client.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO platform_rls_tester`);
    await client.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO platform_rls_tester`);
    await client.query(`REVOKE UPDATE, DELETE ON action_audit_log FROM platform_rls_tester`);
    await client.query(`GRANT platform_rls_tester TO CURRENT_USER`);
  });
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

    const openWithToken = async (subject: string) => {
      const prepared = ok<{ confirmationToken: string; payloadHash: string }>(
        await run(OPEN_PREPARE, { ...ctx, idempotencyKey: randomUUID() }, {
          kind: 'callback',
          subject,
          customer: { name: 'Luis', phone: '+1 555 010 0142' },
        }),
      );
      const commit = { confirmationToken: prepared.confirmationToken, payloadHash: prepared.payloadHash };
      return { commit, result: await run(OPEN_COMMIT, ctx, commit) };
    };
    const open = async (subject: string) => (await openWithToken(subject)).result;
    const outboxRows = async () =>
      (
        await copyPool.query<{ tenant_id: string; status: string; payload: Record<string, unknown> }>(
          `SELECT tenant_id, status, payload FROM ticket_outbox WHERE tenant_id = $1 AND event_type = 'ticket.opened'`,
          [tenantId],
        )
      ).rows;

    const { commit: firstCommit, result: first } = await openWithToken('the leaking sink');
    const firstData = ok<{ ticketId: string; dueAt: string | null; deduped: boolean }>(first);
    expect(firstData.deduped).toBe(false);
    expect(new Date(firstData.dueAt!).getTime()).toBe(now.getTime() + 90 * 60_000);
    expect(first.ok && first.effects?.[0]?.type).toBe('ticket.opened');

    // ticket.opened is a ticket_outbox row written under RLS in the commit transaction.
    const opened = await outboxRows();
    expect(opened).toHaveLength(1);
    expect(opened[0]).toMatchObject({ tenant_id: tenantId, status: 'pending' });
    expect(opened[0].payload).toMatchObject({
      ticketId: firstData.ticketId,
      callId,
      proposalId: firstCommit.confirmationToken,
      idempotencyKey: firstCommit.confirmationToken,
    });

    // A commit retry with the same token replays the stored result: no second ticket or outbox row.
    const retry = await run(OPEN_COMMIT, ctx, firstCommit);
    expect(retry).toEqual(first);
    expect(await outboxRows()).toHaveLength(1);

    const again = ok<{ ticketId: string; deduped: boolean }>(await open('the sink, again'));
    expect(again).toMatchObject({ ticketId: firstData.ticketId, deduped: true });
    // Deduped repeat: no outbox row.
    expect(await outboxRows()).toHaveLength(1);

    const { rows } = await copyPool.query(`SELECT count(*)::int AS n FROM tickets WHERE tenant_id = $1`, [tenantId]);
    expect(rows[0].n).toBe(1);

    // The unique index backs up exactly-once: a second ticket.opened row for the same ticket is rejected.
    await expect(
      copyPool.query(
        `INSERT INTO ticket_outbox (tenant_id, event_type, payload) VALUES ($1, 'ticket.opened', $2::jsonb)`,
        [tenantId, JSON.stringify({ ticketId: firstData.ticketId })],
      ),
    ).rejects.toThrow(/uq_ticket_outbox_ticket_opened/);

    const owner: ActionContext = { ...ctx, actor: { type: 'system', id: 'test' }, callId: undefined };
    const detail = ok<{ callId: string; sourceCallRef: string; notes: unknown[]; source?: string }>(
      await run('tickets.get', owner, { ticketId: firstData.ticketId }),
    );
    expect(detail).toMatchObject({ callId, sourceCallRef: callId });
    expect(detail.notes).toHaveLength(1);

    // More than 50 notes: get returns the newest 50, oldest first.
    for (let i = 0; i < 55; i++) {
      await copyPool.query(
        `INSERT INTO ticket_activity_log (tenant_id, ticket_id, activity_type, content, created_at) VALUES ($1, $2, 'note', $3, $4)`,
        [tenantId, firstData.ticketId, `note ${i}`, new Date(now.getTime() + (i + 1) * 1000)],
      );
    }
    const many = ok<{ notes: Array<{ content: string }> }>(await run('tickets.get', owner, { ticketId: firstData.ticketId }));
    expect(many.notes.map((n) => n.content)).toEqual(Array.from({ length: 50 }, (_, i) => `note ${i + 5}`));

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

  it("does not link another tenant's call as tickets.call_id even with RLS bypassed", async () => {
    const tenantA = await insertTenant(copyPool);
    const tenantB = await insertTenant(copyPool);
    const callB = randomUUID();
    await copyPool.query(`INSERT INTO call_sessions (id, tenant_id) VALUES ($1, $2)`, [callB, tenantB]);

    // The admin connection bypasses RLS, like the app before the qvo_app rollout.
    const withBypassTx = async <T>(id: string, fn: (tx: TenantTx) => Promise<T>): Promise<T> => {
      const client = await copyPool.connect();
      try {
        await client.query('BEGIN');
        await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [id]);
        const result = await fn(client as unknown as TenantTx);
        await client.query('COMMIT');
        return result;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    };
    const registry = createTicketsActions();
    const byName = new Map(registry.map((def) => [def.name, def]));
    const runtime = { store: postgresActionStore, withTenantTx: withBypassTx };
    const ctx: ActionContext = {
      tenantId: tenantA,
      actor: { type: 'agent', id: 'agent-1' },
      now: new Date(),
      tenantTimezone: 'America/New_York',
      callId: callB,
    };
    const prepared = await runActionDefinition(byName.get(OPEN_PREPARE)!, { ...ctx, idempotencyKey: randomUUID() }, {
      kind: 'message',
      subject: 'wrong tenant call',
      customer: { phone: '555-010-8888' },
    }, runtime);
    if (!prepared.ok) throw new Error(prepared.error.message);
    const { confirmationToken, payloadHash } = prepared.data as { confirmationToken: string; payloadHash: string };
    const committed = await runActionDefinition(byName.get(OPEN_COMMIT)!, ctx, { confirmationToken, payloadHash }, runtime);
    if (!committed.ok) throw new Error(committed.error.message);
    const { ticketId } = committed.data as { ticketId: string };

    const { rows } = await copyPool.query(`SELECT tenant_id, call_id, source_call_ref FROM tickets WHERE id = $1`, [ticketId]);
    expect(rows[0]).toEqual({ tenant_id: tenantA, call_id: null, source_call_ref: callB });
  });

  it('adds the CHECKs NOT VALID and the ticket.opened outbox index, and re-runs cleanly', async () => {
    for (const pool of [cleanPool, copyPool]) {
      const { rows } = await pool.query<{ conname: string; convalidated: boolean }>(
        `SELECT conname, convalidated FROM pg_constraint
          WHERE conrelid = 'tickets'::regclass AND conname = ANY($1) ORDER BY conname`,
        [['tickets_intake_object_check', 'tickets_kind_check', 'tickets_urgency_check']],
      );
      expect(rows).toEqual([
        { conname: 'tickets_intake_object_check', convalidated: false },
        { conname: 'tickets_kind_check', convalidated: false },
        { conname: 'tickets_urgency_check', convalidated: false },
      ]);
      const { rows: idx } = await pool.query(
        `SELECT 1 FROM pg_indexes WHERE tablename = 'ticket_outbox' AND indexname = 'uq_ticket_outbox_ticket_opened'`,
      );
      expect(idx).toHaveLength(1);
    }
    // Re-run the file the way scripts/run-migrations.ts does: one explicit transaction, SET LOCAL included.
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, MIGRATION_123), 'utf8');
    const client = await cleanPool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      const { rows } = await client.query<{ lock_timeout: string }>(`SHOW lock_timeout`);
      expect(rows[0].lock_timeout).toBe('5s');
      await client.query('COMMIT');
      const { rows: after } = await client.query<{ lock_timeout: string }>(`SHOW lock_timeout`);
      expect(after[0].lock_timeout).not.toBe('5s');
    } finally {
      client.release();
    }
  });
});
