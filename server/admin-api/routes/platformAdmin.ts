import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { requirePlatformAdmin } from '../middleware/rbac';
import { withPrivilegedClient, getPlatformPool } from '../../../platform/db';
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

router.get('/platform/cost-monitoring', requireAuth, requirePlatformAdmin, async (_req, res) => {
  try {
    const data = await withPrivilegedClient(async (client) => {
      const { rows: [dailyStats] } = await client.query(`
        SELECT
          COALESCE(SUM(CASE WHEN metric_type = 'ai_minutes' THEN quantity ELSE 0 END), 0) AS daily_call_minutes,
          COALESCE(SUM(CASE WHEN metric_type = 'ai_minutes' THEN total_cost_cents ELSE 0 END), 0) AS daily_ai_cost_cents,
          COALESCE(SUM(CASE WHEN metric_type IN ('calls_inbound', 'calls_outbound') THEN total_cost_cents ELSE 0 END), 0) AS daily_twilio_cost_cents,
          COALESCE(SUM(CASE WHEN metric_type IN ('calls_inbound', 'calls_outbound') THEN quantity ELSE 0 END), 0) AS daily_call_count,
          COALESCE(SUM(CASE WHEN metric_type = 'sms_sent' THEN total_cost_cents ELSE 0 END), 0) AS daily_sms_cost_cents,
          COALESCE(SUM(CASE WHEN metric_type = 'tool_executions' THEN quantity ELSE 0 END), 0) AS daily_tool_executions,
          COALESCE(SUM(CASE WHEN metric_type = 'api_requests' THEN quantity ELSE 0 END), 0) AS daily_api_requests,
          COALESCE(SUM(total_cost_cents), 0) AS daily_total_cost_cents
        FROM usage_metrics
        WHERE period_start >= date_trunc('day', NOW())
      `);

      const { rows: [monthlyStats] } = await client.query(`
        SELECT
          COALESCE(SUM(CASE WHEN metric_type = 'ai_minutes' THEN quantity ELSE 0 END), 0) AS monthly_call_minutes,
          COALESCE(SUM(CASE WHEN metric_type IN ('calls_inbound', 'calls_outbound') THEN quantity ELSE 0 END), 0) AS monthly_call_count,
          COALESCE(SUM(total_cost_cents), 0) AS monthly_total_cost_cents,
          COALESCE(SUM(CASE WHEN metric_type = 'ai_minutes' THEN total_cost_cents ELSE 0 END), 0) AS monthly_ai_cost_cents,
          COALESCE(SUM(CASE WHEN metric_type IN ('calls_inbound', 'calls_outbound') THEN total_cost_cents ELSE 0 END), 0) AS monthly_twilio_cost_cents
        FROM usage_metrics
        WHERE period_start >= date_trunc('month', NOW())
      `);

      const { rows: [trialStats] } = await client.query(`
        SELECT
          COUNT(*) FILTER (WHERE s.status = 'trialing') AS active_trials,
          COUNT(*) FILTER (WHERE s.status = 'active') AS paid_accounts,
          COUNT(*) FILTER (WHERE s.status IN ('trialing', 'active', 'past_due', 'cancelled')) AS total_accounts
        FROM subscriptions s
      `);

      const totalAccounts = parseInt(String(trialStats.total_accounts), 10) || 0;
      const activeTrials = parseInt(String(trialStats.active_trials), 10) || 0;
      const paidAccounts = parseInt(String(trialStats.paid_accounts), 10) || 0;
      const conversionRate = totalAccounts > 0
        ? Math.round((paidAccounts / totalAccounts) * 100)
        : 0;

      const monthlyCallCount = parseInt(String(monthlyStats.monthly_call_count), 10) || 0;
      const monthlyTotalCostCents = parseInt(String(monthlyStats.monthly_total_cost_cents), 10) || 0;
      const costPerCall = monthlyCallCount > 0
        ? Math.round(monthlyTotalCostCents / monthlyCallCount)
        : 0;

      const { rows: [revenueStats] } = await client.query(`
        SELECT
          COALESCE(SUM(CASE WHEN event_type = 'invoice_paid' THEN amount_cents ELSE 0 END), 0) AS monthly_revenue_cents
        FROM billing_events
        WHERE created_at >= date_trunc('month', NOW())
      `);

      const monthlyRevenueCents = parseInt(String(revenueStats.monthly_revenue_cents), 10) || 0;
      const revenuePerCall = monthlyCallCount > 0
        ? Math.round(monthlyRevenueCents / monthlyCallCount)
        : 0;

      const { rows: dailyTrend } = await client.query(`
        SELECT
          date_trunc('day', period_start) AS day,
          COALESCE(SUM(CASE WHEN metric_type = 'ai_minutes' THEN quantity ELSE 0 END), 0) AS call_minutes,
          COALESCE(SUM(CASE WHEN metric_type IN ('calls_inbound', 'calls_outbound') THEN quantity ELSE 0 END), 0) AS call_count,
          COALESCE(SUM(total_cost_cents), 0) AS total_cost_cents
        FROM usage_metrics
        WHERE period_start >= NOW() - INTERVAL '30 days'
        GROUP BY date_trunc('day', period_start)
        ORDER BY day DESC
        LIMIT 30
      `);

      return {
        daily: {
          callMinutes: parseInt(String(dailyStats.daily_call_minutes), 10) || 0,
          aiCostCents: parseInt(String(dailyStats.daily_ai_cost_cents), 10) || 0,
          twilioCostCents: parseInt(String(dailyStats.daily_twilio_cost_cents), 10) || 0,
          smsCostCents: parseInt(String(dailyStats.daily_sms_cost_cents), 10) || 0,
          callCount: parseInt(String(dailyStats.daily_call_count), 10) || 0,
          toolExecutions: parseInt(String(dailyStats.daily_tool_executions), 10) || 0,
          apiRequests: parseInt(String(dailyStats.daily_api_requests), 10) || 0,
          totalCostCents: parseInt(String(dailyStats.daily_total_cost_cents), 10) || 0,
        },
        monthly: {
          callMinutes: parseInt(String(monthlyStats.monthly_call_minutes), 10) || 0,
          callCount: monthlyCallCount,
          totalCostCents: monthlyTotalCostCents,
          aiCostCents: parseInt(String(monthlyStats.monthly_ai_cost_cents), 10) || 0,
          twilioCostCents: parseInt(String(monthlyStats.monthly_twilio_cost_cents), 10) || 0,
          revenueCents: monthlyRevenueCents,
        },
        trials: {
          activeTrials,
          paidAccounts,
          totalAccounts,
          conversionRate,
        },
        economics: {
          costPerCallCents: costPerCall,
          revenuePerCallCents: revenuePerCall,
          marginPerCallCents: revenuePerCall - costPerCall,
        },
        trend: dailyTrend.map((row) => ({
          day: row.day,
          callMinutes: parseInt(String(row.call_minutes), 10) || 0,
          callCount: parseInt(String(row.call_count), 10) || 0,
          totalCostCents: parseInt(String(row.total_cost_cents), 10) || 0,
        })),
      };
    });

    return res.json({ monitoring: data });
  } catch (err) {
    logger.error('Failed to get cost monitoring data', { error: String(err) });
    return res.status(500).json({ error: 'Failed to get cost monitoring data' });
  }
});

router.get('/platform/notifications', requireAuth, async (req, res) => {
  const { tenantId } = req.user!;
  const pool = getPlatformPool();

  try {
    const { rows } = await pool.query(
      `SELECT id, type, title, message, metadata, read, created_at
       FROM tenant_notifications
       WHERE tenant_id = $1
       ORDER BY created_at DESC
       LIMIT 50`,
      [tenantId],
    );

    return res.json({ notifications: rows });
  } catch (err) {
    logger.error('Failed to get notifications', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to get notifications' });
  }
});

router.patch('/platform/notifications/:id/read', requireAuth, async (req, res) => {
  const { tenantId } = req.user!;
  const { id } = req.params;
  const pool = getPlatformPool();

  try {
    await pool.query(
      `UPDATE tenant_notifications SET read = TRUE WHERE id = $1 AND tenant_id = $2`,
      [id, tenantId],
    );
    return res.json({ success: true });
  } catch (err) {
    logger.error('Failed to mark notification read', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to update notification' });
  }
});

export default router;
