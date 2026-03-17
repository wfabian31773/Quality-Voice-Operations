import { Router } from 'express';
import type { RequestHandler } from 'express';
import { requireAuth } from '../middleware/auth';
import { requireMiniSystemWrite } from '../middleware/rbac';
import { getPlatformPool } from '../../../platform/db';
import { createLogger } from '../../../platform/core/logger';

const router = Router();
const logger = createLogger('ADMIN_DISPATCH');

function paginate(req: { query: Record<string, unknown> }): { limit: number; offset: number } {
  const limit = Math.min(parseInt(String(req.query.limit ?? '50'), 10), 200);
  const page = Math.max(parseInt(String(req.query.page ?? '1'), 10), 1);
  return { limit, offset: (page - 1) * limit };
}

const listJobsHandler: RequestHandler = async (req, res) => {
  const { tenantId } = req.user!;
  const { limit, offset } = paginate(req);
  const { status, assignee } = req.query as Record<string, string>;
  const pool = getPlatformPool();

  try {
    const conditions: string[] = ['d.tenant_id = $1'];
    const values: unknown[] = [tenantId];

    if (status) { values.push(status); conditions.push(`d.status = $${values.length}`); }
    if (assignee) { values.push(assignee); conditions.push(`d.assignee_user_id = $${values.length}`); }

    const where = conditions.join(' AND ');

    const { rows } = await pool.query(
      `SELECT d.*, u.email AS assignee_email
       FROM dispatch_jobs d
       LEFT JOIN users u ON u.id = d.assignee_user_id
       LEFT JOIN user_roles ur ON ur.user_id = u.id AND ur.tenant_id = d.tenant_id
       WHERE ${where}
       ORDER BY
         CASE d.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
         d.created_at DESC
       LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
      [...values, limit, offset],
    );

    const { rows: countRows } = await pool.query(
      `SELECT COUNT(*) AS total FROM dispatch_jobs d WHERE ${where}`,
      values,
    );

    return res.json({ jobs: rows, total: parseInt(countRows[0].total as string), limit, offset });
  } catch (err) {
    logger.error('Failed to list dispatch jobs', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to list dispatch jobs' });
  }
};

const getJobHandler: RequestHandler = async (req, res) => {
  const { tenantId } = req.user!;
  const { id } = req.params;
  const pool = getPlatformPool();

  try {
    const { rows } = await pool.query(
      `SELECT d.*, u.email AS assignee_email
       FROM dispatch_jobs d
       LEFT JOIN users u ON u.id = d.assignee_user_id
       LEFT JOIN user_roles ur ON ur.user_id = u.id AND ur.tenant_id = d.tenant_id
       WHERE d.id = $1 AND d.tenant_id = $2`,
      [id, tenantId],
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Job not found' });
    }

    return res.json({ job: rows[0] });
  } catch (err) {
    logger.error('Failed to get dispatch job', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to get job' });
  }
};

const createJobHandler: RequestHandler = async (req, res) => {
  const { tenantId } = req.user!;
  const { title, description, status, priority, assignee_user_id, contact_id, contact_name, scheduled_at, notes } = req.body;

  if (!title) {
    return res.status(400).json({ error: 'title is required' });
  }

  const pool = getPlatformPool();

  try {
    if (assignee_user_id) {
      const { rows: memberCheck } = await pool.query(
        `SELECT user_id FROM user_roles WHERE user_id = $1 AND tenant_id = $2 LIMIT 1`,
        [assignee_user_id, tenantId],
      );
      if (memberCheck.length === 0) {
        return res.status(400).json({ error: 'Assignee is not a member of this tenant' });
      }
    }

    const { rows } = await pool.query(
      `INSERT INTO dispatch_jobs (tenant_id, title, description, status, priority, assignee_user_id, contact_id, contact_name, scheduled_at, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING *`,
      [tenantId, title, description || '', status || 'pending', priority || 'medium', assignee_user_id || null, contact_id || null, contact_name || '', scheduled_at || null, notes || ''],
    );

    return res.status(201).json({ job: rows[0] });
  } catch (err) {
    logger.error('Failed to create dispatch job', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to create job' });
  }
};

const updateJobHandler: RequestHandler = async (req, res) => {
  const { tenantId } = req.user!;
  const { id } = req.params;
  const { title, description, status, priority, assignee_user_id, contact_id, contact_name, scheduled_at, notes } = req.body;
  const pool = getPlatformPool();

  try {
    if (assignee_user_id) {
      const { rows: memberCheck } = await pool.query(
        `SELECT user_id FROM user_roles WHERE user_id = $1 AND tenant_id = $2 LIMIT 1`,
        [assignee_user_id, tenantId],
      );
      if (memberCheck.length === 0) {
        return res.status(400).json({ error: 'Assignee is not a member of this tenant' });
      }
    }

    const { rows: existing } = await pool.query(
      `SELECT id, status as current_status FROM dispatch_jobs WHERE id = $1 AND tenant_id = $2`,
      [id, tenantId],
    );

    if (existing.length === 0) {
      return res.status(404).json({ error: 'Job not found' });
    }

    const completedAt = status === 'done' && existing[0].current_status !== 'done' ? 'NOW()' : null;

    const { rows } = await pool.query(
      `UPDATE dispatch_jobs SET
        title = COALESCE($3, title),
        description = COALESCE($4, description),
        status = COALESCE($5, status),
        priority = COALESCE($6, priority),
        assignee_user_id = COALESCE($7, assignee_user_id),
        contact_id = COALESCE($8, contact_id),
        contact_name = COALESCE($9, contact_name),
        scheduled_at = COALESCE($10, scheduled_at),
        notes = COALESCE($11, notes),
        completed_at = ${completedAt ? 'NOW()' : 'completed_at'},
        updated_at = NOW()
       WHERE id = $1 AND tenant_id = $2
       RETURNING *`,
      [id, tenantId, title, description, status, priority, assignee_user_id, contact_id, contact_name, scheduled_at, notes],
    );

    return res.json({ job: rows[0] });
  } catch (err) {
    logger.error('Failed to update dispatch job', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to update job' });
  }
};

const deleteJobHandler: RequestHandler = async (req, res) => {
  const { tenantId } = req.user!;
  const { id } = req.params;
  const pool = getPlatformPool();

  try {
    const { rowCount } = await pool.query(
      `DELETE FROM dispatch_jobs WHERE id = $1 AND tenant_id = $2`,
      [id, tenantId],
    );

    if (rowCount === 0) {
      return res.status(404).json({ error: 'Job not found' });
    }

    return res.json({ success: true });
  } catch (err) {
    logger.error('Failed to delete dispatch job', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to delete job' });
  }
};

router.get('/dispatch/jobs', requireAuth, listJobsHandler);
router.get('/dispatch/jobs/:id', requireAuth, getJobHandler);
router.post('/dispatch/jobs', requireAuth, requireMiniSystemWrite, createJobHandler);
router.put('/dispatch/jobs/:id', requireAuth, requireMiniSystemWrite, updateJobHandler);
router.delete('/dispatch/jobs/:id', requireAuth, requireMiniSystemWrite, deleteJobHandler);

export default router;
