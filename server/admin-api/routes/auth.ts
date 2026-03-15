import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { getPlatformPool } from '../../../platform/db';
import { issueToken, requireAuth } from '../middleware/auth';
import { createLogger } from '../../../platform/core/logger';
import { getStripeClient } from '../../../platform/billing/stripe/client';
import { getPlanPriceId, type PlanTier } from '../../../platform/billing/stripe/plans';
import { writeAuditLog, extractIp } from '../../../platform/audit/AuditService';

const router = Router();
const logger = createLogger('ADMIN_AUTH_ROUTES');

const VALID_PLANS = new Set<string>(['starter', 'pro', 'enterprise']);

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

    writeAuditLog({
      tenantId: user.tenant_id as string,
      actorUserId: user.id as string,
      actorRole: user.role as string,
      action: 'user.login',
      resourceType: 'user',
      resourceId: user.id as string,
      ipAddress: extractIp(req),
      userAgent: req.headers['user-agent'],
    });

    return res.json({
      token,
      userId: user.id,
      email: user.email,
      role: user.role,
      tenantId: user.tenant_id,
      isPlatformAdmin: (user.is_platform_admin as boolean) ?? false,
    });
  } catch (err) {
    logger.error('Login error', { error: String(err) });
    return res.status(500).json({ error: 'Login failed' });
  } finally {
    client.release();
  }
});

router.post('/auth/signup', async (req, res) => {
  const { name, email, password, plan = 'starter' } = req.body as {
    name?: string;
    email?: string;
    password?: string;
    plan?: string;
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

    const { rows: tenantRows } = await client.query(
      `INSERT INTO tenants (name, slug, status, plan)
       VALUES ($1, $2, 'pending', $3)
       RETURNING id`,
      [name, slug, plan],
    );
    const tenantId = tenantRows[0].id as string;

    const passwordHash = await bcrypt.hash(password, 12);
    const { rows: userRows } = await client.query(
      `INSERT INTO users (tenant_id, email, first_name, password_hash, role, is_active)
       VALUES ($1, $2, $3, $4, 'admin', TRUE)
       RETURNING id`,
      [tenantId, email.toLowerCase(), name, passwordHash],
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

      const baseUrl = process.env.APP_BASE_URL ?? `https://${process.env.REPLIT_DEV_DOMAIN ?? 'localhost:5173'}`;

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

    logger.info('Signup initiated', { tenantId, userId });

    return res.status(201).json({
      checkoutUrl,
      token,
      tenantId,
      userId,
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    logger.error('Signup failed', { error: String(err) });
    return res.status(500).json({ error: 'Signup failed' });
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
