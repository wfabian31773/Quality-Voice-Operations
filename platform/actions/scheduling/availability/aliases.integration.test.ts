// @vitest-environment node
// Service aliases (migration 125) on a throwaway local Postgres: the catalog
// loader works before 125 (no aliases key), 125 is re-runnable, and after it
// the loader returns each service's aliases under RLS.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, Pool } from 'pg';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { TenantTx } from '../../index';
import { loadCatalog } from './loaders';
import { resolveServiceByName } from '../serviceMatch';

const ADMIN_URL_RAW = process.env.DATABASE_URL ?? process.env.DATABASE_URL_PRIVILEGED ?? 'postgresql://ubuntu@127.0.0.1:5432/postgres';

function adminUrl(database?: string): string | null {
  try {
    const u = new URL(ADMIN_URL_RAW);
    // Throwaway local databases only.
    if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(u.hostname)) return null;
    if (database) u.pathname = `/${database}`;
    return u.toString();
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

function migrationFiles(): { name: string; sql: string }[] {
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => /^\d{3}_/.test(f) && f.endsWith('.sql')).sort();
  // Same ordering fix as platform/actions/scheduling/postgres.integration.test.ts.
  const iPins = files.indexOf('063_call_saved_view_pins.sql');
  const iPinOrder = files.indexOf('063_call_saved_views_pin_order.sql');
  if (iPins >= 0 && iPinOrder >= 0 && iPins < iPinOrder) {
    files.splice(iPinOrder, 1);
    files.splice(iPins, 0, '063_call_saved_views_pin_order.sql');
  }
  return files.map((name) => ({ name, sql: fs.readFileSync(path.join(MIGRATIONS_DIR, name), 'utf8') }));
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

/** One transaction per file, like scripts/run-migrations.ts (retries cluster-wide role DDL races). */
async function applyMigration(pool: Pool, m: { name: string; sql: string }): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(m.sql);
      await client.query('COMMIT');
      return;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      const message = (err as Error).message;
      if (attempt >= 5 || !/tuple concurrently (updated|deleted)|deadlock detected/.test(message)) {
        throw new Error(`Migration ${m.name} failed: ${message}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 100 * attempt));
    } finally {
      client.release();
    }
  }
}

describe.skipIf(!dbReachable)('service aliases (migration 125) in the catalog loader', () => {
  const DB = `qvo_svc_aliases_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  const tenantId = randomUUID();
  const other = randomUUID();
  let pool: Pool;
  let m125: { name: string; sql: string };

  async function withTenantTx<T>(tenant: string, fn: (tx: TenantTx) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE platform_rls_tester');
      await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenant]);
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

  beforeAll(async () => {
    await adminQuery(`DROP DATABASE IF EXISTS "${DB}" WITH (FORCE)`);
    await adminQuery(`CREATE DATABASE "${DB}"`);
    pool = new Pool({ connectionString: adminUrl(DB)!, max: 4 });
    const all = migrationFiles();
    m125 = all.find((m) => m.name === '125_service_aliases.sql')!;
    for (const m of all.filter((f) => f.name.slice(0, 3) <= '124')) await applyMigration(pool, m);
    await applyMigration(pool, {
      name: 'platform_rls_tester role',
      sql: `
        DO $$ BEGIN
          CREATE ROLE platform_rls_tester NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE;
        EXCEPTION WHEN duplicate_object THEN NULL;
        END $$;
        GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO platform_rls_tester;
        GRANT platform_rls_tester TO CURRENT_USER;
      `,
    });
    for (const [id, label] of [[tenantId, 'a'], [other, 'b']]) {
      await pool.query(`INSERT INTO tenants (id, name, slug, status) VALUES ($1, $2, $3, 'active')`, [id, label, `${label}-${id.slice(0, 8)}`]);
    }
    await pool.query(
      `INSERT INTO scheduling_appointment_types (id, tenant_id, name, duration_minutes)
       VALUES ('fade', $1, 'Fade', 45), ('cut', $1, 'Haircut', 30), ('b-fade', $2, 'Fade', 45)`,
      [tenantId, other],
    );
  }, 600_000);

  afterAll(async () => {
    await pool?.end().catch(() => {});
    await adminQuery(`DROP DATABASE IF EXISTS "${DB}" WITH (FORCE)`).catch(() => {});
  }, 60_000);

  it('loads the catalog before 125 runs, with no aliases key', async () => {
    const catalog = await withTenantTx(tenantId, (tx) => loadCatalog(tx, tenantId));
    expect(catalog.services.map((s) => s.name)).toEqual(['Fade', 'Haircut']);
    for (const s of catalog.services) expect(s).not.toHaveProperty('aliases');
  });

  it('125 is re-runnable and defaults existing rows to no aliases', async () => {
    await applyMigration(pool, m125);
    await applyMigration(pool, m125);
    const { rows } = await pool.query(
      `SELECT data_type, is_nullable, column_default FROM information_schema.columns
        WHERE table_name = 'scheduling_appointment_types' AND column_name = 'aliases'`,
    );
    expect(rows).toEqual([{ data_type: 'ARRAY', is_nullable: 'NO', column_default: "'{}'::text[]" }]);
    const catalog = await withTenantTx(tenantId, (tx) => loadCatalog(tx, tenantId));
    for (const s of catalog.services) expect(s).not.toHaveProperty('aliases');
  });

  it('returns aliases after 125, only for the bound tenant', async () => {
    await pool.query(`UPDATE scheduling_appointment_types SET aliases = ARRAY['skin fade', ' bald fade ', ''] WHERE id = 'fade'`);
    await pool.query(`UPDATE scheduling_appointment_types SET aliases = ARRAY['other tenant alias'] WHERE id = 'b-fade'`);
    const catalog = await withTenantTx(tenantId, (tx) => loadCatalog(tx, tenantId));
    expect(catalog.services).toEqual([
      expect.objectContaining({ id: 'fade', name: 'Fade', aliases: ['skin fade', 'bald fade'] }),
      expect.not.objectContaining({ aliases: expect.anything() }),
    ]);
    expect(resolveServiceByName(catalog, 'bald fade')).toMatchObject({ service: { id: 'fade' }, matchedBy: 'alias' });
    expect(resolveServiceByName(catalog, 'other tenant alias').service).toBeNull();
  });
});
