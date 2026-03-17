import { Router } from 'express';
import type { RequestHandler } from 'express';
import { requireAuth } from '../middleware/auth';
import { requireMiniSystemWrite } from '../middleware/rbac';
import { getPlatformPool } from '../../../platform/db';
import { createLogger } from '../../../platform/core/logger';

const router = Router();
const logger = createLogger('ADMIN_SCHEDULING');

const listBookingsHandler: RequestHandler = async (req, res) => {
  const { tenantId } = req.user!;
  const { start, end, status } = req.query as Record<string, string>;
  const pool = getPlatformPool();

  try {
    const conditions: string[] = ['b.tenant_id = $1'];
    const values: unknown[] = [tenantId];

    if (start) { values.push(start); conditions.push(`b.start_time >= $${values.length}::timestamptz`); }
    if (end) { values.push(end); conditions.push(`b.end_time <= $${values.length}::timestamptz`); }
    if (status) { values.push(status); conditions.push(`b.status = $${values.length}`); }

    const where = conditions.join(' AND ');
    const { rows } = await pool.query(
      `SELECT b.*, a.name AS agent_name
       FROM bookings b
       LEFT JOIN agents a ON a.id = b.agent_id
       WHERE ${where}
       ORDER BY b.start_time ASC`,
      values,
    );

    return res.json({ bookings: rows, total: rows.length });
  } catch (err) {
    logger.error('Failed to list bookings', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to list bookings' });
  }
};

const createBookingHandler: RequestHandler = async (req, res) => {
  const { tenantId } = req.user!;
  const { title, description, start_time, end_time, status, contact_name, contact_phone, contact_email, agent_id, notes } = req.body;

  if (!title || !start_time || !end_time) {
    return res.status(400).json({ error: 'title, start_time, and end_time are required' });
  }

  const pool = getPlatformPool();

  try {
    const { rows } = await pool.query(
      `INSERT INTO bookings (tenant_id, title, description, start_time, end_time, status, contact_name, contact_phone, contact_email, agent_id, created_by, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING *`,
      [tenantId, title, description || '', start_time, end_time, status || 'confirmed', contact_name || '', contact_phone || '', contact_email || '', agent_id || null, req.user!.userId, notes || ''],
    );

    return res.status(201).json({ booking: rows[0] });
  } catch (err) {
    logger.error('Failed to create booking', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to create booking' });
  }
};

const updateBookingHandler: RequestHandler = async (req, res) => {
  const { tenantId } = req.user!;
  const { id } = req.params;
  const { title, description, start_time, end_time, status, contact_name, contact_phone, contact_email, agent_id, notes } = req.body;
  const pool = getPlatformPool();

  try {
    const { rows: existing } = await pool.query(
      `SELECT id FROM bookings WHERE id = $1 AND tenant_id = $2`,
      [id, tenantId],
    );

    if (existing.length === 0) {
      return res.status(404).json({ error: 'Booking not found' });
    }

    const { rows } = await pool.query(
      `UPDATE bookings SET
        title = COALESCE($3, title),
        description = COALESCE($4, description),
        start_time = COALESCE($5, start_time),
        end_time = COALESCE($6, end_time),
        status = COALESCE($7, status),
        contact_name = COALESCE($8, contact_name),
        contact_phone = COALESCE($9, contact_phone),
        contact_email = COALESCE($10, contact_email),
        agent_id = COALESCE($11, agent_id),
        notes = COALESCE($12, notes),
        updated_at = NOW()
       WHERE id = $1 AND tenant_id = $2
       RETURNING *`,
      [id, tenantId, title, description, start_time, end_time, status, contact_name, contact_phone, contact_email, agent_id, notes],
    );

    return res.json({ booking: rows[0] });
  } catch (err) {
    logger.error('Failed to update booking', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to update booking' });
  }
};

const deleteBookingHandler: RequestHandler = async (req, res) => {
  const { tenantId } = req.user!;
  const { id } = req.params;
  const pool = getPlatformPool();

  try {
    const { rowCount } = await pool.query(
      `DELETE FROM bookings WHERE id = $1 AND tenant_id = $2`,
      [id, tenantId],
    );

    if (rowCount === 0) {
      return res.status(404).json({ error: 'Booking not found' });
    }

    return res.json({ success: true });
  } catch (err) {
    logger.error('Failed to delete booking', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to delete booking' });
  }
};

router.get('/scheduling/bookings', requireAuth, listBookingsHandler);
router.post('/scheduling/bookings', requireAuth, requireMiniSystemWrite, createBookingHandler);
router.put('/scheduling/bookings/:id', requireAuth, requireMiniSystemWrite, updateBookingHandler);
router.delete('/scheduling/bookings/:id', requireAuth, requireMiniSystemWrite, deleteBookingHandler);

export default router;
