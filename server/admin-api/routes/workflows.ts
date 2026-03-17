import { Router, Request, Response, NextFunction } from 'express';
import { getPlatformPool, withTenantContext } from '../../../platform/db';
import { requireAuth } from '../middleware/auth';
import { createLogger } from '../../../platform/core/logger';

const router = Router();
const logger = createLogger('ADMIN_WORKFLOWS');

const ALLOWED_WORKFLOW_ROLES = new Set(['tenant_owner', 'operations_manager']);

function requireOwnerOrManager(req: Request, res: Response, next: NextFunction): void {
  if (!req.user) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }
  if (!ALLOWED_WORKFLOW_ROLES.has(req.user.role)) {
    res.status(403).json({ error: 'Workflows require Owner or Manager role' });
    return;
  }
  next();
}

function paginate(req: { query: Record<string, unknown> }): { limit: number; offset: number } {
  const limit = Math.min(parseInt(String(req.query.limit ?? '50'), 10), 100);
  const page = Math.max(parseInt(String(req.query.page ?? '1'), 10), 1);
  return { limit, offset: (page - 1) * limit };
}

router.get('/workflows', requireAuth, requireOwnerOrManager, async (req, res) => {
  const { tenantId } = req.user!;
  const { limit, offset } = paginate(req);
  const pool = getPlatformPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await withTenantContext(client, tenantId, async () => {});

    const { rows } = await client.query(
      `SELECT id, tenant_id, name, description, steps, created_at, updated_at
       FROM workflows WHERE tenant_id = $1
       ORDER BY created_at DESC
       LIMIT $2 OFFSET $3`,
      [tenantId, limit, offset],
    );

    const { rows: countRows } = await client.query(
      `SELECT COUNT(*) AS total FROM workflows WHERE tenant_id = $1`,
      [tenantId],
    );
    await client.query('COMMIT');

    return res.json({ workflows: rows, total: parseInt(countRows[0].total as string), limit, offset });
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error('Failed to list workflows', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to list workflows' });
  } finally {
    client.release();
  }
});

router.get('/workflows/:id', requireAuth, requireOwnerOrManager, async (req, res) => {
  const { tenantId } = req.user!;
  const { id } = req.params;
  const pool = getPlatformPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await withTenantContext(client, tenantId, async () => {});

    const { rows } = await client.query(
      `SELECT * FROM workflows WHERE id = $1 AND tenant_id = $2`,
      [id, tenantId],
    );
    await client.query('COMMIT');

    if (rows.length === 0) return res.status(404).json({ error: 'Workflow not found' });
    return res.json({ workflow: rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    return res.status(500).json({ error: 'Failed to retrieve workflow' });
  } finally {
    client.release();
  }
});

router.post('/workflows', requireAuth, requireOwnerOrManager, async (req, res) => {
  const { tenantId } = req.user!;
  const body = req.body as Record<string, unknown>;
  const { name, description, steps } = body;

  if (!name || typeof name !== 'string') return res.status(400).json({ error: 'name is required' });
  if (steps !== undefined && !Array.isArray(steps)) return res.status(400).json({ error: 'steps must be an array' });

  const pool = getPlatformPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await withTenantContext(client, tenantId, async () => {});

    const { rows } = await client.query(
      `INSERT INTO workflows (tenant_id, name, description, steps)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [tenantId, name, description ?? null, JSON.stringify(steps ?? [])],
    );
    await client.query('COMMIT');

    logger.info('Workflow created', { tenantId, workflowId: rows[0].id });
    return res.status(201).json({ workflow: rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error('Failed to create workflow', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to create workflow' });
  } finally {
    client.release();
  }
});

router.patch('/workflows/:id', requireAuth, requireOwnerOrManager, async (req, res) => {
  const { tenantId } = req.user!;
  const { id } = req.params;
  const body = req.body as Record<string, unknown>;

  if (body.steps !== undefined && !Array.isArray(body.steps)) {
    return res.status(400).json({ error: 'steps must be an array' });
  }

  const allowed = ['name', 'description', 'steps'];
  const updates: string[] = ['updated_at = NOW()'];
  const values: unknown[] = [id, tenantId];

  for (const key of allowed) {
    if (key in body) {
      const val = key === 'steps' ? JSON.stringify(body[key]) : body[key];
      values.push(val);
      updates.push(`${key} = $${values.length}`);
    }
  }

  if (updates.length === 1) return res.status(400).json({ error: 'No valid fields to update' });

  const pool = getPlatformPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await withTenantContext(client, tenantId, async () => {});

    const { rows } = await client.query(
      `UPDATE workflows SET ${updates.join(', ')} WHERE id = $1 AND tenant_id = $2 RETURNING *`,
      values,
    );
    await client.query('COMMIT');

    if (rows.length === 0) return res.status(404).json({ error: 'Workflow not found' });
    return res.json({ workflow: rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error('Failed to update workflow', { tenantId, workflowId: id, error: String(err) });
    return res.status(500).json({ error: 'Failed to update workflow' });
  } finally {
    client.release();
  }
});

router.delete('/workflows/:id', requireAuth, requireOwnerOrManager, async (req, res) => {
  const { tenantId } = req.user!;
  const { id } = req.params;
  const pool = getPlatformPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await withTenantContext(client, tenantId, async () => {});

    await client.query(
      `UPDATE agents SET workflow_id = NULL WHERE workflow_id = $1 AND tenant_id = $2`,
      [id, tenantId],
    );

    const { rowCount } = await client.query(
      `DELETE FROM workflows WHERE id = $1 AND tenant_id = $2`,
      [id, tenantId],
    );
    await client.query('COMMIT');

    if (!rowCount) return res.status(404).json({ error: 'Workflow not found' });
    logger.info('Workflow deleted', { tenantId, workflowId: id });
    return res.json({ deleted: true });
  } catch (err) {
    await client.query('ROLLBACK');
    return res.status(500).json({ error: 'Failed to delete workflow' });
  } finally {
    client.release();
  }
});

export default router;
