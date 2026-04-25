import { Router } from 'express';
import { getPlatformPool } from '../../../platform/db';
import { requireAuth } from '../middleware/auth';
import { requirePlatformAdmin } from '../middleware/rbac';
import { createLogger } from '../../../platform/core/logger';
import {
  getUserPreferences,
  setUserPreferences,
  NOTIFICATION_CATEGORIES,
  NOTIFICATION_CHANNELS,
  isNotificationCategory,
  isNotificationChannel,
  type PreferenceMatrix,
} from '../../../platform/notifications/NotificationPreferences';

const router = Router();
const logger = createLogger('PRODUCTION_ESSENTIALS');

// ---------- Maintenance mode ----------

router.get('/platform/maintenance', async (_req, res) => {
  const pool = getPlatformPool();
  try {
    const { rows } = await pool.query(
      `SELECT value, updated_at FROM platform_settings WHERE key = 'maintenance_mode'`,
    );
    if (rows.length === 0) {
      return res.json({ enabled: false, message: null, scheduled_for: null });
    }
    const v = rows[0].value || {};
    return res.json({
      enabled: !!v.enabled,
      message: v.message ?? null,
      scheduled_for: v.scheduled_for ?? null,
      updated_at: rows[0].updated_at,
    });
  } catch (err) {
    logger.error('maintenance get failed', { error: String(err) });
    return res.json({ enabled: false, message: null, scheduled_for: null });
  }
});

router.put('/platform/maintenance', requireAuth, requirePlatformAdmin, async (req, res) => {
  const { enabled, message, scheduled_for } = req.body ?? {};
  const pool = getPlatformPool();
  try {
    await pool.query(
      `INSERT INTO platform_settings (key, value, updated_by)
       VALUES ('maintenance_mode', $1::jsonb, $2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW(), updated_by = EXCLUDED.updated_by`,
      [JSON.stringify({ enabled: !!enabled, message: message ?? null, scheduled_for: scheduled_for ?? null }), req.user!.userId],
    );
    return res.json({ success: true });
  } catch (err) {
    logger.error('maintenance set failed', { error: String(err) });
    return res.status(500).json({ error: 'Failed to update maintenance mode' });
  }
});

// ---------- Changelog ----------

router.get('/platform/changelog', requireAuth, async (req, res) => {
  const { userId } = req.user!;
  const pool = getPlatformPool();
  try {
    const { rows } = await pool.query(
      `SELECT e.id, e.title, e.body, e.tags, e.published_at,
              (r.user_id IS NOT NULL) AS read
       FROM changelog_entries e
       LEFT JOIN changelog_reads r ON r.entry_id = e.id AND r.user_id = $1
       ORDER BY e.published_at DESC
       LIMIT 100`,
      [userId],
    );
    return res.json({ entries: rows });
  } catch (err) {
    logger.error('changelog list failed', { error: String(err) });
    return res.status(500).json({ error: 'Failed to load changelog' });
  }
});

router.get('/platform/changelog/unread-count', requireAuth, async (req, res) => {
  const { userId } = req.user!;
  const pool = getPlatformPool();
  try {
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS c
       FROM changelog_entries e
       LEFT JOIN changelog_reads r ON r.entry_id = e.id AND r.user_id = $1
       WHERE r.user_id IS NULL`,
      [userId],
    );
    return res.json({ count: rows[0]?.c ?? 0 });
  } catch (err) {
    logger.error('changelog unread count failed', { error: String(err) });
    return res.json({ count: 0 });
  }
});

router.post('/platform/changelog/:id/read', requireAuth, async (req, res) => {
  const { userId } = req.user!;
  const { id } = req.params;
  const pool = getPlatformPool();
  try {
    await pool.query(
      `INSERT INTO changelog_reads (user_id, entry_id) VALUES ($1, $2)
       ON CONFLICT (user_id, entry_id) DO NOTHING`,
      [userId, id],
    );
    return res.json({ success: true });
  } catch (err) {
    logger.error('changelog mark read failed', { error: String(err) });
    return res.status(500).json({ error: 'Failed to mark as read' });
  }
});

router.post('/platform/changelog/read-all', requireAuth, async (req, res) => {
  const { userId } = req.user!;
  const pool = getPlatformPool();
  try {
    await pool.query(
      `INSERT INTO changelog_reads (user_id, entry_id)
       SELECT $1, id FROM changelog_entries
       ON CONFLICT (user_id, entry_id) DO NOTHING`,
      [userId],
    );
    return res.json({ success: true });
  } catch (err) {
    logger.error('changelog read-all failed', { error: String(err) });
    return res.status(500).json({ error: 'Failed to mark all as read' });
  }
});

router.post('/platform/changelog', requireAuth, requirePlatformAdmin, async (req, res) => {
  const { title, body, tags, published_at } = req.body ?? {};
  if (!title || !body) return res.status(400).json({ error: 'title and body are required' });
  const pool = getPlatformPool();
  try {
    const { rows } = await pool.query(
      `INSERT INTO changelog_entries (title, body, tags, published_at)
       VALUES ($1, $2, $3::jsonb, COALESCE($4::timestamp, NOW()))
       RETURNING id, title, body, tags, published_at`,
      [title, body, JSON.stringify(tags ?? []), published_at ?? null],
    );
    return res.status(201).json({ entry: rows[0] });
  } catch (err) {
    logger.error('changelog create failed', { error: String(err) });
    return res.status(500).json({ error: 'Failed to create changelog entry' });
  }
});

// ---------- Notifications enhancements ----------

router.get('/platform/notifications/unread-count', requireAuth, async (req, res) => {
  const { tenantId, userId } = req.user!;
  const pool = getPlatformPool();
  try {
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS c FROM tenant_notifications
        WHERE tenant_id = $1 AND read = FALSE AND (user_id IS NULL OR user_id = $2)`,
      [tenantId, userId],
    );
    return res.json({ count: rows[0]?.c ?? 0 });
  } catch {
    return res.json({ count: 0 });
  }
});

router.post('/platform/notifications/read-all', requireAuth, async (req, res) => {
  const { tenantId, userId } = req.user!;
  const pool = getPlatformPool();
  try {
    await pool.query(
      `UPDATE tenant_notifications SET read = TRUE
        WHERE tenant_id = $1 AND read = FALSE AND (user_id IS NULL OR user_id = $2)`,
      [tenantId, userId],
    );
    return res.json({ success: true });
  } catch (err) {
    logger.error('notifications read-all failed', { error: String(err) });
    return res.status(500).json({ error: 'Failed to update notifications' });
  }
});

router.get('/platform/notifications/preferences', requireAuth, async (req, res) => {
  const { userId } = req.user!;
  try {
    const preferences = await getUserPreferences(userId);
    return res.json({
      preferences,
      categories: NOTIFICATION_CATEGORIES,
      channels: NOTIFICATION_CHANNELS,
    });
  } catch (err) {
    logger.error('notification preferences load failed', { userId, error: String(err) });
    return res.status(500).json({ error: 'Failed to load notification preferences' });
  }
});

router.put('/platform/notifications/preferences', requireAuth, async (req, res) => {
  const { userId } = req.user!;
  const body = (req.body ?? {}) as { preferences?: unknown };
  const raw = body.preferences;
  if (!raw || typeof raw !== 'object') {
    return res.status(400).json({ error: 'preferences object is required' });
  }

  const sanitized: Partial<PreferenceMatrix> = {};
  for (const [category, channels] of Object.entries(raw as Record<string, unknown>)) {
    if (!isNotificationCategory(category)) continue;
    if (!channels || typeof channels !== 'object') continue;
    const row: Record<string, boolean> = {};
    for (const [channel, value] of Object.entries(channels as Record<string, unknown>)) {
      if (!isNotificationChannel(channel)) continue;
      if (typeof value !== 'boolean') continue;
      row[channel] = value;
    }
    if (Object.keys(row).length > 0) {
      (sanitized as Record<string, Record<string, boolean>>)[category] = row;
    }
  }

  try {
    const preferences = await setUserPreferences(userId, sanitized);
    return res.json({
      preferences,
      categories: NOTIFICATION_CATEGORIES,
      channels: NOTIFICATION_CHANNELS,
    });
  } catch (err) {
    logger.error('notification preferences save failed', { userId, error: String(err) });
    return res.status(500).json({ error: 'Failed to save notification preferences' });
  }
});

router.delete('/platform/notifications', requireAuth, async (req, res) => {
  const { tenantId, userId } = req.user!;
  const pool = getPlatformPool();
  try {
    await pool.query(
      `DELETE FROM tenant_notifications
        WHERE tenant_id = $1 AND (user_id IS NULL OR user_id = $2)`,
      [tenantId, userId],
    );
    return res.json({ success: true });
  } catch (err) {
    logger.error('notifications clear failed', { error: String(err) });
    return res.status(500).json({ error: 'Failed to clear notifications' });
  }
});

// ---------- Trial status ----------

router.get('/tenants/me/trial-status', requireAuth, async (req, res) => {
  const { tenantId } = req.user!;
  const pool = getPlatformPool();
  try {
    const { rows: tenantRows } = await pool.query(
      `SELECT trial_started_at, trial_expires_at, status, plan FROM tenants WHERE id = $1`,
      [tenantId],
    );
    const { rows: subRows } = await pool.query(
      `SELECT plan, status, trial_end FROM subscriptions WHERE tenant_id = $1 LIMIT 1`,
      [tenantId],
    );

    const tenant = tenantRows[0];
    const sub = subRows[0];
    const plan = sub?.plan ?? tenant?.plan ?? 'starter';
    const subStatus = sub?.status ?? 'none';
    const trialExpiresAt: Date | null = sub?.trial_end
      ? new Date(sub.trial_end)
      : tenant?.trial_expires_at
      ? new Date(tenant.trial_expires_at)
      : null;

    const now = Date.now();
    const onPaidPlan = ['active', 'past_due'].includes(subStatus) && plan !== 'starter';
    let daysRemaining: number | null = null;
    let expired = false;
    if (trialExpiresAt) {
      const ms = trialExpiresAt.getTime() - now;
      daysRemaining = Math.max(0, Math.ceil(ms / (24 * 60 * 60 * 1000)));
      expired = ms <= 0;
    }
    const onTrial = !onPaidPlan && trialExpiresAt !== null;

    return res.json({
      onTrial,
      onPaidPlan,
      expired: onTrial && expired,
      daysRemaining,
      trialExpiresAt: trialExpiresAt ? trialExpiresAt.toISOString() : null,
      plan,
      status: subStatus,
    });
  } catch (err) {
    logger.error('trial status failed', { error: String(err) });
    return res.json({
      onTrial: false,
      onPaidPlan: false,
      expired: false,
      daysRemaining: null,
      trialExpiresAt: null,
      plan: 'starter',
      status: 'none',
    });
  }
});

export default router;
