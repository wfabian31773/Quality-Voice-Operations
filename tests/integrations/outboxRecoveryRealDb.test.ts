// @vitest-environment node
//
// Task #974 — real-Postgres recovery test for the integration outbox.
// Task #1149 — extended to exercise the full
// `connectorService.dispatchEvent` path end-to-end against the seeded
// database, instead of stubbing dispatch at the drain boundary.
//
// The hermetic sibling (`outboxRecovery.test.ts`) replaces the DB layer with
// an in-memory fake that answers based on string-prefix matching. That's
// fine for control-flow coverage but it cannot catch a SQL typo in
// `outboxBuffer.ts` or `ConnectorOutboxDrainScheduler.ts` — and it cannot
// catch a migration that silently drops/renames the
// `(tenant_id, idempotency_key)` constraint, the `archived_at` filter, or
// the `lease_expires_at` columns the drain CTE depends on.
//
// This suite exercises the actual SQL paths the task calls out, against a
// fresh per-run Postgres database:
//
//   * `bufferOutboxEvent` — `INSERT … ON CONFLICT (tenant_id,
//     idempotency_key) DO NOTHING`. Asserted by re-buffering the same
//     idempotency key and confirming we collapse onto the original row.
//   * `markOutboxRowPendingAfterInlineFailure` — the post-inline-failure
//     UPDATE that resets `next_attempt_at = NOW()` so the drain claims
//     the row on its very next pass.
//   * `runConnectorOutboxDrainCycle` — the CTE-based claim
//     (`WITH claimed AS (… FOR UPDATE SKIP LOCKED …) UPDATE … FROM
//     claimed`) plus `markDelivered`'s UPDATE. Both touch the
//     `archived_at` predicate (migration 095) and the `lease_expires_at`
//     columns (migration 096).
//
// Task #1149 widens the blast radius further: the drain's call to
// `connectorService.dispatchEvent` is no longer stubbed. Instead the
// suite seeds a real (test-mode) `crm`/`hubspot` integration row plus a
// matching encrypted `connector_configs` row, and the drain runs through
// the actual code path:
//
//   1. `runConnectorOutboxDrainCycle` claims the row (real CTE).
//   2. `connectorService.dispatchEvent` resolves enabled integrations via
//      `listEnabledConnectorConfigs` (real SQL — same query whose
//      enum/text mismatch broke production prior to Task #1109).
//   3. The HubSpot adapter is selected from the registry by
//      `(connectorType=crm, provider=hubspot)`.
//   4. `executeWithConfig` dispatches to the adapter and records the
//      result via `updateConnectorSyncStatus` (real SQL on the
//      `last_sync_status` / `last_sync_error*` columns from migrations
//      050/061) and `recordIntegrationEvent` (real SQL on
//      `integration_event_logs` from migration 046).
//   5. The drain finalises the row with `markDelivered` (real UPDATE
//      that nulls the lease columns).
//
// To stay hermetic we replace only the leaf network call: the HubSpot
// adapter's `execute` method is spied on `HubSpotConnectorAdapter.prototype`
// and toggles between an offline failure and an online success based on
// `adapterState.hubspotOnline`. Every layer above that — adapter
// resolution, integration lookup, sync-status updates, integration event
// logging, outbox state transitions — runs against the real database.
//
// The suite skips cleanly when DATABASE_URL is unset or unreachable, the
// same way other real-DB suites
// (`callEventsPartitionAndUsageMetricsIndex.test.ts`) do.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
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
  ? 'DATABASE_URL not set — skipping outbox recovery real-DB test'
  : !dbReachable
    ? 'Postgres server unreachable — skipping outbox recovery real-DB test'
    : null;

const TEST_DB_NAME = `outbox_recovery_${randomUUID().replace(/-/g, '').slice(0, 16)}`;

// ---------------------------------------------------------------------------
// Migration loader. Applies migrations 001..100 — enough to bring
// `outbox_events` up to the schema the production code expects:
//   * 007 — base table + UNIQUE(tenant_id, idempotency_key)
//   * 095 — `archived_at` column + idx_outbox_events_active_status
//   * 096 — `claimed_at` + `lease_expires_at` columns
// 063_call_saved_view_pins references the `pin_order` column added by
// 063_call_saved_views_pin_order — reorder so pin_order applies first
// (same fixup the partition test applies).
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

const TENANT_ID = `tenant_outbox_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
const CRM_INTEGRATION_ID = `int_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
// Toggled per test to simulate the HubSpot adapter being offline / online
// when the drain dispatches the buffered event.
const adapterState = { hubspotOnline: false };

type OutboxBufferImport = typeof import('../../platform/integrations/connectors/outboxBuffer');
type DrainImport = typeof import('../../platform/integrations/connectors/ConnectorOutboxDrainScheduler');
type HubSpotAdapterImport = typeof import('../../platform/integrations/connectors/adapters/hubspot');
type CryptoImport = typeof import('../../platform/integrations/connectors/crypto');
type PlatformDbImport = typeof import('../../platform/db');

let bufferOutboxEvent: OutboxBufferImport['bufferOutboxEvent'];
let markOutboxRowPendingAfterInlineFailure: OutboxBufferImport['markOutboxRowPendingAfterInlineFailure'];
let runConnectorOutboxDrainCycle: DrainImport['runConnectorOutboxDrainCycle'];
let HubSpotConnectorAdapter: HubSpotAdapterImport['HubSpotConnectorAdapter'];
let encryptValue: CryptoImport['encryptValue'];
let closePlatformPool: PlatformDbImport['closePlatformPool'];

let testPool: Pool;
let setupOk = false;
let originalDatabaseUrl: string | undefined;
let originalAppEnv: string | undefined;

describe.skipIf(skipReason !== null)(
  'Integration outbox recovery — real Postgres (Task #974)',
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

      // 2. Apply migrations against the fresh DB. Must complete before the
      //    platform modules are imported, since they query against the
      //    schema as soon as the first call lands.
      const testUrl = buildUrl(adminConn, TEST_DB_NAME);
      testPool = new Pool({ connectionString: testUrl, max: 4 });
      const migrations = loadMigrationsThroughCutoff();
      await applyMigrations(testPool, migrations);

      // 3. Seed a tenant so the FK on outbox_events.tenant_id resolves.
      await testPool.query(
        `INSERT INTO tenants (id, name, slug)
         VALUES ($1, 'Outbox Recovery Tenant', $2)`,
        [TENANT_ID, `outbox-recovery-${TENANT_ID}`],
      );

      // 4. Repoint the platform DB pool at the test database, then
      //    dynamic-import the connector code so it picks up the new env.
      originalDatabaseUrl = process.env.DATABASE_URL;
      originalAppEnv = process.env.APP_ENV;
      process.env.DATABASE_URL = testUrl;
      process.env.APP_ENV = 'development';

      const platformDbModule = await import('../../platform/db');
      closePlatformPool = platformDbModule.closePlatformPool;
      // Drop any pool an earlier import might have opened against the dev
      // URL so subsequent calls reconnect against the test database.
      await closePlatformPool();

      const bufferModule = await import('../../platform/integrations/connectors/outboxBuffer');
      bufferOutboxEvent = bufferModule.bufferOutboxEvent;
      markOutboxRowPendingAfterInlineFailure = bufferModule.markOutboxRowPendingAfterInlineFailure;

      // Loading the drain module transitively loads ConnectorService,
      // which instantiates each adapter singleton (including the HubSpot
      // adapter we spy on below). Spying on the prototype intercepts the
      // call on that same singleton.
      const drainModule = await import('../../platform/integrations/connectors/ConnectorOutboxDrainScheduler');
      runConnectorOutboxDrainCycle = drainModule.runConnectorOutboxDrainCycle;

      const hubspotModule = await import('../../platform/integrations/connectors/adapters/hubspot');
      HubSpotConnectorAdapter = hubspotModule.HubSpotConnectorAdapter;

      const cryptoModule = await import('../../platform/integrations/connectors/crypto');
      encryptValue = cryptoModule.encryptValue;

      // 5. Seed a single enabled CRM/HubSpot integration so
      //    `listEnabledConnectorConfigs` (the real query inside
      //    `dispatchEvent`) returns exactly one config and the drain's
      //    dispatched count is deterministic. The encrypted access_token
      //    flows through the same decrypt branch the production code
      //    takes; the spy on the adapter's `execute` short-circuits the
      //    actual HubSpot HTTP call so the test stays hermetic.
      await testPool.query(
        `INSERT INTO integrations
           (id, tenant_id, name, integration_type, provider, is_enabled, config)
         VALUES ($1, $2, 'HubSpot CRM', 'crm', 'hubspot', TRUE, '{}'::jsonb)`,
        [CRM_INTEGRATION_ID, TENANT_ID],
      );
      await testPool.query(
        `INSERT INTO connector_configs
           (tenant_id, integration_id, config_key, encrypted_value)
         VALUES ($1, $2, 'access_token', $3)`,
        [TENANT_ID, CRM_INTEGRATION_ID, encryptValue('hs-token-real')],
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

    beforeEach(async () => {
      if (!setupOk) return;
      // Fresh outbox state per test so assertions are deterministic.
      await testPool.query('DELETE FROM outbox_events');
      // Reset the integration's sync status so per-test assertions on
      // `last_sync_status` / `last_sync_error*` are not contaminated by
      // an earlier test's success / failure recording.
      await testPool.query(
        `UPDATE integrations
           SET last_sync_status = NULL,
               last_sync_at = NULL,
               last_sync_error = NULL,
               last_sync_error_at = NULL
         WHERE tenant_id = $1`,
        [TENANT_ID],
      );
      // Drop any integration_event_logs rows from a prior test so the
      // dispatch-recorded count assertion below sees only this run's row.
      await testPool.query(
        `DELETE FROM integration_event_logs WHERE tenant_id = $1`,
        [TENANT_ID],
      );
      adapterState.hubspotOnline = false;

      // Task #1149: replace only the leaf network call. The drain runs
      // through the real `connectorService.dispatchEvent` path —
      // `listEnabledConnectorConfigs` (real SQL), adapter resolution,
      // `executeWithConfig` (real `updateConnectorSyncStatus` +
      // `recordIntegrationEvent` writes), and finally `markDelivered` —
      // and only the adapter's outbound HTTP call is replaced via this
      // prototype spy. Toggling `adapterState.hubspotOnline` flips the
      // adapter between an offline failure (drain leaves the row
      // pending) and an online success (drain marks the row delivered).
      // Cleared in afterEach via vi.restoreAllMocks so the spy never
      // leaks to neighboring suites.
      vi.spyOn(HubSpotConnectorAdapter.prototype, 'execute').mockImplementation(
        async (_tenantId, _config, _payload) => {
          if (!adapterState.hubspotOnline) {
            return { success: false, error: 'HubSpot API: connection refused' };
          }
          return { success: true, externalId: 'hs-engagement-real-1' };
        },
      );
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    // Surfaces any silent setup failure (e.g. migration ordering breakage)
    // before later assertions try to read from a half-built schema.
    it('migrated through 100 and produced outbox_events with the expected shape', async () => {
      expect(setupOk).toBe(true);
      const { rows } = await testPool.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
          WHERE table_name = 'outbox_events'`,
      );
      const cols = new Set(rows.map((r) => r.column_name));
      // Every column the production SQL touches must exist.
      for (const expected of [
        'id', 'tenant_id', 'idempotency_key', 'event_type', 'payload',
        'status', 'attempts', 'max_attempts', 'last_error',
        'next_attempt_at', 'delivered_at', 'created_at', 'updated_at',
        'archived_at', 'claimed_at', 'lease_expires_at',
      ]) {
        expect(cols, `missing column ${expected}`).toContain(expected);
      }

      // The unique constraint the ON CONFLICT clause depends on.
      const { rows: idx } = await testPool.query<{ indexdef: string }>(
        `SELECT indexdef FROM pg_indexes
          WHERE tablename = 'outbox_events'`,
      );
      const idxText = idx.map((r) => r.indexdef).join('\n');
      expect(idxText).toMatch(/UNIQUE.*\(tenant_id, idempotency_key\)/);
    });

    it('buffers a pending row when the adapter is offline and delivers it within one drain cycle once it recovers', async () => {
      // 1. Adapter offline. Stage the event durably the same way the
      //    inline dispatch path does: insert via bufferOutboxEvent, then
      //    record the inline failure via markOutboxRowPendingAfterInlineFailure.
      //    Both run real SQL against the real DB — a typo in either UPDATE
      //    would fail loudly here.
      const idempotencyKey = `evt:appointment.booked:appointmentId=appt-real-recovery-1`;
      const buffered = await bufferOutboxEvent(
        TENANT_ID as never,
        'appointment.booked',
        idempotencyKey,
        {
          type: 'appointment.booked',
          appointmentId: 'appt-real-recovery-1',
          callerPhone: '+15555550100',
        } as never,
      );
      expect(buffered.rowId).not.toBeNull();
      expect(buffered.alreadyDelivered).toBe(false);

      await markOutboxRowPendingAfterInlineFailure(
        buffered.rowId!,
        'HubSpot API: connection refused',
      );

      // 2. The row is in `pending` with the inline failure recorded and
      //    next_attempt_at reset to NOW(). If the SQL drifted from the
      //    schema (e.g. a column rename), the UPDATE wouldn't match and
      //    the row would still be in its post-buffer transient state.
      const { rows: afterFailure } = await testPool.query<{
        status: string;
        last_error: string | null;
        attempts: number;
        next_attempt_at: string;
      }>(
        `SELECT status::text AS status, last_error, attempts, next_attempt_at
           FROM outbox_events WHERE tenant_id = $1`,
        [TENANT_ID],
      );
      expect(afterFailure).toHaveLength(1);
      expect(afterFailure[0].status).toBe('pending');
      expect(afterFailure[0].last_error).toMatch(/HubSpot/);
      expect(afterFailure[0].attempts).toBe(1);
      expect(new Date(afterFailure[0].next_attempt_at).getTime())
        .toBeLessThanOrEqual(Date.now() + 1_000);

      // 3. Bring the adapter online and run a single drain cycle. This
      //    exercises the real claim CTE (FOR UPDATE SKIP LOCKED, the
      //    archived_at filter, the lease columns), the real
      //    `connectorService.dispatchEvent` path
      //    (`listEnabledConnectorConfigs` → adapter resolution →
      //    `executeWithConfig`), and finally `markDelivered`'s UPDATE.
      //    Only the adapter's outbound HTTP call is replaced by the
      //    prototype spy in `beforeEach`; every SQL touchpoint runs for
      //    real against the test database.
      const adapterSpy = vi.mocked(HubSpotConnectorAdapter.prototype.execute);
      adapterState.hubspotOnline = true;
      const drain = await runConnectorOutboxDrainCycle();

      expect(drain.claimed).toBe(1);
      expect(drain.delivered).toBe(1);
      expect(drain.failed).toBe(0);
      expect(drain.deadLettered).toBe(0);

      // The adapter spy was actually invoked — proves dispatchEvent
      // resolved an integration row, picked the HubSpot adapter, and
      // executed it (rather than short-circuiting at any earlier stage).
      // Called once for this drain cycle's single claimed row.
      expect(adapterSpy).toHaveBeenCalledTimes(1);
      const adapterCall = adapterSpy.mock.calls[0];
      expect(adapterCall[0]).toBe(TENANT_ID);
      // The config passed to the adapter must be the seeded HubSpot CRM
      // row, with credentials decrypted by `listEnabledConnectorConfigs`.
      expect(adapterCall[1]).toMatchObject({
        connectorType: 'crm',
        provider: 'hubspot',
        integrationId: CRM_INTEGRATION_ID,
        isEnabled: true,
      });
      expect((adapterCall[1].credentials as Record<string, string>).access_token)
        .toBe('hs-token-real');
      expect(adapterCall[2]).toMatchObject({
        type: 'appointment.booked',
        appointmentId: 'appt-real-recovery-1',
      });

      const { rows: after } = await testPool.query<{
        status: string;
        delivered_at: string | null;
        last_error: string | null;
        claimed_at: string | null;
        lease_expires_at: string | null;
      }>(
        `SELECT status::text AS status, delivered_at, last_error,
                claimed_at, lease_expires_at
           FROM outbox_events WHERE tenant_id = $1`,
        [TENANT_ID],
      );
      expect(after).toHaveLength(1);
      expect(after[0].status).toBe('delivered');
      expect(after[0].delivered_at).not.toBeNull();
      expect(after[0].last_error).toBeNull();
      // markDelivered nulls out the lease so a stranded reaper can't
      // accidentally pick the row back up after delivery.
      expect(after[0].claimed_at).toBeNull();
      expect(after[0].lease_expires_at).toBeNull();

      // updateConnectorSyncStatus and recordIntegrationEvent are fired
      // without `await` inside executeWithConfig (they intentionally run
      // out of band so adapter latency isn't blocked on observability
      // writes). Poll briefly for the expected steady state rather than
      // racing them.
      await vi.waitFor(async () => {
        const { rows: integ } = await testPool.query<{
          last_sync_status: string | null;
          last_sync_error: string | null;
          last_sync_at: string | null;
        }>(
          `SELECT last_sync_status, last_sync_error, last_sync_at
             FROM integrations WHERE id = $1`,
          [CRM_INTEGRATION_ID],
        );
        expect(integ).toHaveLength(1);
        // Real `UPDATE integrations SET last_sync_status = $3, ...` —
        // catches column renames or enum mismatches in the sync-status
        // recording path.
        expect(integ[0].last_sync_status).toBe('success');
        expect(integ[0].last_sync_error).toBeNull();
        expect(integ[0].last_sync_at).not.toBeNull();

        const { rows: logs } = await testPool.query<{
          service_name: string | null;
          response_status: number | null;
        }>(
          `SELECT service_name, response_status
             FROM integration_event_logs WHERE tenant_id = $1`,
          [TENANT_ID],
        );
        // Real INSERT into integration_event_logs from
        // `recordIntegrationEvent` — catches schema drift on the
        // observability table.
        expect(logs).toHaveLength(1);
        expect(logs[0].service_name).toBe('crm:hubspot');
        expect(logs[0].response_status).toBe(200);
      }, { timeout: 10_000, interval: 50 });
    });

    it('honours the (tenant_id, idempotency_key) unique constraint — re-buffering the same key collapses onto the original row', async () => {
      // ON CONFLICT (tenant_id, idempotency_key) DO NOTHING is the entire
      // dedupe story for this table. If the migration ever drops or
      // renames that constraint, the second bufferOutboxEvent call would
      // either explode with a duplicate-key error (no constraint shape
      // matches) or insert a second row (constraint moved). Both
      // failure modes are caught here.
      const idempotencyKey = `evt:appointment.booked:appointmentId=appt-collapse-1`;
      const first = await bufferOutboxEvent(
        TENANT_ID as never,
        'appointment.booked',
        idempotencyKey,
        { type: 'appointment.booked', appointmentId: 'appt-collapse-1' } as never,
      );
      const second = await bufferOutboxEvent(
        TENANT_ID as never,
        'appointment.booked',
        idempotencyKey,
        { type: 'appointment.booked', appointmentId: 'appt-collapse-1' } as never,
      );

      expect(first.rowId).not.toBeNull();
      expect(second.rowId).toBe(first.rowId);
      expect(second.alreadyDelivered).toBe(false);

      const { rows } = await testPool.query<{ n: number }>(
        `SELECT COUNT(*)::int AS n FROM outbox_events WHERE tenant_id = $1`,
        [TENANT_ID],
      );
      expect(rows[0].n).toBe(1);
    });
  },
);
