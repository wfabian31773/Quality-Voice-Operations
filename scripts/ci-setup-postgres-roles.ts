/**
 * Apply scripts/ci-setup-postgres-roles.sql against a throwaway Postgres.
 *
 * Uses DATABASE_URL_PRIVILEGED, else DATABASE_URL (development) / PLATFORM_DB_POOL_URL.
 * Must connect as a superuser (postgres) so it can CREATE ROLE.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Pool } from 'pg';

async function main() {
  const env = process.env.APP_ENV ?? 'development';
  const url =
    process.env.DATABASE_URL_PRIVILEGED ||
    (env === 'development' ? process.env.DATABASE_URL : process.env.PLATFORM_DB_POOL_URL) ||
    '';
  if (!url) {
    throw new Error(
      '[CI-ROLES] DATABASE_URL_PRIVILEGED / DATABASE_URL / PLATFORM_DB_POOL_URL is not set',
    );
  }

  const sqlPath = path.join(process.cwd(), 'scripts/ci-setup-postgres-roles.sql');
  const sql = readFileSync(sqlPath, 'utf8');

  const pool = new Pool({ connectionString: url, max: 1 });
  const client = await pool.connect();
  try {
    await client.query(sql);
    const { rows } = await client.query<{ rolname: string; rolbypassrls: boolean; rolcanlogin: boolean }>(
      `SELECT rolname, rolbypassrls, rolcanlogin
         FROM pg_roles
        WHERE rolname = ANY($1::text[])
        ORDER BY rolname`,
      [['anon', 'authenticated', 'qvo_app', 'service_role']],
    );
    console.log('[CI-ROLES] Roles ready:');
    for (const row of rows) {
      console.log(
        `  ${row.rolname} login=${row.rolcanlogin} bypassrls=${row.rolbypassrls}`,
      );
    }
    const names = new Set(rows.map((r) => r.rolname));
    for (const required of ['anon', 'authenticated', 'qvo_app', 'service_role']) {
      if (!names.has(required)) {
        throw new Error(`[CI-ROLES] missing role ${required}`);
      }
    }
    const qvo = rows.find((r) => r.rolname === 'qvo_app');
    if (!qvo?.rolcanlogin || qvo.rolbypassrls) {
      throw new Error('[CI-ROLES] qvo_app must be LOGIN NOBYPASSRLS');
    }
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
