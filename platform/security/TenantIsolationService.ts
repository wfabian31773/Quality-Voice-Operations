import { getPlatformPool, withPrivilegedClient } from '../db';
import { createLogger } from '../core/logger';

const logger = createLogger('TENANT_ISOLATION');

export interface IsolationTestResult {
  testName: string;
  passed: boolean;
  details: string;
}

const RLS_TABLES = [
  'agents', 'phone_numbers', 'call_sessions', 'integrations',
  'connector_configs', 'campaigns', 'campaign_contacts',
  'audit_logs', 'api_keys', 'user_roles', 'analytics_metrics',
  'encryption_keys', 'encrypted_fields', 'gdpr_requests',
];

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

export async function runAllIsolationTests(tenantId: string): Promise<{
  passed: number;
  failed: number;
  results: IsolationTestResult[];
}> {
  const rlsResults = await verifyRLSEnabled();

  const crossTenantResults = await verifyCrossTenantAccessBlocked(tenantId);

  const allResults = [...rlsResults, ...crossTenantResults];
  const passed = allResults.filter(r => r.passed).length;
  const failed = allResults.filter(r => !r.passed).length;

  const pool = getPlatformPool();
  for (const result of allResults) {
    try {
      await pool.query(
        `INSERT INTO tenant_isolation_tests (test_name, test_result, details)
         VALUES ($1, $2, $3)`,
        [result.testName, result.passed ? 'pass' : 'fail', JSON.stringify({ details: result.details })],
      );
    } catch (err) {
      logger.error('Failed to record isolation test', { error: String(err) });
    }
  }

  return { passed, failed, results: allResults };
}

export function getTenantIdFromRequest(req: { user?: { tenantId: string } }): string | null {
  return req.user?.tenantId ?? null;
}
