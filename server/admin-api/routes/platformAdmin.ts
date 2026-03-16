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

router.get('/platform/template-analytics', requireAuth, requirePlatformAdmin, async (_req, res) => {
  try {
    const analytics = await withPrivilegedClient(async (client) => {
      const { rows } = await client.query(`
        SELECT
          tr.id,
          tr.slug,
          tr.display_name,
          tr.current_version,
          tr.status,
          tr.install_count,
          (SELECT COUNT(*) FROM tenant_agent_installations tai WHERE tai.template_id = tr.id AND tai.status = 'active') AS active_installs,
          (SELECT COUNT(*) FROM tenant_agent_installations tai WHERE tai.template_id = tr.id) AS total_installs,
          (SELECT COUNT(*) FROM template_install_events tie WHERE tie.template_id = tr.id AND tie.event_type = 'uninstalled') AS uninstall_count,
          (SELECT COUNT(*) FROM template_install_events tie WHERE tie.template_id = tr.id AND tie.event_type = 'upgraded') AS upgrade_count,
          (SELECT COUNT(DISTINCT cs.id) FROM tenant_agent_installations tai
            JOIN call_sessions cs ON cs.agent_id = tai.agent_id AND cs.tenant_id = tai.tenant_id
            WHERE tai.template_id = tr.id) AS total_calls,
          (SELECT COUNT(DISTINCT cs.id) FROM tenant_agent_installations tai
            JOIN call_sessions cs ON cs.agent_id = tai.agent_id AND cs.tenant_id = tai.tenant_id
            WHERE tai.template_id = tr.id AND cs.created_at > NOW() - INTERVAL '30 days') AS calls_last_30d,
          (SELECT COALESCE(AVG(cs.duration_seconds), 0) FROM tenant_agent_installations tai
            JOIN call_sessions cs ON cs.agent_id = tai.agent_id AND cs.tenant_id = tai.tenant_id
            WHERE tai.template_id = tr.id AND cs.duration_seconds > 0) AS avg_call_duration,
          (SELECT COALESCE(AVG(cs.customer_satisfaction_score), 0) FROM tenant_agent_installations tai
            JOIN call_sessions cs ON cs.agent_id = tai.agent_id AND cs.tenant_id = tai.tenant_id
            WHERE tai.template_id = tr.id AND cs.customer_satisfaction_score IS NOT NULL) AS avg_satisfaction,
          (SELECT COUNT(DISTINCT c.id) FROM tenant_agent_installations tai
            JOIN campaigns c ON c.agent_id = tai.agent_id AND c.tenant_id = tai.tenant_id
            WHERE tai.template_id = tr.id) AS total_campaigns,
          (SELECT COUNT(DISTINCT c.id) FROM tenant_agent_installations tai
            JOIN campaigns c ON c.agent_id = tai.agent_id AND c.tenant_id = tai.tenant_id
            WHERE tai.template_id = tr.id AND c.status = 'completed') AS completed_campaigns
        FROM template_registry tr
        WHERE tr.status IN ('active', 'draft')
        ORDER BY tr.install_count DESC, tr.display_name ASC
      `);
      return rows;
    });

    const templates = analytics.map((row: Record<string, unknown>) => {
      const totalInstalls = parseInt(String(row.total_installs), 10) || 0;
      const activeInstalls = parseInt(String(row.active_installs), 10) || 0;
      const uninstallCount = parseInt(String(row.uninstall_count), 10) || 0;
      const upgradeCount = parseInt(String(row.upgrade_count), 10) || 0;

      const activationRate = totalInstalls > 0 ? Math.min(100, Math.round((activeInstalls / totalInstalls) * 100)) : 0;
      const uninstallRate = totalInstalls > 0 ? Math.min(100, Math.round((uninstallCount / totalInstalls) * 100)) : 0;
      const upgradeAdoption = totalInstalls > 0 ? Math.min(100, Math.round((upgradeCount / totalInstalls) * 100)) : 0;

      return {
        id: row.id,
        slug: row.slug,
        displayName: row.display_name,
        currentVersion: row.current_version,
        status: row.status,
        installCount: parseInt(String(row.install_count), 10) || 0,
        activeInstalls,
        totalInstalls,
        uninstallCount,
        upgradeCount,
        activationRate,
        uninstallRate,
        upgradeAdoption,
        totalCalls: parseInt(String(row.total_calls), 10) || 0,
        callsLast30d: parseInt(String(row.calls_last_30d), 10) || 0,
        avgCallDuration: Math.round(parseFloat(String(row.avg_call_duration)) || 0),
        avgSatisfaction: parseFloat(parseFloat(String(row.avg_satisfaction) || '0').toFixed(1)),
        totalCampaigns: parseInt(String(row.total_campaigns), 10) || 0,
        completedCampaigns: parseInt(String(row.completed_campaigns), 10) || 0,
      };
    });

    return res.json({ templates });
  } catch (err) {
    logger.error('Failed to get template analytics', { error: String(err) });
    return res.status(500).json({ error: 'Failed to get template analytics' });
  }
});

export default router;
