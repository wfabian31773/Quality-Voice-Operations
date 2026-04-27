import { randomUUID } from 'node:crypto';
import { getPlatformPool } from '../db';
import { createLogger } from '../core/logger';
import { sendEmail } from '../email';
import { fanoutInAppNotification } from '../notifications/NotificationPreferences';
import { writeAuditLog } from '../audit/AuditService';
import {
  type IsolationTestResult,
  type RunAllIsolationTestsResult,
  pickActiveTenantForIsolationTest,
  runAllIsolationTests,
  verifyRLSEnabled,
} from './TenantIsolationService';

const logger = createLogger('TENANT_ISOLATION_SCHEDULER');

const DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1000;
const INITIAL_DELAY_MS = 5 * 60 * 1000;

interface SchedulerState {
  intervalMs: number;
  lastRunStartedAt: Date | null;
  lastRunFinishedAt: Date | null;
  nextRunAt: Date | null;
  lastRunFailed: number;
  lastRunPassed: number;
  lastRunId: string | null;
}

const state: SchedulerState = {
  intervalMs: DEFAULT_INTERVAL_MS,
  lastRunStartedAt: null,
  lastRunFinishedAt: null,
  nextRunAt: null,
  lastRunFailed: 0,
  lastRunPassed: 0,
  lastRunId: null,
};

let timer: ReturnType<typeof setInterval> | null = null;
let initialTimer: ReturnType<typeof setTimeout> | null = null;

function appBaseUrl(): string {
  return (
    process.env.APP_URL ??
    (process.env.REPLIT_DEV_DOMAIN ? `https://${process.env.REPLIT_DEV_DOMAIN}` : '')
  );
}

async function getPlatformAdminEmails(): Promise<string[]> {
  const pool = getPlatformPool();
  try {
    const { rows } = await pool.query<{ email: string }>(
      `SELECT email FROM users
        WHERE is_platform_admin = TRUE
          AND COALESCE(is_active, TRUE) = TRUE
          AND email IS NOT NULL`,
    );
    return Array.from(
      new Set(rows.map((r) => r.email).filter((e) => typeof e === 'string' && e.includes('@'))),
    );
  } catch (err) {
    logger.warn('Failed to load platform admin emails for isolation alert', { error: String(err) });
    return [];
  }
}

interface PlatformAdminUser {
  id: string;
  tenant_id: string;
  email: string;
}

async function getPlatformAdminUsers(): Promise<PlatformAdminUser[]> {
  const pool = getPlatformPool();
  try {
    const { rows } = await pool.query<PlatformAdminUser>(
      `SELECT id, tenant_id, email FROM users
        WHERE is_platform_admin = TRUE
          AND COALESCE(is_active, TRUE) = TRUE
          AND tenant_id IS NOT NULL`,
    );
    return rows;
  } catch (err) {
    logger.warn('Failed to load platform admin users for in-app fan-out', { error: String(err) });
    return [];
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderFailureEmail(failures: IsolationTestResult[], passed: number, runId: string): {
  subject: string;
  html: string;
  text: string;
} {
  const subject =
    failures.length === 1
      ? `[QVO Security] Tenant isolation test FAILED — ${failures[0].testName}`
      : `[QVO Security] ${failures.length} tenant isolation tests FAILED`;

  const base = appBaseUrl();
  const link = base ? `${base}/admin/compliance` : '/admin/compliance';

  const rows = failures
    .map(
      (f) => `<tr>
        <td style="padding:6px 10px;border-bottom:1px solid #e5e7eb"><strong>${escapeHtml(f.testName)}</strong></td>
        <td style="padding:6px 10px;border-bottom:1px solid #e5e7eb;color:#b91c1c">${escapeHtml(f.details)}</td>
      </tr>`,
    )
    .join('');

  const html = `
    <div style="font-family:system-ui,sans-serif;color:#0f172a;max-width:720px">
      <h2 style="margin:0 0 8px;color:#b91c1c">Tenant isolation tests failed</h2>
      <p style="margin:0 0 12px;color:#475569">
        The scheduled RLS tenant isolation suite detected ${failures.length} failure${failures.length === 1 ? '' : 's'}
        (${passed} test${passed === 1 ? '' : 's'} still passed). Investigate immediately — a failure
        here means one tenant may be able to read another tenant's data.
      </p>
      <table style="border-collapse:collapse;font-size:13px;width:100%">
        <thead>
          <tr style="background:#f1f5f9;text-align:left">
            <th style="padding:8px 10px">Test</th>
            <th style="padding:8px 10px">Details</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
      <p style="margin:16px 0 0;color:#64748b;font-size:12px">
        Open the <a href="${link}">Platform Compliance → Tenant Isolation tab</a> for the full audit trail.
      </p>
      <p style="margin:8px 0 0;color:#94a3b8;font-size:11px">Run ID: <code>${escapeHtml(runId)}</code></p>
    </div>`;

  const text = [
    'Tenant isolation tests FAILED',
    `${failures.length} failure${failures.length === 1 ? '' : 's'}, ${passed} pass${passed === 1 ? '' : 'es'}.`,
    '',
    ...failures.map((f) => `- ${f.testName}: ${f.details}`),
    '',
    `Open: ${link}`,
    `Run ID: ${runId}`,
  ].join('\n');

  return { subject, html, text };
}

async function notifyPlatformAdmins(failures: IsolationTestResult[], passed: number, runId: string): Promise<{
  emailsAttempted: number;
  emailsDelivered: number;
  inAppDelivered: number;
}> {
  const result = { emailsAttempted: 0, emailsDelivered: 0, inAppDelivered: 0 };

  // Email — single message to all platform admins.
  const recipients = await getPlatformAdminEmails();
  if (recipients.length > 0) {
    const tpl = renderFailureEmail(failures, passed, runId);
    result.emailsAttempted = recipients.length;
    for (const to of recipients) {
      try {
        const sendResult = await sendEmail({ to, subject: tpl.subject, html: tpl.html, text: tpl.text });
        if (sendResult.success) {
          result.emailsDelivered += 1;
        } else {
          logger.warn('Tenant isolation failure email send failed', {
            to,
            error: sendResult.error,
          });
        }
      } catch (err) {
        logger.warn('Tenant isolation failure email threw', { to, error: String(err) });
      }
    }
  } else {
    logger.warn('No platform admin email recipients found for isolation failure alert');
  }

  // In-app — fan out per platform admin in their own tenant.
  const admins = await getPlatformAdminUsers();
  if (admins.length > 0) {
    const grouped = new Map<string, string[]>();
    for (const admin of admins) {
      const list = grouped.get(admin.tenant_id) ?? [];
      list.push(admin.id);
      grouped.set(admin.tenant_id, list);
    }
    const summary =
      failures.length === 1
        ? `Tenant isolation test failed: ${failures[0].testName}`
        : `${failures.length} tenant isolation tests failed.`;
    for (const [tenantId, userIds] of grouped) {
      try {
        const inserted = await fanoutInAppNotification({
          tenantId,
          type: 'integration',
          title: 'Tenant isolation tests FAILED',
          message: `${summary} Open Platform Compliance → Tenant Isolation for details.`,
          metadata: {
            link: '/admin/compliance',
            runId,
            failures: failures.length,
            passed,
            severity: 'critical',
            kind: 'tenant_isolation_failure',
          },
          category: 'integration',
          userIds,
        });
        result.inAppDelivered += inserted;
      } catch (err) {
        logger.warn('Failed to fan out tenant isolation failure notification', {
          tenantId,
          error: String(err),
        });
      }
    }
  }

  return result;
}

async function emitFailureAuditLog(params: {
  tenantId: string;
  failures: IsolationTestResult[];
  passed: number;
  runId: string;
}): Promise<void> {
  try {
    await writeAuditLog({
      tenantId: params.tenantId,
      actorUserId: 'system',
      actorRole: 'system',
      action: 'platform.isolation_tests.scheduled_failure',
      resourceType: 'tenant_isolation',
      resourceId: params.runId,
      severity: 'critical',
      changes: {
        runId: params.runId,
        failed: params.failures.length,
        passed: params.passed,
        source: 'scheduled',
        failures: params.failures.map((f) => ({ testName: f.testName, details: f.details })),
      },
    });
  } catch (err) {
    logger.error('Failed to write critical audit log for isolation failure', {
      runId: params.runId,
      error: String(err),
    });
  }
}

export interface IsolationSchedulerCycleResult {
  ranTests: boolean;
  passed: number;
  failed: number;
  runId: string | null;
  alertedAdmins: boolean;
  emailsDelivered: number;
  inAppDelivered: number;
  skippedReason?: string;
}

/** Run a single scheduled cycle. Exported for tests + manual triggering. */
export async function runTenantIsolationScheduledCycle(): Promise<IsolationSchedulerCycleResult> {
  state.lastRunStartedAt = new Date();
  let cycle: IsolationSchedulerCycleResult = {
    ranTests: false,
    passed: 0,
    failed: 0,
    runId: null,
    alertedAdmins: false,
    emailsDelivered: 0,
    inAppDelivered: 0,
  };

  try {
    const tenantId = await pickActiveTenantForIsolationTest();

    let runResult: RunAllIsolationTestsResult;
    if (tenantId === null) {
      // No active tenant — still run the RLS-enabled checks so we get a
      // signal even before the first customer onboards. Skip the cross-
      // tenant suite (it requires a tenant context).
      logger.info('No active tenant available; running RLS-enabled checks only');
      const rlsResults = await verifyRLSEnabled();
      const passed = rlsResults.filter((r) => r.passed).length;
      const failed = rlsResults.filter((r) => !r.passed).length;
      const runId = randomUUID();

      const pool = getPlatformPool();
      for (const result of rlsResults) {
        try {
          await pool.query(
            `INSERT INTO tenant_isolation_tests (test_name, test_result, details, source, run_id)
             VALUES ($1, $2, $3, 'scheduled', $4)`,
            [
              result.testName,
              result.passed ? 'pass' : 'fail',
              JSON.stringify({ details: result.details, source: 'scheduled', runId, note: 'rls_only' }),
              runId,
            ],
          );
        } catch (err) {
          logger.error('Failed to record scheduled RLS-only result', { error: String(err) });
        }
      }
      runResult = { passed, failed, results: rlsResults, runId, source: 'scheduled' };
    } else {
      runResult = await runAllIsolationTests(tenantId, { source: 'scheduled' });
    }

    cycle = {
      ranTests: true,
      passed: runResult.passed,
      failed: runResult.failed,
      runId: runResult.runId,
      alertedAdmins: false,
      emailsDelivered: 0,
      inAppDelivered: 0,
    };

    state.lastRunPassed = runResult.passed;
    state.lastRunFailed = runResult.failed;
    state.lastRunId = runResult.runId;

    if (runResult.failed > 0) {
      const failures = runResult.results.filter((r) => !r.passed);

      // Critical audit log goes against a real tenant — preferring the
      // tenant we tested as. If we ran RLS-only without a tenant, fall
      // back to picking ANY platform admin's tenant so the row at least
      // surfaces in the cross-tenant audit log.
      let auditTenantId: string | null = tenantId;
      if (!auditTenantId) {
        const admins = await getPlatformAdminUsers();
        auditTenantId = admins[0]?.tenant_id ?? null;
      }

      if (auditTenantId) {
        await emitFailureAuditLog({
          tenantId: auditTenantId,
          failures,
          passed: runResult.passed,
          runId: runResult.runId,
        });
      } else {
        logger.error('Tenant isolation failures detected but no tenant available for audit log', {
          runId: runResult.runId,
          failures: failures.length,
        });
      }

      const notify = await notifyPlatformAdmins(failures, runResult.passed, runResult.runId);
      cycle.alertedAdmins = notify.emailsDelivered > 0 || notify.inAppDelivered > 0;
      cycle.emailsDelivered = notify.emailsDelivered;
      cycle.inAppDelivered = notify.inAppDelivered;

      logger.error('Scheduled tenant isolation tests detected failures', {
        runId: runResult.runId,
        failed: runResult.failed,
        passed: runResult.passed,
        emailsDelivered: notify.emailsDelivered,
        inAppDelivered: notify.inAppDelivered,
      });
    } else {
      logger.info('Scheduled tenant isolation tests passed', {
        runId: runResult.runId,
        passed: runResult.passed,
      });
    }
  } catch (err) {
    logger.error('Scheduled tenant isolation cycle threw', { error: String(err) });
    cycle.skippedReason = err instanceof Error ? err.message : String(err);
  } finally {
    state.lastRunFinishedAt = new Date();
    state.nextRunAt = new Date(Date.now() + state.intervalMs);
  }

  return cycle;
}

export function startTenantIsolationScheduler(intervalMs: number = DEFAULT_INTERVAL_MS): void {
  if (timer) return;
  state.intervalMs = intervalMs;
  state.nextRunAt = new Date(Date.now() + INITIAL_DELAY_MS);

  initialTimer = setTimeout(() => {
    runTenantIsolationScheduledCycle().catch((err) => {
      logger.error('Initial tenant isolation scheduled cycle failed', { error: String(err) });
    });
  }, INITIAL_DELAY_MS);

  timer = setInterval(() => {
    runTenantIsolationScheduledCycle().catch((err) => {
      logger.error('Tenant isolation scheduled cycle failed', { error: String(err) });
    });
  }, intervalMs);

  logger.info('Tenant isolation scheduler started', { intervalMs });
}

export function stopTenantIsolationScheduler(): void {
  if (initialTimer) {
    clearTimeout(initialTimer);
    initialTimer = null;
  }
  if (timer) {
    clearInterval(timer);
    timer = null;
    logger.info('Tenant isolation scheduler stopped');
  }
  state.nextRunAt = null;
}

export interface TenantIsolationSchedulerStatus {
  intervalMs: number;
  isRunning: boolean;
  lastRunStartedAt: string | null;
  lastRunFinishedAt: string | null;
  nextRunAt: string | null;
  lastRunFailed: number;
  lastRunPassed: number;
  lastRunId: string | null;
}

export function getTenantIsolationSchedulerStatus(): TenantIsolationSchedulerStatus {
  return {
    intervalMs: state.intervalMs,
    isRunning: timer !== null,
    lastRunStartedAt: state.lastRunStartedAt ? state.lastRunStartedAt.toISOString() : null,
    lastRunFinishedAt: state.lastRunFinishedAt ? state.lastRunFinishedAt.toISOString() : null,
    nextRunAt: state.nextRunAt ? state.nextRunAt.toISOString() : null,
    lastRunFailed: state.lastRunFailed,
    lastRunPassed: state.lastRunPassed,
    lastRunId: state.lastRunId,
  };
}
