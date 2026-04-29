// @vitest-environment node
//
// BL-044 — real-Postgres integration test for migration 078:
//   - call_events monthly partitioning (INSERT routing, prune helper, RLS)
//   - idx_usage_metrics_tenant_time_type (structural + planner reachability)
//
// Spins up a fresh per-run database via DATABASE_URL, runs migrations
// 001..078, exercises the contracts, drops the database. Suite is skipped
// when DATABASE_URL is unset or the server cannot be reached.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, Pool } from 'pg';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

// ---------------------------------------------------------------------------
// Environment + skip handling
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

// Probe the server before the suite runs so an unreachable Postgres
// SKIPS the suite cleanly instead of failing setup. vitest 4 supports
// top-level await, which lets `describe.skipIf` consult the probe result.
async function probeReachable(): Promise<boolean> {
  if (!adminConn) return false;
  const probe = new Client({
    connectionString: buildUrl(adminConn, adminConn.database),
    connectionTimeoutMillis: 2_000,
    statement_timeout: 2_000,
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
  ? 'DATABASE_URL not set — skipping BL-044 partition integration test'
  : !dbReachable
    ? 'Postgres server unreachable — skipping BL-044 partition integration test'
    : null;

// Unique DB name per run so concurrent test workers don't collide.
const TEST_DB_NAME = `bl044_test_${randomUUID().replace(/-/g, '').slice(0, 16)}`;

// ---------------------------------------------------------------------------
// Migration loader — runs 001..078 (lex sort), exactly like
// scripts/run-migrations.ts but scoped to the partition cut-off.
// ---------------------------------------------------------------------------

const MIGRATIONS_DIR = path.join(process.cwd(), 'migrations');

function loadMigrationsThrough078(): { name: string; sql: string }[] {
  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d{3}_/.test(f) && f.endsWith('.sql'))
    .sort();

  // Two migrations share the `063_` prefix and ASCII-default sort puts
  // them in the WRONG dependency order — `_pins.sql` references the
  // `pin_order` column that `_pin_order.sql` adds. Production
  // `schema_migrations` shows `_pin_order` was applied first
  // (presumably hand-fixed at apply time). Mirror that here so the
  // test's fresh DB matches reality.
  const A_PIN_ORDER = '063_call_saved_views_pin_order.sql';
  const A_PINS = '063_call_saved_view_pins.sql';
  const iPins = files.indexOf(A_PINS);
  const iPinOrder = files.indexOf(A_PIN_ORDER);
  if (iPins >= 0 && iPinOrder >= 0 && iPins < iPinOrder) {
    files.splice(iPinOrder, 1);
    files.splice(iPins, 0, A_PIN_ORDER);
  }

  // Stop after the last `078_*.sql` file (the partition migration); we don't
  // need anything beyond that, and limiting the set keeps the test fast.
  const lastIndex = (() => {
    let idx = -1;
    for (let i = 0; i < files.length; i += 1) {
      if (files[i].startsWith('078_')) idx = i;
    }
    return idx;
  })();

  if (lastIndex < 0) {
    throw new Error('Could not find any 078_*.sql migration');
  }

  return files.slice(0, lastIndex + 1).map((name) => ({
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

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe.skipIf(skipReason !== null)('BL-044 call_events partitioning + usage_metrics index (real Postgres)', () => {
  let testPool: Pool;
  let setupOk = false;

  beforeAll(async () => {
    if (!adminConn) return;

    // 1. Create a fresh database via the admin connection.
    const adminClient = new Client({
      connectionString: buildUrl(adminConn, adminConn.database),
    });
    await adminClient.connect();
    try {
      // CREATE DATABASE cannot run inside a transaction.
      await adminClient.query(`DROP DATABASE IF EXISTS "${TEST_DB_NAME}" WITH (FORCE)`);
      await adminClient.query(`CREATE DATABASE "${TEST_DB_NAME}"`);
    } finally {
      await adminClient.end();
    }

    // 2. Connect to the test database and run migrations 001..078.
    testPool = new Pool({
      connectionString: buildUrl(adminConn, TEST_DB_NAME),
      max: 4,
    });
    const migrations = loadMigrationsThrough078();
    await applyMigrations(testPool, migrations);

    // Migration 015 grants privileges to `platform_rls_tester` only for the
    // tables that exist at THAT moment. Re-run the bulk GRANTs now that the
    // full schema (including call_events + every later table) is in place
    // so the RLS tests below can actually execute SELECT / INSERT under
    // the non-superuser role. Also pin DEFAULT PRIVILEGES so any partition
    // we create later in this suite (via ensure_call_events_partition)
    // inherits the same access.
    await testPool.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO platform_rls_tester`,
    );
    await testPool.query(
      `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO platform_rls_tester`,
    );
    await testPool.query(
      `ALTER DEFAULT PRIVILEGES IN SCHEMA public
         GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO platform_rls_tester`,
    );

    setupOk = true;
  }, 180_000);

  afterAll(async () => {
    if (!adminConn) return;
    if (testPool) {
      await testPool.end().catch(() => {});
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

  // Sanity check so the rest of the assertions don't run against a half-set-up DB.
  it('migrated through 078 and produced a partitioned call_events table', async () => {
    expect(setupOk).toBe(true);
    const { rows } = await testPool.query<{ relkind: string }>(
      `SELECT relkind FROM pg_class
        WHERE relname = 'call_events'
          AND relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = current_schema())`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].relkind).toBe('p');
  });

  // -------------------------------------------------------------------------
  // 1. Partition routing
  // -------------------------------------------------------------------------
  describe('INSERT routing', () => {
    const tenantId = `tenant_${randomUUID().slice(0, 8)}`;
    const sessionId = `sess_${randomUUID().slice(0, 8)}`;

    // Three first-of-month timestamps spanning ~5 months back.
    const monthOffsets = [-4, -2, 0];
    const targets = monthOffsets.map((offset) => {
      const d = new Date();
      d.setUTCDate(15);
      d.setUTCHours(12, 0, 0, 0);
      d.setUTCMonth(d.getUTCMonth() + offset);
      return d;
    });

    function partitionNameFor(d: Date): string {
      const y = d.getUTCFullYear();
      const m = String(d.getUTCMonth() + 1).padStart(2, '0');
      return `call_events_${y}_${m}`;
    }

    beforeAll(async () => {
      // Seed a tenant + call_session via the privileged path (RLS off).
      const c = await testPool.connect();
      try {
        await c.query('BEGIN');
        await c.query('SET LOCAL row_security = off');
        await c.query(
          `INSERT INTO tenants (id, name, slug) VALUES ($1, $2, $3)`,
          [tenantId, 'BL-044 routing tenant', `bl044-routing-${tenantId}`],
        );
        await c.query(
          `INSERT INTO call_sessions (id, tenant_id, direction)
           VALUES ($1, $2, 'inbound')`,
          [sessionId, tenantId],
        );
        await c.query('COMMIT');
      } catch (err) {
        await c.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        c.release();
      }

      // Make sure each target month has a partition before we INSERT into it
      // — production uses CallEventsRetentionScheduler to ensure this on a
      // daily cycle; here we call the same SQL helper directly.
      for (const d of targets) {
        await testPool.query(
          `SELECT ensure_call_events_partition($1::timestamptz)`,
          [d.toISOString()],
        );
      }

      // Insert one event per target month.
      for (const d of targets) {
        const c2 = await testPool.connect();
        try {
          await c2.query('BEGIN');
          await c2.query('SET LOCAL row_security = off');
          await c2.query(
            `INSERT INTO call_events (tenant_id, call_session_id, event_type, occurred_at)
             VALUES ($1, $2, $3, $4)`,
            [tenantId, sessionId, 'CALL_RECEIVED', d.toISOString()],
          );
          await c2.query('COMMIT');
        } finally {
          c2.release();
        }
      }
    });

    it('routes each INSERT into the partition matching its occurred_at month', async () => {
      for (const d of targets) {
        const part = partitionNameFor(d);
        // Read directly from the child partition table (bypasses the parent
        // routing) so we know the row physically lives there.
        const { rows } = await testPool.query(
          `SELECT COUNT(*)::int AS n FROM ${part}
            WHERE call_session_id = $1 AND occurred_at = $2`,
          [sessionId, d.toISOString()],
        );
        expect(rows[0].n, `partition ${part} should hold its month's row`).toBe(1);
      }
    });

    it('reports the same total via the partitioned parent', async () => {
      const { rows } = await testPool.query(
        `SELECT COUNT(*)::int AS n FROM call_events WHERE call_session_id = $1`,
        [sessionId],
      );
      expect(rows[0].n).toBe(targets.length);
    });
  });

  // -------------------------------------------------------------------------
  // 2. prune_call_events_older_than — fully aged vs partially aged
  // -------------------------------------------------------------------------
  describe('prune_call_events_older_than', () => {
    // Helper to compute month-anchored timestamps relative to today.
    function firstOfMonth(monthOffset: number): Date {
      const now = new Date();
      const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
      d.setUTCMonth(d.getUTCMonth() + monthOffset);
      return d;
    }
    async function ensurePartition(tsIso: string): Promise<string> {
      const r = await testPool.query<{ ensure_call_events_partition: string }>(
        `SELECT ensure_call_events_partition($1::timestamptz)`,
        [tsIso],
      );
      return r.rows[0].ensure_call_events_partition;
    }

    it('with the production 90-day window: drops fully-aged months and keeps partitions still in window', async () => {
      // Production CallEventsRetentionScheduler calls
      // prune_call_events_older_than(90). A partition ~3 months back is
      // still in the 90-day window; a partition ~10 months back is fully
      // aged out and must be dropped.
      const partial = await ensurePartition(firstOfMonth(-3).toISOString());
      const aged = await ensurePartition(firstOfMonth(-10).toISOString());

      // Sanity: both partitions exist before the prune.
      const before = await testPool.query<{ relname: string }>(
        `SELECT relname FROM pg_class WHERE relname IN ($1, $2)`,
        [partial, aged],
      );
      expect(before.rows.map((r) => r.relname).sort()).toEqual([aged, partial].sort());

      const { rows } = await testPool.query<{ prune_call_events_older_than: string[] }>(
        `SELECT prune_call_events_older_than(90) AS prune_call_events_older_than`,
      );
      const dropped = rows[0].prune_call_events_older_than ?? [];

      expect(dropped, `90-day prune must drop the fully-aged partition ${aged}`).toContain(aged);
      expect(dropped, `90-day prune must NOT drop the still-in-window partition ${partial}`).not.toContain(partial);

      const after = await testPool.query<{ relname: string }>(
        `SELECT relname FROM pg_class WHERE relname IN ($1, $2)`,
        [partial, aged],
      );
      const remaining = after.rows.map((r) => r.relname);
      expect(remaining).toContain(partial);
      expect(remaining).not.toContain(aged);
    });

    it('with a tighter 30-day window: still protects a partition whose range only partially overlaps the retention boundary', async () => {
      // Previous month's partition spans first-of-prev-month →
      // first-of-this-month. A 30-day cutoff falls inside that range so
      // the partition is "partial" and must be kept.
      const partial = await ensurePartition(firstOfMonth(-1).toISOString());
      const aged = await ensurePartition(firstOfMonth(-6).toISOString());

      const { rows } = await testPool.query<{ prune_call_events_older_than: string[] }>(
        `SELECT prune_call_events_older_than(30) AS prune_call_events_older_than`,
      );
      const dropped = rows[0].prune_call_events_older_than ?? [];

      expect(dropped, `30-day prune must drop the fully-aged partition ${aged}`).toContain(aged);
      expect(dropped, `30-day prune must NOT drop the partial partition ${partial}`).not.toContain(partial);
    });
  });

  // -------------------------------------------------------------------------
  // 3. RLS propagation onto a partition created AFTER the swap
  // -------------------------------------------------------------------------
  describe('tenant_isolation_call_events RLS on a freshly-attached partition', () => {
    const tenantA = `tenant_a_${randomUUID().slice(0, 8)}`;
    const tenantB = `tenant_b_${randomUUID().slice(0, 8)}`;
    const sessionA = `sess_a_${randomUUID().slice(0, 8)}`;
    const sessionB = `sess_b_${randomUUID().slice(0, 8)}`;

    // Use a far-future month so this partition is brand new (created via
    // ensure_call_events_partition AFTER the migration ran) — exactly the
    // scenario where a regression in RLS propagation would surface.
    const target = new Date();
    target.setUTCMonth(target.getUTCMonth() + 9);
    target.setUTCDate(15);
    target.setUTCHours(12, 0, 0, 0);
    const targetIso = target.toISOString();

    let partitionName = '';

    beforeAll(async () => {
      // Privileged setup: tenants, sessions, partition.
      const c = await testPool.connect();
      try {
        await c.query('BEGIN');
        await c.query('SET LOCAL row_security = off');
        await c.query(
          `INSERT INTO tenants (id, name, slug) VALUES ($1, $2, $3), ($4, $5, $6)`,
          [
            tenantA, 'BL-044 RLS A', `bl044-rls-a-${tenantA}`,
            tenantB, 'BL-044 RLS B', `bl044-rls-b-${tenantB}`,
          ],
        );
        await c.query(
          `INSERT INTO call_sessions (id, tenant_id, direction)
           VALUES ($1, $2, 'inbound'), ($3, $4, 'inbound')`,
          [sessionA, tenantA, sessionB, tenantB],
        );
        await c.query('COMMIT');
      } catch (err) {
        await c.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        c.release();
      }

      const { rows } = await testPool.query<{ ensure_call_events_partition: string }>(
        `SELECT ensure_call_events_partition($1::timestamptz)`,
        [targetIso],
      );
      partitionName = rows[0].ensure_call_events_partition;

      // Seed one event per tenant in the new partition (privileged path).
      const c2 = await testPool.connect();
      try {
        await c2.query('BEGIN');
        await c2.query('SET LOCAL row_security = off');
        await c2.query(
          `INSERT INTO call_events (tenant_id, call_session_id, event_type, occurred_at)
           VALUES ($1, $2, 'CALL_RECEIVED', $3),
                  ($4, $5, 'CALL_RECEIVED', $3)`,
          [tenantA, sessionA, targetIso, tenantB, sessionB],
        );
        await c2.query('COMMIT');
      } finally {
        c2.release();
      }
    });

    it('verifies the new partition is correctly attached to the parent', async () => {
      // Sanity-check that ensure_call_events_partition really did create a
      // partition under the call_events parent — this is what makes the
      // parent-level RLS policy reachable when application code queries
      // through `call_events` and the row is routed to this partition.
      const { rows } = await testPool.query<{ partition_name: string }>(
        `SELECT child.relname AS partition_name
           FROM pg_inherits i
           JOIN pg_class child  ON child.oid  = i.inhrelid
           JOIN pg_class parent ON parent.oid = i.inhparent
          WHERE parent.relname = 'call_events'
            AND child.relname = $1`,
        [partitionName],
      );
      expect(rows).toHaveLength(1);
    });

    it('parent-level RLS scopes SELECT to the active tenant — even for rows in a freshly-attached partition', async () => {
      // Application code reads through the partitioned parent (`call_events`),
      // not the child partition. Postgres applies the parent's RLS to every
      // partition routed under that parent — including ones created AFTER
      // the partition swap (the failure mode this test guards against would
      // be a future migration that recreated the parent without re-enabling
      // RLS, leaving newly-attached partitions completely open).
      const c = await testPool.connect();
      let rows: { tenant_id: string; occurred_at: string }[] = [];
      try {
        await c.query('BEGIN');
        await c.query(`SET LOCAL ROLE platform_rls_tester`);
        await c.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantA]);

        const r = await c.query<{ tenant_id: string; occurred_at: string }>(
          `SELECT tenant_id, occurred_at FROM call_events WHERE occurred_at = $1`,
          [targetIso],
        );
        rows = r.rows;
      } finally {
        await c.query('ROLLBACK').catch(() => {});
        c.release();
      }

      // We seeded one row per tenant at this exact occurred_at — RLS must
      // narrow that down to just the active tenant's row.
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        expect(row.tenant_id).toBe(tenantA);
      }
    });

    it('propagates RLS to the new partition (WITH CHECK blocks cross-tenant INSERT)', async () => {
      const c = await testPool.connect();
      let blocked = false;
      try {
        await c.query('BEGIN');
        await c.query(`SET LOCAL ROLE platform_rls_tester`);
        await c.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantA]);
        try {
          // Tenant A is the active context but we try to write a row tagged
          // as Tenant B — the WITH CHECK must reject it.
          await c.query(
            `INSERT INTO call_events (tenant_id, call_session_id, event_type, occurred_at)
             VALUES ($1, $2, 'CALL_RECEIVED', $3)`,
            [tenantB, sessionB, targetIso],
          );
        } catch (err) {
          // pg surfaces RLS denials as 42501 (insufficient_privilege) /
          // "new row violates row-level security policy".
          const msg = String(err);
          blocked = /row-level security|policy/i.test(msg);
        }
      } finally {
        await c.query('ROLLBACK').catch(() => {});
        c.release();
      }
      expect(blocked).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // 4. idx_usage_metrics_tenant_time_type — EXPLAIN check
  // -------------------------------------------------------------------------
  describe('idx_usage_metrics_tenant_time_type is the access path for the analytics rollup', () => {
    const tenantId = `tenant_um_${randomUUID().slice(0, 8)}`;

    beforeAll(async () => {
      const c = await testPool.connect();
      try {
        await c.query('BEGIN');
        await c.query('SET LOCAL row_security = off');
        await c.query(
          `INSERT INTO tenants (id, name, slug) VALUES ($1, $2, $3)`,
          [tenantId, 'BL-044 usage metrics', `bl044-um-${tenantId}`],
        );

        // Insert enough rows across several tenants so the planner has a
        // non-trivial choice — without this it might pick a seq scan
        // even though the index exists.
        const otherTenants = Array.from({ length: 8 }).map(() => `tenant_other_${randomUUID().slice(0, 8)}`);
        for (const t of otherTenants) {
          await c.query(
            `INSERT INTO tenants (id, name, slug) VALUES ($1, $2, $3)`,
            [t, 'BL-044 noise', `bl044-noise-${t}`],
          );
        }

        const allTenants = [tenantId, ...otherTenants];
        const metricTypes = ['ai_minutes', 'calls_inbound', 'calls_outbound', 'sms_sent'];
        const now = Date.now();
        const rows: unknown[][] = [];
        for (const t of allTenants) {
          for (let day = 0; day < 60; day += 1) {
            for (const m of metricTypes) {
              const start = new Date(now - day * 24 * 60 * 60 * 1000 - Math.floor(Math.random() * 60_000));
              const end = new Date(start.getTime() + 60_000);
              rows.push([t, m, start.toISOString(), end.toISOString(), 1, 100, 100]);
            }
          }
        }
        // Bulk insert in chunks.
        const CHUNK = 500;
        for (let i = 0; i < rows.length; i += CHUNK) {
          const chunk = rows.slice(i, i + CHUNK);
          const values: string[] = [];
          const params: unknown[] = [];
          chunk.forEach((r, idx) => {
            const base = idx * 7;
            values.push(
              `($${base + 1}, $${base + 2}::usage_metric_type, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7})`,
            );
            params.push(...r);
          });
          await c.query(
            `INSERT INTO usage_metrics
               (tenant_id, metric_type, period_start, period_end, quantity, unit_cost_cents, total_cost_cents)
             VALUES ${values.join(', ')}
             ON CONFLICT (tenant_id, metric_type, period_start) DO NOTHING`,
            params,
          );
        }
        await c.query('COMMIT');
      } catch (err) {
        await c.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        c.release();
      }

      // ANALYZE so the planner has accurate statistics.
      await testPool.query('ANALYZE usage_metrics');
    });

    it('exists on usage_metrics with the expected column order', async () => {
      const { rows } = await testPool.query<{ indexdef: string }>(
        `SELECT indexdef FROM pg_indexes
          WHERE tablename = 'usage_metrics'
            AND indexname = 'idx_usage_metrics_tenant_time_type'`,
      );
      expect(rows).toHaveLength(1);
      // Column order matters: (tenant_id, metric_type, period_start DESC) is
      // a perfect-prefix match for the AnalyticsService.getCostAnalytics
      // rollup (tenant_id eq + metric_type eq/IN + period_start range) and
      // keeps period_start DESC for tenant + recent-time scans elsewhere.
      // See migration 078's header for why this deviates from the audit's
      // literal column order.
      expect(rows[0].indexdef).toMatch(
        /\(tenant_id, metric_type, period_start DESC\)/,
      );
    });

    it('removes the now-redundant idx_usage_metrics_tenant_type_period from migration 012', async () => {
      // Migration 078 drops the older 4-column index because the new
      // 3-column index covers every query path it served (the 4th
      // column, period_end, is not filtered on by any production
      // query). This guard catches a regression where someone adds it
      // back, which would split planner cost estimates across two
      // duplicate indexes.
      const { rows } = await testPool.query<{ count: string }>(
        `SELECT count(*)::text AS count
           FROM pg_indexes
          WHERE tablename = 'usage_metrics'
            AND indexname = 'idx_usage_metrics_tenant_type_period'`,
      );
      expect(rows[0].count).toBe('0');
    });

    // Walk an EXPLAIN (FORMAT JSON) tree and return every "Index Name" used.
    function collectIndexNames(node: unknown): string[] {
      const found: string[] = [];
      const visit = (n: unknown): void => {
        if (Array.isArray(n)) { for (const item of n) visit(item); return; }
        if (!n || typeof n !== 'object') return;
        const obj = n as Record<string, unknown>;
        if (typeof obj['Index Name'] === 'string') found.push(obj['Index Name'] as string);
        if (obj['Plans']) visit(obj['Plans']);
        if (obj['Plan']) visit(obj['Plan']);
      };
      visit(node);
      return found;
    }

    // Run EXPLAIN unaltered (no GUC overrides, no schema mutation) and
    // return the set of indexes the planner picked.
    async function explainIndexes(sql: string, params: unknown[]): Promise<string[]> {
      const { rows } = await testPool.query<{ ['QUERY PLAN']: unknown[] }>(
        `EXPLAIN (FORMAT JSON) ${sql}`,
        params,
      );
      return collectIndexNames(rows[0]['QUERY PLAN']);
    }

    it('is the natural plan for the AnalyticsService.getCostAnalytics ai_minutes rollup', async () => {
      // The cost-analytics rollup in platform/analytics/AnalyticsService.ts
      // (lines ~376-413) issues a tenant-scoped, period-bounded
      // SUM(total_cost_cents) rollup pinned to metric_type='ai_minutes'.
      // With migration 078's column order (tenant_id, metric_type,
      // period_start DESC) this is a perfect-prefix index scan and the
      // planner picks idx_usage_metrics_tenant_time_type without any
      // GUC overrides or schema mutation. EXPLAIN is unaltered.
      const from = new Date();
      from.setUTCDate(from.getUTCDate() - 30);
      const to = new Date();

      const aiIndexes = await explainIndexes(
        `SELECT DATE(period_start) AS day,
                COALESCE(SUM(total_cost_cents), 0)::int AS cost_cents
           FROM usage_metrics
          WHERE tenant_id = $1
            AND metric_type = 'ai_minutes'
            AND period_start >= $2
            AND period_start < $3
          GROUP BY DATE(period_start)
          ORDER BY day`,
        [tenantId, from.toISOString(), to.toISOString()],
      );
      expect(
        aiIndexes,
        `ai_minutes cost rollup must use idx_usage_metrics_tenant_time_type — got ${JSON.stringify(aiIndexes)}`,
      ).toContain('idx_usage_metrics_tenant_time_type');
    });

    it('is the natural plan for the AnalyticsService.getCostAnalytics calls rollup', async () => {
      // Companion to the ai_minutes test above. Same query shape, but
      // with metric_type IN ('calls_inbound', 'calls_outbound') — the
      // multi-value form the planner sees in production. The new
      // (tenant_id, metric_type, period_start DESC) index serves the
      // IN-list as a BitmapOr / multi-key Index Scan whose leading
      // columns still match the equality + IN filter perfectly.
      const from = new Date();
      from.setUTCDate(from.getUTCDate() - 30);
      const to = new Date();

      const callIndexes = await explainIndexes(
        `SELECT DATE(period_start) AS day,
                COALESCE(SUM(total_cost_cents), 0)::int AS cost_cents
           FROM usage_metrics
          WHERE tenant_id = $1
            AND metric_type IN ('calls_inbound', 'calls_outbound')
            AND period_start >= $2
            AND period_start < $3
          GROUP BY DATE(period_start)
          ORDER BY day`,
        [tenantId, from.toISOString(), to.toISOString()],
      );
      expect(
        callIndexes,
        `calls cost rollup must use idx_usage_metrics_tenant_time_type — got ${JSON.stringify(callIndexes)}`,
      ).toContain('idx_usage_metrics_tenant_time_type');
    });
  });
});
