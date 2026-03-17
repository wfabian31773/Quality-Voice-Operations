import { getPlatformPool, withTenantContext } from '../db';
import { createLogger } from '../core/logger';
import { sendEmail } from '../email/EmailService';
import type { AutopilotNotification, AutopilotRecommendation } from './types';

const logger = createLogger('AUTOPILOT_NOTIFICATIONS');

function mapNotificationRow(r: Record<string, unknown>): AutopilotNotification {
  return {
    id: r.id as string,
    tenantId: r.tenant_id as string,
    recommendationId: (r.recommendation_id as string) || null,
    insightId: (r.insight_id as string) || null,
    channel: r.channel as AutopilotNotification['channel'],
    severity: r.severity as string,
    title: r.title as string,
    body: r.body as string,
    read: Boolean(r.read),
    readAt: r.read_at ? String(r.read_at) : null,
    delivered: Boolean(r.delivered),
    deliveredAt: r.delivered_at ? String(r.delivered_at) : null,
    metadata: (r.metadata as Record<string, unknown>) || {},
    createdAt: String(r.created_at),
  };
}

export async function createInAppNotification(
  tenantId: string,
  params: {
    recommendationId?: string;
    insightId?: string;
    severity: string;
    title: string;
    body: string;
  },
): Promise<AutopilotNotification> {
  const pool = getPlatformPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await withTenantContext(client, tenantId, async () => {});

    const { rows } = await client.query(
      `INSERT INTO autopilot_notifications (
        tenant_id, recommendation_id, insight_id, channel, severity, title, body, delivered, delivered_at
      ) VALUES ($1, $2, $3, 'in_app', $4, $5, $6, true, NOW())
      RETURNING *`,
      [tenantId, params.recommendationId || null, params.insightId || null,
       params.severity, params.title, params.body],
    );
    await client.query('COMMIT');
    return mapNotificationRow(rows[0]);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export async function sendRecommendationEmail(
  tenantId: string,
  recommendation: AutopilotRecommendation,
  recipientEmail: string,
): Promise<void> {
  const pool = getPlatformPool();
  const client = await pool.connect();

  try {
    const severityColor = recommendation.riskTier === 'high' ? '#dc2626' :
      recommendation.riskTier === 'medium' ? '#f59e0b' : '#22c55e';

    const html = `
      <div style="font-family: system-ui, sans-serif; max-width: 600px; margin: 0 auto;">
        <div style="background: #1a1a2e; padding: 20px; border-radius: 8px 8px 0 0;">
          <h2 style="color: #fff; margin: 0;">QVO Autopilot Recommendation</h2>
        </div>
        <div style="background: #fff; padding: 24px; border: 1px solid #e5e7eb;">
          <div style="display: inline-block; padding: 4px 12px; border-radius: 12px; background: ${severityColor}20; color: ${severityColor}; font-size: 12px; font-weight: 600; margin-bottom: 12px;">
            ${recommendation.riskTier.toUpperCase()} RISK
          </div>
          <h3 style="margin: 0 0 8px;">${recommendation.title}</h3>
          <p style="color: #6b7280; margin: 0 0 16px;">${recommendation.situationSummary}</p>
          <div style="background: #f9fafb; padding: 16px; border-radius: 8px; margin-bottom: 16px;">
            <p style="font-weight: 600; margin: 0 0 4px;">Recommended Action</p>
            <p style="color: #374151; margin: 0;">${recommendation.recommendedAction}</p>
          </div>
          <div style="background: #f0fdf4; padding: 16px; border-radius: 8px; margin-bottom: 16px;">
            <p style="font-weight: 600; margin: 0 0 4px;">Expected Outcome</p>
            <p style="color: #374151; margin: 0;">${recommendation.expectedOutcome}</p>
          </div>
          <p style="color: #9ca3af; font-size: 12px; margin: 16px 0 0;">
            Confidence: ${Math.round(recommendation.confidenceScore * 100)}% | Log in to approve or dismiss this recommendation.
          </p>
        </div>
      </div>`;

    await sendEmail({
      to: recipientEmail,
      subject: `[QVO Autopilot] ${recommendation.title}`,
      html,
      text: `QVO Autopilot Recommendation: ${recommendation.title}\n\n${recommendation.situationSummary}\n\nRecommended Action: ${recommendation.recommendedAction}\n\nExpected Outcome: ${recommendation.expectedOutcome}`,
    });

    await client.query('BEGIN');
    await withTenantContext(client, tenantId, async () => {});
    await client.query(
      `INSERT INTO autopilot_notifications (
        tenant_id, recommendation_id, channel, severity, title, body, delivered, delivered_at
      ) VALUES ($1, $2, 'email', $3, $4, $5, true, NOW())`,
      [tenantId, recommendation.id, recommendation.riskTier === 'high' ? 'critical' : 'info',
       recommendation.title, recommendation.situationSummary],
    );
    await client.query('COMMIT');

    logger.info('Autopilot recommendation email sent', { tenantId, recommendationId: recommendation.id });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    logger.error('Failed to send recommendation email', { tenantId, error: String(err) });
  } finally {
    client.release();
  }
}

export async function sendUrgentSmsAlert(
  tenantId: string,
  recommendation: AutopilotRecommendation,
  phoneNumber: string,
): Promise<void> {
  const pool = getPlatformPool();
  const client = await pool.connect();

  try {
    const message = `[QVO Autopilot] ${recommendation.riskTier.toUpperCase()} RISK: ${recommendation.title}. ${recommendation.situationSummary.substring(0, 100)}. Log in to review.`;

    const accountSid = process.env.TWILIO_ACCOUNT_SID;
    const authToken = process.env.TWILIO_AUTH_TOKEN;
    const fromNumber = process.env.TWILIO_SMS_FROM || process.env.TWILIO_PHONE_NUMBER;

    if (accountSid && authToken && fromNumber) {
      const url = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`;
      const body = new URLSearchParams({
        To: phoneNumber,
        From: fromNumber,
        Body: message,
      });

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': 'Basic ' + Buffer.from(`${accountSid}:${authToken}`).toString('base64'),
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: body.toString(),
      });

      if (!response.ok) {
        logger.error('SMS send failed', { status: response.status, tenantId });
      }
    } else {
      logger.info('Twilio not configured — SMS alert logged', { tenantId, message });
    }

    await client.query('BEGIN');
    await withTenantContext(client, tenantId, async () => {});
    await client.query(
      `INSERT INTO autopilot_notifications (
        tenant_id, recommendation_id, channel, severity, title, body, delivered, delivered_at
      ) VALUES ($1, $2, 'sms', 'critical', $3, $4, true, NOW())`,
      [tenantId, recommendation.id, recommendation.title, message],
    );
    await client.query('COMMIT');

    logger.info('Urgent SMS alert sent', { tenantId, recommendationId: recommendation.id });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    logger.error('Failed to send SMS alert', { tenantId, error: String(err) });
  } finally {
    client.release();
  }
}

export async function getNotifications(
  tenantId: string,
  options: { unreadOnly?: boolean; limit?: number; offset?: number } = {},
): Promise<{ notifications: AutopilotNotification[]; total: number; unreadCount: number }> {
  const pool = getPlatformPool();
  const client = await pool.connect();
  const limit = Math.min(options.limit ?? 50, 100);
  const offset = options.offset ?? 0;

  try {
    await client.query('BEGIN');
    return await withTenantContext(client, tenantId, async () => {
      const conditions = ['tenant_id = $1'];
      const params: unknown[] = [tenantId];
      let idx = 2;

      if (options.unreadOnly) {
        conditions.push('read = false');
      }

      const where = conditions.join(' AND ');

      const { rows: countRows } = await client.query(
        `SELECT COUNT(*)::int AS total FROM autopilot_notifications WHERE ${where}`, params,
      );
      const { rows: unreadRows } = await client.query(
        `SELECT COUNT(*)::int AS unread FROM autopilot_notifications WHERE tenant_id = $1 AND read = false`,
        [tenantId],
      );
      const { rows } = await client.query(
        `SELECT * FROM autopilot_notifications WHERE ${where} ORDER BY created_at DESC LIMIT $${idx} OFFSET $${idx + 1}`,
        [...params, limit, offset],
      );
      await client.query('COMMIT');
      return {
        notifications: rows.map(mapNotificationRow),
        total: countRows[0]?.total ?? 0,
        unreadCount: unreadRows[0]?.unread ?? 0,
      };
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export async function markNotificationRead(
  tenantId: string,
  notificationId: string,
): Promise<boolean> {
  const pool = getPlatformPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await withTenantContext(client, tenantId, async () => {});
    const { rowCount } = await client.query(
      `UPDATE autopilot_notifications SET read = true, read_at = NOW()
       WHERE id = $1 AND tenant_id = $2`,
      [notificationId, tenantId],
    );
    await client.query('COMMIT');
    return (rowCount ?? 0) > 0;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    return false;
  } finally {
    client.release();
  }
}

export async function markAllNotificationsRead(tenantId: string): Promise<number> {
  const pool = getPlatformPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await withTenantContext(client, tenantId, async () => {});
    const { rowCount } = await client.query(
      `UPDATE autopilot_notifications SET read = true, read_at = NOW()
       WHERE tenant_id = $1 AND read = false`,
      [tenantId],
    );
    await client.query('COMMIT');
    return rowCount ?? 0;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    return 0;
  } finally {
    client.release();
  }
}
