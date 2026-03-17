import { Router } from 'express';
import { getPlatformPool, withTenantContext } from '../../../platform/db';
import { requireAuth } from '../middleware/auth';
import { requireRole } from '../middleware/rbac';
import { createLogger } from '../../../platform/core/logger';
import { WorkforceRoutingService } from '../../../platform/workforce/WorkforceRoutingService';
import { WorkforceOptimizationEngine } from '../../../platform/workforce/WorkforceOptimizationEngine';
import { WorkforceRevenueService } from '../../../platform/workforce/WorkforceRevenueService';
import { WorkforceOutboundService } from '../../../platform/workforce/WorkforceOutboundService';

const router = Router();
const logger = createLogger('ADMIN_WORKFORCE');
const routingService = new WorkforceRoutingService();
const optimizationEngine = new WorkforceOptimizationEngine();
const revenueService = new WorkforceRevenueService();
const outboundService = new WorkforceOutboundService();

function paginate(req: { query: Record<string, unknown> }): { limit: number; offset: number } {
  const limit = Math.min(parseInt(String(req.query.limit ?? '20'), 10), 100);
  const page = Math.max(parseInt(String(req.query.page ?? '1'), 10), 1);
  return { limit, offset: (page - 1) * limit };
}

router.get('/workforce/teams', requireAuth, async (req, res) => {
  const tenantId = req.user!.tenantId;
  const { limit, offset } = paginate(req);
  const pool = getPlatformPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await withTenantContext(client, tenantId, async () => {
      const { rows: teams } = await client.query(
        `SELECT t.*,
                (SELECT COUNT(*)::int FROM workforce_members m WHERE m.team_id = t.id AND m.status = 'active') as member_count
         FROM workforce_teams t
         ORDER BY t.created_at DESC
         LIMIT $1 OFFSET $2`,
        [limit, offset],
      );
      const { rows: countRows } = await client.query(
        `SELECT COUNT(*)::int as total FROM workforce_teams`,
      );
      await client.query('COMMIT');
      res.json({ teams, total: countRows[0]?.total ?? 0 });
    });
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error('Failed to list teams', { tenantId, error: String(err) });
    res.status(500).json({ error: 'Failed to list workforce teams' });
  } finally {
    client.release();
  }
});

router.get('/workforce/teams/:id', requireAuth, async (req, res) => {
  const tenantId = req.user!.tenantId;
  const teamId = req.params.id;
  const pool = getPlatformPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await withTenantContext(client, tenantId, async () => {
      const { rows } = await client.query(
        `SELECT * FROM workforce_teams WHERE id = $1`,
        [teamId],
      );
      await client.query('COMMIT');
      if (rows.length === 0) {
        res.status(404).json({ error: 'Team not found' });
        return;
      }
      const members = await routingService.getTeamMembers(tenantId, teamId);
      const rules = await routingService.getRoutingRules(tenantId, teamId);
      res.json({ team: rows[0], members, routingRules: rules });
    });
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error('Failed to get team', { tenantId, teamId, error: String(err) });
    res.status(500).json({ error: 'Failed to get team details' });
  } finally {
    client.release();
  }
});

router.post('/workforce/teams', requireAuth, requireRole('manager'), async (req, res) => {
  const tenantId = req.user!.tenantId;
  const { name, description, metadata } = req.body;

  if (!name || typeof name !== 'string') {
    res.status(400).json({ error: 'name is required' });
    return;
  }

  const pool = getPlatformPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await withTenantContext(client, tenantId, async () => {
      const { rows } = await client.query(
        `INSERT INTO workforce_teams (tenant_id, name, description, metadata)
         VALUES ($1, $2, $3, $4)
         RETURNING *`,
        [tenantId, name, description ?? null, JSON.stringify(metadata ?? {})],
      );
      await client.query('COMMIT');
      res.status(201).json({ team: rows[0] });
    });
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error('Failed to create team', { tenantId, error: String(err) });
    res.status(500).json({ error: 'Failed to create team' });
  } finally {
    client.release();
  }
});

router.patch('/workforce/teams/:id', requireAuth, requireRole('manager'), async (req, res) => {
  const tenantId = req.user!.tenantId;
  const teamId = req.params.id;
  const { name, description, status, metadata } = req.body;

  const pool = getPlatformPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await withTenantContext(client, tenantId, async () => {
      const updates: string[] = [];
      const values: unknown[] = [];
      let idx = 1;

      if (name !== undefined) { updates.push(`name = $${idx++}`); values.push(name); }
      if (description !== undefined) { updates.push(`description = $${idx++}`); values.push(description); }
      if (status !== undefined) { updates.push(`status = $${idx++}`); values.push(status); }
      if (metadata !== undefined) { updates.push(`metadata = $${idx++}`); values.push(JSON.stringify(metadata)); }
      updates.push(`updated_at = NOW()`);

      if (updates.length <= 1) {
        await client.query('COMMIT');
        res.status(400).json({ error: 'No fields to update' });
        return;
      }

      values.push(teamId);
      const { rows } = await client.query(
        `UPDATE workforce_teams SET ${updates.join(', ')} WHERE id = $${idx} RETURNING *`,
        values,
      );
      await client.query('COMMIT');

      if (rows.length === 0) {
        res.status(404).json({ error: 'Team not found' });
        return;
      }
      res.json({ team: rows[0] });
    });
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error('Failed to update team', { tenantId, teamId, error: String(err) });
    res.status(500).json({ error: 'Failed to update team' });
  } finally {
    client.release();
  }
});

router.delete('/workforce/teams/:id', requireAuth, requireRole('manager'), async (req, res) => {
  const tenantId = req.user!.tenantId;
  const teamId = req.params.id;
  const pool = getPlatformPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await withTenantContext(client, tenantId, async () => {
      await client.query(`DELETE FROM workforce_teams WHERE id = $1`, [teamId]);
      await client.query('COMMIT');
      res.sendStatus(204);
    });
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error('Failed to delete team', { tenantId, teamId, error: String(err) });
    res.status(500).json({ error: 'Failed to delete team' });
  } finally {
    client.release();
  }
});

router.post('/workforce/teams/:id/members', requireAuth, requireRole('manager'), async (req, res) => {
  const tenantId = req.user!.tenantId;
  const teamId = req.params.id;
  const { agent_id, role, is_receptionist, priority, metadata } = req.body;

  if (!agent_id) {
    res.status(400).json({ error: 'agent_id is required' });
    return;
  }

  const pool = getPlatformPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await withTenantContext(client, tenantId, async () => {
      const { rows: teamRows } = await client.query(
        `SELECT id FROM workforce_teams WHERE id = $1 AND tenant_id = $2`,
        [teamId, tenantId],
      );
      if (teamRows.length === 0) {
        await client.query('ROLLBACK');
        res.status(404).json({ error: 'Team not found' });
        return;
      }

      const { rows: agentRows } = await client.query(
        `SELECT id FROM agents WHERE id = $1 AND tenant_id = $2`,
        [agent_id, tenantId],
      );
      if (agentRows.length === 0) {
        await client.query('ROLLBACK');
        res.status(400).json({ error: 'Agent not found in this tenant' });
        return;
      }

      if (is_receptionist) {
        await client.query(
          `UPDATE workforce_members SET is_receptionist = false WHERE team_id = $1`,
          [teamId],
        );
      }

      const { rows } = await client.query(
        `INSERT INTO workforce_members (team_id, agent_id, tenant_id, role, is_receptionist, priority, metadata)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING *`,
        [teamId, agent_id, tenantId, role ?? 'specialist', is_receptionist ?? false, priority ?? 0, JSON.stringify(metadata ?? {})],
      );
      await client.query('COMMIT');
      res.status(201).json({ member: rows[0] });
    });
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error('Failed to add team member', { tenantId, teamId, error: String(err) });
    res.status(500).json({ error: 'Failed to add team member' });
  } finally {
    client.release();
  }
});

router.patch('/workforce/members/:id', requireAuth, requireRole('manager'), async (req, res) => {
  const tenantId = req.user!.tenantId;
  const memberId = req.params.id;
  const { role, is_receptionist, priority, status, metadata } = req.body;

  const pool = getPlatformPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await withTenantContext(client, tenantId, async () => {
      if (is_receptionist) {
        const { rows: memberRows } = await client.query(
          `SELECT team_id FROM workforce_members WHERE id = $1`,
          [memberId],
        );
        if (memberRows[0]) {
          await client.query(
            `UPDATE workforce_members SET is_receptionist = false WHERE team_id = $1`,
            [memberRows[0].team_id],
          );
        }
      }

      const updates: string[] = [];
      const values: unknown[] = [];
      let idx = 1;

      if (role !== undefined) { updates.push(`role = $${idx++}`); values.push(role); }
      if (is_receptionist !== undefined) { updates.push(`is_receptionist = $${idx++}`); values.push(is_receptionist); }
      if (priority !== undefined) { updates.push(`priority = $${idx++}`); values.push(priority); }
      if (status !== undefined) { updates.push(`status = $${idx++}`); values.push(status); }
      if (metadata !== undefined) { updates.push(`metadata = $${idx++}`); values.push(JSON.stringify(metadata)); }
      updates.push(`updated_at = NOW()`);

      values.push(memberId);
      const { rows } = await client.query(
        `UPDATE workforce_members SET ${updates.join(', ')} WHERE id = $${idx} RETURNING *`,
        values,
      );
      await client.query('COMMIT');

      if (rows.length === 0) {
        res.status(404).json({ error: 'Member not found' });
        return;
      }
      res.json({ member: rows[0] });
    });
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error('Failed to update member', { tenantId, memberId, error: String(err) });
    res.status(500).json({ error: 'Failed to update member' });
  } finally {
    client.release();
  }
});

router.delete('/workforce/members/:id', requireAuth, requireRole('manager'), async (req, res) => {
  const tenantId = req.user!.tenantId;
  const memberId = req.params.id;
  const pool = getPlatformPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await withTenantContext(client, tenantId, async () => {
      await client.query(`DELETE FROM workforce_members WHERE id = $1`, [memberId]);
      await client.query('COMMIT');
      res.sendStatus(204);
    });
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error('Failed to delete member', { tenantId, memberId, error: String(err) });
    res.status(500).json({ error: 'Failed to delete member' });
  } finally {
    client.release();
  }
});

router.post('/workforce/teams/:id/routing-rules', requireAuth, requireRole('manager'), async (req, res) => {
  const tenantId = req.user!.tenantId;
  const teamId = req.params.id;
  const { intent, target_member_id, fallback_member_id, priority, conditions } = req.body;

  if (!intent || !target_member_id) {
    res.status(400).json({ error: 'intent and target_member_id are required' });
    return;
  }

  const pool = getPlatformPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await withTenantContext(client, tenantId, async () => {
      const { rows: teamRows } = await client.query(
        `SELECT id FROM workforce_teams WHERE id = $1 AND tenant_id = $2`,
        [teamId, tenantId],
      );
      if (teamRows.length === 0) {
        await client.query('ROLLBACK');
        res.status(404).json({ error: 'Team not found' });
        return;
      }

      const { rows: memberRows } = await client.query(
        `SELECT id FROM workforce_members WHERE id = $1 AND team_id = $2 AND tenant_id = $3`,
        [target_member_id, teamId, tenantId],
      );
      if (memberRows.length === 0) {
        await client.query('ROLLBACK');
        res.status(400).json({ error: 'Target member not found in this team' });
        return;
      }

      if (fallback_member_id) {
        const { rows: fallbackRows } = await client.query(
          `SELECT id FROM workforce_members WHERE id = $1 AND team_id = $2 AND tenant_id = $3`,
          [fallback_member_id, teamId, tenantId],
        );
        if (fallbackRows.length === 0) {
          await client.query('ROLLBACK');
          res.status(400).json({ error: 'Fallback member not found in this team' });
          return;
        }
      }

      const { rows } = await client.query(
        `INSERT INTO workforce_routing_rules (team_id, tenant_id, intent, target_member_id, fallback_member_id, priority, conditions)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING *`,
        [teamId, tenantId, intent, target_member_id, fallback_member_id ?? null, priority ?? 0, JSON.stringify(conditions ?? {})],
      );
      await client.query('COMMIT');
      res.status(201).json({ rule: rows[0] });
    });
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error('Failed to create routing rule', { tenantId, teamId, error: String(err) });
    res.status(500).json({ error: 'Failed to create routing rule' });
  } finally {
    client.release();
  }
});

router.patch('/workforce/routing-rules/:id', requireAuth, requireRole('manager'), async (req, res) => {
  const tenantId = req.user!.tenantId;
  const ruleId = req.params.id;
  const { intent, target_member_id, fallback_member_id, priority, conditions, status } = req.body;

  const pool = getPlatformPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await withTenantContext(client, tenantId, async () => {
      const updates: string[] = [];
      const values: unknown[] = [];
      let idx = 1;

      if (intent !== undefined) { updates.push(`intent = $${idx++}`); values.push(intent); }
      if (target_member_id !== undefined) { updates.push(`target_member_id = $${idx++}`); values.push(target_member_id); }
      if (fallback_member_id !== undefined) { updates.push(`fallback_member_id = $${idx++}`); values.push(fallback_member_id); }
      if (priority !== undefined) { updates.push(`priority = $${idx++}`); values.push(priority); }
      if (conditions !== undefined) { updates.push(`conditions = $${idx++}`); values.push(JSON.stringify(conditions)); }
      if (status !== undefined) { updates.push(`status = $${idx++}`); values.push(status); }
      updates.push(`updated_at = NOW()`);

      values.push(ruleId);
      const { rows } = await client.query(
        `UPDATE workforce_routing_rules SET ${updates.join(', ')} WHERE id = $${idx} RETURNING *`,
        values,
      );
      await client.query('COMMIT');

      if (rows.length === 0) {
        res.status(404).json({ error: 'Routing rule not found' });
        return;
      }
      res.json({ rule: rows[0] });
    });
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error('Failed to update routing rule', { tenantId, ruleId, error: String(err) });
    res.status(500).json({ error: 'Failed to update routing rule' });
  } finally {
    client.release();
  }
});

router.delete('/workforce/routing-rules/:id', requireAuth, requireRole('manager'), async (req, res) => {
  const tenantId = req.user!.tenantId;
  const ruleId = req.params.id;
  const pool = getPlatformPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await withTenantContext(client, tenantId, async () => {
      await client.query(`DELETE FROM workforce_routing_rules WHERE id = $1`, [ruleId]);
      await client.query('COMMIT');
      res.sendStatus(204);
    });
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error('Failed to delete routing rule', { tenantId, ruleId, error: String(err) });
    res.status(500).json({ error: 'Failed to delete routing rule' });
  } finally {
    client.release();
  }
});

router.get('/workforce/teams/:id/metrics', requireAuth, async (req, res) => {
  const tenantId = req.user!.tenantId;
  const teamId = req.params.id;
  try {
    const metrics = await routingService.getTeamMetrics(tenantId, teamId);
    res.json({ metrics });
  } catch (err) {
    logger.error('Failed to get team metrics', { tenantId, teamId, error: String(err) });
    res.status(500).json({ error: 'Failed to get team metrics' });
  }
});

router.get('/workforce/teams/:id/history', requireAuth, async (req, res) => {
  const tenantId = req.user!.tenantId;
  const teamId = req.params.id;
  const { limit: lim, offset: off } = paginate(req);
  const pool = getPlatformPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await withTenantContext(client, tenantId, async () => {
      const { rows } = await client.query(
        `SELECT rh.*,
                fa.name as from_agent_name,
                ta.name as to_agent_name
         FROM workforce_routing_history rh
         JOIN agents fa ON fa.id = rh.from_agent_id
         JOIN agents ta ON ta.id = rh.to_agent_id
         WHERE rh.team_id = $1
         ORDER BY rh.created_at DESC
         LIMIT $2 OFFSET $3`,
        [teamId, lim, off],
      );
      const { rows: countRows } = await client.query(
        `SELECT COUNT(*)::int as total FROM workforce_routing_history WHERE team_id = $1`,
        [teamId],
      );
      await client.query('COMMIT');
      res.json({ history: rows, total: countRows[0]?.total ?? 0 });
    });
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error('Failed to get routing history', { tenantId, teamId, error: String(err) });
    res.status(500).json({ error: 'Failed to get routing history' });
  } finally {
    client.release();
  }
});

router.get('/workforce/templates', requireAuth, async (req, res) => {
  const tenantId = req.user!.tenantId;
  const pool = getPlatformPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await withTenantContext(client, tenantId, async () => {
      const { rows } = await client.query(
        `SELECT * FROM workforce_templates
         WHERE is_system = true OR tenant_id = $1
         ORDER BY is_system DESC, created_at DESC`,
        [tenantId],
      );
      await client.query('COMMIT');
      res.json({ templates: rows });
    });
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error('Failed to list templates', { tenantId, error: String(err) });
    res.status(500).json({ error: 'Failed to list workforce templates' });
  } finally {
    client.release();
  }
});

router.post('/workforce/templates', requireAuth, requireRole('manager'), async (req, res) => {
  const tenantId = req.user!.tenantId;
  const { name, description, vertical, template_config } = req.body;

  if (!name || !template_config) {
    res.status(400).json({ error: 'name and template_config are required' });
    return;
  }

  const pool = getPlatformPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await withTenantContext(client, tenantId, async () => {
      const { rows } = await client.query(
        `INSERT INTO workforce_templates (tenant_id, name, description, vertical, template_config)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING *`,
        [tenantId, name, description ?? null, vertical ?? null, JSON.stringify(template_config)],
      );
      await client.query('COMMIT');
      res.status(201).json({ template: rows[0] });
    });
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error('Failed to create template', { tenantId, error: String(err) });
    res.status(500).json({ error: 'Failed to create template' });
  } finally {
    client.release();
  }
});

router.get('/workforce/teams/:id/optimization-insights', requireAuth, async (req, res) => {
  const tenantId = req.user!.tenantId;
  const teamId = req.params.id;
  const status = req.query.status as string | undefined;
  const { limit, offset } = paginate(req);

  try {
    const result = await optimizationEngine.getInsights(tenantId, teamId, { status, limit, offset });
    res.json(result);
  } catch (err) {
    logger.error('Failed to get optimization insights', { tenantId, teamId, error: String(err) });
    res.status(500).json({ error: 'Failed to get optimization insights' });
  }
});

router.post('/workforce/teams/:id/optimization-insights/analyze', requireAuth, requireRole('manager'), async (req, res) => {
  const tenantId = req.user!.tenantId;
  const teamId = req.params.id;

  try {
    const insights = await optimizationEngine.runAnalysis(tenantId, teamId);
    res.json({ insights, count: insights.length });
  } catch (err) {
    logger.error('Failed to run optimization analysis', { tenantId, teamId, error: String(err) });
    res.status(500).json({ error: 'Failed to run optimization analysis' });
  }
});

router.patch('/workforce/optimization-insights/:id/acknowledge', requireAuth, requireRole('manager'), async (req, res) => {
  const tenantId = req.user!.tenantId;
  const insightId = req.params.id;
  const userId = req.user!.userId;

  try {
    const insight = await optimizationEngine.acknowledgeInsight(tenantId, insightId, userId);
    if (!insight) {
      res.status(404).json({ error: 'Insight not found' });
      return;
    }
    res.json({ insight });
  } catch (err) {
    logger.error('Failed to acknowledge insight', { tenantId, insightId, error: String(err) });
    res.status(500).json({ error: 'Failed to acknowledge insight' });
  }
});

router.patch('/workforce/optimization-insights/:id/dismiss', requireAuth, requireRole('manager'), async (req, res) => {
  const tenantId = req.user!.tenantId;
  const insightId = req.params.id;

  try {
    const insight = await optimizationEngine.dismissInsight(tenantId, insightId);
    if (!insight) {
      res.status(404).json({ error: 'Insight not found' });
      return;
    }
    res.json({ insight });
  } catch (err) {
    logger.error('Failed to dismiss insight', { tenantId, insightId, error: String(err) });
    res.status(500).json({ error: 'Failed to dismiss insight' });
  }
});

router.get('/workforce/teams/:id/revenue-metrics', requireAuth, async (req, res) => {
  const tenantId = req.user!.tenantId;
  const teamId = req.params.id;

  try {
    const latest = await revenueService.getLatestMetrics(tenantId, teamId);
    res.json({ metrics: latest });
  } catch (err) {
    logger.error('Failed to get revenue metrics', { tenantId, teamId, error: String(err) });
    res.status(500).json({ error: 'Failed to get revenue metrics' });
  }
});

router.post('/workforce/teams/:id/revenue-metrics/calculate', requireAuth, requireRole('manager'), async (req, res) => {
  const tenantId = req.user!.tenantId;
  const teamId = req.params.id;
  const { avgTicketValueCents } = req.body;

  if (avgTicketValueCents !== undefined) {
    if (typeof avgTicketValueCents !== 'number' || avgTicketValueCents < 0 || avgTicketValueCents > 10000000) {
      res.status(400).json({ error: 'avgTicketValueCents must be a number between 0 and 10000000' });
      return;
    }
  }

  try {
    const now = new Date();
    const from = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const metrics = await revenueService.calculateMetrics(
      tenantId, teamId, from, now,
      typeof avgTicketValueCents === 'number' ? avgTicketValueCents : undefined,
    );
    res.json({ metrics });
  } catch (err) {
    logger.error('Failed to calculate revenue metrics', { tenantId, teamId, error: String(err) });
    res.status(500).json({ error: 'Failed to calculate revenue metrics' });
  }
});

router.get('/workforce/teams/:id/revenue-metrics/history', requireAuth, async (req, res) => {
  const tenantId = req.user!.tenantId;
  const teamId = req.params.id;
  const limit = Math.min(parseInt(String(req.query.limit ?? '12'), 10), 52);

  try {
    const history = await revenueService.getMetricsHistory(tenantId, teamId, limit);
    res.json({ history });
  } catch (err) {
    logger.error('Failed to get revenue metrics history', { tenantId, teamId, error: String(err) });
    res.status(500).json({ error: 'Failed to get revenue metrics history' });
  }
});

router.get('/workforce/teams/:id/revenue-attribution', requireAuth, async (req, res) => {
  const tenantId = req.user!.tenantId;
  const teamId = req.params.id;
  const days = Math.min(parseInt(String(req.query.days ?? '7'), 10), 90);
  const avgTicketValueCents = req.query.avgTicketValueCents ? parseInt(String(req.query.avgTicketValueCents), 10) : 15000;
  const to = new Date();
  const from = new Date(to.getTime() - days * 24 * 60 * 60 * 1000);

  try {
    const attribution = await revenueService.getAttributionForTeam(tenantId, teamId, from, to, avgTicketValueCents);
    res.json({ attribution });
  } catch (err) {
    logger.error('Failed to get revenue attribution', { tenantId, teamId, error: String(err) });
    res.status(500).json({ error: 'Failed to get revenue attribution' });
  }
});

router.get('/workforce/teams/:id/outbound-tasks', requireAuth, async (req, res) => {
  const tenantId = req.user!.tenantId;
  const teamId = req.params.id;
  const status = req.query.status as string | undefined;
  const { limit, offset } = paginate(req);

  try {
    const result = await outboundService.listTasks(tenantId, teamId, { status, limit, offset });
    res.json(result);
  } catch (err) {
    logger.error('Failed to list outbound tasks', { tenantId, teamId, error: String(err) });
    res.status(500).json({ error: 'Failed to list outbound tasks' });
  }
});

const VALID_CAMPAIGN_TYPES = [
  'appointment_reminder', 'follow_up', 'maintenance_reminder', 'review_request',
  'reactivation', 'recall', 'lease_renewal', 'custom',
] as const;

const VALID_OUTBOUND_STATUSES = ['draft', 'scheduled', 'running', 'paused', 'completed', 'cancelled'] as const;

router.post('/workforce/teams/:id/outbound-tasks', requireAuth, requireRole('manager'), async (req, res) => {
  const tenantId = req.user!.tenantId;
  const teamId = req.params.id;
  const { campaignType, name, config, scheduledAt } = req.body;

  if (!campaignType || !name) {
    res.status(400).json({ error: 'campaignType and name are required' });
    return;
  }

  if (!VALID_CAMPAIGN_TYPES.includes(campaignType)) {
    res.status(400).json({ error: `Invalid campaignType. Must be one of: ${VALID_CAMPAIGN_TYPES.join(', ')}` });
    return;
  }

  try {
    const task = await outboundService.createTask(tenantId, teamId, {
      campaignType,
      name,
      config,
      scheduledAt,
      createdBy: req.user!.userId,
    });
    res.status(201).json({ task });
  } catch (err) {
    logger.error('Failed to create outbound task', { tenantId, teamId, error: String(err) });
    res.status(500).json({ error: 'Failed to create outbound task' });
  }
});

router.patch('/workforce/outbound-tasks/:id/status', requireAuth, requireRole('manager'), async (req, res) => {
  const tenantId = req.user!.tenantId;
  const taskId = req.params.id;
  const { status, campaignId, totalContacts, contactsReached } = req.body;

  if (!status) {
    res.status(400).json({ error: 'status is required' });
    return;
  }

  if (!VALID_OUTBOUND_STATUSES.includes(status)) {
    res.status(400).json({ error: `Invalid status. Must be one of: ${VALID_OUTBOUND_STATUSES.join(', ')}` });
    return;
  }

  if (totalContacts !== undefined && (typeof totalContacts !== 'number' || totalContacts < 0)) {
    res.status(400).json({ error: 'totalContacts must be a non-negative number' });
    return;
  }

  if (contactsReached !== undefined && (typeof contactsReached !== 'number' || contactsReached < 0)) {
    res.status(400).json({ error: 'contactsReached must be a non-negative number' });
    return;
  }

  try {
    const task = await outboundService.updateTaskStatus(tenantId, taskId, status, {
      campaignId, totalContacts, contactsReached,
    });
    if (!task) {
      res.status(404).json({ error: 'Outbound task not found' });
      return;
    }
    res.json({ task });
  } catch (err) {
    logger.error('Failed to update outbound task', { tenantId, taskId, error: String(err) });
    res.status(500).json({ error: 'Failed to update outbound task' });
  }
});

router.post('/workforce/outbound-tasks/:id/launch', requireAuth, requireRole('manager'), async (req, res) => {
  const tenantId = req.user!.tenantId;
  const taskId = req.params.id;
  const { agentId, contacts } = req.body;

  if (!agentId) {
    res.status(400).json({ error: 'agentId is required to launch an outbound campaign' });
    return;
  }

  if (!Array.isArray(contacts) || contacts.length === 0) {
    res.status(400).json({ error: 'contacts array is required (each with phoneNumber)' });
    return;
  }

  try {
    const task = await outboundService.launchTask(tenantId, taskId, { agentId, contacts });
    res.json({ task, message: `Campaign launched with ${contacts.length} contacts via CampaignScheduler` });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('not found') || msg.includes('must be')) {
      res.status(400).json({ error: msg });
      return;
    }
    logger.error('Failed to launch outbound task', { tenantId, taskId, error: String(err) });
    res.status(500).json({ error: 'Failed to launch outbound task' });
  }
});

router.post('/workforce/outbound-tasks/:id/sync', requireAuth, requireRole('manager'), async (req, res) => {
  const tenantId = req.user!.tenantId;
  const taskId = req.params.id;

  try {
    const task = await outboundService.syncTaskFromCampaign(tenantId, taskId);
    if (!task) {
      res.status(404).json({ error: 'Outbound task not found' });
      return;
    }
    res.json({ task });
  } catch (err) {
    logger.error('Failed to sync outbound task', { tenantId, taskId, error: String(err) });
    res.status(500).json({ error: 'Failed to sync outbound task status' });
  }
});

router.delete('/workforce/outbound-tasks/:id', requireAuth, requireRole('manager'), async (req, res) => {
  const tenantId = req.user!.tenantId;
  const taskId = req.params.id;

  try {
    const deleted = await outboundService.deleteTask(tenantId, taskId);
    if (!deleted) {
      res.status(404).json({ error: 'Task not found or cannot be deleted (must be draft or cancelled)' });
      return;
    }
    res.sendStatus(204);
  } catch (err) {
    logger.error('Failed to delete outbound task', { tenantId, taskId, error: String(err) });
    res.status(500).json({ error: 'Failed to delete outbound task' });
  }
});

router.post('/workforce/teams/:id/prompt-proposals', requireAuth, requireRole('manager'), async (req, res) => {
  const tenantId = req.user!.tenantId;
  const teamId = req.params.id;

  try {
    const proposals = await optimizationEngine.generatePromptProposals(tenantId, teamId);
    res.json({ proposals, count: proposals.length });
  } catch (err) {
    logger.error('Failed to generate prompt proposals', { tenantId, teamId, error: String(err) });
    res.status(500).json({ error: 'Failed to generate prompt improvement proposals' });
  }
});

router.post('/workforce/teams/:id/validate-proposal', requireAuth, requireRole('manager'), async (req, res) => {
  const tenantId = req.user!.tenantId;
  const teamId = req.params.id;
  const { agentId } = req.body;

  if (!agentId) {
    res.status(400).json({ error: 'agentId is required' });
    return;
  }

  try {
    const result = await optimizationEngine.validateProposalWithSimulation(tenantId, teamId, agentId);
    if (!result) {
      res.json({ message: 'No simulation scenarios available for validation', result: null });
      return;
    }
    res.json({ result });
  } catch (err) {
    logger.error('Failed to validate proposal', { tenantId, teamId, error: String(err) });
    res.status(500).json({ error: 'Failed to validate prompt proposal via simulation' });
  }
});

router.get('/workforce/teams/:id/deployment-recommendations', requireAuth, async (req, res) => {
  const tenantId = req.user!.tenantId;
  const teamId = req.params.id;

  try {
    const recommendations = await optimizationEngine.generateDeploymentRecommendations(tenantId, teamId);
    res.json({ recommendations, count: recommendations.length });
  } catch (err) {
    logger.error('Failed to generate deployment recommendations', { tenantId, teamId, error: String(err) });
    res.status(500).json({ error: 'Failed to generate deployment recommendations' });
  }
});

router.post('/workforce/templates/:id/deploy', requireAuth, requireRole('manager'), async (req, res) => {
  const tenantId = req.user!.tenantId;
  const templateId = req.params.id;
  const { teamName, agentAssignments } = req.body;

  const pool = getPlatformPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await withTenantContext(client, tenantId, async () => {
      const { rows: tplRows } = await client.query(
        `SELECT * FROM workforce_templates WHERE id = $1 AND (is_system = true OR tenant_id = $2)`,
        [templateId, tenantId],
      );
      if (tplRows.length === 0) {
        await client.query('ROLLBACK');
        res.status(404).json({ error: 'Template not found' });
        return;
      }

      const template = tplRows[0];
      const config = template.template_config as {
        roles: Array<{ role: string; agentType: string; isReceptionist: boolean; description: string }>;
        routingRules: Array<{ intent: string; targetRole: string; fallbackRole?: string }>;
        outboundAutomations?: Array<{ type: string; description: string }>;
      };

      const name = teamName || `${template.name} Team`;

      const { rows: teamRows } = await client.query(
        `INSERT INTO workforce_teams (tenant_id, name, description, metadata)
         VALUES ($1, $2, $3, $4)
         RETURNING *`,
        [tenantId, name, template.description, JSON.stringify({
          templateId, vertical: template.vertical,
          templateRoles: config.roles,
          templateRoutingRules: config.routingRules,
          outboundAutomations: config.outboundAutomations ?? [],
        })],
      );

      const team = teamRows[0];
      const teamId = team.id as string;

      const assignments = (agentAssignments ?? {}) as Record<string, string>;
      const roleMemberMap: Record<string, string> = {};

      for (const roleDef of config.roles) {
        const agentId = assignments[roleDef.role];
        if (agentId) {
          const { rows: agentRows } = await client.query(
            `SELECT id FROM agents WHERE id = $1 AND tenant_id = $2`,
            [agentId, tenantId],
          );
          if (agentRows.length > 0) {
            const { rows: memberRows } = await client.query(
              `INSERT INTO workforce_members (team_id, agent_id, tenant_id, role, is_receptionist, priority, metadata)
               VALUES ($1, $2, $3, $4, $5, $6, $7)
               RETURNING id`,
              [teamId, agentId, tenantId, roleDef.role, roleDef.isReceptionist, 0,
               JSON.stringify({ agentType: roleDef.agentType, description: roleDef.description, fromTemplate: true })],
            );
            if (memberRows[0]) {
              roleMemberMap[roleDef.role] = memberRows[0].id as string;
            }
          }
        }
      }

      const deployedRules: Array<Record<string, unknown>> = [];
      for (const rule of config.routingRules) {
        const targetMemberId = roleMemberMap[rule.targetRole];
        const fallbackMemberId = rule.fallbackRole ? roleMemberMap[rule.fallbackRole] : null;

        if (targetMemberId) {
          const { rows: ruleRows } = await client.query(
            `INSERT INTO workforce_routing_rules (team_id, tenant_id, intent, target_member_id, fallback_member_id, priority, conditions)
             VALUES ($1, $2, $3, $4, $5, 0, $6)
             RETURNING *`,
            [teamId, tenantId, rule.intent, targetMemberId, fallbackMemberId ?? null,
             JSON.stringify({ targetRole: rule.targetRole, fallbackRole: rule.fallbackRole, fromTemplate: true })],
          );
          if (ruleRows[0]) deployedRules.push(ruleRows[0]);
        }
      }

      await client.query('COMMIT');

      const assignedRoles = Object.keys(roleMemberMap);
      const unassignedRoles = config.roles.filter((r) => !assignedRoles.includes(r.role));

      res.status(201).json({
        team,
        membersCreated: assignedRoles.length,
        routingRulesCreated: deployedRules.length,
        unassignedRoles: unassignedRoles.map((r) => ({ role: r.role, agentType: r.agentType, description: r.description })),
        message: unassignedRoles.length > 0
          ? `Team "${name}" deployed from template with ${assignedRoles.length} agents assigned. ${unassignedRoles.length} role(s) still need agents: ${unassignedRoles.map((r) => r.role).join(', ')}`
          : `Team "${name}" fully deployed from template with ${assignedRoles.length} agents and ${deployedRules.length} routing rules.`,
      });
    });
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error('Failed to deploy template', { tenantId, templateId, error: String(err) });
    res.status(500).json({ error: 'Failed to deploy template' });
  } finally {
    client.release();
  }
});

export default router;
