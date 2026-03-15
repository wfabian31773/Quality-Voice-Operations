import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { getPlatformPool, withTenantContext } from '../../../platform/db';
import { requireAuth } from '../middleware/auth';
import { requireRole, simpleToDatabaseRole, dbRoleToSimple, type SimpleRole } from '../middleware/rbac';
import { createLogger } from '../../../platform/core/logger';
import { writeAuditLog, extractIp } from '../../../platform/audit/AuditService';

const router = Router();
const logger = createLogger('ADMIN_USERS');

const VALID_SIMPLE_ROLES = ['member', 'admin', 'owner'] as const;

function paginate(req: { query: Record<string, unknown> }): { limit: number; offset: number } {
  const limit = Math.min(parseInt(String(req.query.limit ?? '20'), 10), 100);
  const page = Math.max(parseInt(String(req.query.page ?? '1'), 10), 1);
  return { limit, offset: (page - 1) * limit };
}

router.get('/users', requireAuth, requireRole('admin'), async (req, res) => {
  const { tenantId } = req.user!;
  const { limit, offset } = paginate(req);
  const pool = getPlatformPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await withTenantContext(client, tenantId, async () => {});

    const { rows } = await client.query(
      `SELECT u.id, u.email, u.first_name, u.last_name, u.is_active,
              u.email_verified, u.last_login_at, u.created_at,
              ur.role
       FROM users u
       JOIN user_roles ur ON ur.user_id = u.id AND ur.tenant_id = $1
       ORDER BY u.created_at DESC
       LIMIT $2 OFFSET $3`,
      [tenantId, limit, offset],
    );

    const { rows: countRows } = await client.query(
      `SELECT COUNT(*) AS total FROM user_roles WHERE tenant_id = $1`,
      [tenantId],
    );
    await client.query('COMMIT');

    const mappedUsers = rows.map((row) => ({
      ...row,
      role: dbRoleToSimple(row.role as string),
    }));

    return res.json({ users: mappedUsers, total: parseInt(countRows[0].total as string), limit, offset });
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error('Failed to list users', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to list users' });
  } finally {
    client.release();
  }
});

router.post('/users/invite', requireAuth, requireRole('admin'), async (req, res) => {
  const { tenantId } = req.user!;
  const { email, role = 'member', first_name, last_name, password } = req.body as {
    email?: string;
    role?: string;
    first_name?: string;
    last_name?: string;
    password?: string;
  };

  if (!email) return res.status(400).json({ error: 'email is required' });
  if (!VALID_SIMPLE_ROLES.includes(role as (typeof VALID_SIMPLE_ROLES)[number])) {
    return res.status(400).json({ error: `role must be one of: ${VALID_SIMPLE_ROLES.join(', ')}` });
  }

  const pool = getPlatformPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await withTenantContext(client, tenantId, async () => {});

    const passwordHash = password ? await bcrypt.hash(password, 12) : null;

    const dbRole = simpleToDatabaseRole(role as SimpleRole);

    const { rows: [user] } = await client.query(
      `INSERT INTO users (email, first_name, last_name, password_hash, role, tenant_id)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (email) DO UPDATE SET
         first_name = COALESCE(EXCLUDED.first_name, users.first_name),
         last_name = COALESCE(EXCLUDED.last_name, users.last_name),
         updated_at = NOW()
       RETURNING id, email, first_name, last_name, created_at`,
      [email.toLowerCase(), first_name ?? null, last_name ?? null, passwordHash, dbRole, tenantId],
    );

    await client.query(
      `INSERT INTO user_roles (tenant_id, user_id, role)
       VALUES ($1, $2, $3::tenant_role)
       ON CONFLICT (tenant_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
      [tenantId, user.id, dbRole],
    );

    await client.query('COMMIT');
    logger.info('User invited', { tenantId, userId: user.id, email: user.email });
    return res.status(201).json({ user: { ...user, role } });
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error('Failed to invite user', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to invite user' });
  } finally {
    client.release();
  }
});

router.patch('/users/:id/role', requireAuth, requireRole('admin'), async (req, res) => {
  const { tenantId, userId: requestingUserId } = req.user!;
  const { id } = req.params;
  const { role } = req.body as { role?: string };

  if (!role || !VALID_SIMPLE_ROLES.includes(role as (typeof VALID_SIMPLE_ROLES)[number])) {
    return res.status(400).json({ error: `role must be one of: ${VALID_SIMPLE_ROLES.join(', ')}` });
  }

  if (id === requestingUserId) {
    return res.status(400).json({ error: 'Cannot change your own role' });
  }

  const pool = getPlatformPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await withTenantContext(client, tenantId, async () => {});

    const dbRole = simpleToDatabaseRole(role as SimpleRole);
    const { rowCount } = await client.query(
      `UPDATE user_roles SET role = $1::tenant_role WHERE tenant_id = $2 AND user_id = $3`,
      [dbRole, tenantId, id],
    );
    await client.query('COMMIT');

    if (!rowCount) return res.status(404).json({ error: 'User not found in this tenant' });

    writeAuditLog({
      tenantId,
      actorUserId: requestingUserId,
      actorRole: req.user!.role,
      action: 'user.role_changed',
      resourceType: 'user',
      resourceId: id,
      changes: { newRole: role },
      ipAddress: extractIp(req),
      userAgent: req.headers['user-agent'],
    });

    logger.info('User role updated', { tenantId, userId: id, newRole: role });
    return res.json({ updated: true, role });
  } catch (err) {
    await client.query('ROLLBACK');
    return res.status(500).json({ error: 'Failed to update user role' });
  } finally {
    client.release();
  }
});

export default router;
