import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { requirePlatformAdmin } from '../middleware/rbac';
import { withPrivilegedClient } from '../../../platform/db';
import { createLogger } from '../../../platform/core/logger';

const router = Router();
const logger = createLogger('PLATFORM_ADMIN');

router.get('/platform/tenants', requireAuth, requirePlatformAdmin, async (_req, res) => {
  try {
    const tenants = await withPrivilegedClient(async (client) => {
      const { rows } = await client.query(`
        SELECT
          t.id, t.name, t.slug, t.status, t.plan, t.created_at, t.updated_at,
          (SELECT COUNT(*) FROM user_roles ur WHERE ur.tenant_id = t.id) AS user_count,
          (SELECT COUNT(*) FROM call_sessions cs WHERE cs.tenant_id = t.id) AS total_calls,
          (SELECT MAX(cs.created_at) FROM call_sessions cs WHERE cs.tenant_id = t.id) AS last_call_at,
          (SELECT COUNT(*) FROM call_sessions cs
           WHERE cs.tenant_id = t.id
             AND cs.created_at > NOW() - INTERVAL '30 days') AS calls_last_30d
        FROM tenants t
        ORDER BY t.created_at DESC
      `);
      return rows;
    });

    return res.json({ tenants });
  } catch (err) {
    logger.error('Failed to list tenants for platform admin', { error: String(err) });
    return res.status(500).json({ error: 'Failed to list tenants' });
  }
});

router.get('/platform/tenants/:id', requireAuth, requirePlatformAdmin, async (req, res) => {
  const { id } = req.params;
  try {
    const tenant = await withPrivilegedClient(async (client) => {
      const { rows } = await client.query(`
        SELECT
          t.id, t.name, t.slug, t.status, t.plan, t.created_at, t.updated_at,
          (SELECT COUNT(*) FROM user_roles ur WHERE ur.tenant_id = t.id) AS user_count,
          (SELECT COUNT(*) FROM agents a WHERE a.tenant_id = t.id) AS agent_count,
          (SELECT COUNT(*) FROM phone_numbers pn WHERE pn.tenant_id = t.id) AS phone_number_count,
          (SELECT COUNT(*) FROM call_sessions cs WHERE cs.tenant_id = t.id) AS total_calls,
          (SELECT COALESCE(SUM(cs.total_cost_cents), 0) FROM call_sessions cs WHERE cs.tenant_id = t.id) AS total_cost_cents
        FROM tenants t
        WHERE t.id = $1
      `, [id]);
      return rows[0] ?? null;
    });

    if (!tenant) return res.status(404).json({ error: 'Tenant not found' });
    return res.json({ tenant });
  } catch (err) {
    logger.error('Failed to get tenant details', { tenantId: id, error: String(err) });
    return res.status(500).json({ error: 'Failed to get tenant details' });
  }
});

router.get('/platform/stats', requireAuth, requirePlatformAdmin, async (_req, res) => {
  try {
    const stats = await withPrivilegedClient(async (client) => {
      const { rows: [summary] } = await client.query(`
        SELECT
          (SELECT COUNT(*) FROM tenants WHERE status = 'active') AS active_tenants,
          (SELECT COUNT(*) FROM tenants) AS total_tenants,
          (SELECT COUNT(*) FROM users WHERE is_active = true) AS total_users,
          (SELECT COUNT(*) FROM call_sessions) AS total_calls,
          (SELECT COUNT(*) FROM call_sessions WHERE created_at > NOW() - INTERVAL '30 days') AS calls_last_30d,
          (SELECT COUNT(*) FROM call_sessions WHERE created_at > NOW() - INTERVAL '24 hours') AS calls_last_24h,
          (SELECT COALESCE(SUM(total_cost_cents), 0) FROM call_sessions) AS total_revenue_cents,
          (SELECT COALESCE(SUM(total_cost_cents), 0) FROM call_sessions WHERE created_at > NOW() - INTERVAL '30 days') AS revenue_last_30d_cents
      `);
      return summary;
    });

    return res.json({ stats });
  } catch (err) {
    logger.error('Failed to get platform stats', { error: String(err) });
    return res.status(500).json({ error: 'Failed to get platform stats' });
  }
});

router.patch('/platform/tenants/:id/status', requireAuth, requirePlatformAdmin, async (req, res) => {
  const { id } = req.params;
  const { status } = req.body as { status?: string };

  if (!status || !['active', 'suspended'].includes(status)) {
    return res.status(400).json({ error: 'status must be "active" or "suspended"' });
  }

  try {
    const result = await withPrivilegedClient(async (client) => {
      const { rows, rowCount } = await client.query(
        `UPDATE tenants SET status = $1, updated_at = NOW() WHERE id = $2 RETURNING id, name, status`,
        [status, id],
      );
      return { rows, rowCount };
    });

    if (!result.rowCount) return res.status(404).json({ error: 'Tenant not found' });

    logger.info('Tenant status updated by platform admin', { tenantId: id, newStatus: status, adminUserId: req.user!.userId });
    return res.json({ tenant: result.rows[0] });
  } catch (err) {
    logger.error('Failed to update tenant status', { tenantId: id, error: String(err) });
    return res.status(500).json({ error: 'Failed to update tenant status' });
  }
});

export default router;
