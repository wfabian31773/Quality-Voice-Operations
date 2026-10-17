// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, Pool } from 'pg';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  createEchoCommitAction,
  createEchoPrepareAction,
  createEchoReadAction,
  createEchoWriteAction,
} from './__fixtures__/echo';
import { defineAction } from './defineAction';
import { postgresActionStore } from './postgresStore';
import { runActionDefinition } from './runAction';
import type { ActionContext, TenantTx } from './types';

const ADMIN_URL_RAW = process.env.DATABASE_URL ?? process.env.DATABASE_URL_PRIVILEGED ?? 'postgresql://ubuntu@127.0.0.1:5432/postgres';

interface ParsedConn {
  user: string;
  password: string;
  host: string;
  port: number;
  database: string;
  search: string;
}

function parseConnection(url: string): ParsedConn | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return {
      user: decodeURIComponent(u.username || 'postgres'),
      password: decodeURIComponent(u.password || ''),
      host: u.hostname || '127.0.0.1',
      port: u.port ? Number(u.port) : 5432,
      database: u.pathname.replace(/^\//, '') || 'postgres',
      search: u.search ?? '',
    };
  } catch {
    return null;
  }
}

function buildUrl(conn: ParsedConn, database: string): string {
  const userPart = encodeURIComponent(conn.user);
  const passPart = conn.password ? `:${encodeURIComponent(conn.password)}` : '';
  return `postgresql://${userPart}${passPart}@${conn.host}:${conn.port}/${database}${conn.search}`;
}

const adminConn = parseConnection(ADMIN_URL_RAW);

async function probeReachable(): Promise<boolean> {
  if (!adminConn) return false;
  const probe = new Client({
    connectionString: buildUrl(adminConn, adminConn.database),
    connectionTimeoutMillis: 2_000,
  });
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
const skipReason = !dbReachable ? 'Postgres unreachable — skipping action-layer integration tests' : null;

const MIGRATIONS_DIR = path.join(process.cwd(), 'migrations');
const MIGRATION_121 = fs.readFileSync(path.join(MIGRATIONS_DIR, '121_action_layer.sql'), 'utf8');

function loadMigrationsThrough(maxPrefix: string): { name: string; sql: string }[] {
  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d{3}_/.test(f) && f.endsWith('.sql'))
    .sort();

  const A_PIN_ORDER = '063_call_saved_views_pin_order.sql';
  const A_PINS = '063_call_saved_view_pins.sql';
  const iPins = files.indexOf(A_PINS);
  const iPinOrder = files.indexOf(A_PIN_ORDER);
  if (iPins >= 0 && iPinOrder >= 0 && iPins < iPinOrder) {
    files.splice(iPinOrder, 1);
    files.splice(iPins, 0, A_PIN_ORDER);
  }

  return files
    .filter((name) => name.slice(0, 3) <= maxPrefix)
    .map((name) => ({
      name,
      sql: fs.readFileSync(path.join(MIGRATIONS_DIR, name), 'utf8'),
    }));
}

async function applyMigrations(client: Client | Pool, migrations: { name: string; sql: string }[]): Promise<void> {
  for (const m of migrations) {
    try {
      await client.query(m.sql);
    } catch (err) {
      throw new Error(`Migration ${m.name} failed: ${(err as Error).message}`);
    }
  }
}

async function createDatabase(name: string): Promise<Pool> {
  if (!adminConn) throw new Error('no admin conn');
  const admin = new Client({ connectionString: buildUrl(adminConn, adminConn.database) });
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await admin.query(`CREATE DATABASE "${name}"`);
  } finally {
    await admin.end();
  }
  return new Pool({ connectionString: buildUrl(adminConn, name), max: 8 });
}

async function dropDatabase(name: string, pool?: Pool): Promise<void> {
  if (pool) await pool.end().catch(() => {});
  if (!adminConn) return;
  const admin = new Client({ connectionString: buildUrl(adminConn, adminConn.database) });
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
  } finally {
    await admin.end();
  }
}

const MINIMAL_TENANTS = `
  CREATE TABLE IF NOT EXISTS tenants (
    id VARCHAR PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    slug VARCHAR(100) NOT NULL UNIQUE,
    status VARCHAR(20) NOT NULL DEFAULT 'active'
  );
`;

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

function makeCtx(tenantId: string, now = new Date()): ActionContext {
  return {
    tenantId,
    actor: { type: 'user', id: 'owner-1', role: 'owner' },
    now,
    tenantTimezone: 'America/New_York',
    callId: 'call-live',
  };
}

async function withTenantTx<T>(pool: Pool, tenantId: string, fn: (tx: TenantTx) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);
    const result = await fn(client as unknown as TenantTx);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

describe.skipIf(skipReason !== null)('action layer postgres integration', () => {
  const suffix = randomUUID().replace(/-/g, '').slice(0, 12);
  const CLEAN_DB = `qvo_act_clean_${suffix}`;
  const CURRENT_DB = `qvo_act_curr_${suffix}`;
  const FULL_DB = `qvo_act_full_${suffix}`;
  let cleanPool: Pool;
  let currentPool: Pool;
  let fullPool: Pool | undefined;
  let fullMigrateError: string | undefined;

  beforeAll(async () => {
    cleanPool = await createDatabase(CLEAN_DB);
    await cleanPool.query(MINIMAL_TENANTS);
    await cleanPool.query(MIGRATION_121);
    await cleanPool.query(MIGRATION_121);
    await ensureRlsTester(cleanPool);

    currentPool = await createDatabase(CURRENT_DB);
    const through120 = loadMigrationsThrough('120').filter((m) => m.name !== '121_action_layer.sql');
    await applyMigrations(currentPool, through120);
    await currentPool.query(MIGRATION_121);
    await ensureRlsTester(currentPool);

    try {
      fullPool = await createDatabase(FULL_DB);
      await applyMigrations(fullPool, loadMigrationsThrough('121'));
    } catch (err) {
      fullMigrateError = (err as Error).message;
      if (fullPool) {
        await dropDatabase(FULL_DB, fullPool);
        fullPool = undefined;
      }
    }
  }, 300_000);

  afterAll(async () => {
    await dropDatabase(CLEAN_DB, cleanPool);
    await dropDatabase(CURRENT_DB, currentPool);
    if (fullPool) await dropDatabase(FULL_DB, fullPool);
  }, 60_000);

  it('applies 121 on a clean Postgres that only has tenants', async () => {
    const { rows } = await cleanPool.query<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      `SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND c.relname = ANY($1)`,
      [['action_idempotency', 'action_proposals', 'action_audit_log']],
    );
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.relrowsecurity).toBe(true);
      expect(row.relforcerowsecurity).toBe(true);
    }
  });

  it('applies 121 on a copy of the current schema (through 120)', async () => {
    const { rows } = await currentPool.query(
      `SELECT tablename FROM pg_tables
        WHERE schemaname = 'public'
          AND tablename IN ('action_idempotency', 'action_proposals', 'action_audit_log')
        ORDER BY tablename`,
    );
    expect(rows.map((r) => r.tablename)).toEqual([
      'action_audit_log',
      'action_idempotency',
      'action_proposals',
    ]);
  });

  it('applies every migration including 121 on a clean database', async () => {
    if (fullMigrateError) {
      throw new Error(`Full migration path failed: ${fullMigrateError}`);
    }
    expect(fullPool).toBeTruthy();
    const { rows } = await fullPool!.query(
      `SELECT 1 FROM information_schema.tables WHERE table_name = 'action_idempotency'`,
    );
    expect(rows).toHaveLength(1);
  });

  for (const table of ['action_idempotency', 'action_proposals', 'action_audit_log'] as const) {
    it(`denies cross-tenant access on ${table}`, async () => {
      const tenantA = randomUUID();
      const tenantB = randomUUID();
      await currentPool.query(
        `INSERT INTO tenants (id, name, slug, status) VALUES ($1, $2, $3, 'active'), ($4, $5, $6, 'active')`,
        [tenantA, 'A', `a-${tenantA.slice(0, 8)}`, tenantB, 'B', `b-${tenantB.slice(0, 8)}`],
      );

      const hash = 'a'.repeat(64);
      if (table === 'action_idempotency') {
        await currentPool.query(
          `INSERT INTO action_idempotency (tenant_id, action, key, request_hash, status, expires_at)
           VALUES ($1, 'core.echo.write', $2, $3, 'completed', NOW() + interval '1 hour'),
                  ($4, 'core.echo.write', $5, $3, 'completed', NOW() + interval '1 hour')`,
          [tenantA, `k-${tenantA}`, hash, tenantB, `k-${tenantB}`],
        );
      } else if (table === 'action_proposals') {
        await currentPool.query(
          `INSERT INTO action_proposals (tenant_id, action, payload_hash, payload, readback, expires_at)
           VALUES ($1, 'core.echo.prepare', $2, '{}'::jsonb, 'ok', NOW() + interval '5 minutes'),
                  ($3, 'core.echo.prepare', $2, '{}'::jsonb, 'ok', NOW() + interval '5 minutes')`,
          [tenantA, hash, tenantB],
        );
      } else {
        await currentPool.query(
          `INSERT INTO action_audit_log (tenant_id, action, actor, input_redacted, result_code, latency_ms)
           VALUES ($1, 'core.echo.write', '{}'::jsonb, '{}'::jsonb, 'ok', 1),
                  ($2, 'core.echo.write', '{}'::jsonb, '{}'::jsonb, 'ok', 1)`,
          [tenantA, tenantB],
        );
      }

      const client = await currentPool.connect();
      try {
        await client.query('BEGIN');
        await client.query('SET LOCAL ROLE platform_rls_tester');
        await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantA]);

        const { rows } = await client.query(`SELECT tenant_id FROM ${table}`);
        expect(rows.every((r) => r.tenant_id === tenantA)).toBe(true);
        expect(rows.length).toBeGreaterThan(0);

        await expect(
          client.query(
            table === 'action_idempotency'
              ? `INSERT INTO action_idempotency (tenant_id, action, key, request_hash, status, expires_at)
                 VALUES ($1, 'core.echo.write', 'cross', $2, 'completed', NOW() + interval '1 hour')`
              : table === 'action_proposals'
                ? `INSERT INTO action_proposals (tenant_id, action, payload_hash, payload, readback, expires_at)
                   VALUES ($1, 'core.echo.prepare', $2, '{}'::jsonb, 'nope', NOW() + interval '5 minutes')`
                : `INSERT INTO action_audit_log (tenant_id, action, actor, input_redacted, result_code, latency_ms)
                   VALUES ($1, 'core.echo.write', '{}'::jsonb, '{}'::jsonb, 'ok', 1)`,
            table === 'action_audit_log' ? [tenantB] : [tenantB, hash],
          ),
        ).rejects.toThrow();
      } finally {
        await client.query('ROLLBACK').catch(() => {});
        client.release();
      }
    });
  }

  it('rejects UPDATE and DELETE on action_audit_log', async () => {
    const tenantId = randomUUID();
    await currentPool.query(
      `INSERT INTO tenants (id, name, slug, status) VALUES ($1, $2, $3, 'active')`,
      [tenantId, 'Audit', `audit-${tenantId.slice(0, 8)}`],
    );
    const { rows } = await currentPool.query<{ id: string }>(
      `INSERT INTO action_audit_log (tenant_id, action, actor, input_redacted, result_code, latency_ms)
       VALUES ($1, 'core.echo.write', '{}'::jsonb, '{}'::jsonb, 'ok', 1)
       RETURNING id`,
      [tenantId],
    );
    const id = rows[0].id;
    await expect(
      currentPool.query(`UPDATE action_audit_log SET result_code = 'tampered' WHERE id = $1`, [id]),
    ).rejects.toThrow(/immutable/);
    await expect(
      currentPool.query(`DELETE FROM action_audit_log WHERE id = $1`, [id]),
    ).rejects.toThrow(/immutable/);
  });

  it('lets a verified tenant deletion cascade through action_audit_log', async () => {
    const tenantId = randomUUID();
    await cleanPool.query(
      `INSERT INTO tenants (id, name, slug, status) VALUES ($1, $2, $3, 'active')`,
      [tenantId, 'DeleteMe', `del-${tenantId.slice(0, 8)}`],
    );
    await cleanPool.query(
      `INSERT INTO action_audit_log (tenant_id, action, actor, input_redacted, result_code, latency_ms)
       VALUES ($1, 'core.echo.write', '{}'::jsonb, '{}'::jsonb, 'ok', 1)`,
      [tenantId],
    );
    await expect(cleanPool.query(`DELETE FROM tenants WHERE id = $1`, [tenantId])).rejects.toThrow(/immutable/);

    const client = await cleanPool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.verified_tenant_deletion_id', $1, true)`, [tenantId]);
      await client.query(`DELETE FROM tenants WHERE id = $1`, [tenantId]);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
    const { rows } = await cleanPool.query(
      `SELECT 1 FROM action_audit_log WHERE tenant_id = $1`,
      [tenantId],
    );
    expect(rows).toHaveLength(0);
  });

  it('rolls back a thrown write and does not store an INTERNAL idempotent replay', async () => {
    const tenantId = randomUUID();
    await currentPool.query(
      `INSERT INTO tenants (id, name, slug, status) VALUES ($1, $2, $3, 'active')`,
      [tenantId, 'Throw', `th-${tenantId.slice(0, 8)}`],
    );
    const def = defineAction({
      name: 'core.pg_throw',
      tool: 'business',
      kind: 'write',
      input: z.object({ message: z.string() }),
      output: z.object({ echoed: z.string() }),
      permissions: { roles: ['owner'] },
      run: async (actionCtx, _input, tx) => {
        await tx.query(
          `INSERT INTO action_proposals (tenant_id, action, payload_hash, payload, readback, expires_at)
           VALUES ($1, 'core.pg_throw', $2, '{}'::jsonb, 'x', NOW() + interval '5 minutes')`,
          [actionCtx.tenantId, 'b'.repeat(64)],
        );
        throw new Error('after write');
      },
    });
    const runtime = {
      store: postgresActionStore,
      withTenantTx: <T>(id: string, fn: (tx: TenantTx) => Promise<T>) => withTenantTx(currentPool, id, fn),
    };
    const result = await runActionDefinition(
      def,
      { ...makeCtx(tenantId), idempotencyKey: 'throw-pg' },
      { message: 'x' },
      runtime,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('INTERNAL');
    const proposals = await currentPool.query(
      `SELECT 1 FROM action_proposals WHERE tenant_id = $1 AND action = 'core.pg_throw'`,
      [tenantId],
    );
    expect(proposals.rows).toHaveLength(0);
    const idem = await currentPool.query(
      `SELECT status, response FROM action_idempotency WHERE tenant_id = $1 AND key = 'throw-pg'`,
      [tenantId],
    );
    expect(idem.rows).toHaveLength(0);
  });

  it('truncates oversized callId and still commits the action when audit would overflow', async () => {
    const tenantId = randomUUID();
    await currentPool.query(
      `INSERT INTO tenants (id, name, slug, status) VALUES ($1, $2, $3, 'active')`,
      [tenantId, 'CallId', `cid-${tenantId.slice(0, 8)}`],
    );
    const result = await runActionDefinition(
      createEchoWriteAction({ count: 0 }),
      { ...makeCtx(tenantId), idempotencyKey: 'long-call', callId: 'c'.repeat(200) },
      { message: 'ok' },
      {
        store: postgresActionStore,
        withTenantTx: <T>(id: string, fn: (tx: TenantTx) => Promise<T>) => withTenantTx(currentPool, id, fn),
      },
    );
    expect(result).toEqual({ ok: true, data: { echoed: 'ok' } });
    const { rows } = await currentPool.query<{ call_id: string }>(
      `SELECT call_id FROM action_audit_log WHERE tenant_id = $1 AND action = 'core.echo.write'`,
      [tenantId],
    );
    expect(rows[0]?.call_id).toHaveLength(128);
  });

  it('stores {} for a missing body instead of SQL NULL', async () => {
    const tenantId = randomUUID();
    await currentPool.query(
      `INSERT INTO tenants (id, name, slug, status) VALUES ($1, $2, $3, 'active')`,
      [tenantId, 'Sentinel', `s-${tenantId.slice(0, 8)}`],
    );
    const read = createEchoReadAction();
    const result = await runActionDefinition(
      read,
      makeCtx(tenantId),
      undefined,
      {
        store: postgresActionStore,
        withTenantTx: <T>(id: string, fn: (tx: TenantTx) => Promise<T>) => withTenantTx(currentPool, id, fn),
      },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('VALIDATION_FAILED');
    const { rows } = await currentPool.query<{ input_redacted: unknown }>(
      `SELECT input_redacted FROM action_audit_log WHERE tenant_id = $1 AND action = $2`,
      [tenantId, 'core.echo.read'],
    );
    expect(rows[0]?.input_redacted).toEqual({});
  });

  it('runs two parallel commits with the same token as exactly one side effect', async () => {
    const tenantId = randomUUID();
    await currentPool.query(
      `INSERT INTO tenants (id, name, slug, status) VALUES ($1, $2, $3, 'active')`,
      [tenantId, 'Concurrency', `c-${tenantId.slice(0, 8)}`],
    );
    const side = { count: 0 };
    const prepare = createEchoPrepareAction();
    const commit = createEchoCommitAction(side);
    const runtime = {
      store: postgresActionStore,
      withTenantTx: <T>(id: string, fn: (tx: TenantTx) => Promise<T>) => withTenantTx(currentPool, id, fn),
    };
    const prepared = await runActionDefinition(
      prepare,
      { ...makeCtx(tenantId), idempotencyKey: 'prep-conc' },
      { message: 'only-once' },
      runtime,
    );
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;

    const [first, second] = await Promise.all([
      runActionDefinition(
        commit,
        makeCtx(tenantId),
        { confirmationToken: prepared.data.confirmationToken, payloadHash: prepared.data.payloadHash },
        runtime,
      ),
      runActionDefinition(
        commit,
        makeCtx(tenantId),
        { confirmationToken: prepared.data.confirmationToken, payloadHash: prepared.data.payloadHash },
        runtime,
      ),
    ]);
    const results = [first, second];
    const oks = results.filter((r) => r.ok);
    const invalid = results.filter((r) => !r.ok && r.error.code === 'CONFIRMATION_INVALID');
    const replays = results.filter((r) => r.ok);
    expect(oks.length + invalid.length).toBe(2);
    expect(oks.length).toBeGreaterThanOrEqual(1);
    expect(side.count).toBe(1);
    expect(replays.every((r) => r.ok && r.data.echoed === 'only-once')).toBe(true);
  });
});
