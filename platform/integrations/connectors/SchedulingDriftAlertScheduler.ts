import { getPlatformPool } from '../../db';
import { createLogger } from '../../core/logger';
import { sendEmail, connectorSchedulingDriftEmail } from '../../email';
import { filterEmailRecipientsByPreference } from '../../notifications/NotificationPreferences';
import { getTenantAlertEmailRecipients } from './ConnectorAlertRecipients';

const logger = createLogger('SCHEDULING_DRIFT_ALERT');

const CHECK_INTERVAL_MS = 30 * 60 * 1000;
const INITIAL_DELAY_MS = 7 * 60 * 1000;
const MAX_RECIPIENTS_PER_TENANT = 5;
const ALERT_THROTTLE_HOURS = 24;

/**
 * Display labels for scheduling provider keys persisted on
 * `agents.scheduling_provider` / `phone_numbers.scheduling_provider`. Mirrors
 * the labels used by the Connectors page (`SCHEDULING_PROVIDER_LABELS`) so the
 * email matches what the tenant sees in-app. Unknown providers fall through
 * to the raw key — better to show a recognizable identifier than a generic
 * "Scheduling integration" label that hides which calendar is misconfigured.
 */
const SCHEDULING_PROVIDER_LABELS: Record<string, string> = {
  'google-calendar': 'Google Calendar',
  'outlook-calendar': 'Outlook Calendar',
};

function schedulingProviderLabel(provider: string): string {
  return SCHEDULING_PROVIDER_LABELS[provider] ?? provider;
}

function appBaseUrl(): string {
  return (
    process.env.APP_URL ??
    `https://${process.env.REPLIT_DEV_DOMAIN ?? 'localhost:5173'}`
  );
}

export interface DriftedTarget {
  refType: 'agent' | 'phone_number';
  refId: string;
  name: string;
  provider: string;
}

export interface TenantDrift {
  tenantId: string;
  tenantName: string | null;
  drifted: DriftedTarget[];
}

/**
 * Find tenants that have at least one agent or phone number whose
 * `scheduling_provider` doesn't match any enabled scheduling integration on
 * the tenant. Tenants with `scheduling_drift_alert_sent_at` inside the last
 * 24h are excluded so admins don't get spammed.
 *
 * The query intentionally returns one row per drifted target (rather than
 * one per tenant) so the alert email can list each affected agent / phone
 * number by name. We bucket per-tenant in JS below.
 */
export async function findPendingSchedulingDrift(): Promise<TenantDrift[]> {
  const pool = getPlatformPool();
  const { rows } = await pool.query<{
    tenant_id: string;
    tenant_name: string | null;
    ref_type: 'agent' | 'phone_number';
    ref_id: string;
    ref_name: string | null;
    provider: string;
  }>(
    `WITH agent_targets AS (
       SELECT a.tenant_id,
              'agent'::text AS ref_type,
              a.id::text AS ref_id,
              a.name AS ref_name,
              a.scheduling_provider AS provider
         FROM agents a
        WHERE a.scheduling_provider IS NOT NULL
          AND a.scheduling_provider <> ''
     ),
     phone_targets AS (
       SELECT pn.tenant_id,
              'phone_number'::text AS ref_type,
              pn.id::text AS ref_id,
              COALESCE(NULLIF(pn.friendly_name, ''), pn.phone_number) AS ref_name,
              pn.scheduling_provider AS provider
         FROM phone_numbers pn
        WHERE pn.scheduling_provider IS NOT NULL
          AND pn.scheduling_provider <> ''
     ),
     all_targets AS (
       SELECT * FROM agent_targets
       UNION ALL
       SELECT * FROM phone_targets
     ),
     drifted AS (
       SELECT t.*
         FROM all_targets t
        WHERE NOT EXISTS (
                SELECT 1
                  FROM integrations i
                 WHERE i.tenant_id = t.tenant_id
                   AND i.integration_type = 'scheduling'
                   AND i.is_enabled = TRUE
                   AND i.provider = t.provider
              )
     )
     SELECT d.tenant_id,
            tn.name AS tenant_name,
            d.ref_type,
            d.ref_id,
            d.ref_name,
            d.provider
       FROM drifted d
       JOIN tenants tn ON tn.id = d.tenant_id
      WHERE tn.scheduling_drift_alert_sent_at IS NULL
         OR tn.scheduling_drift_alert_sent_at < NOW() - INTERVAL '${ALERT_THROTTLE_HOURS} hours'
      ORDER BY d.tenant_id, d.ref_type, d.ref_name NULLS LAST, d.ref_id`,
  );

  const byTenant = new Map<string, TenantDrift>();
  for (const r of rows) {
    let bucket = byTenant.get(r.tenant_id);
    if (!bucket) {
      bucket = {
        tenantId: r.tenant_id,
        tenantName: r.tenant_name,
        drifted: [],
      };
      byTenant.set(r.tenant_id, bucket);
    }
    bucket.drifted.push({
      refType: r.ref_type,
      refId: r.ref_id,
      name: r.ref_name ?? '(unnamed)',
      provider: r.provider,
    });
  }
  return Array.from(byTenant.values());
}

/**
 * Atomic 24h slot claim on the tenant row. Returns true if this caller won
 * the race to send the next drift email for this tenant. The conditional
 * UPDATE guarantees that two scheduler instances racing on the same tenant
 * cannot both fan out an email.
 */
async function claimSchedulingDriftSlot(tenantId: string): Promise<boolean> {
  const pool = getPlatformPool();
  try {
    const result = await pool.query(
      `UPDATE tenants
          SET scheduling_drift_alert_sent_at = NOW(), updated_at = NOW()
        WHERE id = $1
          AND (
            scheduling_drift_alert_sent_at IS NULL
            OR scheduling_drift_alert_sent_at < NOW() - INTERVAL '${ALERT_THROTTLE_HOURS} hours'
          )`,
      [tenantId],
    );
    return (result as { rowCount?: number }).rowCount === 1;
  } catch (err) {
    logger.warn('Failed to claim scheduling drift alert slot', {
      tenantId,
      error: String(err),
    });
    return false;
  }
}

/**
 * Reset the throttle stamp so the *next* cycle re-considers this tenant.
 * Used when the slot was claimed but no email was actually delivered (no
 * recipients, every send failed) — without this, a transient SMTP outage
 * would silence the alert for 24h.
 */
async function releaseSchedulingDriftSlot(tenantId: string): Promise<void> {
  const pool = getPlatformPool();
  try {
    await pool.query(
      `UPDATE tenants
          SET scheduling_drift_alert_sent_at = NULL, updated_at = NOW()
        WHERE id = $1`,
      [tenantId],
    );
  } catch (err) {
    logger.warn('Failed to release scheduling drift alert slot', {
      tenantId,
      error: String(err),
    });
  }
}

export interface SchedulingDriftCycleResult {
  inspected: number;
  alerted: number;
  emailedRecipients: number;
  skippedNoRecipients: number;
  throttled: number;
}

export async function runSchedulingDriftAlertCycle(): Promise<SchedulingDriftCycleResult> {
  let pending: TenantDrift[];
  try {
    pending = await findPendingSchedulingDrift();
  } catch (err) {
    logger.error('Failed to query pending scheduling drift', { error: String(err) });
    return {
      inspected: 0,
      alerted: 0,
      emailedRecipients: 0,
      skippedNoRecipients: 0,
      throttled: 0,
    };
  }

  if (pending.length === 0) {
    logger.debug('No pending scheduling drift to alert on');
    return {
      inspected: 0,
      alerted: 0,
      emailedRecipients: 0,
      skippedNoRecipients: 0,
      throttled: 0,
    };
  }

  let alerted = 0;
  let emailedRecipients = 0;
  let skippedNoRecipients = 0;
  let throttled = 0;

  const connectorsUrl = `${appBaseUrl().replace(/\/$/, '')}/connectors`;

  for (const tenant of pending) {
    const claimed = await claimSchedulingDriftSlot(tenant.tenantId);
    if (!claimed) {
      // Lost the race to a parallel scheduler instance, or another cycle
      // tick stamped the slot first. Either way, the email is the other
      // caller's responsibility.
      throttled += 1;
      continue;
    }

    const { emails: rawRecipients } = await getTenantAlertEmailRecipients(
      tenant.tenantId,
      MAX_RECIPIENTS_PER_TENANT,
    );

    if (rawRecipients.length === 0) {
      // Nobody to email — release the slot so the next cycle can retry once
      // the tenant adds an admin user (rather than waiting 24h).
      await releaseSchedulingDriftSlot(tenant.tenantId);
      skippedNoRecipients += 1;
      logger.info('Scheduling drift alert skipped: no admin recipients', {
        tenantId: tenant.tenantId,
        driftedCount: tenant.drifted.length,
      });
      continue;
    }

    // Drift alerts ride the existing 'integration' notification category so
    // admins who already opted out of integration emails (e.g. via Settings
    // → Notifications) don't get nagged through a new channel.
    const recipients = await filterEmailRecipientsByPreference(
      tenant.tenantId,
      rawRecipients,
      'integration',
    );

    if (recipients.length === 0) {
      await releaseSchedulingDriftSlot(tenant.tenantId);
      skippedNoRecipients += 1;
      logger.info(
        'Scheduling drift alert skipped: all admin recipients opted out of integration emails',
        { tenantId: tenant.tenantId, removed: rawRecipients.length },
      );
      continue;
    }

    const detectedAt = new Date().toUTCString();
    const { subject, html, text } = connectorSchedulingDriftEmail({
      tenantName: tenant.tenantName ?? undefined,
      connectorsUrl,
      detectedAt,
      drifted: tenant.drifted.map((d) => ({
        refType: d.refType,
        name: d.name,
        providerLabel: schedulingProviderLabel(d.provider),
      })),
    });

    let delivered = 0;
    for (const to of recipients) {
      try {
        const result = await sendEmail({ to, subject, html, text });
        if (result.success) {
          delivered += 1;
        } else {
          logger.warn('Scheduling drift email send failed', {
            tenantId: tenant.tenantId,
            to,
            error: result.error,
          });
        }
      } catch (err) {
        logger.warn('Scheduling drift email threw', {
          tenantId: tenant.tenantId,
          to,
          error: String(err),
        });
      }
    }

    if (delivered === 0) {
      // Slot claimed but nothing actually delivered — release so the next
      // cycle can retry instead of staying silent for 24h.
      await releaseSchedulingDriftSlot(tenant.tenantId);
      skippedNoRecipients += 1;
      logger.error(
        'Scheduling drift alert claim succeeded but zero emails delivered',
        {
          tenantId: tenant.tenantId,
          attemptedRecipients: recipients.length,
        },
      );
      continue;
    }

    alerted += 1;
    emailedRecipients += delivered;
    logger.info('Scheduling drift alert dispatched', {
      tenantId: tenant.tenantId,
      driftedCount: tenant.drifted.length,
      recipients: recipients.length,
      delivered,
    });
  }

  return {
    inspected: pending.length,
    alerted,
    emailedRecipients,
    skippedNoRecipients,
    throttled,
  };
}

let timer: ReturnType<typeof setInterval> | null = null;
let initialTimer: ReturnType<typeof setTimeout> | null = null;

export function startSchedulingDriftAlertScheduler(
  intervalMs: number = CHECK_INTERVAL_MS,
): void {
  if (timer) return;

  initialTimer = setTimeout(() => {
    runSchedulingDriftAlertCycle().catch((err) => {
      logger.error('Initial scheduling drift alert cycle failed', { error: String(err) });
    });
  }, INITIAL_DELAY_MS);

  timer = setInterval(() => {
    runSchedulingDriftAlertCycle().catch((err) => {
      logger.error('Scheduling drift alert cycle failed', { error: String(err) });
    });
  }, intervalMs);

  logger.info('Scheduling drift alert scheduler started', { intervalMs });
}

export function stopSchedulingDriftAlertScheduler(): void {
  if (initialTimer) {
    clearTimeout(initialTimer);
    initialTimer = null;
  }
  if (timer) {
    clearInterval(timer);
    timer = null;
    logger.info('Scheduling drift alert scheduler stopped');
  }
}
