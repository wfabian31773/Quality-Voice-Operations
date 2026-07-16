import { randomBytes } from 'crypto';
import { Router } from 'express';
import { getPlatformPool } from '../../../platform/db';
import { writeAuditLog, extractIp } from '../../../platform/audit/AuditService';
import { sendEmail } from '../../../platform/email/EmailService';
import { invitationEmail } from '../../../platform/email/templates';
import { createLogger } from '../../../platform/core/logger';
import { requireAuth } from '../middleware/auth';
import { requirePlatformAdmin } from '../middleware/rbac';

const router = Router();
const logger = createLogger('PLATFORM_ADMIN_PROVISIONING');
const INVITE_EXPIRY_HOURS = 72;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;

function applicationBaseUrl(): string | null {
  const configured = process.env.APP_URL
    ?? (process.env.REPLIT_DEV_DOMAIN ? `https://${process.env.REPLIT_DEV_DOMAIN}` : null);
  if (!configured) return null;
  try {
    const url = new URL(configured);
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    if ((process.env.APP_ENV === 'production' || process.env.NODE_ENV === 'production') && url.protocol !== 'https:') return null;
    return url.origin;
  } catch {
    return null;
  }
}

function optionalName(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw new Error('invalid name');
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 100) throw new Error('invalid name');
  return trimmed;
}

router.post(
  '/platform/compliance/platform-admins/invite',
  requireAuth,
  requirePlatformAdmin,
  async (req, res) => {
    const rawEmail = req.body && typeof req.body === 'object'
      ? (req.body as Record<string, unknown>).email
      : undefined;
    if (typeof rawEmail !== 'string') return res.status(400).json({ error: 'A valid email is required' });
    const email = rawEmail.trim().toLowerCase();
    if (email.length > 254 || !EMAIL_PATTERN.test(email)) {
      return res.status(400).json({ error: 'A valid email is required' });
    }

    let firstName: string | null;
    let lastName: string | null;
    try {
      firstName = optionalName((req.body as Record<string, unknown>).firstName);
      lastName = optionalName((req.body as Record<string, unknown>).lastName);
    } catch {
      return res.status(400).json({ error: 'Names must be between 1 and 100 characters' });
    }

    const baseUrl = applicationBaseUrl();
    if (!baseUrl) {
      return res.status(503).json({ error: 'A secure application URL is required before invitations can be created' });
    }

    const { tenantId, userId: inviterId, role: inviterRole } = req.user!;
    const client = await getPlatformPool().connect();
    let invitedUser: { id: string; email: string } | null = null;
    let token = '';
    let expiresAt = new Date(0);
    try {
      await client.query('BEGIN');
      const { rows: existingRows } = await client.query(
        `SELECT id, is_platform_admin, mfa_enabled_at
         FROM users
         WHERE lower(email) = lower($1)
         FOR UPDATE`,
        [email],
      );
      const existing = existingRows[0];
      if (existing?.is_platform_admin === true && existing.mfa_enabled_at) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'This identity is already an enrolled platform administrator' });
      }

      if (existing) {
        const { rows } = await client.query(
          `UPDATE users
           SET first_name = COALESCE($1, first_name),
               last_name = COALESCE($2, last_name),
               is_platform_admin = TRUE,
               updated_at = NOW()
           WHERE id = $3
           RETURNING id, email`,
          [firstName, lastName, existing.id],
        );
        invitedUser = rows[0] as { id: string; email: string };
      } else {
        const { rows } = await client.query(
          `INSERT INTO users (
             email, first_name, last_name, role, is_active,
             is_platform_admin, email_verified
           )
           VALUES ($1, $2, $3, 'support_reviewer', FALSE, TRUE, FALSE)
           RETURNING id, email`,
          [email, firstName, lastName],
        );
        invitedUser = rows[0] as { id: string; email: string };
      }

      await client.query(
        `INSERT INTO user_roles (user_id, tenant_id, role)
         VALUES ($1, $2, 'support_reviewer')
         ON CONFLICT (user_id, tenant_id, role) DO NOTHING`,
        [invitedUser.id, tenantId],
      );

      await client.query(
        `DELETE FROM user_invitations
         WHERE lower(email) = lower($1) AND accepted_at IS NULL`,
        [email],
      );
      token = randomBytes(32).toString('hex');
      expiresAt = new Date(Date.now() + INVITE_EXPIRY_HOURS * 60 * 60 * 1000);
      await client.query(
        `INSERT INTO user_invitations (tenant_id, email, role, token, invited_by, expires_at)
         VALUES ($1, $2, 'support_reviewer', $3, $4, $5)`,
        [tenantId, email, token, inviterId, expiresAt],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      logger.error('Failed to create platform-admin invitation', { inviterId, error: String(error) });
      return res.status(500).json({ error: 'Failed to create platform-admin invitation' });
    } finally {
      client.release();
    }

    const signupUrl = `${baseUrl}/accept-invite?token=${encodeURIComponent(token)}`;
    const message = invitationEmail({
      inviterName: req.user!.email,
      role: 'viewer',
      tenantName: 'Quality Voice Operations',
      signupUrl,
      expiresInHours: INVITE_EXPIRY_HOURS,
    });
    const emailResult = await sendEmail({
      to: email,
      subject: message.subject,
      html: message.html,
      text: message.text,
    });

    await writeAuditLog({
      tenantId,
      actorUserId: inviterId,
      actorRole: inviterRole,
      action: 'platform_admin.invited',
      resourceType: 'user',
      resourceId: invitedUser!.id,
      changes: {
        email,
        tenantRole: 'support_reviewer',
        mfaRequired: true,
        invitationExpiresAt: expiresAt.toISOString(),
        invitationSent: emailResult.success,
      },
      ipAddress: extractIp(req),
      userAgent: req.headers['user-agent'],
    });

    return res.status(201).json({
      userId: invitedUser!.id,
      email,
      invitationSent: emailResult.success,
      mfaRequired: true,
      expiresAt: expiresAt.toISOString(),
      ...(emailResult.success ? {} : { emailError: 'Invitation created but delivery failed' }),
    });
  },
);

export default router;
