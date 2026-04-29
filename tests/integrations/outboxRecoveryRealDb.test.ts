// @vitest-environment node
//
// Task #974 — real-Postgres recovery test for the integration outbox.
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
// What this test deliberately does NOT exercise: the high-level
// `connectorService.dispatchEvent` flow. That path resolves enabled
// integrations through `listEnabledConnectorConfigs` in
// `platform/integrations/connectors/db.ts`, which is its own concern and
// already has dedicated coverage. Stubbing `dispatchEvent` at the drain's
// dispatch boundary keeps this test focused on the SQL paths the task
// explicitly enumerates.
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
// Toggled per test to simulate the HubSpot adapter being offline / online
// when the drain dispatches the buffered event.
const adapterState = { hubspotOnline: false };

type OutboxBufferImport = typeof import('../../platform/integrations/connectors/outboxBuffer');
type DrainImport = typeof import('../../platform/integrations/connectors/ConnectorOutboxDrainScheduler');
type ConnectorServiceImport = typeof import('../../platform/integrations/connectors/ConnectorService');
type PlatformDbImport = typeof import('../../platform/db');

let bufferOutboxEvent: OutboxBufferImport['bufferOutboxEvent'];
let markOutboxRowPendingAfterInlineFailure: OutboxBufferImport['markOutboxRowPendingAfterInlineFailure'];
let runConnectorOutboxDrainCycle: DrainImport['runConnectorOutboxDrainCycle'];
let connectorService: ConnectorServiceImport['connectorService'];
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

      const drainModule = await import('../../platform/integrations/connectors/ConnectorOutboxDrainScheduler');
      runConnectorOutboxDrainCycle = drainModule.runConnectorOutboxDrainCycle;

      const csModule = await import('../../platform/integrations/connectors/ConnectorService');
      connectorService = csModule.connectorService;

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
      adapterState.hubspotOnline = false;

      // The drain calls `connectorService.dispatchEvent(... { bufferToOutbox: false })`
      // to deliver each claimed row. Stubbing that single boundary lets us
      // exercise the drain's real claim CTE + delivery UPDATE while
      // simulating the HubSpot adapter being offline / online via the
      // `adapterState` toggle. The outbox SQL paths under test
      // (bufferOutboxEvent, markOutboxRow*, claim CTE) all run for real.
      // Cleared in afterEach via vi.restoreAllMocks so the spy never
      // leaks to neighboring suites.
      vi.spyOn(connectorService, 'dispatchEvent').mockImplementation(
        async (_tenantId, _eventType, _payload, _opts) => {
          if (!adapterState.hubspotOnline) {
            return {
              dispatched: 1,
              results: [{
                connectorType: 'crm',
                provider: 'hubspot',
                success: false,
                error: 'HubSpot API: connection refused',
              }],
            };
          }
          return {
            dispatched: 1,
            results: [{
              connectorType: 'crm',
              provider: 'hubspot',
              success: true,
            }],
          };
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
      //    archived_at filter, the lease columns) plus markDelivered's
      //    UPDATE. dispatchEvent is stubbed at the boundary so the
      //    decision to mark delivered comes from the test, not from a
      //    network call — but the SQL that records that decision runs
      //    for real.
      adapterState.hubspotOnline = true;
      const drain = await runConnectorOutboxDrainCycle();

      expect(drain.claimed).toBe(1);
      expect(drain.delivered).toBe(1);
      expect(drain.failed).toBe(0);
      expect(drain.deadLettered).toBe(0);

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
