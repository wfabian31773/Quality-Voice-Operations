/**
 * Background scheduler that re-nudges tenant owners who still have not
 * initialized their per-tenant data encryption key (DEK). Mirrors the
 * one-off "Send reminder" button on Platform Compliance → Encryption
 * (`server/admin-api/routes/platformCompliance.ts`) so an admin who
 * forgets to follow up doesn't leave a tenant unencrypted forever.
 *
 * Cadence: a single tick runs daily, but each tenant only re-fires once
 * the configured cooldown (default 14 days) has elapsed since the most
 * recent `platform.encryption.reminder_sent` audit row — whether that
 * row was written by a human via the manual button or by an earlier
 * scheduler tick. That keeps the audit log as the single source of
 * truth for "when did this tenant last hear from us?" so the existing
 * "Last reminder" column on the same tab reflects automated sends with
 * no extra wiring.
 *
 * Per-tenant opt-out: `tenants.encryption_reminder_paused` (added in
 * migration 098) lets an admin park a tenant indefinitely from the
 * console. The manual "Send reminder" button is intentionally NOT
 * gated by the pause flag — pausing only suppresses the automated
 * cadence, since humans pausing the bot still need an escape hatch
 * to nudge the tenant on demand.
 *
 * Cadence + cooldown are env-tunable so support can shorten the loop
 * during incident response without redeploying:
 *   ENCRYPTION_REMINDER_INTERVAL_MS  (default 24h, the daily tick)
 *   ENCRYPTION_REMINDER_COOLDOWN_DAYS (default 14, per-tenant gap)
 *   ENCRYPTION_REMINDER_MAX_PER_CYCLE (default 50, soft batch cap)
 *
 * Failure handling: each tenant is processed independently. A failed
 * email send does NOT write the audit row, so the next tick will
 * retry that tenant on the same cooldown clock. A failed audit log
 * write DOES log loudly but does not abort the cycle for the
 * remaining tenants.
 */
import { getPlatformPool } from '../db';
import { createLogger } from '../core/logger';
import { sendEmail } from '../email/EmailService';
import { encryptionInitializationReminderEmail } from '../email/templates';
import { writeAuditLog } from '../audit/AuditService';

const logger = createLogger('ENCRYPTION_REMINDER_SCHEDULER');

export const ENCRYPTION_REMINDER_ACTION = 'platform.encryption.reminder_sent';

const DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1000;
const INITIAL_DELAY_MS = 5 * 60 * 1000;
const DEFAULT_COOLDOWN_DAYS = 14;
const DEFAULT_MAX_PER_CYCLE = 50;
const MIN_COOLDOWN_DAYS = 1;
const MAX_COOLDOWN_DAYS = 365;

function appBaseUrl(): string {
  return (
    process.env.APP_URL ??
    (process.env.REPLIT_DEV_DOMAIN ? `https://${process.env.REPLIT_DEV_DOMAIN}` : '')
  );
}

function parseIntEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    logger.warn('Ignoring invalid env override; falling back to default', {
      name,
      raw,
      fallback,
      min,
      max,
    });
    return fallback;
  }
  return parsed;
}

export function getCooldownDays(): number {
  return parseIntEnv(
    'ENCRYPTION_REMINDER_COOLDOWN_DAYS',
    DEFAULT_COOLDOWN_DAYS,
    MIN_COOLDOWN_DAYS,
    MAX_COOLDOWN_DAYS,
  );
}

export function getMaxPerCycle(): number {
  return parseIntEnv('ENCRYPTION_REMINDER_MAX_PER_CYCLE', DEFAULT_MAX_PER_CYCLE, 1, 1_000);
}

export interface DueReminderTenant {
  tenant_id: string;
  tenant_name: string;
  owner_user_id: string;
  owner_email: string;
  owner_first_name: string | null;
  owner_last_name: string | null;
  last_reminded_at: Date | null;
}

/**
 * Find tenants that are due for an automated encryption reminder. The
 * query is the canonical "needs nudging" predicate so tests can exercise
 * the same shape the production scheduler runs with.
 */
export async function findTenantsDueForReminder(
  cooldownDays: number = getCooldownDays(),
  limit: number = getMaxPerCycle(),
): Promise<DueReminderTenant[]> {
  const pool = getPlatformPool();
  const { rows } = await pool.query<{
    tenant_id: string;
    tenant_name: string;
    owner_user_id: string;
    owner_email: string;
    owner_first_name: string | null;
    owner_last_name: string | null;
    last_reminded_at: Date | null;
  }>(
    `SELECT
       t.id AS tenant_id,
       t.name AS tenant_name,
       o.owner_user_id,
       o.owner_email,
       o.owner_first_name,
       o.owner_last_name,
       r.last_reminded_at
     FROM tenants t
     LEFT JOIN (
       SELECT tenant_id, COUNT(*) FILTER (WHERE is_active = TRUE) AS active_keys
       FROM encryption_keys
       GROUP BY tenant_id
     ) k ON k.tenant_id = t.id
     LEFT JOIN LATERAL (
       SELECT ur.user_id AS owner_user_id,
              u.email AS owner_email,
              u.first_name AS owner_first_name,
              u.last_name AS owner_last_name
       FROM user_roles ur
       JOIN users u ON u.id = ur.user_id
       WHERE ur.tenant_id = t.id
         AND ur.role = 'tenant_owner'
         AND COALESCE(u.is_active, TRUE) = TRUE
         AND u.email IS NOT NULL
       ORDER BY ur.created_at ASC
       LIMIT 1
     ) o ON TRUE
     LEFT JOIN LATERAL (
       SELECT MAX(a.occurred_at) AS last_reminded_at
       FROM audit_logs a
       WHERE a.tenant_id = t.id AND a.action = $1
     ) r ON TRUE
     WHERE COALESCE(t.encryption_reminder_paused, FALSE) = FALSE
       AND COALESCE(k.active_keys, 0) = 0
       AND o.owner_user_id IS NOT NULL
       AND (
         r.last_reminded_at IS NULL
         OR r.last_reminded_at <= NOW() - ($2 || ' days')::interval
       )
     ORDER BY r.last_reminded_at NULLS FIRST, t.created_at ASC
     LIMIT $3`,
    [ENCRYPTION_REMINDER_ACTION, String(cooldownDays), limit],
  );

  return rows.map((row) => ({
    ...row,
    last_reminded_at: row.last_reminded_at ?? null,
  }));
}

export interface ReminderCycleResult {
  scanned: number;
  sent: number;
  failed: number;
  skippedNoBaseUrl: number;
  cooldownDays: number;
}

/** Run a single scheduler cycle. Exported for tests + manual triggering. */
export async function runEncryptionReminderCycle(): Promise<ReminderCycleResult> {
  const cooldownDays = getCooldownDays();
  const maxPerCycle = getMaxPerCycle();

  const baseUrl = appBaseUrl();
  if (!baseUrl) {
    // Without an absolute URL the email body would render an unclickable
    // relative path. Bail loudly instead of sending a broken nudge — the
    // manual reminder endpoint applies the same guard.
    logger.error(
      'Skipping encryption reminder cycle: APP_URL / REPLIT_DEV_DOMAIN is not configured',
    );
    return { scanned: 0, sent: 0, failed: 0, skippedNoBaseUrl: 1, cooldownDays };
  }

  let due: DueReminderTenant[];
  try {
    due = await findTenantsDueForReminder(cooldownDays, maxPerCycle);
  } catch (err) {
    logger.error('Failed to query tenants due for encryption reminder', {
      error: err instanceof Error ? err.message : String(err),
    });
    return { scanned: 0, sent: 0, failed: 0, skippedNoBaseUrl: 0, cooldownDays };
  }

  if (due.length === 0) {
    logger.debug('No tenants due for an automated encryption reminder', { cooldownDays });
    return { scanned: 0, sent: 0, failed: 0, skippedNoBaseUrl: 0, cooldownDays };
  }

  const initializeUrl = `${baseUrl.replace(/\/$/, '')}/compliance`;
  const senderName = 'The Quality Voice Operations team';

  let sent = 0;
  let failed = 0;

  for (const tenant of due) {
    const ownerDisplay =
      [tenant.owner_first_name, tenant.owner_last_name].filter(Boolean).join(' ').trim() || null;

    const message = encryptionInitializationReminderEmail({
      tenantName: tenant.tenant_name,
      ownerName: ownerDisplay,
      initializeUrl,
      senderName,
    });

    let result;
    try {
      result = await sendEmail({
        to: tenant.owner_email,
        subject: message.subject,
        html: message.html,
        text: message.text,
      });
    } catch (err) {
      failed += 1;
      logger.error('Encryption reminder email threw', {
        tenantId: tenant.tenant_id,
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }

    if (!result.success) {
      failed += 1;
      logger.warn('Encryption reminder email failed to deliver', {
        tenantId: tenant.tenant_id,
        ownerEmail: tenant.owner_email,
        error: result.error,
        permanent: result.permanent ?? false,
      });
      // Intentionally skip the audit-log write so the tenant stays
      // eligible on the next tick; the cooldown clock only starts on a
      // successful delivery.
      continue;
    }

    try {
      await writeAuditLog({
        tenantId: tenant.tenant_id,
        // null actor = system-initiated. The "Last reminder" join in
        // platformCompliance.ts already LEFT JOINs through users so a
        // null actor renders as no "by" line, distinguishing automated
        // sends from the manual button without a schema change.
        actorUserId: null,
        actorRole: 'system',
        action: ENCRYPTION_REMINDER_ACTION,
        resourceType: 'tenant',
        resourceId: tenant.tenant_id,
        severity: 'info',
        changes: {
          ownerEmail: tenant.owner_email,
          ownerUserId: tenant.owner_user_id,
          tenantName: tenant.tenant_name,
          messageId: result.messageId ?? null,
          sentBy: 'EncryptionReminderScheduler',
          source: 'scheduled',
          cooldownDays,
          previousReminderAt: tenant.last_reminded_at
            ? tenant.last_reminded_at.toISOString()
            : null,
        },
      });
      sent += 1;
    } catch (err) {
      // Audit-log failure is logged loudly but does not roll back the
      // already-delivered email. The next tick will see the missing
      // audit row and re-send — that's the lesser evil compared with
      // dropping the cycle for every tenant after this one.
      logger.error('Failed to write encryption reminder audit log after successful send', {
        tenantId: tenant.tenant_id,
        ownerEmail: tenant.owner_email,
        error: err instanceof Error ? err.message : String(err),
      });
      sent += 1;
    }
  }

  logger.info('Encryption reminder cycle complete', {
    scanned: due.length,
    sent,
    failed,
    cooldownDays,
  });

  return {
    scanned: due.length,
    sent,
    failed,
    skippedNoBaseUrl: 0,
    cooldownDays,
  };
}

let timer: ReturnType<typeof setInterval> | null = null;
let initialTimer: ReturnType<typeof setTimeout> | null = null;

export function startEncryptionReminderScheduler(
  intervalMs: number = parseIntEnv(
    'ENCRYPTION_REMINDER_INTERVAL_MS',
    DEFAULT_INTERVAL_MS,
    60_000,
    7 * 24 * 60 * 60 * 1000,
  ),
): void {
  if (timer) return;

  initialTimer = setTimeout(() => {
    runEncryptionReminderCycle().catch((err) => {
      logger.error('Initial encryption reminder cycle failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }, INITIAL_DELAY_MS);

  timer = setInterval(() => {
    runEncryptionReminderCycle().catch((err) => {
      logger.error('Encryption reminder cycle failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }, intervalMs);

  logger.info('Encryption reminder scheduler started', {
    intervalMs,
    cooldownDays: getCooldownDays(),
    maxPerCycle: getMaxPerCycle(),
  });
}

export function stopEncryptionReminderScheduler(): void {
  if (initialTimer) {
    clearTimeout(initialTimer);
    initialTimer = null;
  }
  if (timer) {
    clearInterval(timer);
    timer = null;
    logger.info('Encryption reminder scheduler stopped');
  }
}
