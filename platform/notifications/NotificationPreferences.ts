import { getPlatformPool } from '../db';
import { createLogger } from '../core/logger';

const logger = createLogger('NOTIFICATION_PREFERENCES');

export const NOTIFICATION_CATEGORIES = [
  'call',
  'billing',
  'sms',
  'integration',
  'integration_recovery',
  'escalation',
] as const;
export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number];

export const NOTIFICATION_CHANNELS = ['in_app', 'email'] as const;
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];

const CATEGORY_SET = new Set<string>(NOTIFICATION_CATEGORIES);
const CHANNEL_SET = new Set<string>(NOTIFICATION_CHANNELS);

export type PreferenceMatrix = Record<NotificationCategory, Record<NotificationChannel, boolean>>;

export function defaultPreferenceMatrix(): PreferenceMatrix {
  const matrix = {} as PreferenceMatrix;
  for (const category of NOTIFICATION_CATEGORIES) {
    matrix[category] = { in_app: true, email: true };
  }
  return matrix;
}

export function isNotificationCategory(value: unknown): value is NotificationCategory {
  return typeof value === 'string' && CATEGORY_SET.has(value);
}

export function isNotificationChannel(value: unknown): value is NotificationChannel {
  return typeof value === 'string' && CHANNEL_SET.has(value);
}

/**
 * Map a tenant_notifications.type value to the user-facing preference category.
 * Returns null when the type is unmapped — callers should treat that as
 * "always deliver" so we don't accidentally suppress new alert kinds.
 */
export function categoryForNotificationType(type: string | null | undefined): NotificationCategory | null {
  if (!type) return null;
  const t = type.toLowerCase();
  if (t === 'call') return 'call';
  if (t === 'integration') return 'integration';
  if (t === 'integration_recovery') return 'integration_recovery';
  if (t === 'integration_sms' || t === 'sms') return 'sms';
  if (t === 'campaign') return null; // not yet user-toggleable
  if (t === 'escalation') return 'escalation';
  if (t === 'account_suspended') return 'billing';
  if (t.startsWith('usage_warning')) return 'billing';
  if (t.startsWith('billing')) return 'billing';
  return null;
}

interface RawPreferenceRow {
  category: string;
  channel: string;
  enabled: boolean;
}

async function loadRawPreferences(userId: string): Promise<RawPreferenceRow[]> {
  if (!userId) return [];
  try {
    const pool = getPlatformPool();
    const { rows } = await pool.query<RawPreferenceRow>(
      `SELECT category, channel, enabled
         FROM user_notification_preferences
        WHERE user_id = $1`,
      [userId],
    );
    return rows;
  } catch (err) {
    logger.warn('Failed to load notification preferences; defaulting to enabled', {
      userId,
      error: String(err),
    });
    return [];
  }
}

/**
 * Returns the full category × channel matrix for a single user with defaults
 * applied. Callers should treat this as authoritative; categories not
 * recognised in the database are ignored.
 */
export async function getUserPreferences(userId: string): Promise<PreferenceMatrix> {
  const matrix = defaultPreferenceMatrix();
  const rows = await loadRawPreferences(userId);
  for (const row of rows) {
    if (!isNotificationCategory(row.category)) continue;
    if (!isNotificationChannel(row.channel)) continue;
    matrix[row.category][row.channel] = !!row.enabled;
  }
  return matrix;
}

/**
 * Cheap one-shot check used by notification creation paths. Falls back to TRUE
 * (deliver) on any database error so a misbehaving prefs table never silences
 * alerts.
 */
export async function isChannelEnabled(
  userId: string | null | undefined,
  category: NotificationCategory,
  channel: NotificationChannel,
): Promise<boolean> {
  if (!userId) return true;
  try {
    const pool = getPlatformPool();
    const { rows } = await pool.query<{ enabled: boolean }>(
      `SELECT enabled FROM user_notification_preferences
        WHERE user_id = $1 AND category = $2 AND channel = $3
        LIMIT 1`,
      [userId, category, channel],
    );
    if (rows.length === 0) return true;
    return rows[0].enabled !== false;
  } catch (err) {
    logger.warn('Failed to check notification preference; defaulting to enabled', {
      userId,
      category,
      channel,
      error: String(err),
    });
    return true;
  }
}

/**
 * Bulk filter: given a list of user ids, return the subset whose
 * (category, channel) preference is enabled. Users with no row default to
 * enabled.
 */
export async function filterUserIdsByPreference(
  userIds: string[],
  category: NotificationCategory,
  channel: NotificationChannel,
): Promise<string[]> {
  const unique = Array.from(new Set(userIds.filter((u): u is string => Boolean(u))));
  if (unique.length === 0) return [];
  try {
    const pool = getPlatformPool();
    const { rows } = await pool.query<{ user_id: string; enabled: boolean }>(
      `SELECT user_id, enabled FROM user_notification_preferences
        WHERE category = $1 AND channel = $2 AND user_id = ANY($3::varchar[])`,
      [category, channel, unique],
    );
    const optedOut = new Set<string>();
    for (const row of rows) {
      if (row.enabled === false) optedOut.add(row.user_id);
    }
    return unique.filter((id) => !optedOut.has(id));
  } catch (err) {
    logger.warn('Failed to filter user ids by preference; defaulting to all enabled', {
      category,
      channel,
      error: String(err),
    });
    return unique;
  }
}

/**
 * Bulk filter for email recipients. Looks up the matching user inside the
 * tenant; recipients without a user row (e.g. external collaborators on a
 * saved view) default to enabled. Recipients whose user has explicitly opted
 * out of the (category, email) combination are dropped.
 */
export async function filterEmailRecipientsByPreference(
  tenantId: string,
  emails: string[],
  category: NotificationCategory,
): Promise<string[]> {
  const cleaned = Array.from(
    new Set(
      emails
        .map((e) => (typeof e === 'string' ? e.trim().toLowerCase() : ''))
        .filter((e) => e.length > 0),
    ),
  );
  if (cleaned.length === 0) return [];
  try {
    const pool = getPlatformPool();
    const { rows } = await pool.query<{ email: string; enabled: boolean | null }>(
      `SELECT LOWER(u.email) AS email,
              p.enabled
         FROM users u
         LEFT JOIN user_notification_preferences p
                ON p.user_id = u.id AND p.category = $3 AND p.channel = 'email'
        WHERE u.tenant_id = $1
          AND LOWER(u.email) = ANY($2::text[])`,
      [tenantId, cleaned, category],
    );
    const optedOut = new Set<string>();
    for (const row of rows) {
      if (row.enabled === false) optedOut.add(row.email);
    }
    if (optedOut.size === 0) {
      // Preserve original casing/order from the caller for backwards compat.
      return emails.filter((e) => typeof e === 'string' && e.length > 0);
    }
    return emails.filter(
      (e) => typeof e === 'string' && !optedOut.has(e.trim().toLowerCase()),
    );
  } catch (err) {
    logger.warn('Failed to filter email recipients by preference; defaulting to all enabled', {
      tenantId,
      category,
      error: String(err),
    });
    return emails.filter((e) => typeof e === 'string' && e.length > 0);
  }
}

/**
 * Upsert the preferences for a user. Only the (category, channel) cells
 * provided in `prefs` are written — omitted cells are left untouched, so a
 * caller can update a single toggle without resending the whole matrix.
 * Unknown categories/channels are silently dropped so the API surface stays
 * forwards compatible with older clients.
 *
 * The current Settings UI always sends the full matrix, so in practice this
 * also behaves like "replace"; if a stricter replace semantic is ever needed,
 * delete the user's rows in the same transaction before the loop below.
 */
export async function setUserPreferences(
  userId: string,
  prefs: Partial<PreferenceMatrix>,
): Promise<PreferenceMatrix> {
  if (!userId) throw new Error('userId is required');
  const pool = getPlatformPool();

  const upserts: Array<{ category: NotificationCategory; channel: NotificationChannel; enabled: boolean }> = [];
  for (const category of NOTIFICATION_CATEGORIES) {
    const row = (prefs as Record<string, Record<string, boolean> | undefined>)[category];
    if (!row || typeof row !== 'object') continue;
    for (const channel of NOTIFICATION_CHANNELS) {
      const value = (row as Record<string, unknown>)[channel];
      if (typeof value !== 'boolean') continue;
      upserts.push({ category, channel, enabled: value });
    }
  }

  if (upserts.length === 0) return getUserPreferences(userId);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const u of upserts) {
      await client.query(
        `INSERT INTO user_notification_preferences (user_id, category, channel, enabled, updated_at)
         VALUES ($1, $2, $3, $4, NOW())
         ON CONFLICT (user_id, category, channel)
         DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = NOW()`,
        [userId, u.category, u.channel, u.enabled],
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  return getUserPreferences(userId);
}

interface FanoutParams {
  tenantId: string;
  type: string;
  title: string;
  message: string;
  metadata: Record<string, unknown>;
  category: NotificationCategory;
  /**
   * When true, only inserts a per-user row when there is no recent
   * (last 24h) row of the same type for that user. Mirrors the legacy
   * tenant-wide throttle but applied per-user so a quiet user doesn't
   * miss the next event because someone else already saw it.
   */
  throttleHours?: number;
  /**
   * Optional caller-provided audience. When set, the fan-out is
   * restricted to these user IDs (intersected with the tenant's active
   * users) instead of every active member. Use this to scope a
   * notification to admins/owners only while still respecting per-user
   * notification preferences.
   */
  userIds?: string[];
}

/**
 * Insert one in-app notification per opted-in user in the tenant. Replaces
 * the legacy "tenant_notifications row with user_id NULL" pattern so per-user
 * preferences can apply to historically tenant-wide categories.
 *
 * Returns the number of rows actually inserted (0 when everyone has opted
 * out or the tenant has no active members).
 */
export async function fanoutInAppNotification(params: FanoutParams): Promise<number> {
  const pool = getPlatformPool();
  let userIds: string[] = [];
  try {
    if (params.userIds !== undefined) {
      // Caller restricted the audience explicitly. An empty list means
      // "send to no one" (do NOT silently fall back to tenant-wide).
      // Otherwise, intersect with active members of the tenant so a
      // stale ID list cannot leak rows across tenants.
      if (params.userIds.length === 0) {
        userIds = [];
      } else {
        const { rows } = await pool.query<{ id: string }>(
          `SELECT id FROM users
            WHERE tenant_id = $1
              AND id = ANY($2::varchar[])
              AND COALESCE(is_active, TRUE) = TRUE`,
          [params.tenantId, params.userIds],
        );
        userIds = rows.map((r) => r.id);
      }
    } else {
      const { rows } = await pool.query<{ id: string }>(
        `SELECT id FROM users
          WHERE tenant_id = $1
            AND COALESCE(is_active, TRUE) = TRUE`,
        [params.tenantId],
      );
      userIds = rows.map((r) => r.id);
    }
  } catch (err) {
    logger.warn('Failed to load tenant users for in-app fan-out', {
      tenantId: params.tenantId,
      error: String(err),
    });
    return 0;
  }

  if (userIds.length === 0) return 0;

  const eligible = await filterUserIdsByPreference(userIds, params.category, 'in_app');
  if (eligible.length === 0) return 0;

  const metadataJson = JSON.stringify(params.metadata ?? {});
  let inserted = 0;
  for (const userId of eligible) {
    if (params.throttleHours && params.throttleHours > 0) {
      try {
        const { rows: throttleRows } = await pool.query(
          `SELECT 1 FROM tenant_notifications
            WHERE tenant_id = $1
              AND user_id = $2
              AND type = $3
              AND created_at > NOW() - ($4 || ' hours')::interval
            LIMIT 1`,
          [params.tenantId, userId, params.type, String(params.throttleHours)],
        );
        if (throttleRows.length > 0) continue;
      } catch (err) {
        logger.warn('Failed to evaluate per-user notification throttle; inserting anyway', {
          tenantId: params.tenantId,
          userId,
          type: params.type,
          error: String(err),
        });
      }
    }
    try {
      await pool.query(
        `INSERT INTO tenant_notifications (tenant_id, user_id, type, title, message, metadata)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [params.tenantId, userId, params.type, params.title, params.message, metadataJson],
      );
      inserted += 1;
    } catch (err) {
      logger.warn('Failed to insert per-user in-app notification', {
        tenantId: params.tenantId,
        userId,
        type: params.type,
        error: String(err),
      });
    }
  }
  return inserted;
}
