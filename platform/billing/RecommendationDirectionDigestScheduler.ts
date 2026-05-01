/**
 * Weekly digest that emails the upgrade vs. downgrade arms of the billing
 * recommendation funnel to platform/billing admins.
 *
 * The platform admin dashboard already surfaces the same `byDirection`
 * aggregation inside the recommendation tile (see `byDirection` in
 * `server/admin-api/routes/platformAdmin.ts`). Finance teams who don't
 * log in every week were missing the trailing-week MRR delta — this
 * scheduler ships them the same numbers the dashboard renders so they
 * can react inside the close window.
 *
 * Recipients are platform admins (users with `is_platform_admin = TRUE`)
 * filtered by their per-user `billing` email notification preference, so
 * an admin who silenced billing emails is silenced here too.
 *
 * Cooldown / dedup
 * ----------------
 * Last successful send timestamp lives in `platform_settings` under the
 * `recommendation_direction_digest_last_sent_at` key. The cycle skips if
 * fewer than `RECOMMENDATION_DIRECTION_DIGEST_COOLDOWN_DAYS` (default 7)
 * have elapsed since the last send. With a daily timer this enforces a
 * true weekly cadence: a Monday send suppresses every tick until the
 * following Monday. If a tick is missed (e.g. Monday outage), the next
 * tick (Tuesday) sends because >=7 days have passed and the recipient
 * is just one day late instead of getting two pings inside a week.
 */
import { createLogger } from '../core/logger';
import { getPlatformPool, withPrivilegedClient } from '../db';
import { sendEmail } from '../email/EmailService';
import { recommendationDirectionDigestEmail } from '../email/templates';
import { filterUserIdsByPreference } from '../notifications/NotificationPreferences';

const logger = createLogger('RECOMMENDATION_DIRECTION_DIGEST');

const DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1000;
const INITIAL_DELAY_MS = 11 * 60 * 1000;
const DEFAULT_COOLDOWN_DAYS = 7;
const DEFAULT_WINDOW_DAYS = 7;
const MIN_COOLDOWN_DAYS = 1;
const MAX_COOLDOWN_DAYS = 30;
const MIN_WINDOW_DAYS = 1;
const MAX_WINDOW_DAYS = 30;

const LAST_SENT_KEY = 'recommendation_direction_digest_last_sent_at';

const RECOMMENDATION_DIRECTIONS = ['upgrade', 'downgrade', 'lateral'] as const;
type RecommendationDirection = (typeof RECOMMENDATION_DIRECTIONS)[number];
const isRecommendationDirection = (
  value: unknown,
): value is RecommendationDirection =>
  typeof value === 'string' &&
  (RECOMMENDATION_DIRECTIONS as readonly string[]).includes(value);

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
    'RECOMMENDATION_DIRECTION_DIGEST_COOLDOWN_DAYS',
    DEFAULT_COOLDOWN_DAYS,
    MIN_COOLDOWN_DAYS,
    MAX_COOLDOWN_DAYS,
  );
}

export function getWindowDays(): number {
  return parseIntEnv(
    'RECOMMENDATION_DIRECTION_DIGEST_WINDOW_DAYS',
    DEFAULT_WINDOW_DAYS,
    MIN_WINDOW_DAYS,
    MAX_WINDOW_DAYS,
  );
}

export interface DirectionRow {
  direction: RecommendationDirection;
  impressions: number;
  clicks: number;
  completedSwitches: number;
  monthlySavingsCents: number;
}

/**
 * Run the same direction-bucketed funnel aggregation used by
 * `/platform/billing-recommendations` so the email and the in-app tile
 * never diverge. The CASE clause must stay in lockstep with the
 * dashboard route — both encode the same `(current_tier,
 * recommended_tier) → direction` truth table.
 */
export async function aggregateRecommendationsByDirection(
  windowDays: number = getWindowDays(),
): Promise<DirectionRow[]> {
  const { rows } = await withPrivilegedClient(async (client) => {
    return client.query(
      `SELECT
         CASE
           WHEN current_tier = recommended_tier THEN 'lateral'
           WHEN current_tier = 'starter'
                AND recommended_tier IN ('pro', 'enterprise')
             THEN 'upgrade'
           WHEN current_tier = 'pro'
                AND recommended_tier = 'enterprise'
             THEN 'upgrade'
           WHEN current_tier = 'enterprise'
                AND recommended_tier IN ('pro', 'starter')
             THEN 'downgrade'
           WHEN current_tier = 'pro'
                AND recommended_tier = 'starter'
             THEN 'downgrade'
           ELSE 'unknown'
         END AS direction,
         COUNT(*) FILTER (WHERE event_type = 'impression')::bigint
           AS impressions,
         COUNT(*) FILTER (WHERE event_type = 'click')::bigint
           AS clicks,
         COUNT(*) FILTER (WHERE event_type = 'switch_completed')::bigint
           AS completed_switches,
         COALESCE(
           SUM(monthly_savings_cents)
             FILTER (WHERE event_type = 'switch_completed'),
           0
         )::bigint AS monthly_savings_cents
         FROM billing_recommendation_events
        WHERE created_at >= NOW() - ($1 || ' days')::interval
          AND event_type IN ('impression', 'click', 'switch_completed')
        GROUP BY direction`,
      [String(windowDays)],
    );
  });

  const index = new Map<RecommendationDirection, DirectionRow>();
  for (const raw of rows as Array<{
    direction: string;
    impressions: string;
    clicks: string;
    completed_switches: string;
    monthly_savings_cents: string;
  }>) {
    if (!isRecommendationDirection(raw.direction)) continue;
    index.set(raw.direction, {
      direction: raw.direction,
      impressions: Number(raw.impressions) || 0,
      clicks: Number(raw.clicks) || 0,
      completedSwitches: Number(raw.completed_switches) || 0,
      monthlySavingsCents: Number(raw.monthly_savings_cents) || 0,
    });
  }
  // Always emit the three known directions in stable order so the email
  // table renders deterministically even when one bucket is empty.
  return RECOMMENDATION_DIRECTIONS.map((direction) =>
    index.get(direction) ?? {
      direction,
      impressions: 0,
      clicks: 0,
      completedSwitches: 0,
      monthlySavingsCents: 0,
    },
  );
}

export interface PlatformAdminRecipient {
  userId: string;
  email: string;
}

/**
 * Load active platform admins, then drop anyone who silenced the
 * `billing` email channel in their notification preferences. The
 * preference filter is the same one tenant-side billing emails use, so
 * an admin who muted billing across the product also mutes this digest.
 */
export async function loadOptedInPlatformAdminRecipients(): Promise<PlatformAdminRecipient[]> {
  const pool = getPlatformPool();
  let rows: Array<{ id: string; email: string | null }> = [];
  try {
    const r = await pool.query<{ id: string; email: string | null }>(
      `SELECT id, email FROM users
        WHERE is_platform_admin = TRUE
          AND COALESCE(is_active, TRUE) = TRUE
          AND email IS NOT NULL`,
    );
    rows = r.rows;
  } catch (err) {
    logger.warn('Failed to load platform admin recipients', { error: String(err) });
    return [];
  }

  const candidates = rows
    .map((row) => ({
      userId: row.id,
      email: (row.email ?? '').trim(),
    }))
    .filter((r) => r.userId && r.email.includes('@'));

  if (candidates.length === 0) return [];

  const optedInIds = new Set(
    await filterUserIdsByPreference(
      candidates.map((c) => c.userId),
      'billing',
      'email',
    ),
  );

  // Dedup on lower-cased email so two admin accounts that share an
  // address (a vanishingly rare-but-possible aliasing case) don't double
  // their pings.
  const seenEmail = new Set<string>();
  const result: PlatformAdminRecipient[] = [];
  for (const c of candidates) {
    if (!optedInIds.has(c.userId)) continue;
    const key = c.email.toLowerCase();
    if (seenEmail.has(key)) continue;
    seenEmail.add(key);
    result.push(c);
  }
  return result;
}

async function loadLastSentAt(): Promise<Date | null> {
  const pool = getPlatformPool();
  try {
    const { rows } = await pool.query<{ value: { sent_at?: string } | null }>(
      `SELECT value FROM platform_settings WHERE key = $1`,
      [LAST_SENT_KEY],
    );
    const sentAt = rows[0]?.value?.sent_at;
    if (!sentAt) return null;
    const parsed = new Date(sentAt);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  } catch (err) {
    logger.warn('Failed to load last-sent timestamp; assuming never sent', {
      error: String(err),
    });
    return null;
  }
}

async function recordLastSentAt(now: Date): Promise<void> {
  const pool = getPlatformPool();
  try {
    await pool.query(
      `INSERT INTO platform_settings (key, value, updated_at)
       VALUES ($1, $2::jsonb, NOW())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      [LAST_SENT_KEY, JSON.stringify({ sent_at: now.toISOString() })],
    );
  } catch (err) {
    // Email already delivered; failing to persist the cooldown row will
    // cause the next tick to re-send. Logged loudly so ops can intervene
    // before recipients get a duplicate.
    logger.error(
      'Failed to record digest last-sent timestamp after successful send',
      { error: String(err) },
    );
  }
}

export interface DirectionDigestCycleResult {
  scanned: number;
  emailed: number;
  recipients: number;
  skippedCooldown: boolean;
  skippedNoBaseUrl: boolean;
  skippedNoRecipients: boolean;
  skippedNoActivity: boolean;
  failed: boolean;
  windowDays: number;
  cooldownDays: number;
}

function emptyResult(
  windowDays: number,
  cooldownDays: number,
): DirectionDigestCycleResult {
  return {
    scanned: 0,
    emailed: 0,
    recipients: 0,
    skippedCooldown: false,
    skippedNoBaseUrl: false,
    skippedNoRecipients: false,
    skippedNoActivity: false,
    failed: false,
    windowDays,
    cooldownDays,
  };
}

export async function runRecommendationDirectionDigestCycle(): Promise<DirectionDigestCycleResult> {
  const cooldownDays = getCooldownDays();
  const windowDays = getWindowDays();
  const result = emptyResult(windowDays, cooldownDays);

  const baseUrl = appBaseUrl();
  if (!baseUrl) {
    logger.warn(
      'Skipping recommendation direction digest cycle: APP_URL / REPLIT_DEV_DOMAIN is not configured',
    );
    return { ...result, skippedNoBaseUrl: true };
  }

  // Cooldown check first — cheaper than DB aggregation when we already
  // sent recently.
  const lastSentAt = await loadLastSentAt();
  if (lastSentAt) {
    const ageMs = Date.now() - lastSentAt.getTime();
    const cooldownMs = cooldownDays * 24 * 60 * 60 * 1000;
    if (ageMs < cooldownMs) {
      logger.debug('Skipping digest: still inside cooldown window', {
        lastSentAt: lastSentAt.toISOString(),
        ageHours: Math.round(ageMs / 3_600_000),
        cooldownDays,
      });
      return { ...result, skippedCooldown: true };
    }
  }

  let rows: DirectionRow[];
  try {
    rows = await aggregateRecommendationsByDirection(windowDays);
  } catch (err) {
    logger.error('Failed to aggregate recommendation direction metrics', {
      error: err instanceof Error ? err.message : String(err),
    });
    return { ...result, failed: true };
  }
  result.scanned = rows.length;

  const totalActivity = rows.reduce(
    (acc, r) => acc + r.impressions + r.clicks + r.completedSwitches,
    0,
  );
  if (totalActivity === 0) {
    // No activity in the trailing window — don't ping admins with an
    // empty table. Don't write the cooldown either, so when activity
    // returns the next tick sends immediately instead of waiting another
    // full cooldown.
    logger.info('Skipping digest: no recommendation activity in window', {
      windowDays,
    });
    return { ...result, skippedNoActivity: true };
  }

  const recipients = await loadOptedInPlatformAdminRecipients();
  result.recipients = recipients.length;
  if (recipients.length === 0) {
    logger.warn('No opted-in platform admin recipients; skipping digest send');
    return { ...result, skippedNoRecipients: true };
  }

  const dashboardUrl = `${baseUrl.replace(/\/$/, '')}/admin/billing-recommendations`;
  const generatedAt = new Date().toISOString();
  const message = recommendationDirectionDigestEmail({
    windowDays,
    generatedAt,
    dashboardUrl,
    rows,
  });

  let sendResult;
  try {
    sendResult = await sendEmail({
      to: recipients.map((r) => r.email).join(', '),
      subject: message.subject,
      html: message.html,
      text: message.text,
    });
  } catch (err) {
    logger.error('Recommendation direction digest send threw', {
      error: err instanceof Error ? err.message : String(err),
    });
    return { ...result, failed: true };
  }

  if (!sendResult.success) {
    logger.warn('Recommendation direction digest failed to deliver', {
      error: sendResult.error,
      permanent: sendResult.permanent ?? false,
      recipients: recipients.length,
    });
    return { ...result, failed: true };
  }

  await recordLastSentAt(new Date());
  result.emailed = recipients.length;

  logger.info('Recommendation direction digest cycle complete', {
    windowDays,
    recipients: recipients.length,
    totalCompletedSwitches: rows.reduce((acc, r) => acc + r.completedSwitches, 0),
    totalMonthlySavingsCents: rows.reduce(
      (acc, r) => acc + r.monthlySavingsCents,
      0,
    ),
  });
  return result;
}

let timer: ReturnType<typeof setInterval> | null = null;
let initialTimer: ReturnType<typeof setTimeout> | null = null;

export function startRecommendationDirectionDigestScheduler(
  intervalMs: number = parseIntEnv(
    'RECOMMENDATION_DIRECTION_DIGEST_INTERVAL_MS',
    DEFAULT_INTERVAL_MS,
    60_000,
    7 * 24 * 60 * 60 * 1000,
  ),
): void {
  if (timer) return;

  initialTimer = setTimeout(() => {
    runRecommendationDirectionDigestCycle().catch((err) => {
      logger.error('Initial recommendation direction digest cycle failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }, INITIAL_DELAY_MS);

  timer = setInterval(() => {
    runRecommendationDirectionDigestCycle().catch((err) => {
      logger.error('Recommendation direction digest cycle failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }, intervalMs);

  logger.info('Recommendation direction digest scheduler started', {
    intervalMs,
    cooldownDays: getCooldownDays(),
    windowDays: getWindowDays(),
  });
}

export function stopRecommendationDirectionDigestScheduler(): void {
  if (initialTimer) {
    clearTimeout(initialTimer);
    initialTimer = null;
  }
  if (timer) {
    clearInterval(timer);
    timer = null;
    logger.info('Recommendation direction digest scheduler stopped');
  }
}
