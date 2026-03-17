import { Router } from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { getPlatformPool } from '../../../platform/db';
import { issueToken, requireAuth } from '../middleware/auth';
import { createLogger } from '../../../platform/core/logger';
import { getStripeClient } from '../../../platform/billing/stripe/client';
import { getPlanPriceId, TRIAL_LIMITS, type PlanTier } from '../../../platform/billing/stripe/plans';
import { writeAuditLog, extractIp } from '../../../platform/audit/AuditService';

const router = Router();
const logger = createLogger('ADMIN_AUTH_ROUTES');

const VALID_PLANS = new Set<string>(['starter', 'pro', 'enterprise']);
const TURNSTILE_SECRET = process.env.TURNSTILE_SECRET_KEY;

async function verifyTurnstileToken(token: string, ip: string): Promise<boolean> {
  if (!TURNSTILE_SECRET) {
    logger.warn('TURNSTILE_SECRET_KEY not configured — skipping CAPTCHA verification');
    return true;
  }

  try {
    const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        secret: TURNSTILE_SECRET,
        response: token,
        remoteip: ip,
      }),
    });
    const data = await response.json() as { success: boolean };
    return data.success === true;
  } catch (err) {
    logger.error('Turnstile verification failed', { error: String(err) });
    return false;
  }
}

router.post('/auth/login', async (req, res) => {
  const { email, password } = req.body as { email?: string; password?: string };

  if (!email || !password) {
    return res.status(400).json({ error: 'email and password are required' });
  }

  const pool = getPlatformPool();
  const client = await pool.connect();

  try {
    const { rows } = await client.query(
      `SELECT u.id, u.email, u.password_hash, u.is_active, u.is_platform_admin,
              u.email_verified,
              ur.tenant_id, ur.role
       FROM users u
       JOIN user_roles ur ON ur.user_id = u.id
       WHERE u.email = $1
       ORDER BY ur.created_at DESC
       LIMIT 1`,
      [email.toLowerCase()],
    );

    if (rows.length === 0) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const user = rows[0];

    if (!user.is_active) {
      return res.status(403).json({ error: 'Account is disabled' });
    }

    const passwordHash = user.password_hash as string | null;
    if (!passwordHash) {
      return res.status(401).json({ error: 'Password auth not configured for this account' });
    }

    const valid = await bcrypt.compare(password, passwordHash);
    if (!valid) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    await client.query(
      `UPDATE users SET last_login_at = NOW() WHERE id = $1`,
      [user.id],
    );

    const token = issueToken({
      userId: user.id as string,
      tenantId: user.tenant_id as string,
      email: user.email as string,
      role: user.role as string,
      isPlatformAdmin: (user.is_platform_admin as boolean) ?? false,
    });

    const isProd = (process.env.APP_ENV ?? process.env.NODE_ENV ?? '').startsWith('prod');
    res.cookie('auth_token', token, {
      httpOnly: true,
      secure: isProd,
      sameSite: 'lax',
      maxAge: 8 * 60 * 60 * 1000,
      path: '/',
    });

    logger.info('User logged in', { userId: user.id, tenantId: user.tenant_id });

    await writeAuditLog({
      tenantId: user.tenant_id as string,
      actorUserId: user.id as string,
      actorRole: user.role as string,
      action: 'user.login',
      resourceType: 'user',
      resourceId: user.id as string,
      ipAddress: extractIp(req),
      userAgent: req.headers['user-agent'],
    });

    const emailVerified = (user.email_verified as boolean) ?? false;

    return res.json({
      token,
      userId: user.id,
      email: user.email,
      role: user.role,
      tenantId: user.tenant_id,
      isPlatformAdmin: (user.is_platform_admin as boolean) ?? false,
      emailVerified,
      emailVerificationRequired: !emailVerified,
    });
  } catch (err) {
    logger.error('Login error', { error: String(err) });
    return res.status(500).json({ error: 'Login failed' });
  } finally {
    client.release();
  }
});

router.post('/auth/signup', async (req, res) => {
  const { name, email, password, plan = 'starter', captchaToken } = req.body as {
    name?: string;
    email?: string;
    password?: string;
    plan?: string;
    captchaToken?: string;
  };

  if (!name || !email || !password) {
    return res.status(400).json({ error: 'name, email, and password are required' });
  }

  if (password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }

  if (!VALID_PLANS.has(plan)) {
    return res.status(400).json({ error: `plan must be one of: ${[...VALID_PLANS].join(', ')}` });
  }

  if (TURNSTILE_SECRET && !captchaToken) {
    return res.status(400).json({ error: 'CAPTCHA verification is required' });
  }

  if (captchaToken) {
    const forwarded = req.headers['x-forwarded-for'];
    const ip = typeof forwarded === 'string' ? forwarded.split(',')[0].trim() : req.socket?.remoteAddress ?? '';
    const captchaValid = await verifyTurnstileToken(captchaToken, ip);
    if (!captchaValid) {
      return res.status(400).json({ error: 'CAPTCHA verification failed. Please try again.' });
    }
  }

  const pool = getPlatformPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL row_security = off`);

    const { rows: existing } = await client.query(
      `SELECT id FROM users WHERE email = $1`,
      [email.toLowerCase()],
    );
    if (existing.length > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'An account with this email already exists' });
    }

    const slug = email.toLowerCase().split('@')[0].replace(/[^a-z0-9-]/g, '-').slice(0, 60) + '-' + Date.now().toString(36);
    const trialExpiresAt = new Date(Date.now() + TRIAL_LIMITS.durationDays * 24 * 60 * 60 * 1000);

    const { rows: tenantRows } = await client.query(
      `INSERT INTO tenants (name, slug, status, plan, trial_started_at, trial_expires_at)
       VALUES ($1, $2, 'pending', $3, NOW(), $4)
       RETURNING id`,
      [name, slug, plan, trialExpiresAt.toISOString()],
    );
    const tenantId = tenantRows[0].id as string;

    const passwordHash = await bcrypt.hash(password, 12);
    const emailVerificationToken = crypto.randomBytes(32).toString('hex');

    const { rows: userRows } = await client.query(
      `INSERT INTO users (tenant_id, email, first_name, password_hash, role, is_active, email_verified, email_verification_token, email_verification_sent_at)
       VALUES ($1, $2, $3, $4, 'admin', TRUE, FALSE, $5, NOW())
       RETURNING id`,
      [tenantId, email.toLowerCase(), name, passwordHash, emailVerificationToken],
    );
    const userId = userRows[0].id as string;

    await client.query(
      `INSERT INTO user_roles (user_id, tenant_id, role)
       VALUES ($1, $2, 'tenant_owner')`,
      [userId, tenantId],
    );

    await client.query('COMMIT');

    let checkoutUrl: string | null = null;
    try {
      const stripe = getStripeClient();
      const priceId = getPlanPriceId(plan as PlanTier);

      const isProd = (process.env.APP_ENV ?? process.env.NODE_ENV ?? '').startsWith('prod') || process.env.APP_ENV === 'staging';
      const baseUrl = process.env.APP_URL ?? (isProd ? '' : `https://${process.env.REPLIT_DEV_DOMAIN ?? 'localhost:5173'}`);
      if (isProd && !baseUrl) {
        throw new Error('APP_URL is required in production for Stripe checkout redirects');
      }

      const session = await stripe.checkout.sessions.create({
        mode: 'subscription',
        line_items: [{ price: priceId, quantity: 1 }],
        metadata: { tenantId, userId, plan },
        success_url: `${baseUrl}/onboarding?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${baseUrl}/login?cancelled=true`,
        customer_email: email.toLowerCase(),
      });
      checkoutUrl = session.url;
    } catch (stripeErr) {
      logger.error('Stripe checkout session creation failed, cleaning up', { tenantId, error: String(stripeErr) });
      const cleanupClient = await pool.connect();
      try {
        await cleanupClient.query('BEGIN');
        await cleanupClient.query(`SET LOCAL row_security = off`);
        await cleanupClient.query(`DELETE FROM user_roles WHERE user_id = $1`, [userId]);
        await cleanupClient.query(`DELETE FROM users WHERE id = $1`, [userId]);
        await cleanupClient.query(`DELETE FROM tenants WHERE id = $1`, [tenantId]);
        await cleanupClient.query('COMMIT');
      } catch (cleanupErr) {
        await cleanupClient.query('ROLLBACK').catch(() => {});
        logger.error('Cleanup after failed Stripe session also failed', { tenantId, error: String(cleanupErr) });
      } finally {
        cleanupClient.release();
      }
      return res.status(502).json({ error: 'Failed to create checkout session. Please try again.' });
    }

    const token = issueToken({
      userId,
      tenantId,
      email: email.toLowerCase(),
      role: 'tenant_owner',
      isPlatformAdmin: false,
    });

    const isProd = (process.env.APP_ENV ?? process.env.NODE_ENV ?? '').startsWith('prod');
    res.cookie('auth_token', token, {
      httpOnly: true,
      secure: isProd,
      sameSite: 'lax',
      maxAge: 8 * 60 * 60 * 1000,
      path: '/',
    });

    logger.info('Signup initiated', { tenantId, userId, emailVerificationRequired: true });

    try {
      const { sendEmail, emailVerificationEmail } = await import('../../../platform/email');
      const appUrl = process.env.APP_URL ?? `https://${process.env.REPLIT_DEV_DOMAIN ?? 'localhost:5173'}`;
      const verificationUrl = `${appUrl}/auth/verify-email?token=${emailVerificationToken}`;
      const emailContent = emailVerificationEmail({ verificationUrl, name });
      await sendEmail({ to: email.toLowerCase(), ...emailContent });
    } catch (emailErr) {
      logger.error('Failed to send verification email', { userId, error: String(emailErr) });
    }

    return res.status(201).json({
      checkoutUrl,
      token,
      tenantId,
      userId,
      emailVerificationRequired: true,
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    logger.error('Signup failed', { error: String(err) });
    return res.status(500).json({ error: 'Signup failed' });
  } finally {
    client.release();
  }
});

router.post('/auth/verify-email', async (req, res) => {
  const { token } = req.body as { token?: string };
  if (!token) {
    return res.status(400).json({ error: 'Verification token is required' });
  }

  const pool = getPlatformPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL row_security = off`);

    const { rows } = await client.query(
      `SELECT id, tenant_id FROM users WHERE email_verification_token = $1`,
      [token],
    );

    if (rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Invalid or expired verification token' });
    }

    const userId = rows[0].id as string;
    const tenantId = rows[0].tenant_id as string;

    await client.query(
      `UPDATE users SET email_verified = TRUE, email_verification_token = NULL, updated_at = NOW() WHERE id = $1`,
      [userId],
    );

    await client.query(
      `UPDATE tenants SET status = 'active', updated_at = NOW() WHERE id = $1 AND status = 'pending'`,
      [tenantId],
    );

    await client.query('COMMIT');

    logger.info('Email verified', { userId, tenantId });
    return res.json({ verified: true, tenantId });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    logger.error('Email verification failed', { error: String(err) });
    return res.status(500).json({ error: 'Verification failed' });
  } finally {
    client.release();
  }
});

router.post('/auth/resend-verification', requireAuth, async (req, res) => {
  const { userId, tenantId } = req.user!;
  const pool = getPlatformPool();

  try {
    const newToken = crypto.randomBytes(32).toString('hex');
    await pool.query(
      `UPDATE users SET email_verification_token = $1, email_verification_sent_at = NOW() WHERE id = $2`,
      [newToken, userId],
    );

    try {
      const { sendEmail, emailVerificationEmail } = await import('../../../platform/email');
      const { rows: userEmailRows } = await pool.query(`SELECT email, first_name FROM users WHERE id = $1`, [userId]);
      if (userEmailRows.length > 0) {
        const appUrl = process.env.APP_URL ?? `https://${process.env.REPLIT_DEV_DOMAIN ?? 'localhost:5173'}`;
        const verificationUrl = `${appUrl}/auth/verify-email?token=${newToken}`;
        const emailContent = emailVerificationEmail({ verificationUrl, name: userEmailRows[0].first_name as string });
        await sendEmail({ to: userEmailRows[0].email as string, ...emailContent });
      }
    } catch (emailErr) {
      logger.error('Failed to send verification email on resend', { userId, error: String(emailErr) });
    }

    logger.info('Verification email resent', { userId, tenantId });
    return res.json({ sent: true });
  } catch (err) {
    logger.error('Failed to resend verification', { userId, error: String(err) });
    return res.status(500).json({ error: 'Failed to resend verification email' });
  }
});

router.post('/auth/send-phone-verification', requireAuth, async (req, res) => {
  const { userId, tenantId } = req.user!;
  const { phoneNumber } = req.body as { phoneNumber?: string };

  if (!phoneNumber) {
    return res.status(400).json({ error: 'phoneNumber is required' });
  }

  const cleaned = phoneNumber.replace(/[^+\d]/g, '');
  if (cleaned.length < 10) {
    return res.status(400).json({ error: 'Invalid phone number format' });
  }

  const code = String(Math.floor(100000 + Math.random() * 900000));
  const pool = getPlatformPool();

  try {
    await pool.query(
      `UPDATE users SET phone_number = $1, phone_verification_code = $2, phone_verification_sent_at = NOW(), phone_verified = FALSE WHERE id = $3`,
      [cleaned, code, userId],
    );

    try {
      const { default: twilio } = await import('twilio');
      const twilioClient = twilio(
        process.env.TWILIO_ACCOUNT_SID,
        process.env.TWILIO_AUTH_TOKEN,
      );
      await twilioClient.messages.create({
        body: `Your verification code is: ${code}`,
        from: process.env.TWILIO_PHONE_NUMBER,
        to: cleaned,
      });
      logger.info('Phone verification SMS sent', { userId, phone: cleaned.slice(-4) });
    } catch (smsErr) {
      logger.warn('Failed to send SMS, code stored for manual verification', { userId, error: String(smsErr) });
    }

    return res.json({ sent: true, phoneNumber: cleaned });
  } catch (err) {
    logger.error('Failed to initiate phone verification', { userId, error: String(err) });
    return res.status(500).json({ error: 'Failed to send verification code' });
  }
});

const phoneVerifyAttempts = new Map<string, { count: number; lockedUntil: number }>();
const PHONE_VERIFY_MAX_ATTEMPTS = 5;
const PHONE_VERIFY_LOCKOUT_MS = 15 * 60 * 1000;

router.post('/auth/verify-phone', requireAuth, async (req, res) => {
  const { userId, tenantId } = req.user!;
  const { code } = req.body as { code?: string };

  if (!code) {
    return res.status(400).json({ error: 'Verification code is required' });
  }

  const entry = phoneVerifyAttempts.get(userId);
  if (entry && entry.lockedUntil > Date.now()) {
    const remainMin = Math.ceil((entry.lockedUntil - Date.now()) / 60000);
    return res.status(429).json({ error: `Too many attempts. Try again in ${remainMin} minute(s).` });
  }

  const pool = getPlatformPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL row_security = off`);

    const { rows } = await client.query(
      `SELECT phone_verification_code, phone_verification_sent_at FROM users WHERE id = $1`,
      [userId],
    );

    if (rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'User not found' });
    }

    const storedCode = rows[0].phone_verification_code as string | null;
    const sentAt = rows[0].phone_verification_sent_at as string | null;

    if (!storedCode || storedCode !== code) {
      await client.query('ROLLBACK');
      const attempt = phoneVerifyAttempts.get(userId) ?? { count: 0, lockedUntil: 0 };
      attempt.count += 1;
      if (attempt.count >= PHONE_VERIFY_MAX_ATTEMPTS) {
        attempt.lockedUntil = Date.now() + PHONE_VERIFY_LOCKOUT_MS;
        attempt.count = 0;
        phoneVerifyAttempts.set(userId, attempt);
        return res.status(429).json({ error: 'Too many failed attempts. Account locked for 15 minutes.' });
      }
      phoneVerifyAttempts.set(userId, attempt);
      return res.status(400).json({ error: 'Invalid verification code' });
    }

    if (sentAt) {
      const sentTime = new Date(sentAt).getTime();
      const now = Date.now();
      if (now - sentTime > 10 * 60 * 1000) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Verification code has expired. Please request a new one.' });
      }
    }

    await client.query(
      `UPDATE users SET phone_verified = TRUE, phone_verification_code = NULL, updated_at = NOW() WHERE id = $1`,
      [userId],
    );

    await client.query('COMMIT');
    phoneVerifyAttempts.delete(userId);
    logger.info('Phone verified', { userId, tenantId });
    return res.json({ verified: true });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    logger.error('Phone verification failed', { userId, error: String(err) });
    return res.status(500).json({ error: 'Verification failed' });
  } finally {
    client.release();
  }
});

router.get('/auth/verification-status', requireAuth, async (req, res) => {
  const { userId } = req.user!;
  const pool = getPlatformPool();

  try {
    const { rows } = await pool.query(
      `SELECT email_verified, phone_verified, phone_number FROM users WHERE id = $1`,
      [userId],
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    return res.json({
      emailVerified: (rows[0].email_verified as boolean) ?? false,
      phoneVerified: (rows[0].phone_verified as boolean) ?? false,
      phoneNumber: rows[0].phone_number ?? null,
    });
  } catch (err) {
    logger.error('Failed to get verification status', { userId, error: String(err) });
    return res.status(500).json({ error: 'Failed to get verification status' });
  }
});

router.get('/auth/invite-info', async (req, res) => {
  const { token } = req.query as { token?: string };
  if (!token) return res.status(400).json({ error: 'token is required' });

  const pool = getPlatformPool();
  try {
    const { rows } = await pool.query(
      `SELECT ui.email, ui.role, ui.expires_at, ui.accepted_at,
              t.name AS tenant_name,
              inv.email AS inviter_email
       FROM user_invitations ui
       LEFT JOIN tenants t ON t.id = ui.tenant_id
       LEFT JOIN users inv ON inv.id = ui.invited_by
       WHERE ui.token = $1`,
      [token],
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Invitation not found' });
    }

    const inv = rows[0];
    if (inv.accepted_at) {
      return res.status(410).json({ error: 'This invitation has already been accepted' });
    }
    if (new Date(inv.expires_at as string) < new Date()) {
      return res.status(410).json({ error: 'This invitation has expired' });
    }

    return res.json({
      email: inv.email,
      role: inv.role,
      tenantName: inv.tenant_name ?? 'Organization',
      inviterEmail: inv.inviter_email ?? '',
      expiresAt: inv.expires_at,
    });
  } catch (err) {
    logger.error('Failed to fetch invite info', { error: String(err) });
    return res.status(500).json({ error: 'Failed to fetch invitation' });
  }
});

router.post('/auth/accept-invite', async (req, res) => {
  const { token, password } = req.body as { token?: string; password?: string };
  if (!token || !password) {
    return res.status(400).json({ error: 'token and password are required' });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }

  const pool = getPlatformPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const { rows } = await client.query(
      `SELECT ui.id, ui.email, ui.role, ui.tenant_id, ui.expires_at, ui.accepted_at
       FROM user_invitations ui
       WHERE ui.token = $1
       FOR UPDATE`,
      [token],
    );

    if (rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Invitation not found' });
    }

    const inv = rows[0];
    if (inv.accepted_at) {
      await client.query('ROLLBACK');
      return res.status(410).json({ error: 'This invitation has already been accepted' });
    }
    if (new Date(inv.expires_at as string) < new Date()) {
      await client.query('ROLLBACK');
      return res.status(410).json({ error: 'This invitation has expired' });
    }

    const passwordHash = await bcrypt.hash(password, 12);

    await client.query(
      `UPDATE users SET password_hash = $1, email_verified = true, is_active = true, updated_at = NOW()
       WHERE email = $2`,
      [passwordHash, (inv.email as string).toLowerCase()],
    );

    await client.query(
      `UPDATE user_invitations SET accepted_at = NOW() WHERE id = $1`,
      [inv.id],
    );

    await client.query('COMMIT');

    const { rows: userRows } = await pool.query(
      `SELECT u.id, u.email, u.is_platform_admin, ur.role, ur.tenant_id
       FROM users u
       JOIN user_roles ur ON ur.user_id = u.id AND ur.tenant_id = $1
       WHERE u.email = $2
       LIMIT 1`,
      [inv.tenant_id, (inv.email as string).toLowerCase()],
    );

    if (userRows.length === 0) {
      return res.status(500).json({ error: 'Failed to resolve user after invitation acceptance' });
    }

    const user = userRows[0];

    await pool.query(`UPDATE users SET last_login_at = NOW() WHERE id = $1`, [user.id]);

    const jwt = issueToken({
      userId: user.id as string,
      tenantId: user.tenant_id as string,
      email: user.email as string,
      role: user.role as string,
      isPlatformAdmin: (user.is_platform_admin as boolean) ?? false,
    });

    const isProd = (process.env.APP_ENV ?? process.env.NODE_ENV ?? '').startsWith('prod');
    res.cookie('auth_token', jwt, {
      httpOnly: true,
      secure: isProd,
      sameSite: 'lax',
      maxAge: 8 * 60 * 60 * 1000,
      path: '/',
    });

    logger.info('Invitation accepted', { userId: user.id, tenantId: user.tenant_id, email: user.email });

    await writeAuditLog({
      tenantId: user.tenant_id as string,
      actorUserId: user.id as string,
      actorRole: user.role as string,
      action: 'user.invitation_accepted',
      resourceType: 'user',
      resourceId: user.id as string,
      ipAddress: extractIp(req),
      userAgent: req.headers['user-agent'],
    });

    return res.json({
      token: jwt,
      userId: user.id,
      email: user.email,
      role: user.role,
      tenantId: user.tenant_id,
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    logger.error('Failed to accept invitation', { error: String(err) });
    return res.status(500).json({ error: 'Failed to accept invitation' });
  } finally {
    client.release();
  }
});

router.post('/auth/refresh', requireAuth, (req, res) => {
  const user = req.user!;
  const token = issueToken(user);
  return res.json({ token });
});

router.get('/auth/me', requireAuth, (req, res) => {
  return res.json({ user: req.user });
});

export default router;
