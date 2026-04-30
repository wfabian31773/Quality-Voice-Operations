/**
 * Daily scheduler that emails the tenant owner once per closed billing
 * cycle when a cheaper plan would have saved them money. Math is
 * delegated to `recommendCheapestPlan` so the email matches the in-app
 * /billing recommendation card.
 */
import { withPrivilegedClient, withTenantContext, getPlatformPool } from '../db';
import { createLogger } from '../core/logger';
import { sendEmail } from '../email/EmailService';
import { planRecommendationEmail } from '../email/templates';
import { writeAuditLog } from '../audit/AuditService';
import { isChannelEnabled } from '../notifications/NotificationPreferences';
import { getTenantEffectiveRate } from './stripe/effectiveRate';
import {
  recommendCheapestPlan,
  type PlanRateOverride,
} from '../../shared/billing/planRecommendation';

const logger = createLogger('PLAN_RECOMMENDATION_DIGEST');

export const PLAN_RECOMMENDATION_AUDIT_ACTION =
  'billing.plan_recommendation_email_sent';

const DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1000;
const INITIAL_DELAY_MS = 9 * 60 * 1000;
const DEFAULT_COOLDOWN_DAYS = 28;
const DEFAULT_MAX_PER_CYCLE = 100;
const DEFAULT_LOOKBACK_MONTHS = 3;
const MIN_COOLDOWN_DAYS = 7;
const MAX_COOLDOWN_DAYS = 365;
const MIN_LOOKBACK_MONTHS = 1;
const MAX_LOOKBACK_MONTHS = 12;

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
    'PLAN_RECOMMENDATION_DIGEST_COOLDOWN_DAYS',
    DEFAULT_COOLDOWN_DAYS,
    MIN_COOLDOWN_DAYS,
    MAX_COOLDOWN_DAYS,
  );
}

export function getMaxPerCycle(): number {
  return parseIntEnv(
    'PLAN_RECOMMENDATION_DIGEST_MAX_PER_CYCLE',
    DEFAULT_MAX_PER_CYCLE,
    1,
    1_000,
  );
}

export function getLookbackMonths(): number {
  return parseIntEnv(
    'PLAN_RECOMMENDATION_DIGEST_LOOKBACK_MONTHS',
    DEFAULT_LOOKBACK_MONTHS,
    MIN_LOOKBACK_MONTHS,
    MAX_LOOKBACK_MONTHS,
  );
}

export interface DueRecommendationTenant {
  tenant_id: string;
  tenant_name: string;
  owner_user_id: string;
  owner_email: string;
  owner_first_name: string | null;
  owner_last_name: string | null;
  current_period_start: Date;
  last_emailed_at: Date | null;
}

export async function findTenantsDueForRecommendation(
  cooldownDays: number = getCooldownDays(),
  limit: number = getMaxPerCycle(),
): Promise<DueRecommendationTenant[]> {
  // Cross-tenant scan: privileged (RLS-bypassing) read.
  return withPrivilegedClient(async (client) => {
    // Cast both sides of the periodStart dedup to timestamptz; comparing
    // the JSON-stored ISO-8601 string against `TIMESTAMP::text` would
    // never match (different formats) and break idempotency.
    const { rows } = await client.query(
      `SELECT
         t.id AS tenant_id,
         t.name AS tenant_name,
         o.owner_user_id,
         o.owner_email,
         o.owner_first_name,
         o.owner_last_name,
         s.current_period_start,
         r.last_emailed_at
       FROM tenants t
       JOIN subscriptions s ON s.tenant_id = t.id
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
         SELECT MAX(a.occurred_at) AS last_emailed_at,
                MAX((a.changes->>'periodStart')::timestamptz)
                  AS last_emailed_period_start
         FROM audit_logs a
         WHERE a.tenant_id = t.id
           AND a.action = $1
       ) r ON TRUE
       WHERE s.status IN ('active', 'past_due')
         AND s.current_period_start IS NOT NULL
         AND s.current_period_start > s.created_at + INTERVAL '1 day'
         AND o.owner_user_id IS NOT NULL
         AND (
           r.last_emailed_period_start IS NULL
           OR r.last_emailed_period_start
              <> (s.current_period_start AT TIME ZONE 'UTC')
         )
         AND (
           r.last_emailed_at IS NULL
           OR r.last_emailed_at <= NOW() - ($2 || ' days')::interval
         )
       ORDER BY r.last_emailed_at NULLS FIRST, t.created_at ASC
       LIMIT $3`,
      [PLAN_RECOMMENDATION_AUDIT_ACTION, String(cooldownDays), limit],
    );

    return rows.map((row) => ({
      tenant_id: row.tenant_id as string,
      tenant_name: row.tenant_name as string,
      owner_user_id: row.owner_user_id as string,
      owner_email: row.owner_email as string,
      owner_first_name: (row.owner_first_name as string | null) ?? null,
      owner_last_name: (row.owner_last_name as string | null) ?? null,
      current_period_start: row.current_period_start as Date,
      last_emailed_at: (row.last_emailed_at as Date | null) ?? null,
    }));
  });
}

/** Trailing average AI minutes, zero-filling missing months. RLS-scoped. */
export async function computeTrailingAverageMinutes(
  tenantId: string,
  months: number = getLookbackMonths(),
): Promise<{ averageMinutes: number; monthsConsidered: number }> {
  const pool = getPlatformPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    let rows: Array<{ minutes: string }> = [];
    await withTenantContext(client, tenantId, async () => {
      const result = await client.query(
        `WITH window_months AS (
           SELECT generate_series(
             date_trunc('month', NOW()) - ($2::int * INTERVAL '1 month'),
             date_trunc('month', NOW()) - INTERVAL '1 month',
             INTERVAL '1 month'
           ) AS month_start
         ),
         monthly_totals AS (
           SELECT
             date_trunc('month', period_start) AS month_start,
             SUM(quantity)::bigint AS minutes
           FROM usage_metrics
           WHERE tenant_id = $1
             AND metric_type = 'ai_minutes'
             AND period_start >= date_trunc('month', NOW()) - ($2::int * INTERVAL '1 month')
             AND period_start < date_trunc('month', NOW())
           GROUP BY date_trunc('month', period_start)
         )
         SELECT COALESCE(t.minutes, 0)::bigint AS minutes
         FROM window_months w
         LEFT JOIN monthly_totals t ON t.month_start = w.month_start
         ORDER BY w.month_start DESC`,
        [tenantId, months],
      );
      rows = result.rows as Array<{ minutes: string }>;
    });
    await client.query('COMMIT');

    if (rows.length === 0) {
      return { averageMinutes: 0, monthsConsidered: 0 };
    }
    const total = rows.reduce((acc, r) => acc + Number(r.minutes), 0);
    return {
      averageMinutes: total / rows.length,
      monthsConsidered: rows.length,
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export interface RecommendationCycleResult {
  scanned: number;
  emailed: number;
  skippedAlreadyOptimal: number;
  skippedNoUsage: number;
  skippedOptedOut: number;
  failed: number;
  skippedNoBaseUrl: number;
  cooldownDays: number;
  lookbackMonths: number;
}

function emptyResult(
  cooldownDays: number,
  lookbackMonths: number,
): RecommendationCycleResult {
  return {
    scanned: 0,
    emailed: 0,
    skippedAlreadyOptimal: 0,
    skippedNoUsage: 0,
    skippedOptedOut: 0,
    failed: 0,
    skippedNoBaseUrl: 0,
    cooldownDays,
    lookbackMonths,
  };
}

export async function runPlanRecommendationDigestCycle(): Promise<RecommendationCycleResult> {
  const cooldownDays = getCooldownDays();
  const lookbackMonths = getLookbackMonths();
  const maxPerCycle = getMaxPerCycle();

  const baseUrl = appBaseUrl();
  if (!baseUrl) {
    logger.error(
      'Skipping plan recommendation digest cycle: APP_URL / REPLIT_DEV_DOMAIN is not configured',
    );
    return { ...emptyResult(cooldownDays, lookbackMonths), skippedNoBaseUrl: 1 };
  }

  let due: DueRecommendationTenant[];
  try {
    due = await findTenantsDueForRecommendation(cooldownDays, maxPerCycle);
  } catch (err) {
    logger.error('Failed to query tenants due for plan recommendation digest', {
      error: err instanceof Error ? err.message : String(err),
    });
    return emptyResult(cooldownDays, lookbackMonths);
  }

  if (due.length === 0) {
    return emptyResult(cooldownDays, lookbackMonths);
  }

  const billingUrl = `${baseUrl.replace(/\/$/, '')}/billing`;
  const result = emptyResult(cooldownDays, lookbackMonths);
  result.scanned = due.length;

  for (const tenant of due) {
    try {
      const effective = await getTenantEffectiveRate(tenant.tenant_id);
      const usage = await computeTrailingAverageMinutes(
        tenant.tenant_id,
        lookbackMonths,
      );

      if (usage.averageMinutes <= 0 || usage.monthsConsidered === 0) {
        result.skippedNoUsage += 1;
        continue;
      }

      const override: PlanRateOverride = {
        basePriceCents: effective.basePriceCents,
        overageRatePerMinute: effective.overageRatePerMinute,
      };
      const recommendation = recommendCheapestPlan(
        effective.plan,
        usage.averageMinutes,
        override,
      );
      if (!recommendation) {
        result.skippedAlreadyOptimal += 1;
        continue;
      }
      if (recommendation.isAlreadyOptimal || recommendation.monthlySavings <= 0) {
        result.skippedAlreadyOptimal += 1;
        continue;
      }

      const ownerOptedIn = await isChannelEnabled(
        tenant.owner_user_id,
        'billing',
        'email',
      );
      if (!ownerOptedIn) {
        result.skippedOptedOut += 1;
        continue;
      }

      const ownerDisplay =
        [tenant.owner_first_name, tenant.owner_last_name]
          .filter(Boolean)
          .join(' ')
          .trim() || null;

      const message = planRecommendationEmail({
        tenantName: tenant.tenant_name,
        ownerName: ownerDisplay,
        currentPlanName: recommendation.current.name,
        recommendedPlanName: recommendation.recommended.name,
        averageMinutes: recommendation.averageMinutes,
        monthsConsidered: usage.monthsConsidered,
        monthlySavings: recommendation.monthlySavings,
        annualSavings: recommendation.annualSavings,
        billingUrl,
      });

      let sendResult;
      try {
        sendResult = await sendEmail({
          to: tenant.owner_email,
          subject: message.subject,
          html: message.html,
          text: message.text,
        });
      } catch (err) {
        result.failed += 1;
        logger.error('Plan recommendation email threw', {
          tenantId: tenant.tenant_id,
          error: err instanceof Error ? err.message : String(err),
        });
        continue;
      }

      if (!sendResult.success) {
        result.failed += 1;
        logger.warn('Plan recommendation email failed to deliver', {
          tenantId: tenant.tenant_id,
          ownerEmail: tenant.owner_email,
          error: sendResult.error,
          permanent: sendResult.permanent ?? false,
        });
        continue;
      }

      try {
        await writeAuditLog({
          tenantId: tenant.tenant_id,
          actorUserId: null,
          actorRole: 'system',
          action: PLAN_RECOMMENDATION_AUDIT_ACTION,
          resourceType: 'tenant',
          resourceId: tenant.tenant_id,
          severity: 'info',
          changes: {
            ownerEmail: tenant.owner_email,
            ownerUserId: tenant.owner_user_id,
            tenantName: tenant.tenant_name,
            messageId: sendResult.messageId ?? null,
            sentBy: 'PlanRecommendationDigestScheduler',
            source: 'scheduled',
            cooldownDays,
            lookbackMonths,
            // ISO 8601; eligibility SQL casts back to timestamptz.
            periodStart: tenant.current_period_start.toISOString(),
            currentPlan: recommendation.current.tier,
            recommendedPlan: recommendation.recommended.tier,
            averageMinutes: recommendation.averageMinutes,
            monthlySavings: recommendation.monthlySavings,
            annualSavings: recommendation.annualSavings,
            previousEmailedAt: tenant.last_emailed_at
              ? tenant.last_emailed_at.toISOString()
              : null,
          },
        });
        result.emailed += 1;
      } catch (err) {
        // Email already delivered; next tick will re-send because the
        // period-keyed audit row is missing.
        logger.error(
          'Failed to write plan recommendation audit log after successful send',
          {
            tenantId: tenant.tenant_id,
            ownerEmail: tenant.owner_email,
            error: err instanceof Error ? err.message : String(err),
          },
        );
        result.emailed += 1;
      }
    } catch (err) {
      result.failed += 1;
      logger.error('Plan recommendation cycle failed for tenant', {
        tenantId: tenant.tenant_id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  logger.info('Plan recommendation digest cycle complete', { ...result });
  return result;
}

let timer: ReturnType<typeof setInterval> | null = null;
let initialTimer: ReturnType<typeof setTimeout> | null = null;

export function startPlanRecommendationDigestScheduler(
  intervalMs: number = parseIntEnv(
    'PLAN_RECOMMENDATION_DIGEST_INTERVAL_MS',
    DEFAULT_INTERVAL_MS,
    60_000,
    7 * 24 * 60 * 60 * 1000,
  ),
): void {
  if (timer) return;

  initialTimer = setTimeout(() => {
    runPlanRecommendationDigestCycle().catch((err) => {
      logger.error('Initial plan recommendation digest cycle failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }, INITIAL_DELAY_MS);

  timer = setInterval(() => {
    runPlanRecommendationDigestCycle().catch((err) => {
      logger.error('Plan recommendation digest cycle failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }, intervalMs);

  logger.info('Plan recommendation digest scheduler started', {
    intervalMs,
    cooldownDays: getCooldownDays(),
    lookbackMonths: getLookbackMonths(),
    maxPerCycle: getMaxPerCycle(),
  });
}

export function stopPlanRecommendationDigestScheduler(): void {
  if (initialTimer) {
    clearTimeout(initialTimer);
    initialTimer = null;
  }
  if (timer) {
    clearInterval(timer);
    timer = null;
    logger.info('Plan recommendation digest scheduler stopped');
  }
}
