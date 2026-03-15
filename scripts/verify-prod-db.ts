import { Pool } from 'pg';

async function main() {
  const url = process.env.PLATFORM_DB_POOL_URL;
  if (!url) {
    console.log('[VERIFY] PLATFORM_DB_POOL_URL is not set — skipping production DB verification');
    process.exit(0);
  }

  console.log('[VERIFY] Connecting to production database...');

  const pool = new Pool({
    connectionString: url,
    max: 2,
    connectionTimeoutMillis: 10_000,
    ssl: { rejectUnauthorized: false },
  });

  try {
    const client = await pool.connect();
    console.log('[VERIFY] Connection established.');

    const { rows: versionRows } = await client.query('SELECT version()');
    console.log(`[VERIFY] PostgreSQL version: ${versionRows[0]?.version}`);

    const { rows: migrationRows } = await client.query(
      'SELECT COUNT(*) AS cnt FROM schema_migrations',
    );
    const migrationCount = parseInt(migrationRows[0]?.cnt as string, 10);
    console.log(`[VERIFY] Migrations applied: ${migrationCount}`);

    const { rows: migrations } = await client.query(
      'SELECT filename, applied_at FROM schema_migrations ORDER BY filename',
    );
    for (const m of migrations) {
      console.log(`  - ${m.filename} (${m.applied_at})`);
    }

    const { rows: tableRows } = await client.query(`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
      ORDER BY table_name
    `);
    console.log(`[VERIFY] Tables in public schema: ${tableRows.length}`);

    const { rows: rlsRows } = await client.query(`
      SELECT relname, relrowsecurity
      FROM pg_class
      WHERE relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'public')
        AND relkind = 'r'
      ORDER BY relname
    `);
    const rlsEnabled = rlsRows.filter((r) => r.relrowsecurity === true).length;
    console.log(`[VERIFY] Tables with RLS enabled: ${rlsEnabled}/${rlsRows.length}`);

    client.release();
    console.log('[VERIFY] Production database verification PASSED.');
  } catch (err) {
    console.error('[VERIFY] Production database verification FAILED:', (err as Error).message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();
