import { Router } from 'express';
import type { RequestHandler } from 'express';
import { requireAuth } from '../middleware/auth';
import { requireMiniSystemWrite } from '../middleware/rbac';
import { getPlatformPool } from '../../../platform/db';
import { createLogger } from '../../../platform/core/logger';

const router = Router();
const logger = createLogger('ADMIN_TICKETS');

function paginate(req: { query: Record<string, unknown> }): { limit: number; offset: number } {
  const limit = Math.min(parseInt(String(req.query.limit ?? '20'), 10), 100);
  const page = Math.max(parseInt(String(req.query.page ?? '1'), 10), 1);
  return { limit, offset: (page - 1) * limit };
}

const listTicketsHandler: RequestHandler = async (req, res) => {
  const { tenantId } = req.user!;
  const { limit, offset } = paginate(req);
  const { status, assignee } = req.query as Record<string, string>;
  const pool = getPlatformPool();

  try {
    const conditions: string[] = ['t.tenant_id = $1'];
    const values: unknown[] = [tenantId];

    if (status) { values.push(status); conditions.push(`t.status = $${values.length}`); }
    if (assignee) { values.push(assignee); conditions.push(`t.assignee_user_id = $${values.length}`); }

    const where = conditions.join(' AND ');

    const { rows } = await pool.query(
      `SELECT t.*, u.email AS assignee_email
       FROM tickets t
       LEFT JOIN users u ON u.id = t.assignee_user_id
       LEFT JOIN user_roles ur ON ur.user_id = u.id AND ur.tenant_id = t.tenant_id
       WHERE ${where}
       ORDER BY t.created_at DESC
       LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
      [...values, limit, offset],
    );

    const { rows: countRows } = await pool.query(
      `SELECT COUNT(*) AS total FROM tickets t WHERE ${where}`,
      values,
    );

    return res.json({ tickets: rows, total: parseInt(countRows[0].total as string), limit, offset });
  } catch (err) {
    logger.error('Failed to list tickets', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to list tickets' });
  }
};

const getTicketHandler: RequestHandler = async (req, res) => {
  const { tenantId } = req.user!;
  const { id } = req.params;
  const pool = getPlatformPool();

  try {
    const { rows } = await pool.query(
      `SELECT t.*, u.email AS assignee_email
       FROM tickets t
       LEFT JOIN users u ON u.id = t.assignee_user_id
       LEFT JOIN user_roles ur ON ur.user_id = u.id AND ur.tenant_id = t.tenant_id
       WHERE t.id = $1 AND t.tenant_id = $2`,
      [id, tenantId],
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Ticket not found' });
    }

    return res.json({ ticket: rows[0] });
  } catch (err) {
    logger.error('Failed to get ticket', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to get ticket' });
  }
};

const createTicketHandler: RequestHandler = async (req, res) => {
  const { tenantId } = req.user!;
  const { subject, description, status, priority, assignee_user_id, call_id, notes } = req.body;

  if (!subject) {
    return res.status(400).json({ error: 'subject is required' });
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
      `INSERT INTO tickets (tenant_id, call_id, subject, description, status, priority, assignee_user_id, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [tenantId, call_id || null, subject, description || '', status || 'open', priority || 'medium', assignee_user_id || null, notes || ''],
    );

    return res.status(201).json({ ticket: rows[0] });
  } catch (err) {
    logger.error('Failed to create ticket', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to create ticket' });
  }
};

const updateTicketHandler: RequestHandler = async (req, res) => {
  const { tenantId } = req.user!;
  const { id } = req.params;
  const { subject, description, status, priority, assignee_user_id, notes } = req.body;
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
      `SELECT id FROM tickets WHERE id = $1 AND tenant_id = $2`,
      [id, tenantId],
    );

    if (existing.length === 0) {
      return res.status(404).json({ error: 'Ticket not found' });
    }

    const { rows } = await pool.query(
      `UPDATE tickets SET
        subject = COALESCE($3, subject),
        description = COALESCE($4, description),
        status = COALESCE($5, status),
        priority = COALESCE($6, priority),
        assignee_user_id = COALESCE($7, assignee_user_id),
        notes = COALESCE($8, notes),
        updated_at = NOW()
       WHERE id = $1 AND tenant_id = $2
       RETURNING *`,
      [id, tenantId, subject, description, status, priority, assignee_user_id, notes],
    );

    return res.json({ ticket: rows[0] });
  } catch (err) {
    logger.error('Failed to update ticket', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to update ticket' });
  }
};

const deleteTicketHandler: RequestHandler = async (req, res) => {
  const { tenantId } = req.user!;
  const { id } = req.params;
  const pool = getPlatformPool();

  try {
    const { rowCount } = await pool.query(
      `DELETE FROM tickets WHERE id = $1 AND tenant_id = $2`,
      [id, tenantId],
    );

    if (rowCount === 0) {
      return res.status(404).json({ error: 'Ticket not found' });
    }

    return res.json({ success: true });
  } catch (err) {
    logger.error('Failed to delete ticket', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to delete ticket' });
  }
};

router.get('/tickets', requireAuth, listTicketsHandler);
router.get('/tickets/:id', requireAuth, getTicketHandler);
router.post('/tickets', requireAuth, requireMiniSystemWrite, createTicketHandler);
router.put('/tickets/:id', requireAuth, requireMiniSystemWrite, updateTicketHandler);
router.delete('/tickets/:id', requireAuth, requireMiniSystemWrite, deleteTicketHandler);

export default router;
