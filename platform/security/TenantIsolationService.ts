import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { getPlatformPool, getPrivilegedPool, withPrivilegedClient } from '../db';
import { runWithRestrictedScope } from '../db/tenantScope';
import { createLogger } from '../core/logger';

const logger = createLogger('TENANT_ISOLATION');

export type IsolationTestSource = 'manual' | 'scheduled';

export interface IsolationTestResult {
  testName: string;
  passed: boolean;
  details: string;
}

export interface RunAllIsolationTestsOptions {
  /**
   * Tag the run as scheduled (background sweep) vs manual (admin-triggered
   * from the Platform Compliance UI). Persisted on every row so the UI can
   * show the most recent automated and manual runs side-by-side.
   */
  source?: IsolationTestSource;
}

export interface RunAllIsolationTestsResult {
  passed: number;
  failed: number;
  results: IsolationTestResult[];
  runId: string;
  source: IsolationTestSource;
}

/**
 * Pick an active tenant id to use as the "self" perspective when running
 * cross-tenant access tests. Uses the privileged pool because `tenants`
 * is RLS-scoped to app.tenant_id. Returns null when no active tenant
 * exists, in which case the cross-tenant suite is skipped (RLS-enabled
 * and rolbypassrls checks still run).
 */
export async function pickActiveTenantForIsolationTest(): Promise<string | null> {
  const pool = getPrivilegedPool();
  try {
    const { rows } = await pool.query<{ id: string }>(
      `SELECT id FROM tenants
        WHERE status = 'active'
        ORDER BY created_at ASC
        LIMIT 1`,
    );
    if (rows.length === 0) return null;
    return rows[0].id;
  } catch (err) {
    logger.warn('Failed to pick active tenant for isolation test', { error: String(err) });
    return null;
  }
}

/**
 * Tables checked for RLS enabled + FORCE. Every table that migrations 121+
 * put under RLS must be listed (TenantIsolationService.coverage.test.ts).
 */
export const RLS_TABLES = [
  'agents', 'phone_numbers', 'call_sessions', 'integrations',
  'connector_configs', 'campaigns', 'campaign_contacts',
  'audit_logs', 'api_keys', 'user_roles', 'analytics_metrics',
  'encryption_keys', 'encrypted_fields', 'gdpr_requests', 'tickets',
  'ticket_activity_log',
  // 121 action layer
  'action_idempotency', 'action_proposals', 'action_audit_log',
  // 048 bookings (FORCE from 120) and 122 scheduling v2
  'bookings', 'scheduling_provider_services', 'scheduling_business_hours',
];

/** Tables probed by the cross-tenant read check (fixed list, never input). */
export const CROSS_TENANT_READ_TABLES = [
  'agents', 'audit_logs', 'api_keys', 'bookings', 'tickets', 'action_proposals',
];

/**
 * NOBYPASSRLS role from migration 015. When the pool connects as a role that
 * bypasses RLS (postgres today), the cross-tenant read probe switches to it so
 * the COUNT is evaluated against the real policies. Fixed literal: it is the
 * only identifier interpolated into the SET ROLE statement.
 */
const RLS_TESTER_ROLE = 'platform_rls_tester';

/**
 * A missing grant (SQLSTATE 42501). RLS filters rows and never raises on
 * SELECT, so this means the probe could not read the table at all: the check
 * must fail, never count as "blocked".
 */
function isPermissionDenied(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === '42501' || String(err).includes('permission denied');
}

function probeCouldNotRead(table: string, asWhom: string, err: unknown): string {
  return `Probe could not read ${table} as ${asWhom} (permission denied, missing grant), ` +
    `so cross-tenant reads on it were not checked: ${String(err)}`;
}

/**
 * Fail loudly when the restricted pool is still a BYPASSRLS / superuser
 * role. Cross-tenant COUNT(*) checks are meaningless on that connection.
 */
export async function verifyConnectedRoleDoesNotBypassRls(): Promise<IsolationTestResult> {
  const pool = getPlatformPool();
  try {
    const { rows } = await pool.query<{
      rolname: string;
      rolbypassrls: boolean;
      rolsuper: boolean;
    }>(
      `SELECT rolname, rolbypassrls, rolsuper
         FROM pg_roles
        WHERE rolname = CURRENT_USER`,
    );
    const role = rows[0];
    if (!role) {
      return {
        testName: 'Connected role subject to RLS',
        passed: false,
        details: 'Could not resolve CURRENT_USER in pg_roles — failing closed',
      };
    }
    if (role.rolbypassrls || role.rolsuper) {
      return {
        testName: 'Connected role subject to RLS',
        passed: false,
        details:
          `CONNECTED ROLE BYPASSES RLS: "${role.rolname}" has rolbypassrls=${role.rolbypassrls} ` +
          `rolsuper=${role.rolsuper}. Isolation tests on this pool cannot detect leaks. ` +
          'Point DATABASE_URL / PLATFORM_DB_POOL_URL at qvo_app (NOBYPASSRLS) and set ' +
          'DATABASE_URL_PRIVILEGED to the postgres URL.',
      };
    }
    return {
      testName: 'Connected role subject to RLS',
      passed: true,
      details: `Connected as "${role.rolname}" with rolbypassrls=false rolsuper=false`,
    };
  } catch (err) {
    return {
      testName: 'Connected role subject to RLS',
      passed: false,
      details: `Error checking connected role: ${String(err)}`,
    };
  }
}

/**
 * Fail loudly when the restricted role can sidestep policies as a table
 * owner: owners bypass RLS unless the table has FORCE ROW LEVEL SECURITY
 * (migration 120). Also fails when FORCE is missing on any checked table,
 * so a reverted migration shows up even while qvo_app owns nothing.
 */
export async function verifyRestrictedRoleCannotBypassAsOwner(): Promise<IsolationTestResult[]> {
  const results: IsolationTestResult[] = [];
  const pool = getPlatformPool();
  try {
    const { rows } = await pool.query<{
      relname: string;
      relforcerowsecurity: boolean;
      owned_by_current_role: boolean;
    }>(
      `SELECT c.relname,
              c.relforcerowsecurity,
              pg_has_role(CURRENT_USER, c.relowner, 'USAGE') AS owned_by_current_role
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND c.relkind IN ('r', 'p')
          AND c.relname = ANY($1::text[])`,
      [RLS_TABLES],
    );
    for (const row of rows) {
      const ownerBypass = row.owned_by_current_role && !row.relforcerowsecurity;
      results.push({
        testName: `FORCE RLS on ${row.relname}`,
        passed: row.relforcerowsecurity && !ownerBypass,
        details: ownerBypass
          ? `CONNECTED ROLE OWNS ${row.relname} WITHOUT FORCE ROW LEVEL SECURITY — owner bypasses every policy`
          : row.relforcerowsecurity
            ? 'FORCE ROW LEVEL SECURITY is set'
            : 'FORCE ROW LEVEL SECURITY missing (re-run migration 120)',
      });
    }
  } catch (err) {
    results.push({
      testName: 'FORCE RLS check',
      passed: false,
      details: `Error checking table ownership / FORCE RLS: ${String(err)}`,
    });
  }
  return results;
}

export async function verifyRLSEnabled(): Promise<IsolationTestResult[]> {
  const results: IsolationTestResult[] = [];

  await withPrivilegedClient(async (client) => {
    for (const table of RLS_TABLES) {
      try {
        const { rows } = await client.query(
          `SELECT relrowsecurity FROM pg_class WHERE relname = $1`,
          [table],
        );
        const rlsEnabled = rows.length > 0 && rows[0].relrowsecurity === true;
        results.push({
          testName: `RLS enabled on ${table}`,
          passed: rlsEnabled,
          details: rlsEnabled ? 'Row Level Security is active' : 'RLS not enabled or table not found',
        });
      } catch (err) {
        results.push({
          testName: `RLS enabled on ${table}`,
          passed: false,
          details: `Error checking: ${String(err)}`,
        });
      }
    }
  });

  return results;
}

export async function verifyCrossTenantBlocked(tenantIdA: string, tenantIdB: string): Promise<IsolationTestResult[]> {
  const results: IsolationTestResult[] = [];
  const pool = getPlatformPool();

  for (const table of ['agents', 'call_sessions', 'audit_logs']) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantIdA]);

      const { rows } = await client.query(
        `SELECT COUNT(*) as cnt FROM ${table} WHERE tenant_id = $1`,
        [tenantIdB],
      );
      const count = parseInt(rows[0]?.cnt as string ?? '0');
      await client.query('COMMIT');

      results.push({
        testName: `Cross-tenant blocked on ${table} (${tenantIdA} -> ${tenantIdB})`,
        passed: count === 0,
        details: count === 0
          ? 'No cross-tenant data accessible'
          : `VIOLATION: ${count} rows from other tenant visible`,
      });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      const testName = `Cross-tenant blocked on ${table} (${tenantIdA} -> ${tenantIdB})`;
      if (isPermissionDenied(err)) {
        results.push({ testName, passed: false, details: probeCouldNotRead(table, 'the connected role', err) });
        continue;
      }
      const errStr = String(err);
      const isRlsBlock = errStr.includes('row_security') || errStr.includes('policy');
      results.push({
        testName,
        passed: isRlsBlock,
        details: isRlsBlock ? `Query blocked by RLS policy: ${errStr}` : `Unexpected error (failing safe): ${errStr}`,
      });
    } finally {
      client.release();
    }
  }

  return results;
}

async function countOtherTenantRows(client: PoolClient, table: string, tenantId: string): Promise<number> {
  const { rows } = await client.query(
    `SELECT COUNT(*) as cnt FROM ${table} WHERE tenant_id != $1`,
    [tenantId],
  );
  return parseInt(rows[0]?.cnt as string ?? '0');
}

/**
 * Cross-tenant COUNT(*) under `app.tenant_id = tenantId`. A connection that
 * bypasses RLS sees every row, so in that case the probe runs as
 * RLS_TESTER_ROLE inside a savepoint. If the switch (or the COUNT as the
 * tester) fails, it rolls back to the savepoint and counts as the connected
 * role, as before, and says so in `details`. A role that does not bypass RLS
 * (qvo_app) is tested as itself. A permission-denied COUNT (as either role)
 * fails the check: the probe could not read the table, so nothing was proven.
 */
async function verifyCrossTenantAccessBlocked(tenantId: string): Promise<IsolationTestResult[]> {
  const results: IsolationTestResult[] = [];
  const pool = getPlatformPool();

  for (const table of CROSS_TENANT_READ_TABLES) {
    const client = await pool.connect();
    let connectedRole = 'unknown';
    let evaluatedAs = connectedRole;
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);

      const { rows: roleRows } = await client.query<{ rolname: string; bypasses_rls: boolean }>(
        `SELECT rolname, (rolbypassrls OR rolsuper) AS bypasses_rls
           FROM pg_roles
          WHERE rolname = CURRENT_USER`,
      );
      connectedRole = roleRows[0]?.rolname ?? 'unknown';
      // Unresolvable role: try the switch anyway (it can only make the probe stricter).
      const connectedBypassesRls = roleRows[0]?.bypasses_rls ?? true;

      evaluatedAs = connectedRole;
      let fallbackReason: string | null = null;
      let testerDenied: string | null = null;
      if (connectedBypassesRls) {
        await client.query('SAVEPOINT rls_probe');
        try {
          await client.query(`SET LOCAL ROLE ${RLS_TESTER_ROLE}`);
          evaluatedAs = RLS_TESTER_ROLE;
        } catch (err) {
          await client.query('ROLLBACK TO SAVEPOINT rls_probe');
          fallbackReason = `SET ROLE ${RLS_TESTER_ROLE} failed: ${String(err)}`;
        }
      }

      let count: number;
      try {
        count = await countOtherTenantRows(client, table, tenantId);
      } catch (err) {
        if (evaluatedAs !== RLS_TESTER_ROLE) throw err;
        // RLS filters rows, it never raises, so an error here (e.g. no SELECT
        // grant for the tester) is not an RLS block. Count as the connected role.
        await client.query('ROLLBACK TO SAVEPOINT rls_probe');
        evaluatedAs = connectedRole;
        fallbackReason = `${RLS_TESTER_ROLE} could not read ${table}: ${String(err)}`;
        // A missing grant must fail the check even if the recount sees nothing.
        if (isPermissionDenied(err)) testerDenied = probeCouldNotRead(table, `"${RLS_TESTER_ROLE}"`, err);
        count = await countOtherTenantRows(client, table, tenantId);
      }
      await client.query('COMMIT');

      let details: string;
      if (fallbackReason) {
        const asConnected =
          `evaluated as connected role "${connectedRole}", which bypasses RLS, so this result cannot detect leaks; ` +
          fallbackReason;
        details = count === 0
          ? `No rows from other tenants visible (${asConnected})`
          : `VIOLATION: ${count} rows from other tenants visible (${asConnected})`;
      } else {
        details = count === 0
          ? `RLS correctly prevents cross-tenant reads (evaluated as ${evaluatedAs})`
          : `VIOLATION: ${count} rows from other tenants visible (evaluated as ${evaluatedAs})`;
      }
      if (testerDenied) details = `${testerDenied}. ${details}`;

      results.push({
        testName: `Cross-tenant read blocked on ${table}`,
        passed: count === 0 && !testerDenied,
        details,
      });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      const testName = `Cross-tenant read blocked on ${table}`;
      if (isPermissionDenied(err)) {
        results.push({ testName, passed: false, details: probeCouldNotRead(table, `"${evaluatedAs}"`, err) });
        continue;
      }
      const errStr = String(err);
      const isRlsBlock = errStr.includes('row_security') || errStr.includes('policy');
      results.push({
        testName,
        passed: isRlsBlock,
        details: isRlsBlock ? `Query blocked by RLS policy: ${errStr}` : `Unexpected error (failing safe): ${errStr}`,
      });
    } finally {
      client.release();
    }
  }

  return results;
}

export async function runAllIsolationTests(
  tenantId: string,
  options: RunAllIsolationTestsOptions = {},
): Promise<RunAllIsolationTestsResult> {
  const source: IsolationTestSource = options.source ?? 'manual';
  const runId = randomUUID();

  // The restricted-pool checks must hit the real app role even when the
  // daily run starts from a scheduler (privileged DB scope) or a request.
  const { roleResult, rlsResults, ownerResults, crossTenantResults } = await runWithRestrictedScope(async () => ({
    roleResult: await verifyConnectedRoleDoesNotBypassRls(),
    rlsResults: await verifyRLSEnabled(),
    ownerResults: await verifyRestrictedRoleCannotBypassAsOwner(),
    crossTenantResults: await verifyCrossTenantAccessBlocked(tenantId),
  }));

  const allResults = [roleResult, ...rlsResults, ...ownerResults, ...crossTenantResults];
  const passed = allResults.filter(r => r.passed).length;
  const failed = allResults.filter(r => r.passed === false).length;

  // tenant_isolation_tests has no tenant_id / RLS — restricted pool is fine.
  const pool = getPlatformPool();
  for (const result of allResults) {
    try {
      await pool.query(
        `INSERT INTO tenant_isolation_tests (test_name, test_result, details, source, run_id)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          result.testName,
          result.passed ? 'pass' : 'fail',
          JSON.stringify({ details: result.details, source, runId }),
          source,
          runId,
        ],
      );
    } catch (err) {
      logger.error('Failed to record isolation test', { error: String(err) });
    }
  }

  return { passed, failed, results: allResults, runId, source };
}

export function getTenantIdFromRequest(req: { user?: { tenantId: string } }): string | null {
  return req.user?.tenantId ?? null;
}
