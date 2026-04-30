import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { requirePlatformAdmin } from '../middleware/rbac';
import { withPrivilegedClient, getPlatformPool } from '../../../platform/db';
import { createLogger } from '../../../platform/core/logger';
import { getAllTenantsActivationMetrics } from '../../../platform/activation/ActivationService';
import {
  getCallAnalytics,
  getCampaignAnalytics,
  getCostAnalytics,
} from '../../../platform/analytics';
import { getCampaign, getCampaignMetrics, listContacts } from '../../../platform/campaigns/CampaignService';
import { redactPHI } from '../../../platform/core/phi/redact';
import { getConversationCost } from '../../../platform/billing/cost';
import { getTenantBillingCurrency } from '../../../platform/billing/tenantCurrency';
import { PLAN_MONTHLY_PRICE_CENTS, type PlanTier } from '../../../platform/billing/stripe/plans';
import { listToolExecutions } from '../../../platform/tools/ToolExecutionService';
import {
  iterateLeadsForExport,
  listLeads,
  listLeadEvents,
  listLeadEventAuthors,
  updateLeadStatus,
  sendAlertMessage,
  type BookingStatusFilter,
  type LeadListItem,
  type LeadSource,
  type LeadStatus,
} from '../services/marketing-leads';
import {
  getSalesAlertSettings,
  setSalesAlertSettings,
  type SalesAlertSettingsPatch,
} from '../services/sales-alert-settings';
import {
  getDemoSchedulerSettings,
  setDemoSchedulerSettings,
  toAdminView,
  DemoSchedulerSettingsValidationError,
  type DemoSchedulerSettingsPatch,
  type SchedulerProvider,
} from '../services/demo-scheduler-settings';

const router = Router();
const logger = createLogger('PLATFORM_ADMIN');

router.get('/platform/tenants', requireAuth, requirePlatformAdmin, async (_req, res) => {
  try {
    const tenants = await withPrivilegedClient(async (client) => {
      // The `latest_owner` LATERAL join surfaces the most-recently granted
      // tenant_owner so the All Tenants table can show an Onboarding badge
      // without admins expanding each row (Task #994). The defensive
      // JSONB parsing matches `/platform/tenants/:id/onboarding` so a
      // corrupt legacy `users.preferences` row can't 500 the list.
      const { rows } = await client.query(`
        SELECT
          t.id, t.name, t.slug, t.status, t.plan, t.created_at, t.updated_at,
          (SELECT COUNT(*) FROM user_roles ur WHERE ur.tenant_id = t.id) AS user_count,
          (SELECT COUNT(*) FROM call_sessions cs WHERE cs.tenant_id = t.id) AS total_calls,
          (SELECT MAX(cs.created_at) FROM call_sessions cs WHERE cs.tenant_id = t.id) AS last_call_at,
          (SELECT COUNT(*) FROM call_sessions cs
           WHERE cs.tenant_id = t.id
             AND cs.created_at > NOW() - INTERVAL '30 days') AS calls_last_30d,
          latest_owner.onboarding_step AS latest_owner_onboarding_step,
          latest_owner.onboarding_completed AS latest_owner_onboarding_completed
        FROM tenants t
        LEFT JOIN LATERAL (
          SELECT
            -- COALESCE so a missing onboarding_completed key (or NULL
            -- preferences blob) projects FALSE rather than NULL. Without
            -- this, (LOWER(NULL) = 'true') evaluates to NULL and the
            -- client would suppress the badge for an owner that is
            -- actually still mid-onboarding -- exactly the stuck-signup
            -- case this column is supposed to surface.
            COALESCE(
              (LOWER(u.preferences->>'onboarding_completed') = 'true'),
              FALSE
            ) AS onboarding_completed,
            GREATEST(1, LEAST(3,
              CASE
                WHEN u.preferences->>'onboarding_step' ~ '^[0-9]+$'
                  THEN (u.preferences->>'onboarding_step')::int
                ELSE 1
              END
            )) AS onboarding_step
          FROM user_roles ur
          JOIN users u ON u.id = ur.user_id
          WHERE ur.tenant_id = t.id
            AND ur.role = 'tenant_owner'
            AND ur.revoked_at IS NULL
          ORDER BY ur.granted_at DESC NULLS LAST, u.created_at DESC
          LIMIT 1
        ) AS latest_owner ON TRUE
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
          (SELECT COALESCE(SUM(cs.total_cost_cents), 0) FROM call_sessions cs WHERE cs.tenant_id = t.id) AS total_cost_cents,
          (
            SELECT MAX(al.occurred_at)
            FROM audit_logs al
            WHERE al.tenant_id = t.id
              AND al.action IN ('billing.checkout_created', 'billing.downgrade_scheduled')
              AND al.changes->>'direction' = 'downgrade'
          ) AS last_downgrade_at
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

// Per-tenant onboarding progress for every owner user (Task #612).
//
// Surfaces `users.preferences.onboarding_step` + `onboarding_completed`
// (persisted by the wizard in `client-app/src/pages/Onboarding.tsx`) for
// each `tenant_owner` row in `user_roles`, joined to the active tenant.
// Used by the Platform Admin "Tenant Details" expander so support /
// product can see which owner stalled at which step. We deliberately
// scope to the `tenant_owner` role rather than every user — the rest of
// the org gets seated *after* onboarding finishes, so their preferences
// blob isn't a meaningful signal.
router.get('/platform/tenants/:id/onboarding', requireAuth, requirePlatformAdmin, async (req, res) => {
  const { id } = req.params;
  try {
    const owners = await withPrivilegedClient(async (client) => {
      const tenantRow = await client.query(
        `SELECT id FROM tenants WHERE id = $1`,
        [id],
      );
      if (!tenantRow.rows[0]) return null;
      const { rows } = await client.query(
        `SELECT
           u.id AS user_id,
           u.email,
           u.first_name,
           u.last_name,
           u.created_at,
           u.last_login_at,
           ur.granted_at AS role_granted_at,
           -- Whitelist 'true' (case-insensitive) only. Any other JSONB
           -- value (NULL, 'maybe', '1', '{}', etc.) degrades to FALSE so
           -- a corrupt legacy row can't 500 the endpoint by failing the
           -- ::boolean cast.
           (LOWER(u.preferences->>'onboarding_completed') = 'true') AS onboarding_completed,
           -- Defensive integer parse for the step. We only attempt the
           -- ::int cast when the value is a bare positive integer; any
           -- non-numeric / NULL / out-of-range value falls back to 1.
           -- The wizard already clamps to [1..3] on write, but we
           -- re-clamp here so a stale row written by an older client
           -- can't slip through.
           GREATEST(1, LEAST(3,
             CASE
               WHEN u.preferences->>'onboarding_step' ~ '^[0-9]+$'
                 THEN (u.preferences->>'onboarding_step')::int
               ELSE 1
             END
           )) AS onboarding_step
         FROM user_roles ur
         JOIN users u ON u.id = ur.user_id
         WHERE ur.tenant_id = $1
           AND ur.role = 'tenant_owner'
           AND ur.revoked_at IS NULL
         ORDER BY ur.granted_at ASC NULLS LAST, u.created_at ASC`,
        [id],
      );
      return rows;
    });

    if (owners === null) return res.status(404).json({ error: 'Tenant not found' });
    return res.json({ owners });
  } catch (err) {
    logger.error('Failed to get tenant onboarding state', { tenantId: id, error: String(err) });
    return res.status(500).json({ error: 'Failed to get tenant onboarding state' });
  }
});

router.get('/platform/tenants/:id/analytics', requireAuth, requirePlatformAdmin, async (req, res) => {
  const { id } = req.params;
  const range = String(req.query.range ?? '30d');
  let days = 30;
  if (range === '7d') days = 7;
  else if (range === '90d') days = 90;
  const to = new Date();
  const from = new Date(to.getTime() - days * 24 * 60 * 60 * 1000);

  try {
    const tenant = await withPrivilegedClient(async (client) => {
      const { rows } = await client.query(
        `SELECT id, name, slug, status, plan, COALESCE(billing_currency, 'usd') AS billing_currency
         FROM tenants WHERE id = $1`,
        [id],
      );
      return rows[0] ?? null;
    });
    if (!tenant) return res.status(404).json({ error: 'Tenant not found' });

    const [calls, campaigns, costs, currency] = await Promise.all([
      getCallAnalytics(id, from, to),
      getCampaignAnalytics(id, from, to),
      getCostAnalytics(id, from, to),
      getTenantBillingCurrency(id),
    ]);

    logger.info('Platform admin viewed tenant analytics', {
      tenantId: id,
      adminUserId: req.user!.userId,
      range,
    });

    return res.json({ tenant, range, calls, campaigns, costs, currency });
  } catch (err) {
    logger.error('Failed to fetch per-tenant analytics for admin', { tenantId: id, error: String(err) });
    return res.status(500).json({ error: 'Failed to fetch tenant analytics' });
  }
});

router.get('/platform/tenants/:id/calls', requireAuth, requirePlatformAdmin, async (req, res) => {
  const { id } = req.params;
  const limit = Math.min(parseInt(String(req.query.limit ?? '20'), 10), 100);
  const page = Math.max(parseInt(String(req.query.page ?? '1'), 10), 1);
  const offset = (page - 1) * limit;
  const { agent_id, direction, lifecycle_state, since, q, has_transcript, has_events, has_tool_executions, tool_failures_only } = req.query as Record<string, string>;

  const parseBoolFilter = (v: string | undefined): boolean | null => {
    if (v === 'true' || v === '1') return true;
    if (v === 'false' || v === '0') return false;
    return null;
  };
  const transcriptFilter = parseBoolFilter(has_transcript);
  const eventsFilter = parseBoolFilter(has_events);
  const toolsFilter = parseBoolFilter(has_tool_executions);
  const toolFailuresOnly = parseBoolFilter(tool_failures_only) === true;

  try {
    const tenantExists = await withPrivilegedClient(async (client) => {
      const { rows } = await client.query(
        `SELECT id, name, slug FROM tenants WHERE id = $1`,
        [id],
      );
      return rows[0] ?? null;
    });
    if (!tenantExists) return res.status(404).json({ error: 'Tenant not found' });

    const conditions: string[] = ['cs.tenant_id = $1'];
    const values: unknown[] = [id];
    if (agent_id) { values.push(agent_id); conditions.push(`cs.agent_id = $${values.length}`); }
    if (direction) { values.push(direction); conditions.push(`cs.direction = $${values.length}`); }
    if (lifecycle_state) { values.push(lifecycle_state); conditions.push(`cs.lifecycle_state = $${values.length}`); }
    if (since) { values.push(since); conditions.push(`cs.start_time >= $${values.length}::timestamptz`); }
    if (q && q.trim()) {
      const term = `%${q.trim()}%`;
      values.push(term);
      const idx = values.length;
      conditions.push(
        `(cs.caller_number ILIKE $${idx} OR cs.called_number ILIKE $${idx} OR cs.id::text ILIKE $${idx})`,
      );
    }
    if (transcriptFilter !== null) {
      const op = transcriptFilter ? 'EXISTS' : 'NOT EXISTS';
      conditions.push(`${op} (SELECT 1 FROM call_transcripts ct WHERE ct.call_session_id = cs.id AND ct.tenant_id = cs.tenant_id)`);
    }
    if (eventsFilter !== null) {
      const op = eventsFilter ? 'EXISTS' : 'NOT EXISTS';
      conditions.push(`${op} (SELECT 1 FROM call_events ce WHERE ce.call_session_id = cs.id AND ce.tenant_id = cs.tenant_id)`);
    }
    if (toolsFilter !== null) {
      const op = toolsFilter ? 'EXISTS' : 'NOT EXISTS';
      conditions.push(`${op} (SELECT 1 FROM tool_invocations ti WHERE ti.call_session_id = cs.id AND ti.tenant_id = cs.tenant_id)`);
    }
    if (toolFailuresOnly) {
      conditions.push(
        `EXISTS (SELECT 1 FROM tool_invocations ti WHERE ti.call_session_id = cs.id AND ti.tenant_id = cs.tenant_id AND ti.status IN ('failed', 'timeout'))`,
      );
    }
    const where = conditions.join(' AND ');

    const result = await withPrivilegedClient(async (client) => {
      const { rows } = await client.query(
        `SELECT cs.id, cs.agent_id, cs.direction, cs.lifecycle_state,
                cs.caller_number, cs.called_number,
                cs.start_time, cs.end_time, cs.duration_seconds,
                cs.total_cost_cents, cs.environment, cs.created_at,
                -- Snapshot wins; fall back to agents.language for legacy rows
                -- that pre-date migration 082_call_sessions_language.
                COALESCE(cs.language, a.language) AS language,
                a.name AS agent_name,
                EXISTS (
                  SELECT 1 FROM call_transcripts ct
                  WHERE ct.call_session_id = cs.id AND ct.tenant_id = cs.tenant_id
                ) AS has_transcript,
                EXISTS (
                  SELECT 1 FROM call_events ce
                  WHERE ce.call_session_id = cs.id AND ce.tenant_id = cs.tenant_id
                ) AS has_events,
                (
                  SELECT COUNT(*)::int FROM tool_invocations ti
                  WHERE ti.call_session_id = cs.id AND ti.tenant_id = cs.tenant_id
                ) AS tool_count,
                (
                  SELECT COUNT(*)::int FROM tool_invocations ti
                  WHERE ti.call_session_id = cs.id AND ti.tenant_id = cs.tenant_id
                    AND ti.status IN ('failed', 'timeout')
                ) AS failed_tool_count
         FROM call_sessions cs
         LEFT JOIN agents a ON a.id = cs.agent_id
         WHERE ${where}
         ORDER BY cs.created_at DESC
         LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
        [...values, limit, offset],
      );
      const { rows: countRows } = await client.query(
        `SELECT COUNT(*) AS total FROM call_sessions cs WHERE ${where}`,
        values,
      );
      return { rows, total: parseInt(countRows[0].total as string, 10) };
    });

    const calls = result.rows.map((r) => {
      const out = { ...r } as Record<string, unknown>;
      if (typeof out.caller_number === 'string') out.caller_number = redactPHI(out.caller_number);
      if (typeof out.called_number === 'string') out.called_number = redactPHI(out.called_number);
      return out;
    });

    logger.info('Platform admin viewed tenant calls', {
      tenantId: id,
      adminUserId: req.user!.userId,
      page,
      limit,
    });

    const currency = await getTenantBillingCurrency(id);

    return res.json({ tenant: tenantExists, calls, total: result.total, limit, offset, currency });
  } catch (err) {
    logger.error('Failed to list tenant calls for admin', { tenantId: id, error: String(err) });
    return res.status(500).json({ error: 'Failed to list tenant calls' });
  }
});

router.get('/platform/tenants/:id/agents', requireAuth, requirePlatformAdmin, async (req, res) => {
  const { id } = req.params;
  try {
    const tenant = await withPrivilegedClient(async (client) => {
      const { rows } = await client.query(`SELECT id FROM tenants WHERE id = $1`, [id]);
      return rows[0] ?? null;
    });
    if (!tenant) return res.status(404).json({ error: 'Tenant not found' });

    const agents = await withPrivilegedClient(async (client) => {
      const { rows } = await client.query(
        `SELECT id, name FROM agents WHERE tenant_id = $1 ORDER BY name ASC`,
        [id],
      );
      return rows;
    });
    return res.json({ agents });
  } catch (err) {
    logger.error('Failed to list tenant agents for admin', { tenantId: id, error: String(err) });
    return res.status(500).json({ error: 'Failed to list tenant agents' });
  }
});

router.get('/platform/tenants/:id/calls/:callId', requireAuth, requirePlatformAdmin, async (req, res) => {
  const { id, callId } = req.params;
  try {
    const result = await withPrivilegedClient(async (client) => {
      const { rows: tenantRows } = await client.query(
        `SELECT id, name, slug FROM tenants WHERE id = $1`,
        [id],
      );
      if (!tenantRows[0]) return { tenant: null, call: null };
      const { rows } = await client.query(
        `SELECT cs.*,
                -- Same fallback as the list endpoint above so the language
                -- shows up consistently between the table and the detail
                -- view, even for calls created before migration 082.
                COALESCE(cs.language, a.language) AS language,
                a.name AS agent_name
         FROM call_sessions cs
         LEFT JOIN agents a ON a.id = cs.agent_id
         WHERE cs.id = $1 AND cs.tenant_id = $2`,
        [callId, id],
      );
      return { tenant: tenantRows[0], call: rows[0] ?? null };
    });
    if (!result.tenant) return res.status(404).json({ error: 'Tenant not found' });
    if (!result.call) return res.status(404).json({ error: 'Call not found' });

    const call = { ...result.call } as Record<string, unknown>;
    if (typeof call.caller_number === 'string') call.caller_number = redactPHI(call.caller_number);
    if (typeof call.called_number === 'string') call.called_number = redactPHI(call.called_number);
    if (typeof call.escalation_target === 'string') call.escalation_target = redactPHI(call.escalation_target);

    let costBreakdown = null;
    try {
      costBreakdown = await getConversationCost(id, callId);
    } catch {}
    const currency = await getTenantBillingCurrency(id);

    logger.info('Platform admin viewed tenant call detail', {
      tenantId: id,
      callId,
      adminUserId: req.user!.userId,
    });

    return res.json({ tenant: result.tenant, call, costBreakdown, currency });
  } catch (err) {
    logger.error('Failed to fetch tenant call for admin', { tenantId: id, callId, error: String(err) });
    return res.status(500).json({ error: 'Failed to fetch tenant call' });
  }
});

router.get('/platform/tenants/:id/calls/:callId/transcript', requireAuth, requirePlatformAdmin, async (req, res) => {
  const { id, callId } = req.params;
  try {
    const lines = await withPrivilegedClient(async (client) => {
      const { rows: sessionRows } = await client.query(
        `SELECT id FROM call_sessions WHERE id = $1 AND tenant_id = $2`,
        [callId, id],
      );
      if (sessionRows.length === 0) return null;
      const { rows } = await client.query(
        `SELECT id, role, content, sequence_number, occurred_at
         FROM call_transcripts
         WHERE call_session_id = $1 AND tenant_id = $2
         ORDER BY sequence_number ASC, occurred_at ASC`,
        [callId, id],
      );
      return rows;
    });
    if (lines === null) return res.status(404).json({ error: 'Call not found' });

    const transcript = lines.map((row) => ({
      ...row,
      content: typeof row.content === 'string' ? redactPHI(row.content) : row.content,
    }));

    return res.json({ callId, transcript });
  } catch (err) {
    logger.error('Failed to fetch tenant call transcript for admin', { tenantId: id, callId, error: String(err) });
    return res.status(500).json({ error: 'Failed to fetch call transcript' });
  }
});

router.get('/platform/tenants/:id/calls/:callId/events', requireAuth, requirePlatformAdmin, async (req, res) => {
  const { id, callId } = req.params;
  try {
    const events = await withPrivilegedClient(async (client) => {
      const { rows: sessionRows } = await client.query(
        `SELECT id FROM call_sessions WHERE id = $1 AND tenant_id = $2`,
        [callId, id],
      );
      if (sessionRows.length === 0) return null;
      const { rows } = await client.query(
        `SELECT id, event_type, from_state, to_state, payload, occurred_at
         FROM call_events
         WHERE call_session_id = $1 AND tenant_id = $2
         ORDER BY occurred_at ASC`,
        [callId, id],
      );
      return rows;
    });
    if (events === null) return res.status(404).json({ error: 'Call not found' });
    return res.json({ callId, events });
  } catch (err) {
    logger.error('Failed to fetch tenant call events for admin', { tenantId: id, callId, error: String(err) });
    return res.status(500).json({ error: 'Failed to fetch call events' });
  }
});

router.get('/platform/tenants/:id/calls/:callId/tool-executions', requireAuth, requirePlatformAdmin, async (req, res) => {
  const { id, callId } = req.params;
  try {
    const sessionExists = await withPrivilegedClient(async (client) => {
      const { rows } = await client.query(
        `SELECT id FROM call_sessions WHERE id = $1 AND tenant_id = $2`,
        [callId, id],
      );
      return rows.length > 0;
    });
    if (!sessionExists) return res.status(404).json({ error: 'Call not found' });

    const result = await listToolExecutions({
      tenantId: id,
      callSessionId: callId,
      limit: 200,
      offset: 0,
    });
    return res.json({ executions: result.executions, total: result.total });
  } catch (err) {
    logger.error('Failed to fetch tenant tool executions for admin', { tenantId: id, callId, error: String(err) });
    return res.status(500).json({ error: 'Failed to fetch tool executions' });
  }
});

router.get('/platform/tenants/:id/campaigns/:campaignId', requireAuth, requirePlatformAdmin, async (req, res) => {
  const { id, campaignId } = req.params;
  try {
    const tenant = await withPrivilegedClient(async (client) => {
      const { rows } = await client.query(
        `SELECT id, name, slug FROM tenants WHERE id = $1`,
        [id],
      );
      return rows[0] ?? null;
    });
    if (!tenant) return res.status(404).json({ error: 'Tenant not found' });

    const [campaign, metrics, agentRow] = await Promise.all([
      getCampaign(id, campaignId),
      getCampaignMetrics(id, campaignId).catch(() => null),
      withPrivilegedClient(async (client) => {
        const { rows } = await client.query(
          `SELECT a.id, a.name FROM agents a
            JOIN campaigns c ON c.agent_id = a.id
            WHERE c.id = $1 AND c.tenant_id = $2`,
          [campaignId, id],
        );
        return rows[0] ?? null;
      }),
    ]);

    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });

    logger.info('Platform admin viewed tenant campaign', {
      tenantId: id,
      campaignId,
      adminUserId: req.user!.userId,
    });

    return res.json({ tenant, campaign, metrics, agent: agentRow });
  } catch (err) {
    logger.error('Failed to fetch tenant campaign for admin', { tenantId: id, campaignId, error: String(err) });
    return res.status(500).json({ error: 'Failed to fetch tenant campaign' });
  }
});

router.get('/platform/tenants/:id/campaigns/:campaignId/contacts', requireAuth, requirePlatformAdmin, async (req, res) => {
  const { id, campaignId } = req.params;
  const limit = Math.min(parseInt(String(req.query.limit ?? '20'), 10), 100);
  const page = Math.max(parseInt(String(req.query.page ?? '1'), 10), 1);
  const offset = (page - 1) * limit;
  const { status } = req.query as Record<string, string>;

  try {
    const tenant = await withPrivilegedClient(async (client) => {
      const { rows } = await client.query(`SELECT id FROM tenants WHERE id = $1`, [id]);
      return rows[0] ?? null;
    });
    if (!tenant) return res.status(404).json({ error: 'Tenant not found' });

    const result = await listContacts(id, campaignId, {
      limit,
      offset,
      status: status as import('../../../platform/campaigns').ContactStatus,
    });

    const contacts = result.contacts.map((c) => ({
      ...c,
      phoneNumber: c.phoneNumber ? redactPHI(c.phoneNumber) : c.phoneNumber,
    }));

    return res.json({ contacts, total: result.total, limit, offset });
  } catch (err) {
    logger.error('Failed to list tenant campaign contacts for admin', { tenantId: id, campaignId, error: String(err) });
    return res.status(500).json({ error: 'Failed to list campaign contacts' });
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
          (SELECT CASE WHEN COUNT(ccr.score_normalized) = 0 THEN 0
                       ELSE 1 + AVG(ccr.score_normalized) * 4 END
            FROM tenant_agent_installations tai
            JOIN call_sessions cs ON cs.agent_id = tai.agent_id AND cs.tenant_id = tai.tenant_id
            JOIN call_csat_responses ccr ON ccr.call_session_id = cs.id AND ccr.tenant_id = cs.tenant_id
            WHERE tai.template_id = tr.id
              AND ccr.status = 'responded'
              AND ccr.score_normalized IS NOT NULL) AS avg_satisfaction,
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

      const { rows: subscriptionRows } = await client.query(`
        SELECT plan, status::text AS status, COUNT(*)::text AS count
        FROM subscriptions
        WHERE status IN ('trialing', 'active', 'past_due', 'cancelled')
        GROUP BY plan, status
      `);

      let activeTrials = 0;
      let paidAccounts = 0;
      let totalAccounts = 0;
      let mrrCents = 0;
      let pipelineMrrCents = 0;

      for (const row of subscriptionRows) {
        const count = parseInt(String(row.count), 10) || 0;
        const planPriceCents = PLAN_MONTHLY_PRICE_CENTS[String(row.plan) as PlanTier] ?? 0;
        totalAccounts += count;
        if (row.status === 'trialing') {
          activeTrials += count;
          pipelineMrrCents += count * planPriceCents;
        } else if (row.status === 'active') {
          paidAccounts += count;
          mrrCents += count * planPriceCents;
        } else if (row.status === 'past_due') {
          mrrCents += count * planPriceCents;
        }
      }

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
          mrrCents,
          pipelineMrrCents,
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

router.get('/platform/activation-metrics', requireAuth, requirePlatformAdmin, async (_req, res) => {
  try {
    const metrics = await getAllTenantsActivationMetrics();
    return res.json({ metrics });
  } catch (err) {
    logger.error('Failed to get activation metrics', { error: String(err) });
    return res.status(500).json({ error: 'Failed to get activation metrics' });
  }
});

// Onboarding wizard funnel for the past N days (Task #612).
//
// Bucketises every `tenant_owner` user that signed up in the window into
// either the step they last persisted (1 / 2 / 3) or "completed", reading
// from `users.preferences` populated by the wizard. Drives the funnel
// cards on the Activation tab so product / support can see where new
// signups stall most often.
//
// `days` is clamped to a sensible range so a hostile / accidental query
// string (e.g. `?days=99999`) can't cause a multi-year table scan.
router.get('/platform/onboarding-funnel', requireAuth, requirePlatformAdmin, async (req, res) => {
  const rawDays = parseInt(String(req.query.days ?? '30'), 10);
  const days = Number.isFinite(rawDays)
    ? Math.min(Math.max(rawDays, 1), 365)
    : 30;
  try {
    const funnel = await withPrivilegedClient(async (client) => {
      const { rows } = await client.query(
        `WITH owners AS (
           SELECT
             u.id,
             -- Whitelist 'true' (case-insensitive) only. Any other JSONB
             -- value (NULL, 'maybe', '{}', etc.) degrades to FALSE so a
             -- corrupt legacy row can't 500 the endpoint via a failed
             -- ::boolean cast.
             (LOWER(u.preferences->>'onboarding_completed') = 'true') AS completed,
             -- Defensive integer parse: only cast bare positive integers,
             -- otherwise default to 1. The wizard already clamps on
             -- write, but we re-clamp on read so a stale row from an
             -- older client can't slip through.
             GREATEST(1, LEAST(3,
               CASE
                 WHEN u.preferences->>'onboarding_step' ~ '^[0-9]+$'
                   THEN (u.preferences->>'onboarding_step')::int
                 ELSE 1
               END
             )) AS step
           FROM users u
           JOIN user_roles ur ON ur.user_id = u.id
           WHERE ur.role = 'tenant_owner'
             AND ur.revoked_at IS NULL
             AND u.created_at >= NOW() - make_interval(days => $1::int)
         )
         SELECT
           COUNT(*)::int AS total,
           COUNT(*) FILTER (WHERE completed)::int AS completed,
           COUNT(*) FILTER (WHERE NOT completed AND step = 1)::int AS step_1,
           COUNT(*) FILTER (WHERE NOT completed AND step = 2)::int AS step_2,
           COUNT(*) FILTER (WHERE NOT completed AND step = 3)::int AS step_3
         FROM owners`,
        [days],
      );
      return rows[0] ?? { total: 0, completed: 0, step_1: 0, step_2: 0, step_3: 0 };
    });
    return res.json({ days, funnel });
  } catch (err) {
    logger.error('Failed to get onboarding funnel', { error: String(err) });
    return res.status(500).json({ error: 'Failed to get onboarding funnel' });
  }
});

const VALID_LEAD_SOURCES: ReadonlyArray<LeadSource | 'all'> = ['all', 'book_demo', 'roi_calculator', 'contact'];
const VALID_BOOKING_STATUSES: ReadonlyArray<BookingStatusFilter> = ['all', 'booked', 'no_booking', 'cancelled'];
const VALID_LEAD_STATUSES: ReadonlyArray<LeadStatus | 'all'> = ['all', 'new', 'contacted', 'closed'];
const TRIAGEABLE_LEAD_STATUSES: ReadonlyArray<LeadStatus> = ['new', 'contacted', 'closed'];

// Mitigates CSV formula injection (CWE-1236): when a spreadsheet (Excel,
// Numbers, LibreOffice, Google Sheets) opens a CSV cell that begins with
// `=`, `+`, `-`, `@`, TAB, or CR, it interprets the cell as a formula and
// will execute it. Lead names/companies/emails are user-controlled, so we
// prefix risky leading characters with a single quote so the cell is
// rendered as literal text.
function sanitizeForFormulaInjection(value: string): string {
  if (value === '') return value;
  const first = value.charCodeAt(0);
  // = + - @ \t \r
  if (first === 0x3d || first === 0x2b || first === 0x2d || first === 0x40 || first === 0x09 || first === 0x0d) {
    return `'${value}`;
  }
  return value;
}

function csvField(value: unknown): string {
  if (value === null || value === undefined) return '';
  const raw = typeof value === 'string' ? value : String(value);
  if (raw === '') return '';
  const s = sanitizeForFormulaInjection(raw);
  if (/[",\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function getLatestBooking(lead: LeadListItem): Record<string, unknown> | null {
  const booking = (lead.payload as { booking?: unknown }).booking;
  if (booking && typeof booking === 'object') return booking as Record<string, unknown>;
  return null;
}

const CSV_COLUMNS = [
  'id',
  'source',
  'name',
  'email',
  'company',
  'phone',
  'status',
  'booking_start',
  'booking_timezone',
  'meeting_url',
  'reschedule_url',
  'cancel_url',
  'created_at',
] as const;

/**
 * Parse the shared subset of marketing-lead filter query params used by the
 * Sales Inbox list, CSV export, and (future) other read endpoints. Unknown /
 * malformed values are coerced to safe defaults rather than rejected so the
 * UI can remain a thin pass-through over the query string.
 */
const VALID_LEAD_SORT_FIELDS = ['created_at', 'last_activity'] as const;
const VALID_LEAD_SORT_ORDERS = ['asc', 'desc'] as const;

export function parseLeadFilters(query: Record<string, unknown>): {
  source: LeadSource | 'all';
  booking: BookingStatusFilter;
  status: LeadStatus | 'all';
  q: string | undefined;
  actedOnBy: string | undefined;
  inactiveForDays: number | undefined;
  sort: 'created_at' | 'last_activity';
  order: 'asc' | 'desc';
} {
  const sourceParam = String(query.source ?? 'all');
  const bookingParam = String(query.booking ?? 'all');
  const statusParam = String(query.status ?? 'all');
  const q = typeof query.q === 'string' && query.q.trim() ? query.q.trim() : undefined;

  const actedOnByRaw = typeof query.actedOnBy === 'string' ? query.actedOnBy.trim() : '';
  const actedOnBy = actedOnByRaw ? actedOnByRaw : undefined;

  let inactiveForDays: number | undefined;
  const inactiveRaw = query.inactiveDays;
  if (inactiveRaw !== undefined && inactiveRaw !== null && String(inactiveRaw).trim() !== '') {
    const parsed = parseInt(String(inactiveRaw), 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      // Cap at ~10 years to keep `make_interval` happy and bound the query.
      inactiveForDays = Math.min(parsed, 3650);
    }
  }

  const sortParam = typeof query.sort === 'string' ? query.sort.trim() : '';
  const orderParam = typeof query.order === 'string' ? query.order.trim().toLowerCase() : '';
  const sort = (VALID_LEAD_SORT_FIELDS as readonly string[]).includes(sortParam)
    ? (sortParam as 'created_at' | 'last_activity')
    : 'created_at';
  const order = (VALID_LEAD_SORT_ORDERS as readonly string[]).includes(orderParam)
    ? (orderParam as 'asc' | 'desc')
    : 'desc';

  const source = (VALID_LEAD_SOURCES as readonly string[]).includes(sourceParam)
    ? (sourceParam as LeadSource | 'all')
    : 'all';
  const booking = (VALID_BOOKING_STATUSES as readonly string[]).includes(bookingParam)
    ? (bookingParam as BookingStatusFilter)
    : 'all';
  const status = (VALID_LEAD_STATUSES as readonly string[]).includes(statusParam)
    ? (statusParam as LeadStatus | 'all')
    : 'all';

  return { source, booking, status, q, actedOnBy, inactiveForDays, sort, order };
}

router.get('/platform/marketing-leads.csv', requireAuth, requirePlatformAdmin, async (req, res) => {
  const { source, booking, status, q, actedOnBy, inactiveForDays } = parseLeadFilters(
    req.query as Record<string, unknown>,
  );

  const stamp = new Date().toISOString().slice(0, 10);
  const filename = `sales-inbox-${stamp}.csv`;

  res.status(200);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');

  let exported = 0;
  try {
    res.write(CSV_COLUMNS.join(',') + '\r\n');
    for await (const lead of iterateLeadsForExport({
      source,
      status,
      bookingStatus: booking,
      q,
      actedOnBy,
      inactiveForDays,
    })) {
      const latest = getLatestBooking(lead);
      const row = [
        lead.id,
        lead.source,
        lead.name,
        lead.email,
        lead.company,
        lead.phone,
        lead.status,
        latest?.startTime ?? '',
        latest?.timezone ?? '',
        latest?.meetingUrl ?? '',
        latest?.rescheduleUrl ?? '',
        latest?.cancelUrl ?? '',
        lead.created_at,
      ].map(csvField).join(',');
      res.write(row + '\r\n');
      exported += 1;
    }
    res.end();
    logger.info('Marketing leads CSV exported', {
      adminUserId: req.user?.userId,
      filters: {
        source,
        booking,
        status,
        q: q ?? null,
        actedOnBy: actedOnBy ?? null,
        inactiveForDays: inactiveForDays ?? null,
      },
      rows: exported,
    });
  } catch (err) {
    logger.error('Failed to stream marketing leads CSV', {
      error: err instanceof Error ? err.message : String(err),
      exported,
    });
    if (!res.headersSent) {
      return res.status(500).json({ error: 'Failed to export marketing leads' });
    }
    // Headers already sent — terminate the stream so the client sees a partial download.
    try { res.end(); } catch { /* ignore */ }
  }
});

router.get('/platform/marketing-leads', requireAuth, requirePlatformAdmin, async (req, res) => {
  const limit = Math.min(parseInt(String(req.query.limit ?? '50'), 10) || 50, 200);
  const page = Math.max(parseInt(String(req.query.page ?? '1'), 10) || 1, 1);
  const offset = (page - 1) * limit;

  const { source, booking, status, q, actedOnBy, inactiveForDays, sort, order } = parseLeadFilters(
    req.query as Record<string, unknown>,
  );

  try {
    const result = await listLeads({
      source,
      status,
      bookingStatus: booking,
      q,
      actedOnBy,
      inactiveForDays,
      sort,
      order,
      limit,
      offset,
    });
    return res.json({
      leads: result.leads,
      total: result.total,
      counts: result.counts,
      limit,
      offset,
      page,
    });
  } catch (err) {
    logger.error('Failed to list marketing leads', { error: String(err) });
    return res.status(500).json({ error: 'Failed to list marketing leads' });
  }
});

router.get(
  '/platform/marketing-lead-authors',
  requireAuth,
  requirePlatformAdmin,
  async (_req, res) => {
    try {
      const authors = await listLeadEventAuthors();
      return res.json({ authors });
    } catch (err) {
      logger.error('Failed to list marketing lead authors', { error: String(err) });
      return res.status(500).json({ error: 'Failed to list marketing lead authors' });
    }
  },
);

router.get('/platform/marketing-leads/:id/events', requireAuth, requirePlatformAdmin, async (req, res) => {
  const { id } = req.params;
  const leadId = parseInt(id, 10);
  if (!Number.isFinite(leadId) || leadId <= 0) {
    return res.status(400).json({ error: 'Invalid lead id' });
  }

  try {
    const events = await listLeadEvents(leadId);
    return res.json({ events });
  } catch (err) {
    logger.error('Failed to list marketing lead events', { leadId, error: String(err) });
    return res.status(500).json({ error: 'Failed to list marketing lead events' });
  }
});

router.patch('/platform/marketing-leads/:id', requireAuth, requirePlatformAdmin, async (req, res) => {
  const { id } = req.params;
  const leadId = parseInt(id, 10);
  if (!Number.isFinite(leadId) || leadId <= 0) {
    return res.status(400).json({ error: 'Invalid lead id' });
  }

  const { status, notes } = (req.body ?? {}) as { status?: string; notes?: string | null };
  if (!status || !(TRIAGEABLE_LEAD_STATUSES as readonly string[]).includes(status)) {
    return res.status(400).json({ error: 'status must be one of new, contacted, closed' });
  }

  try {
    const updated = await updateLeadStatus(leadId, status as LeadStatus, {
      notes: typeof notes === 'string' ? notes : null,
      updatedBy: req.user!.email,
    });
    if (!updated) return res.status(404).json({ error: 'Lead not found' });

    logger.info('Marketing lead status updated by platform admin', {
      leadId,
      newStatus: status,
      adminUserId: req.user!.userId,
    });
    return res.json({ lead: updated });
  } catch (err) {
    logger.error('Failed to update marketing lead status', { leadId, error: String(err) });
    return res.status(500).json({ error: 'Failed to update marketing lead' });
  }
});

// ---------- Sales-alert settings ----------
//
// Sits next to the Sales Inbox in /admin/sales-inbox so platform admins can
// pick the recipient list and channels (email / Slack) used by lead-capture
// and Cal.com booking notifications. Stored under platform_settings, falls
// back to SALES_NOTIFICATION_EMAIL / OPS_SLACK_WEBHOOK_URL env vars when no
// override is set.

router.get('/platform/sales-alert-settings', requireAuth, requirePlatformAdmin, async (_req, res) => {
  try {
    const settings = await getSalesAlertSettings();
    return res.json({
      settings,
      fallbacks: {
        envEmail: (process.env.SALES_NOTIFICATION_EMAIL ?? process.env.SALES_EMAIL ?? '').trim() || null,
        envSlackConfigured: Boolean(
          (process.env.OPS_SLACK_WEBHOOK_URL ?? process.env.SLACK_WEBHOOK_URL ?? process.env.SLACK_WEBHOOK ?? '').trim(),
        ),
      },
    });
  } catch (err) {
    logger.error('Failed to load sales alert settings', { error: String(err) });
    return res.status(500).json({ error: 'Failed to load sales alert settings' });
  }
});

router.put('/platform/sales-alert-settings', requireAuth, requirePlatformAdmin, async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const patch: SalesAlertSettingsPatch = {};

  if (body.channels && typeof body.channels === 'object') {
    const ch = body.channels as Record<string, unknown>;
    const channelsPatch: { email?: boolean; slack?: boolean } = {};
    if (typeof ch.email === 'boolean') channelsPatch.email = ch.email;
    if (typeof ch.slack === 'boolean') channelsPatch.slack = ch.slack;
    if (Object.keys(channelsPatch).length > 0) patch.channels = channelsPatch;
  }
  if (body.emailRecipients !== undefined) {
    if (!Array.isArray(body.emailRecipients)) {
      return res.status(400).json({ error: 'emailRecipients must be an array of strings' });
    }
    patch.emailRecipients = body.emailRecipients.filter((v): v is string => typeof v === 'string');
  }
  if (body.slackWebhookUrl !== undefined) {
    if (body.slackWebhookUrl !== null && typeof body.slackWebhookUrl !== 'string') {
      return res.status(400).json({ error: 'slackWebhookUrl must be a string or null' });
    }
    patch.slackWebhookUrl = body.slackWebhookUrl as string | null;
  }
  if (typeof body.notifyOnNewLead === 'boolean') patch.notifyOnNewLead = body.notifyOnNewLead;
  if (typeof body.notifyOnBookingCreated === 'boolean') patch.notifyOnBookingCreated = body.notifyOnBookingCreated;
  if (typeof body.notifyOnBookingRescheduled === 'boolean') patch.notifyOnBookingRescheduled = body.notifyOnBookingRescheduled;
  if (typeof body.notifyOnBookingCancelled === 'boolean') patch.notifyOnBookingCancelled = body.notifyOnBookingCancelled;

  try {
    const settings = await setSalesAlertSettings(patch, req.user!.userId);
    logger.info('Sales alert settings updated', {
      adminUserId: req.user!.userId,
      recipientCount: settings.emailRecipients.length,
      slackOverride: Boolean(settings.slackWebhookUrl),
      channels: settings.channels,
    });
    return res.json({ settings });
  } catch (err) {
    logger.error('Failed to save sales alert settings', { error: String(err) });
    return res.status(500).json({ error: 'Failed to save sales alert settings' });
  }
});

// Send a clearly-marked test alert through the currently-saved channels and
// recipients so admins can verify their email addresses and Slack webhook
// before relying on real lead traffic. Does NOT touch marketing_leads or the
// `notified` flag — purely a one-shot delivery probe.
router.post('/platform/sales-alert-settings/test', requireAuth, requirePlatformAdmin, async (req, res) => {
  try {
    const settings = await getSalesAlertSettings();
    const adminEmail = req.user?.email ?? null;
    const triggeredBy = adminEmail ?? req.user?.userId ?? 'platform admin';
    const timestamp = new Date().toISOString();

    // Defensive escape — `triggeredBy` is sourced from the JWT payload and
    // should be safe, but rendering it as raw HTML in an email is exactly the
    // kind of place where a stray angle bracket would cause weird breakage.
    const escapeHtml = (v: string): string =>
      v
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');

    const subject = '[TEST] Sales-alert settings test from QVO';
    const slackText = [
      ':white_check_mark: *This is a test alert from QVO*',
      `Triggered by: ${triggeredBy}`,
      `Time: ${timestamp}`,
      '',
      'If you received this message, your Sales Inbox alert channel is working.',
      'No marketing lead was created and no notification flag was changed.',
    ].join('\n');
    const plainText = [
      'This is a test alert from QVO.',
      `Triggered by: ${triggeredBy}`,
      `Time: ${timestamp}`,
      '',
      'If you received this message, your Sales Inbox alert channel is working.',
      'No marketing lead was created and no notification flag was changed.',
    ].join('\n');
    const html = `
      <div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:560px;">
        <h2 style="color:#0f172a;margin:0 0 12px;">This is a test alert from QVO</h2>
        <p style="color:#475569;margin:0 0 12px;">
          A platform admin triggered this from <strong>Admin → Sales Inbox → Alert settings</strong>
          to verify delivery. <strong>No marketing lead was created</strong> and the
          <code>notified</code> flag was not changed for any existing lead.
        </p>
        <table style="border-collapse:collapse;border:1px solid #e2e8f0;border-radius:8px;overflow:hidden;">
          <tr><td style="padding:6px 12px;font-weight:600;color:#475569;">Triggered by</td>
              <td style="padding:6px 12px;color:#0f172a;">${escapeHtml(triggeredBy)}</td></tr>
          <tr><td style="padding:6px 12px;font-weight:600;color:#475569;">Time</td>
              <td style="padding:6px 12px;color:#0f172a;">${escapeHtml(timestamp)}</td></tr>
        </table>
        <p style="color:#475569;margin:16px 0 0;">
          If you received this message, the channel is configured correctly.
        </p>
      </div>
    `;

    const result = await sendAlertMessage(settings, {
      subject,
      slackText,
      html,
      plainText,
      replyTo: adminEmail ?? undefined,
      leadId: null,
    });

    logger.info('Test sales alert dispatched', {
      adminUserId: req.user?.userId,
      email: result.email,
      slack: result.slack,
    });

    // Surface a single top-level `error` for failed channels so the modal can
    // show one inline summary, while still returning per-channel detail.
    const errorParts: string[] = [];
    if (result.email === 'failed' && result.emailError) errorParts.push(`Email: ${result.emailError}`);
    if (result.slack === 'failed' && result.slackError) errorParts.push(`Slack: ${result.slackError}`);

    return res.json({
      email: result.email,
      slack: result.slack,
      ...(result.emailError ? { emailError: result.emailError } : {}),
      ...(result.slackError ? { slackError: result.slackError } : {}),
      ...(errorParts.length ? { error: errorParts.join(' | ') } : {}),
    });
  } catch (err) {
    logger.error('Failed to send test sales alert', { error: String(err) });
    return res.status(500).json({
      email: 'failed',
      slack: 'failed',
      error: err instanceof Error ? err.message : 'Failed to send test alert',
    });
  }
});

router.get('/platform/notifications', requireAuth, async (req, res) => {
  const { tenantId, userId } = req.user!;
  const pool = getPlatformPool();

  try {
    const { rows } = await pool.query(
      `SELECT id, type, title, message, metadata, read, created_at
       FROM tenant_notifications
       WHERE tenant_id = $1 AND (user_id IS NULL OR user_id = $2)
       ORDER BY created_at DESC
       LIMIT 50`,
      [tenantId, userId],
    );

    return res.json({ notifications: rows });
  } catch (err) {
    logger.error('Failed to get notifications', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to get notifications' });
  }
});

router.patch('/platform/notifications/:id/read', requireAuth, async (req, res) => {
  const { tenantId, userId } = req.user!;
  const { id } = req.params;
  const pool = getPlatformPool();

  try {
    await pool.query(
      `UPDATE tenant_notifications
          SET read = TRUE
        WHERE id = $1 AND tenant_id = $2 AND (user_id IS NULL OR user_id = $3)`,
      [id, tenantId, userId],
    );
    return res.json({ success: true });
  } catch (err) {
    logger.error('Failed to mark notification read', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to update notification' });
  }
});

// ---------- Demo scheduler settings ----------
//
// Lets a platform admin switch the public /book-demo embed between Cal.com
// and Calendly, swap the embed URL, and rotate either webhook secret WITHOUT
// a redeploy. The plaintext webhook secrets are encrypted at rest in
// platform_settings and never returned to the client (the GET endpoint only
// reports whether each secret is currently configured).

router.get('/platform/demo-scheduler-settings', requireAuth, requirePlatformAdmin, async (_req, res) => {
  try {
    const settings = await getDemoSchedulerSettings();
    return res.json({
      settings: toAdminView(settings),
      fallbacks: {
        envProvider:
          (process.env.BOOK_DEMO_SCHEDULER_PROVIDER ?? process.env.VITE_BOOK_DEMO_SCHEDULER_PROVIDER ?? '').trim() ||
          null,
        envEmbedUrl: (process.env.VITE_BOOK_DEMO_SCHEDULER_URL ?? '').trim() || null,
        envCalcomSecretConfigured: Boolean((process.env.CALCOM_WEBHOOK_SECRET ?? '').trim()),
        envCalendlySecretConfigured: Boolean((process.env.CALENDLY_WEBHOOK_SECRET ?? '').trim()),
      },
    });
  } catch (err) {
    logger.error('Failed to load demo scheduler settings', { error: String(err) });
    return res.status(500).json({ error: 'Failed to load demo scheduler settings' });
  }
});

router.put('/platform/demo-scheduler-settings', requireAuth, requirePlatformAdmin, async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const patch: DemoSchedulerSettingsPatch = {};

  if (body.provider !== undefined) {
    if (body.provider !== 'cal.com' && body.provider !== 'calendly') {
      return res.status(400).json({ error: 'provider must be "cal.com" or "calendly"' });
    }
    patch.provider = body.provider as SchedulerProvider;
  }
  if (body.embedUrl !== undefined) {
    if (typeof body.embedUrl !== 'string') {
      return res.status(400).json({ error: 'embedUrl must be a string' });
    }
    patch.embedUrl = body.embedUrl;
  }
  // Use `null` to clear, a non-empty string to rotate, or omit to leave
  // unchanged. Empty string is treated as "leave unchanged" so an admin
  // saving the form without re-typing the secret doesn't accidentally wipe
  // it out.
  if (body.calcomWebhookSecret !== undefined) {
    if (body.calcomWebhookSecret === null) {
      patch.calcomWebhookSecret = null;
    } else if (typeof body.calcomWebhookSecret === 'string') {
      const trimmed = body.calcomWebhookSecret.trim();
      if (trimmed) patch.calcomWebhookSecret = trimmed;
    } else {
      return res.status(400).json({ error: 'calcomWebhookSecret must be a string or null' });
    }
  }
  if (body.calendlyWebhookSecret !== undefined) {
    if (body.calendlyWebhookSecret === null) {
      patch.calendlyWebhookSecret = null;
    } else if (typeof body.calendlyWebhookSecret === 'string') {
      const trimmed = body.calendlyWebhookSecret.trim();
      if (trimmed) patch.calendlyWebhookSecret = trimmed;
    } else {
      return res.status(400).json({ error: 'calendlyWebhookSecret must be a string or null' });
    }
  }

  try {
    const settings = await setDemoSchedulerSettings(patch, req.user!.userId);
    logger.info('Demo scheduler settings updated', {
      adminUserId: req.user!.userId,
      provider: settings.provider,
      embedUrl: settings.embedUrl,
      calcomConfigured: Boolean(settings.calcomWebhookSecretEncrypted),
      calendlyConfigured: Boolean(settings.calendlyWebhookSecretEncrypted),
    });
    return res.json({ settings: toAdminView(settings) });
  } catch (err) {
    if (err instanceof DemoSchedulerSettingsValidationError) {
      return res.status(400).json({ error: err.message });
    }
    logger.error('Failed to save demo scheduler settings', { error: String(err) });
    return res.status(500).json({ error: 'Failed to save demo scheduler settings' });
  }
});

// Checkout-session direction breakdown over the past N days, sourced
// from `billing.checkout_created` (success) and
// `billing.checkout_rejected` (strict-downgrade rejected at the
// /billing/checkout guard). `billing.downgrade_scheduled` is
// intentionally excluded so a single downgrade journey (rejected
// checkout → scheduled downgrade) isn't counted twice.
// `windowDays` is clamped to 1..365.
router.get(
  '/platform/checkout-directions',
  requireAuth,
  requirePlatformAdmin,
  async (req, res) => {
    const rawDays = parseInt(String(req.query.days ?? '30'), 10);
    const days = Number.isFinite(rawDays)
      ? Math.min(Math.max(rawDays, 1), 365)
      : 30;

    try {
      const data = await withPrivilegedClient(async (client) => {
        const { rows: byDayRows } = await client.query(
          `SELECT
             date_trunc('day', occurred_at) AS day,
             COALESCE(NULLIF(changes->>'direction', ''), 'unknown') AS direction,
             COUNT(*)::bigint AS count
           FROM audit_logs
           WHERE action IN ('billing.checkout_created', 'billing.checkout_rejected')
             AND occurred_at >= NOW() - make_interval(days => $1::int)
           GROUP BY day, direction
           ORDER BY day ASC, direction ASC`,
          [days],
        );

        const { rows: totalRows } = await client.query(
          `SELECT
             COALESCE(NULLIF(changes->>'direction', ''), 'unknown') AS direction,
             COUNT(*)::bigint AS count
           FROM audit_logs
           WHERE action IN ('billing.checkout_created', 'billing.checkout_rejected')
             AND occurred_at >= NOW() - make_interval(days => $1::int)
           GROUP BY direction`,
          [days],
        );

        const { rows: downgradeRows } = await client.query(
          `SELECT
             COALESCE(NULLIF(changes->>'fromPlan', ''), 'unknown') AS from_plan,
             COALESCE(NULLIF(changes->>'toPlan', ''),   'unknown') AS to_plan,
             COUNT(*)::bigint AS count
           FROM audit_logs
           WHERE action IN ('billing.checkout_created', 'billing.checkout_rejected')
             AND changes->>'direction' = 'downgrade'
             AND occurred_at >= NOW() - make_interval(days => $1::int)
           GROUP BY from_plan, to_plan
           ORDER BY count DESC, from_plan ASC, to_plan ASC
           LIMIT 10`,
          [days],
        );

        const ALLOWED_DIRECTIONS = new Set([
          'upgrade',
          'downgrade',
          'interval_change',
          'same',
          'new',
          'unknown',
        ]);
        const normalizeDirection = (raw: string): string =>
          ALLOWED_DIRECTIONS.has(raw) ? raw : 'unknown';

        const totals: Record<string, number> = {
          upgrade: 0,
          downgrade: 0,
          interval_change: 0,
          same: 0,
          new: 0,
          unknown: 0,
        };
        for (const row of totalRows as Array<{ direction: string; count: string }>) {
          const dir = normalizeDirection(row.direction);
          totals[dir] = (totals[dir] ?? 0) + (Number(row.count) || 0);
        }

        const byDay = (byDayRows as Array<{ day: Date; direction: string; count: string }>).map(
          (row) => ({
            day:
              row.day instanceof Date
                ? row.day.toISOString().slice(0, 10)
                : String(row.day).slice(0, 10),
            direction: normalizeDirection(row.direction),
            count: Number(row.count) || 0,
          }),
        );

        const topDowngradeTransitions = (downgradeRows as Array<{
          from_plan: string;
          to_plan: string;
          count: string;
        }>).map((row) => ({
          fromPlan: row.from_plan,
          toPlan: row.to_plan,
          count: Number(row.count) || 0,
        }));

        return { totals, byDay, topDowngradeTransitions };
      });

      return res.json({
        windowDays: days,
        ...data,
      });
    } catch (err) {
      logger.error('Failed to load checkout direction breakdown', {
        error: String(err),
      });
      return res.status(500).json({
        error: 'Failed to load checkout direction breakdown',
      });
    }
  },
);

// Trailing-30-day funnel for the BillingEstimator recommendation
// banner. Counts are sourced from `billing_recommendation_events`:
// impressions/clicks come from the tenant-facing route, switch_completed
// is written by the Stripe webhook for server-attributed conversions.
//
// In addition to the global funnel we expose:
//   * `byRecommendedTier` — per-recommended-tier (starter / pro / enterprise)
//     impressions, clicks, completed switches, and the realised
//     `monthly_savings_cents` sum for completed switches. This lets admins
//     see *which* tier the banner is actually moving MRR for.
//   * `switchPairs` — completed-switch counts and savings broken down by
//     (current_tier → recommended_tier) so the admin can see e.g.
//     "12 of 18 completed switches were Pro → Starter, $4.2k/mo saved".
//   * `totalMonthlySavingsCents` — sum of `monthly_savings_cents` across
//     every `switch_completed` row in the window.
const RECOMMENDATION_TIERS = ['starter', 'pro', 'enterprise'] as const;
type RecommendationTier = (typeof RECOMMENDATION_TIERS)[number];

// Order drives dashboard row order; tier-switch first since every
// pre-migration row falls into that bucket.
const RECOMMENDATION_PITCHES = ['tier-switch', 'annual-only'] as const;
type RecommendationPitch = (typeof RECOMMENDATION_PITCHES)[number];
const isRecommendationPitch = (value: unknown): value is RecommendationPitch =>
  typeof value === 'string' &&
  (RECOMMENDATION_PITCHES as readonly string[]).includes(value);
const isRecommendationTier = (value: unknown): value is RecommendationTier =>
  typeof value === 'string' &&
  (RECOMMENDATION_TIERS as readonly string[]).includes(value);

router.get(
  '/platform/billing-recommendations',
  requireAuth,
  requirePlatformAdmin,
  async (_req, res) => {
    try {
      // Per-recommended-tier funnel + savings. A single grouped query with
      // FILTER aggregates so we don't have to round-trip three times.
      const { rows: tierRows } = await withPrivilegedClient(async (client) => {
        return client.query(
          `SELECT
             recommended_tier,
             COUNT(*) FILTER (WHERE event_type = 'impression')::bigint
               AS impressions,
             COUNT(*) FILTER (WHERE event_type = 'click')::bigint
               AS clicks,
             COUNT(*) FILTER (WHERE event_type = 'switch_completed')::bigint
               AS completed_switches,
             COALESCE(
               SUM(monthly_savings_cents)
                 FILTER (WHERE event_type = 'switch_completed'),
               0
             )::bigint AS monthly_savings_cents
             FROM billing_recommendation_events
            WHERE created_at >= NOW() - INTERVAL '30 days'
            GROUP BY recommended_tier`,
        );
      });

      // Always render the three known tiers in a stable order, even when no
      // events exist for one of them, so the UI can render a deterministic
      // table without conditionally hiding rows.
      const tierIndex = new Map<RecommendationTier, {
        impressions: number;
        clicks: number;
        completedSwitches: number;
        monthlySavingsCents: number;
      }>();
      for (const raw of tierRows as Array<{
        recommended_tier: string;
        impressions: string;
        clicks: string;
        completed_switches: string;
        monthly_savings_cents: string;
      }>) {
        if (!isRecommendationTier(raw.recommended_tier)) continue;
        tierIndex.set(raw.recommended_tier, {
          impressions: Number(raw.impressions) || 0,
          clicks: Number(raw.clicks) || 0,
          completedSwitches: Number(raw.completed_switches) || 0,
          monthlySavingsCents: Number(raw.monthly_savings_cents) || 0,
        });
      }
      const byRecommendedTier = RECOMMENDATION_TIERS.map((tier) => ({
        recommendedTier: tier,
        impressions: tierIndex.get(tier)?.impressions ?? 0,
        clicks: tierIndex.get(tier)?.clicks ?? 0,
        completedSwitches: tierIndex.get(tier)?.completedSwitches ?? 0,
        monthlySavingsCents: tierIndex.get(tier)?.monthlySavingsCents ?? 0,
      }));

      const totals = byRecommendedTier.reduce(
        (acc, row) => ({
          impressions: acc.impressions + row.impressions,
          clicks: acc.clicks + row.clicks,
          completedSwitches: acc.completedSwitches + row.completedSwitches,
          monthlySavingsCents:
            acc.monthlySavingsCents + row.monthlySavingsCents,
        }),
        {
          impressions: 0,
          clicks: 0,
          completedSwitches: 0,
          monthlySavingsCents: 0,
        },
      );

      // Completed-switch breakdown by (current_tier → recommended_tier) so
      // the drawer can surface the dominant migration direction (e.g. the
      // "Pro → Starter" downgrade story).
      const { rows: pairRows } = await withPrivilegedClient(async (client) => {
        return client.query(
          `SELECT
             current_tier,
             recommended_tier,
             COUNT(*)::bigint AS completed_switches,
             COALESCE(SUM(monthly_savings_cents), 0)::bigint
               AS monthly_savings_cents
             FROM billing_recommendation_events
            WHERE event_type = 'switch_completed'
              AND created_at >= NOW() - INTERVAL '30 days'
            GROUP BY current_tier, recommended_tier
            ORDER BY completed_switches DESC, monthly_savings_cents DESC`,
        );
      });
      const switchPairs = (pairRows as Array<{
        current_tier: string;
        recommended_tier: string;
        completed_switches: string;
        monthly_savings_cents: string;
      }>)
        .filter(
          (r) =>
            isRecommendationTier(r.current_tier) &&
            isRecommendationTier(r.recommended_tier),
        )
        .map((r) => ({
          currentTier: r.current_tier as RecommendationTier,
          recommendedTier: r.recommended_tier as RecommendationTier,
          completedSwitches: Number(r.completed_switches) || 0,
          monthlySavingsCents: Number(r.monthly_savings_cents) || 0,
        }));

      // Unique-tenant counts let the tile show how many distinct tenants
      // engaged, not just total event volume. Distinct counts cannot be
      // safely derived from the per-tier query (a tenant who clicks on two
      // different recommendations would be double-counted), so this stays a
      // separate query.
      const { rows: tenantRows } = await withPrivilegedClient(async (client) => {
        return client.query(
          `SELECT
             COUNT(DISTINCT tenant_id) FILTER (WHERE event_type = 'click')::bigint
               AS tenants_clicked,
             COUNT(DISTINCT tenant_id) FILTER (WHERE event_type = 'switch_completed')::bigint
               AS tenants_switched
             FROM billing_recommendation_events
            WHERE created_at >= NOW() - INTERVAL '30 days'`,
        );
      });
      const tenantsClicked = Number(tenantRows[0]?.tenants_clicked ?? 0) || 0;
      const tenantsSwitched = Number(tenantRows[0]?.tenants_switched ?? 0) || 0;

      // Per-pitch funnel (tier-switch vs annual-only) for the dashboard.
      const { rows: pitchRows } = await withPrivilegedClient(async (client) => {
        return client.query(
          `SELECT
             pitch,
             COUNT(*) FILTER (WHERE event_type = 'impression')::bigint
               AS impressions,
             COUNT(*) FILTER (WHERE event_type = 'click')::bigint
               AS clicks,
             COUNT(*) FILTER (WHERE event_type = 'switch_completed')::bigint
               AS completed_switches,
             COALESCE(
               SUM(monthly_savings_cents)
                 FILTER (WHERE event_type = 'switch_completed'),
               0
             )::bigint AS monthly_savings_cents
             FROM billing_recommendation_events
            WHERE created_at >= NOW() - INTERVAL '30 days'
            GROUP BY pitch`,
        );
      });
      const pitchIndex = new Map<RecommendationPitch, {
        impressions: number;
        clicks: number;
        completedSwitches: number;
        monthlySavingsCents: number;
      }>();
      for (const raw of pitchRows as Array<{
        pitch: string;
        impressions: string;
        clicks: string;
        completed_switches: string;
        monthly_savings_cents: string;
      }>) {
        if (!isRecommendationPitch(raw.pitch)) continue;
        pitchIndex.set(raw.pitch, {
          impressions: Number(raw.impressions) || 0,
          clicks: Number(raw.clicks) || 0,
          completedSwitches: Number(raw.completed_switches) || 0,
          monthlySavingsCents: Number(raw.monthly_savings_cents) || 0,
        });
      }
      // Emit both pitches in stable order so empty buckets still render.
      const byPitch = RECOMMENDATION_PITCHES.map((pitch) => ({
        pitch,
        impressions: pitchIndex.get(pitch)?.impressions ?? 0,
        clicks: pitchIndex.get(pitch)?.clicks ?? 0,
        completedSwitches: pitchIndex.get(pitch)?.completedSwitches ?? 0,
        monthlySavingsCents: pitchIndex.get(pitch)?.monthlySavingsCents ?? 0,
      }));

      return res.json({
        windowDays: 30,
        impressions: totals.impressions,
        clicks: totals.clicks,
        completedSwitches: totals.completedSwitches,
        totalMonthlySavingsCents: totals.monthlySavingsCents,
        tenantsClicked,
        tenantsSwitched,
        // Computed server-side so consumers agree on divide-by-zero handling.
        clickThroughRate:
          totals.impressions > 0 ? totals.clicks / totals.impressions : 0,
        completionRate:
          totals.clicks > 0
            ? totals.completedSwitches / totals.clicks
            : 0,
        byRecommendedTier,
        byPitch,
        switchPairs,
      });
    } catch (err) {
      logger.error('Failed to load billing recommendation metrics', {
        error: String(err),
      });
      return res.status(500).json({
        error: 'Failed to load billing recommendation metrics',
      });
    }
  },
);

// Trailing-30-day funnel for the BillingEstimator's *upgrade-card
// discount badge*. Mirrors the recommendation funnel above but rolls
// up by the resolved (coupon_id, promotion_code) pair so admins can
// answer "which active discounts have been seen / clicked /
// completed?" — the source-of-truth question for whether a promo is
// pulling weight or just sitting in the coupon catalogue.
//
// Like the recommendation funnel, completions are server-attributed
// from the Stripe webhook (see webhook.ts) — the tenant route refuses
// 'discount_switch_completed', so a row of that type is always real.
router.get(
  '/platform/billing-discount-events',
  requireAuth,
  requirePlatformAdmin,
  async (_req, res) => {
    try {
      const { rows: discountRows } = await withPrivilegedClient(async (client) => {
        return client.query(
          `SELECT
             coupon_id,
             promotion_code,
             COUNT(*) FILTER (WHERE event_type = 'discount_impression')::bigint
               AS impressions,
             COUNT(*) FILTER (WHERE event_type = 'discount_click')::bigint
               AS clicks,
             COUNT(*) FILTER (WHERE event_type = 'discount_switch_completed')::bigint
               AS completed_switches,
             COUNT(DISTINCT tenant_id) FILTER (WHERE event_type = 'discount_click')::bigint
               AS tenants_clicked,
             COUNT(DISTINCT tenant_id) FILTER (WHERE event_type = 'discount_switch_completed')::bigint
               AS tenants_switched,
             MAX(created_at) AS last_seen_at
             FROM billing_recommendation_events
            WHERE event_type IN (
              'discount_impression',
              'discount_click',
              'discount_switch_completed'
            )
              AND created_at >= NOW() - INTERVAL '30 days'
            GROUP BY coupon_id, promotion_code
            ORDER BY impressions DESC, clicks DESC, last_seen_at DESC`,
        );
      });

      const byDiscount = (discountRows as Array<{
        coupon_id: string | null;
        promotion_code: string | null;
        impressions: string;
        clicks: string;
        completed_switches: string;
        tenants_clicked: string;
        tenants_switched: string;
        last_seen_at: Date | string | null;
      }>).map((r) => {
        const impressions = Number(r.impressions) || 0;
        const clicks = Number(r.clicks) || 0;
        const completedSwitches = Number(r.completed_switches) || 0;
        return {
          couponId: r.coupon_id,
          promotionCode: r.promotion_code,
          impressions,
          clicks,
          completedSwitches,
          tenantsClicked: Number(r.tenants_clicked) || 0,
          tenantsSwitched: Number(r.tenants_switched) || 0,
          // Computed server-side so consumers agree on divide-by-zero.
          clickThroughRate: impressions > 0 ? clicks / impressions : 0,
          completionRate: clicks > 0 ? completedSwitches / clicks : 0,
          lastSeenAt:
            r.last_seen_at instanceof Date
              ? r.last_seen_at.toISOString()
              : r.last_seen_at ?? null,
        };
      });

      const totals = byDiscount.reduce(
        (acc, row) => ({
          impressions: acc.impressions + row.impressions,
          clicks: acc.clicks + row.clicks,
          completedSwitches: acc.completedSwitches + row.completedSwitches,
        }),
        { impressions: 0, clicks: 0, completedSwitches: 0 },
      );

      return res.json({
        windowDays: 30,
        impressions: totals.impressions,
        clicks: totals.clicks,
        completedSwitches: totals.completedSwitches,
        clickThroughRate:
          totals.impressions > 0 ? totals.clicks / totals.impressions : 0,
        completionRate:
          totals.clicks > 0
            ? totals.completedSwitches / totals.clicks
            : 0,
        byDiscount,
      });
    } catch (err) {
      logger.error('Failed to load billing discount metrics', {
        error: String(err),
      });
      return res.status(500).json({
        error: 'Failed to load billing discount metrics',
      });
    }
  },
);

export default router;
