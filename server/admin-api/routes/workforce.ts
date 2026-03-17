import { Router } from 'express';
import { getPlatformPool, withTenantContext } from '../../../platform/db';
import { requireAuth } from '../middleware/auth';
import { requireRole } from '../middleware/rbac';
import { createLogger } from '../../../platform/core/logger';
import { WorkforceRoutingService } from '../../../platform/workforce/WorkforceRoutingService';

const router = Router();
const logger = createLogger('ADMIN_WORKFORCE');
const routingService = new WorkforceRoutingService();

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

router.post('/workforce/teams', requireAuth, requireRole('admin'), async (req, res) => {
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

router.patch('/workforce/teams/:id', requireAuth, requireRole('admin'), async (req, res) => {
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

router.delete('/workforce/teams/:id', requireAuth, requireRole('admin'), async (req, res) => {
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

router.post('/workforce/teams/:id/members', requireAuth, requireRole('admin'), async (req, res) => {
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

router.patch('/workforce/members/:id', requireAuth, requireRole('admin'), async (req, res) => {
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

router.delete('/workforce/members/:id', requireAuth, requireRole('admin'), async (req, res) => {
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

router.post('/workforce/teams/:id/routing-rules', requireAuth, requireRole('admin'), async (req, res) => {
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

router.patch('/workforce/routing-rules/:id', requireAuth, requireRole('admin'), async (req, res) => {
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

router.delete('/workforce/routing-rules/:id', requireAuth, requireRole('admin'), async (req, res) => {
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

router.post('/workforce/templates', requireAuth, requireRole('admin'), async (req, res) => {
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

export default router;
