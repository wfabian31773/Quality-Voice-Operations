// @vitest-environment node
//
// Task #1109 — real-Postgres regression test for `listEnabledConnectorConfigs`.
//
// The hermetic suites for the connector layer (`adapters/dispatch.chain.test.ts`
// and friends) all stub `listEnabledConnectorConfigs` at its module boundary,
// so any SQL typo in the body of that function is invisible to them. The
// outbox real-DB test (`outboxRecoveryRealDb.test.ts`) similarly stubs
// `connectorService.dispatchEvent` so the lookup query never runs against
// real Postgres.
//
// That gap is exactly how the casts caught by Task #1109 slipped through:
//
//   * `integration_type = ANY($2::text[])` could not match the
//     `integration_type` enum column — Postgres has no implicit text↔enum
//     equality, so the query crashed with `operator does not exist:
//     integration_type = text` the moment a real DB executed it.
//   * `integration_id = ANY($2::uuid[])` was being cast against the
//     `varchar` PK on `integrations` and the matching FK on
//     `connector_configs`, producing `character varying = uuid` failures.
//
// This suite seeds a real per-run Postgres database with a tenant, two
// enabled integrations (one `crm`, one `scheduling`), one disabled
// integration that must be filtered out, and a connector_configs row per
// integration (encrypted with the same `encryptValue` helper the
// production write path uses). It then calls `listEnabledConnectorConfigs`
// twice — once with a `connectorTypes` filter (exercising the
// `integration_type = ANY(...)` cast) and once without (the unfiltered
// branch) — and asserts both queries succeed against the real schema and
// return the expected rows with credentials decrypted.
//
// Skips cleanly when DATABASE_URL is unset or unreachable, the same way
// `outboxRecoveryRealDb.test.ts` does.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, Pool } from 'pg';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

// ---------------------------------------------------------------------------
// Connection probing & per-run database name
// ---------------------------------------------------------------------------

const ADMIN_URL_RAW = process.env.DATABASE_URL ?? '';

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
      host: u.hostname,
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
    connectionTimeoutMillis: 10_000,
    statement_timeout: 5_000,
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
const skipReason = !adminConn
  ? 'DATABASE_URL not set — skipping listEnabledConnectorConfigs real-DB test'
  : !dbReachable
    ? 'Postgres server unreachable — skipping listEnabledConnectorConfigs real-DB test'
    : null;

const TEST_DB_NAME = `list_conn_${randomUUID().replace(/-/g, '').slice(0, 16)}`;

// ---------------------------------------------------------------------------
// Migration loader — same recipe as the outbox real-DB test, including
// the 063 ordering fixup. Migrations through 100 are sufficient to bring
// `integrations` + `connector_configs` to the schema the production code
// expects (enum `integration_type`, varchar `integration_id` FK,
// `last_sync_status`, `fallback_*` columns, …).
// ---------------------------------------------------------------------------

const MIGRATIONS_DIR = path.join(process.cwd(), 'migrations');
const MIGRATION_CUTOFF_PREFIX = '100_';

function loadMigrationsThroughCutoff(): { name: string; sql: string }[] {
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

  const lastIndex = (() => {
    let idx = -1;
    for (let i = 0; i < files.length; i += 1) {
      if (files[i].startsWith(MIGRATION_CUTOFF_PREFIX)) idx = i;
    }
    return idx;
  })();

  if (lastIndex < 0) {
    throw new Error(`Could not find any ${MIGRATION_CUTOFF_PREFIX}*.sql migration`);
  }

  return files.slice(0, lastIndex + 1).map((name) => ({
    name,
    sql: fs.readFileSync(path.join(MIGRATIONS_DIR, name), 'utf8'),
  }));
}

async function applyMigrations(client: Pool, migrations: { name: string; sql: string }[]): Promise<void> {
  for (const m of migrations) {
    try {
      await client.query(m.sql);
    } catch (err) {
      throw new Error(`Migration ${m.name} failed: ${(err as Error).message}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

const TENANT_ID = `tenant_listconn_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
const CRM_INTEGRATION_ID = `int_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
const SCHED_INTEGRATION_ID = `int_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
const DISABLED_INTEGRATION_ID = `int_${randomUUID().replace(/-/g, '').slice(0, 16)}`;

type ConnectorDbImport = typeof import('../../platform/integrations/connectors/db');
type CryptoImport = typeof import('../../platform/integrations/connectors/crypto');
type PlatformDbImport = typeof import('../../platform/db');

let listEnabledConnectorConfigs: ConnectorDbImport['listEnabledConnectorConfigs'];
let encryptValue: CryptoImport['encryptValue'];
let closePlatformPool: PlatformDbImport['closePlatformPool'];

let testPool: Pool;
let setupOk = false;
let originalDatabaseUrl: string | undefined;
let originalAppEnv: string | undefined;

describe.skipIf(skipReason !== null)(
  'listEnabledConnectorConfigs — real Postgres (Task #1109)',
  () => {
    beforeAll(async () => {
      if (!adminConn) return;

      // 1. Create the per-run test database.
      const adminClient = new Client({
        connectionString: buildUrl(adminConn, adminConn.database),
      });
      await adminClient.connect();
      try {
        await adminClient.query(`DROP DATABASE IF EXISTS "${TEST_DB_NAME}" WITH (FORCE)`);
        await adminClient.query(`CREATE DATABASE "${TEST_DB_NAME}"`);
      } finally {
        await adminClient.end();
      }

      // 2. Apply migrations against the fresh DB before importing the
      //    platform modules so they bind to the test schema.
      const testUrl = buildUrl(adminConn, TEST_DB_NAME);
      testPool = new Pool({ connectionString: testUrl, max: 4 });
      const migrations = loadMigrationsThroughCutoff();
      await applyMigrations(testPool, migrations);

      // 3. Repoint the platform DB pool at the test database, then
      //    dynamic-import the connector code so it picks up the new env.
      originalDatabaseUrl = process.env.DATABASE_URL;
      originalAppEnv = process.env.APP_ENV;
      process.env.DATABASE_URL = testUrl;
      process.env.APP_ENV = 'development';

      const platformDbModule = await import('../../platform/db');
      closePlatformPool = platformDbModule.closePlatformPool;
      await closePlatformPool();

      const dbModule = await import('../../platform/integrations/connectors/db');
      listEnabledConnectorConfigs = dbModule.listEnabledConnectorConfigs;

      const cryptoModule = await import('../../platform/integrations/connectors/crypto');
      encryptValue = cryptoModule.encryptValue;

      // 4. Seed a tenant, three integrations (crm enabled, scheduling
      //    enabled, crm disabled) and one connector_configs row per
      //    integration. Encrypted with the same helper the production
      //    write path uses so the decrypt branch in
      //    `listEnabledConnectorConfigs` returns plaintext.
      await testPool.query(
        `INSERT INTO tenants (id, name, slug)
         VALUES ($1, 'List Conn Tenant', $2)`,
        [TENANT_ID, `list-conn-${TENANT_ID}`],
      );

      await testPool.query(
        `INSERT INTO integrations
           (id, tenant_id, name, integration_type, provider, is_enabled, config)
         VALUES
           ($1, $2, 'HubSpot CRM',  'crm',        'hubspot',  TRUE,  '{"region":"us"}'::jsonb),
           ($3, $2, 'Google Cal',   'scheduling', 'google',   TRUE,  '{}'::jsonb),
           ($4, $2, 'Old HubSpot',  'crm',        'hubspot2', FALSE, '{}'::jsonb)`,
        [CRM_INTEGRATION_ID, TENANT_ID, SCHED_INTEGRATION_ID, DISABLED_INTEGRATION_ID],
      );

      await testPool.query(
        `INSERT INTO connector_configs
           (tenant_id, integration_id, config_key, encrypted_value)
         VALUES
           ($1, $2, 'access_token', $3),
           ($1, $4, 'access_token', $5),
           ($1, $6, 'access_token', $7)`,
        [
          TENANT_ID,
          CRM_INTEGRATION_ID, encryptValue('crm-token-real'),
          SCHED_INTEGRATION_ID, encryptValue('scheduling-token-real'),
          DISABLED_INTEGRATION_ID, encryptValue('disabled-token-real'),
        ],
      );

      setupOk = true;
    }, 180_000);

    afterAll(async () => {
      if (!adminConn) return;
      try {
        if (closePlatformPool) await closePlatformPool().catch(() => {});
        if (testPool) await testPool.end().catch(() => {});
      } finally {
        if (originalDatabaseUrl === undefined) {
          delete process.env.DATABASE_URL;
        } else {
          process.env.DATABASE_URL = originalDatabaseUrl;
        }
        if (originalAppEnv === undefined) {
          delete process.env.APP_ENV;
        } else {
          process.env.APP_ENV = originalAppEnv;
        }
      }
      const adminClient = new Client({
        connectionString: buildUrl(adminConn, adminConn.database),
      });
      await adminClient.connect();
      try {
        await adminClient.query(`DROP DATABASE IF EXISTS "${TEST_DB_NAME}" WITH (FORCE)`);
      } finally {
        await adminClient.end();
      }
    }, 60_000);

    // The bug this task fixes was specifically `integration_type = ANY($2::text[])`
    // crashing with `operator does not exist: integration_type = text` and
    // `integration_id = ANY($2::uuid[])` crashing with
    // `character varying = uuid`. If those casts ever drift back, this
    // assertion fails before any of the dispatch-flow assertions get a
    // chance to run.
    it('runs the filtered query against the real schema without an enum/text or varchar/uuid mismatch', async () => {
      expect(setupOk).toBe(true);
      // Multi-type filter == the exact shape `dispatchEvent` builds for
      // `appointment.booked` (it asks for crm + scheduling + a few more).
      // The combination of the enum cast on `integration_type` and the
      // text cast on `integration_id` exercises both broken sites in one
      // call.
      const configs = await listEnabledConnectorConfigs(
        TENANT_ID as never,
        ['crm', 'scheduling'] as never,
      );

      // Disabled integration must not appear; the two enabled rows must.
      expect(configs).toHaveLength(2);
      const byProvider = new Map(configs.map((c) => [c.provider, c]));

      const crm = byProvider.get('hubspot');
      expect(crm).toBeDefined();
      expect(crm!.connectorType).toBe('crm');
      expect(crm!.isEnabled).toBe(true);
      expect(crm!.integrationId).toBe(CRM_INTEGRATION_ID);
      // Static config from the JSONB `config` column merges through.
      expect(crm!.credentials.region).toBe('us');
      // Connector_configs row was encrypted, so this is the round-trip
      // through the join + decrypt branch.
      expect(crm!.credentials.access_token).toBe('crm-token-real');

      const sched = byProvider.get('google');
      expect(sched).toBeDefined();
      expect(sched!.connectorType).toBe('scheduling');
      expect(sched!.integrationId).toBe(SCHED_INTEGRATION_ID);
      expect(sched!.credentials.access_token).toBe('scheduling-token-real');

      // Belt-and-suspenders: the disabled row's plaintext token must not
      // have leaked into either bucket via a misjoin.
      for (const c of configs) {
        expect(c.credentials.access_token).not.toBe('disabled-token-real');
      }
    });

    // Covers the unfiltered branch (no `connectorTypes` argument). It
    // skips the `integration_type = ANY(...)` predicate entirely but
    // still hits the second varchar/uuid site on `connector_configs`.
    it('returns every enabled integration when called without a connectorTypes filter', async () => {
      expect(setupOk).toBe(true);
      const configs = await listEnabledConnectorConfigs(TENANT_ID as never);

      expect(configs).toHaveLength(2);
      const providers = configs.map((c) => c.provider).sort();
      expect(providers).toEqual(['google', 'hubspot']);

      // Credentials still decrypted on the unfiltered path.
      const crm = configs.find((c) => c.provider === 'hubspot')!;
      expect(crm.credentials.access_token).toBe('crm-token-real');
    });
  },
);
