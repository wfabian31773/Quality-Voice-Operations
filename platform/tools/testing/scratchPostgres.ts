/**
 * Scratch-database helpers for real-Postgres tests of the legacy tool
 * library. Same approach as platform/actions/scheduling/postgres.integration.test.ts:
 * a throwaway database on the local DATABASE_URL server, the full migration
 * chain, and a NOBYPASSRLS tester role so RLS is actually enforced.
 * Test-only; never point DATABASE_URL at a shared database.
 */
import { Client, Pool } from 'pg';
import fs from 'node:fs';
import path from 'node:path';

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

const adminConn = parseConnection(ADMIN_URL_RAW);

function buildUrl(conn: ParsedConn, database: string): string {
  const userPart = encodeURIComponent(conn.user);
  const passPart = conn.password ? `:${encodeURIComponent(conn.password)}` : '';
  return `postgresql://${userPart}${passPart}@${conn.host}:${conn.port}/${database}${conn.search}`;
}

export async function probePostgres(): Promise<boolean> {
  if (!adminConn) return false;
  const probe = new Client({ connectionString: buildUrl(adminConn, adminConn.database), connectionTimeoutMillis: 2_000 });
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

async function adminQuery(sql: string): Promise<void> {
  if (!adminConn) throw new Error('no admin conn');
  const admin = new Client({ connectionString: buildUrl(adminConn, adminConn.database) });
  await admin.connect();
  try {
    await admin.query(sql);
  } finally {
    await admin.end();
  }
}

const MIGRATIONS_DIR = path.join(process.cwd(), 'migrations');

function loadAllMigrations(): { name: string; sql: string }[] {
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
  return files.map((name) => ({ name, sql: fs.readFileSync(path.join(MIGRATIONS_DIR, name), 'utf8') }));
}

export interface ScratchDatabase {
  name: string;
  /** Owner connection (migrations, seeding, assertions). */
  admin: Pool;
  /** Every connection runs as the NOBYPASSRLS platform_rls_tester role. */
  app: Pool;
  drop(): Promise<void>;
}

/** Create a fresh database, apply every migration and set up the RLS tester role. */
export async function createScratchDatabase(prefix: string): Promise<ScratchDatabase> {
  if (!adminConn) throw new Error('no admin conn');
  const name = `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
  await adminQuery(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
  await adminQuery(`CREATE DATABASE "${name}"`);
  const url = buildUrl(adminConn, name);
  const admin = new Pool({ connectionString: url, max: 4 });
  for (const m of loadAllMigrations()) {
    try {
      await admin.query(m.sql);
    } catch (err) {
      await admin.end().catch(() => {});
      throw new Error(`Migration ${m.name} failed: ${(err as Error).message}`);
    }
  }
  await admin.query(`
    DO $$ BEGIN
      CREATE ROLE platform_rls_tester NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE;
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $$;
  `);
  await admin.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO platform_rls_tester`);
  await admin.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO platform_rls_tester`);
  await admin.query(`GRANT platform_rls_tester TO CURRENT_USER`);

  const app = new Pool({ connectionString: url, max: 4 });
  app.on('connect', (client) => {
    void client.query('SET ROLE platform_rls_tester');
  });

  return {
    name,
    admin,
    app,
    async drop() {
      await app.end().catch(() => {});
      await admin.end().catch(() => {});
      await adminQuery(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    },
  };
}
