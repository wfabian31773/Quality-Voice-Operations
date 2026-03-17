import { Router } from 'express';
import { getPlatformPool, withTenantContext } from '../../../platform/db';
import { requireAuth } from '../middleware/auth';
import { requireRole } from '../middleware/rbac';
import { createLogger } from '../../../platform/core/logger';

const router = Router();
const logger = createLogger('ADMIN_AUDIT');

router.get('/audit-log', requireAuth, requireRole('manager'), async (req, res) => {
  const { tenantId } = req.user!;
  const action = req.query.action as string | undefined;
  const userId = req.query.userId as string | undefined;
  const since = req.query.since as string | undefined;
  const until = req.query.until as string | undefined;
  const limit = Math.min(parseInt(String(req.query.limit ?? '50'), 10), 100);
  const page = Math.max(parseInt(String(req.query.page ?? '1'), 10), 1);
  const offset = (page - 1) * limit;

  const pool = getPlatformPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await withTenantContext(client, tenantId, async () => {});

    const conditions = ['a.tenant_id = $1'];
    const values: unknown[] = [tenantId];
    let paramIdx = 2;

    if (action) {
      conditions.push(`a.action = $${paramIdx}`);
      values.push(action);
      paramIdx++;
    }
    if (userId) {
      conditions.push(`a.actor_user_id = $${paramIdx}`);
      values.push(userId);
      paramIdx++;
    }
    if (since) {
      conditions.push(`a.occurred_at >= $${paramIdx}`);
      values.push(since);
      paramIdx++;
    }
    if (until) {
      conditions.push(`a.occurred_at <= $${paramIdx}`);
      values.push(until);
      paramIdx++;
    }

    const where = conditions.join(' AND ');

    const { rows } = await client.query(
      `SELECT a.id, a.action, a.resource_type, a.resource_id, a.changes,
              a.before_state, a.after_state, a.severity,
              a.ip_address, a.occurred_at,
              a.actor_user_id, a.actor_role,
              u.email AS actor_email
       FROM audit_logs a
       LEFT JOIN users u ON u.id = a.actor_user_id
       WHERE ${where}
       ORDER BY a.occurred_at DESC
       LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`,
      [...values, limit, offset],
    );

    const { rows: countRows } = await client.query(
      `SELECT COUNT(*) AS total FROM audit_logs a WHERE ${where}`,
      values,
    );
    await client.query('COMMIT');

    return res.json({
      events: rows,
      total: parseInt(countRows[0].total as string),
      page,
      limit,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error('Failed to query audit logs', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to query audit logs' });
  } finally {
    client.release();
  }
});

export default router;
