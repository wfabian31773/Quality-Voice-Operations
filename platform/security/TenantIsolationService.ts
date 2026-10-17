import { randomUUID } from 'node:crypto';
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

const RLS_TABLES = [
  'agents', 'phone_numbers', 'call_sessions', 'integrations',
  'connector_configs', 'campaigns', 'campaign_contacts',
  'audit_logs', 'api_keys', 'user_roles', 'analytics_metrics',
  'encryption_keys', 'encrypted_fields', 'gdpr_requests',
];

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
      const errStr = String(err);
      const isRlsBlock = errStr.includes('row_security') || errStr.includes('policy') || errStr.includes('permission denied');
      results.push({
        testName: `Cross-tenant blocked on ${table} (${tenantIdA} -> ${tenantIdB})`,
        passed: isRlsBlock,
        details: isRlsBlock ? `Query blocked by RLS policy: ${errStr}` : `Unexpected error (failing safe): ${errStr}`,
      });
    } finally {
      client.release();
    }
  }

  return results;
}

async function verifyCrossTenantAccessBlocked(tenantId: string): Promise<IsolationTestResult[]> {
  const results: IsolationTestResult[] = [];
  const pool = getPlatformPool();
  const testTables = ['agents', 'audit_logs', 'api_keys'];

  for (const table of testTables) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);

      const { rows } = await client.query(
        `SELECT COUNT(*) as cnt FROM ${table} WHERE tenant_id != $1`,
        [tenantId],
      );
      const count = parseInt(rows[0]?.cnt as string ?? '0');
      await client.query('COMMIT');

      results.push({
        testName: `Cross-tenant read blocked on ${table}`,
        passed: count === 0,
        details: count === 0
          ? 'RLS correctly prevents cross-tenant reads'
          : `VIOLATION: ${count} rows from other tenants visible`,
      });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      const errStr = String(err);
      const isRlsBlock = errStr.includes('row_security') || errStr.includes('policy') || errStr.includes('permission denied');
      results.push({
        testName: `Cross-tenant read blocked on ${table}`,
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
