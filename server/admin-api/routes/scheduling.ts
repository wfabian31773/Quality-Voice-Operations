import { Router } from 'express';
import type { RequestHandler } from 'express';
import { requireAuth } from '../middleware/auth';
import { requireMiniSystemWrite } from '../middleware/rbac';
import { getPlatformPool } from '../../../platform/db';
import { createLogger } from '../../../platform/core/logger';

const router = Router();
const logger = createLogger('ADMIN_SCHEDULING');

async function auditLog(
  pool: ReturnType<typeof getPlatformPool>,
  tenantId: string,
  bookingId: string | null,
  action: string,
  previousStatus: string | null,
  newStatus: string | null,
  changedBy: string | null,
  details: Record<string, unknown> = {},
  overrideReason = '',
) {
  await pool.query(
    `INSERT INTO scheduling_audit_log (tenant_id, booking_id, action, previous_status, new_status, changed_by, details, override_reason)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [tenantId, bookingId, action, previousStatus, newStatus, changedBy, JSON.stringify(details), overrideReason],
  );
}

// ─── BOOKINGS CRUD ───

const listBookingsHandler: RequestHandler = async (req, res) => {
  const { tenantId } = req.user!;
  const { start, end, status, provider_id, appointment_type_id, resource_id, search, limit, offset } = req.query as Record<string, string>;
  const pool = getPlatformPool();

  try {
    const conditions: string[] = ['b.tenant_id = $1'];
    const values: unknown[] = [tenantId];

    if (start) { values.push(start); conditions.push(`b.start_time >= $${values.length}::timestamptz`); }
    if (end) { values.push(end); conditions.push(`b.end_time <= $${values.length}::timestamptz`); }
    if (status) { values.push(status); conditions.push(`b.status = $${values.length}`); }
    if (provider_id) { values.push(provider_id); conditions.push(`b.provider_id = $${values.length}`); }
    if (appointment_type_id) { values.push(appointment_type_id); conditions.push(`b.appointment_type_id = $${values.length}`); }
    if (resource_id) { values.push(resource_id); conditions.push(`b.resource_id = $${values.length}`); }
    if (search) {
      values.push(`%${search}%`);
      conditions.push(`(b.title ILIKE $${values.length} OR b.contact_name ILIKE $${values.length} OR b.contact_email ILIKE $${values.length} OR b.contact_phone ILIKE $${values.length})`);
    }

    const where = conditions.join(' AND ');
    const lim = Math.min(parseInt(limit || '500', 10), 1000);
    const off = parseInt(offset || '0', 10);

    const { rows } = await pool.query(
      `SELECT b.*, a.name AS agent_name,
              sp.name AS provider_name,
              sat.name AS appointment_type_name,
              sat.color AS appointment_type_color,
              sr.name AS resource_name
       FROM bookings b
       LEFT JOIN agents a ON a.id = b.agent_id
       LEFT JOIN scheduling_providers sp ON sp.id = b.provider_id
       LEFT JOIN scheduling_appointment_types sat ON sat.id = b.appointment_type_id
       LEFT JOIN scheduling_resources sr ON sr.id = b.resource_id
       WHERE ${where}
       ORDER BY b.start_time ASC
       LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
      [...values, lim, off],
    );

    const { rows: countRows } = await pool.query(
      `SELECT COUNT(*)::int AS total FROM bookings b WHERE ${where}`,
      values,
    );

    return res.json({ bookings: rows, total: countRows[0]?.total || 0 });
  } catch (err) {
    logger.error('Failed to list bookings', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to list bookings' });
  }
};

const getBookingHandler: RequestHandler = async (req, res) => {
  const { tenantId } = req.user!;
  const { id } = req.params;
  const pool = getPlatformPool();

  try {
    const { rows } = await pool.query(
      `SELECT b.*, a.name AS agent_name, sp.name AS provider_name,
              sat.name AS appointment_type_name, sat.color AS appointment_type_color,
              sr.name AS resource_name
       FROM bookings b
       LEFT JOIN agents a ON a.id = b.agent_id
       LEFT JOIN scheduling_providers sp ON sp.id = b.provider_id
       LEFT JOIN scheduling_appointment_types sat ON sat.id = b.appointment_type_id
       LEFT JOIN scheduling_resources sr ON sr.id = b.resource_id
       WHERE b.id = $1 AND b.tenant_id = $2`,
      [id, tenantId],
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Booking not found' });
    return res.json({ booking: rows[0] });
  } catch (err) {
    logger.error('Failed to get booking', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to get booking' });
  }
};

async function checkConflicts(pool: ReturnType<typeof getPlatformPool>, tenantId: string, startTime: string, endTime: string, providerId?: string, resourceId?: string, excludeBookingId?: string) {
  const conds: string[] = ['tenant_id = $1', "status NOT IN ('cancelled', 'no_show', 'rescheduled')"];
  const vals: unknown[] = [tenantId];

  vals.push(startTime);
  vals.push(endTime);
  conds.push(`start_time < $3::timestamptz`);
  conds.push(`end_time > $2::timestamptz`);

  if (providerId) { vals.push(providerId); conds.push(`provider_id = $${vals.length}`); }
  if (resourceId) { vals.push(resourceId); conds.push(`resource_id = $${vals.length}`); }
  if (excludeBookingId) { vals.push(excludeBookingId); conds.push(`id != $${vals.length}`); }

  const { rows } = await pool.query(
    `SELECT id, title, start_time, end_time FROM bookings WHERE ${conds.join(' AND ')}`,
    vals,
  );
  return rows;
}

async function getBookingRules(pool: ReturnType<typeof getPlatformPool>, tenantId: string, appointmentTypeId?: string) {
  if (appointmentTypeId) {
    const { rows } = await pool.query(
      `SELECT * FROM scheduling_booking_rules WHERE tenant_id = $1 AND appointment_type_id = $2 LIMIT 1`,
      [tenantId, appointmentTypeId],
    );
    if (rows.length > 0) return rows[0];
  }
  const { rows } = await pool.query(
    `SELECT * FROM scheduling_booking_rules WHERE tenant_id = $1 AND appointment_type_id IS NULL LIMIT 1`,
    [tenantId],
  );
  return rows[0] || null;
}

const createBookingHandler: RequestHandler = async (req, res) => {
  const { tenantId } = req.user!;
  const { title, description, start_time, end_time, status, contact_name, contact_phone, contact_email,
    agent_id, notes, provider_id, appointment_type_id, resource_id, recurring_series_id,
    intake_data, timezone, location, booking_source, override_reason } = req.body;

  if (!title || !start_time || !end_time) {
    return res.status(400).json({ error: 'title, start_time, and end_time are required' });
  }

  if (new Date(start_time) >= new Date(end_time)) {
    return res.status(400).json({ error: 'start_time must be before end_time' });
  }

  const pool = getPlatformPool();

  try {
    if (!override_reason) {
      const rules = await getBookingRules(pool, tenantId, appointment_type_id);
      const startDate = new Date(start_time);
      const now = new Date();
      const hoursUntil = (startDate.getTime() - now.getTime()) / (1000 * 60 * 60);

      if (rules) {
        if (rules.min_lead_time_hours && hoursUntil < rules.min_lead_time_hours) {
          return res.status(400).json({ error: `Booking requires at least ${rules.min_lead_time_hours} hours lead time` });
        }

        if (!rules.allow_same_day) {
          const sameDay = startDate.toDateString() === now.toDateString();
          if (sameDay) {
            return res.status(400).json({ error: 'Same-day bookings are not allowed' });
          }
        }
      }

      const allowDoubleBook = rules?.allow_double_book ?? false;
      if (!allowDoubleBook && (provider_id || resource_id)) {
        const conflicts = await checkConflicts(pool, tenantId, start_time, end_time, provider_id, resource_id);
        if (conflicts.length > 0) {
          return res.status(409).json({ error: 'Time slot conflict detected', conflicts });
        }
      }
    }

    const { rows } = await pool.query(
      `INSERT INTO bookings (tenant_id, title, description, start_time, end_time, status,
        contact_name, contact_phone, contact_email, agent_id, created_by, notes,
        provider_id, appointment_type_id, resource_id, recurring_series_id,
        intake_data, timezone, location, booking_source)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)
       RETURNING *`,
      [tenantId, title, description || '', start_time, end_time, status || 'confirmed',
        contact_name || '', contact_phone || '', contact_email || '',
        agent_id || null, req.user!.userId, notes || '',
        provider_id || null, appointment_type_id || null, resource_id || null, recurring_series_id || null,
        JSON.stringify(intake_data || {}), timezone || 'America/New_York', location || '', booking_source || 'manual'],
    );

    await auditLog(pool, tenantId, rows[0].id, 'created', null, rows[0].status, req.user!.userId, { title, provider_id, appointment_type_id }, override_reason || '');

    return res.status(201).json({ booking: rows[0] });
  } catch (err) {
    logger.error('Failed to create booking', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to create booking' });
  }
};

const updateBookingHandler: RequestHandler = async (req, res) => {
  const { tenantId } = req.user!;
  const { id } = req.params;
  const pool = getPlatformPool();

  try {
    const { rows: existing } = await pool.query(
      `SELECT * FROM bookings WHERE id = $1 AND tenant_id = $2`,
      [id, tenantId],
    );
    if (existing.length === 0) return res.status(404).json({ error: 'Booking not found' });

    const old = existing[0];
    const { title, description, start_time, end_time, status, contact_name, contact_phone,
      contact_email, agent_id, notes, provider_id, appointment_type_id, resource_id,
      intake_data, timezone, location } = req.body;

    if (start_time && end_time && new Date(start_time) >= new Date(end_time)) {
      return res.status(400).json({ error: 'start_time must be before end_time' });
    }

    const newStart = start_time || old.start_time;
    const newEnd = end_time || old.end_time;
    const newProviderId = provider_id !== undefined ? provider_id : old.provider_id;
    const newResourceId = resource_id !== undefined ? resource_id : old.resource_id;

    if (start_time || end_time || provider_id || resource_id) {
      const conflicts = await checkConflicts(pool, tenantId, newStart, newEnd, newProviderId, newResourceId, id);
      if (conflicts.length > 0) {
        return res.status(409).json({ error: 'Time slot conflict detected', conflicts });
      }
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
        provider_id = COALESCE($13, provider_id),
        appointment_type_id = COALESCE($14, appointment_type_id),
        resource_id = COALESCE($15, resource_id),
        intake_data = COALESCE($16, intake_data),
        timezone = COALESCE($17, timezone),
        location = COALESCE($18, location),
        updated_at = NOW()
       WHERE id = $1 AND tenant_id = $2
       RETURNING *`,
      [id, tenantId, title, description, start_time, end_time, status, contact_name, contact_phone,
        contact_email, agent_id, notes, provider_id, appointment_type_id, resource_id,
        intake_data ? JSON.stringify(intake_data) : null, timezone, location],
    );

    if (status && status !== old.status) {
      await auditLog(pool, tenantId, id, 'status_changed', old.status, status, req.user!.userId, { title: rows[0].title });
    } else {
      await auditLog(pool, tenantId, id, 'updated', old.status, rows[0].status, req.user!.userId, { changed_fields: Object.keys(req.body) });
    }

    return res.json({ booking: rows[0] });
  } catch (err) {
    logger.error('Failed to update booking', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to update booking' });
  }
};

// ─── LIFECYCLE ACTIONS ───

const transitionBookingHandler: RequestHandler = async (req, res) => {
  const { tenantId } = req.user!;
  const { id } = req.params;
  const { action, cancellation_reason, override_reason, new_start_time, new_end_time } = req.body;
  const pool = getPlatformPool();

  const VALID_TRANSITIONS: Record<string, string[]> = {
    confirm: ['pending'],
    check_in: ['confirmed'],
    complete: ['checked_in', 'confirmed'],
    no_show: ['confirmed', 'checked_in'],
    cancel: ['pending', 'confirmed', 'checked_in'],
    reschedule: ['pending', 'confirmed'],
    reopen: ['cancelled', 'no_show', 'completed'],
  };

  if (!VALID_TRANSITIONS[action]) {
    return res.status(400).json({ error: `Invalid action: ${action}` });
  }

  try {
    const { rows: existing } = await pool.query(
      `SELECT * FROM bookings WHERE id = $1 AND tenant_id = $2`,
      [id, tenantId],
    );
    if (existing.length === 0) return res.status(404).json({ error: 'Booking not found' });

    const booking = existing[0];
    if (!VALID_TRANSITIONS[action].includes(booking.status)) {
      return res.status(400).json({
        error: `Cannot ${action} a booking with status '${booking.status}'. Allowed from: ${VALID_TRANSITIONS[action].join(', ')}`,
      });
    }

    const STATUS_MAP: Record<string, string> = {
      confirm: 'confirmed',
      check_in: 'checked_in',
      complete: 'completed',
      no_show: 'no_show',
      cancel: 'cancelled',
      reschedule: 'rescheduled',
      reopen: 'pending',
    };

    const newStatus = STATUS_MAP[action];
    const updates: string[] = [`status = '${newStatus}'`, 'updated_at = NOW()'];

    if (action === 'check_in') updates.push('checked_in_at = NOW()');
    if (action === 'complete') updates.push('completed_at = NOW()');
    if (action === 'cancel' && cancellation_reason) {
      updates.push(`cancellation_reason = '${cancellation_reason.replace(/'/g, "''")}'`);
    }

    if (action === 'reschedule') {
      if (!new_start_time || !new_end_time) {
        return res.status(400).json({ error: 'new_start_time and new_end_time required for reschedule' });
      }
      const conflicts = await checkConflicts(pool, tenantId, new_start_time, new_end_time, booking.provider_id, booking.resource_id, id);
      if (conflicts.length > 0 && !override_reason) {
        return res.status(409).json({ error: 'New time slot has conflicts', conflicts });
      }
    }

    await pool.query(
      `UPDATE bookings SET ${updates.join(', ')} WHERE id = $1 AND tenant_id = $2`,
      [id, tenantId],
    );

    if (action === 'reschedule') {
      const { rows: newBookingRows } = await pool.query(
        `INSERT INTO bookings (tenant_id, title, description, start_time, end_time, status,
          contact_name, contact_phone, contact_email, agent_id, created_by, notes,
          provider_id, appointment_type_id, resource_id, recurring_series_id,
          intake_data, timezone, location, booking_source)
         SELECT tenant_id, title, description, $3, $4, 'confirmed',
           contact_name, contact_phone, contact_email, agent_id, $5, notes,
           provider_id, appointment_type_id, resource_id, recurring_series_id,
           intake_data, timezone, location, booking_source
         FROM bookings WHERE id = $1 AND tenant_id = $2
         RETURNING *`,
        [id, tenantId, new_start_time, new_end_time, req.user!.userId],
      );

      await auditLog(pool, tenantId, id, 'rescheduled', booking.status, 'rescheduled', req.user!.userId, { new_booking_id: newBookingRows[0]?.id, new_start_time, new_end_time }, override_reason || '');

      return res.json({ booking: newBookingRows[0], previous_booking_id: id });
    }

    if (action === 'cancel') {
      const { rows: waitlistRows } = await pool.query(
        `SELECT * FROM scheduling_waitlist
         WHERE tenant_id = $1 AND status = 'waiting'
           AND (appointment_type_id IS NULL OR appointment_type_id = $2)
           AND (provider_id IS NULL OR provider_id = $3)
         ORDER BY created_at ASC LIMIT 1`,
        [tenantId, booking.appointment_type_id, booking.provider_id],
      );

      if (waitlistRows.length > 0) {
        await pool.query(
          `UPDATE scheduling_waitlist SET status = 'offered', notified_at = NOW(), updated_at = NOW() WHERE id = $1`,
          [waitlistRows[0].id],
        );
      }
    }

    await auditLog(pool, tenantId, id, action, booking.status, newStatus, req.user!.userId, { cancellation_reason }, override_reason || '');

    const { rows: updated } = await pool.query(
      `SELECT * FROM bookings WHERE id = $1 AND tenant_id = $2`,
      [id, tenantId],
    );

    return res.json({ booking: updated[0] });
  } catch (err) {
    logger.error('Failed to transition booking', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to transition booking' });
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
    if (rowCount === 0) return res.status(404).json({ error: 'Booking not found' });

    await auditLog(pool, tenantId, id, 'deleted', null, null, req.user!.userId);

    return res.json({ success: true });
  } catch (err) {
    logger.error('Failed to delete booking', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to delete booking' });
  }
};

// ─── PROVIDERS CRUD ───

const listProvidersHandler: RequestHandler = async (req, res) => {
  const { tenantId } = req.user!;
  const pool = getPlatformPool();
  try {
    const { rows } = await pool.query(
      `SELECT * FROM scheduling_providers WHERE tenant_id = $1 ORDER BY name ASC`,
      [tenantId],
    );
    return res.json({ providers: rows });
  } catch (err) {
    logger.error('Failed to list providers', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to list providers' });
  }
};

const createProviderHandler: RequestHandler = async (req, res) => {
  const { tenantId } = req.user!;
  const { name, specialty, email, phone, location, metadata } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });
  const pool = getPlatformPool();
  try {
    const { rows } = await pool.query(
      `INSERT INTO scheduling_providers (tenant_id, name, specialty, email, phone, location, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [tenantId, name, specialty || '', email || '', phone || '', location || '', JSON.stringify(metadata || {})],
    );
    return res.status(201).json({ provider: rows[0] });
  } catch (err) {
    logger.error('Failed to create provider', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to create provider' });
  }
};

const updateProviderHandler: RequestHandler = async (req, res) => {
  const { tenantId } = req.user!;
  const { id } = req.params;
  const { name, specialty, email, phone, location, is_active, metadata } = req.body;
  const pool = getPlatformPool();
  try {
    const { rows } = await pool.query(
      `UPDATE scheduling_providers SET
        name = COALESCE($3, name), specialty = COALESCE($4, specialty),
        email = COALESCE($5, email), phone = COALESCE($6, phone),
        location = COALESCE($7, location), is_active = COALESCE($8, is_active),
        metadata = COALESCE($9, metadata), updated_at = NOW()
       WHERE id = $1 AND tenant_id = $2 RETURNING *`,
      [id, tenantId, name, specialty, email, phone, location, is_active, metadata ? JSON.stringify(metadata) : null],
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Provider not found' });
    return res.json({ provider: rows[0] });
  } catch (err) {
    logger.error('Failed to update provider', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to update provider' });
  }
};

const deleteProviderHandler: RequestHandler = async (req, res) => {
  const { tenantId } = req.user!;
  const { id } = req.params;
  const pool = getPlatformPool();
  try {
    const { rowCount } = await pool.query(
      `DELETE FROM scheduling_providers WHERE id = $1 AND tenant_id = $2`,
      [id, tenantId],
    );
    if (rowCount === 0) return res.status(404).json({ error: 'Provider not found' });
    return res.json({ success: true });
  } catch (err) {
    logger.error('Failed to delete provider', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to delete provider' });
  }
};

// ─── PROVIDER SCHEDULES ───

const listProviderSchedulesHandler: RequestHandler = async (req, res) => {
  const { tenantId } = req.user!;
  const { provider_id } = req.params;
  const pool = getPlatformPool();
  try {
    const { rows } = await pool.query(
      `SELECT * FROM scheduling_provider_schedules WHERE tenant_id = $1 AND provider_id = $2 ORDER BY day_of_week, start_time`,
      [tenantId, provider_id],
    );
    return res.json({ schedules: rows });
  } catch (err) {
    logger.error('Failed to list provider schedules', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to list provider schedules' });
  }
};

const upsertProviderScheduleHandler: RequestHandler = async (req, res) => {
  const { tenantId } = req.user!;
  const { provider_id } = req.params;
  const { schedules } = req.body;
  if (!Array.isArray(schedules)) return res.status(400).json({ error: 'schedules array required' });
  const pool = getPlatformPool();
  try {
    await pool.query(`DELETE FROM scheduling_provider_schedules WHERE tenant_id = $1 AND provider_id = $2`, [tenantId, provider_id]);
    for (const s of schedules) {
      await pool.query(
        `INSERT INTO scheduling_provider_schedules (tenant_id, provider_id, day_of_week, start_time, end_time, location, is_active)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [tenantId, provider_id, s.day_of_week, s.start_time, s.end_time, s.location || '', s.is_active !== false],
      );
    }
    const { rows } = await pool.query(
      `SELECT * FROM scheduling_provider_schedules WHERE tenant_id = $1 AND provider_id = $2 ORDER BY day_of_week, start_time`,
      [tenantId, provider_id],
    );
    return res.json({ schedules: rows });
  } catch (err) {
    logger.error('Failed to update provider schedules', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to update provider schedules' });
  }
};

// ─── SCHEDULE OVERRIDES ───

const listOverridesHandler: RequestHandler = async (req, res) => {
  const { tenantId } = req.user!;
  const { provider_id, start, end } = req.query as Record<string, string>;
  const pool = getPlatformPool();
  try {
    const conditions: string[] = ['tenant_id = $1'];
    const values: unknown[] = [tenantId];
    if (provider_id) { values.push(provider_id); conditions.push(`provider_id = $${values.length}`); }
    if (start) { values.push(start); conditions.push(`override_date >= $${values.length}::date`); }
    if (end) { values.push(end); conditions.push(`override_date <= $${values.length}::date`); }
    const { rows } = await pool.query(
      `SELECT * FROM scheduling_overrides WHERE ${conditions.join(' AND ')} ORDER BY override_date`,
      values,
    );
    return res.json({ overrides: rows });
  } catch (err) {
    logger.error('Failed to list overrides', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to list overrides' });
  }
};

const createOverrideHandler: RequestHandler = async (req, res) => {
  const { tenantId } = req.user!;
  const { provider_id, override_date, start_time, end_time, is_available, reason } = req.body;
  if (!override_date) return res.status(400).json({ error: 'override_date is required' });
  const pool = getPlatformPool();
  try {
    const { rows } = await pool.query(
      `INSERT INTO scheduling_overrides (tenant_id, provider_id, override_date, start_time, end_time, is_available, reason, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [tenantId, provider_id || null, override_date, start_time || null, end_time || null, is_available !== undefined ? is_available : false, reason || '', req.user!.userId],
    );
    return res.status(201).json({ override: rows[0] });
  } catch (err) {
    logger.error('Failed to create override', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to create override' });
  }
};

const deleteOverrideHandler: RequestHandler = async (req, res) => {
  const { tenantId } = req.user!;
  const { id } = req.params;
  const pool = getPlatformPool();
  try {
    const { rowCount } = await pool.query(`DELETE FROM scheduling_overrides WHERE id = $1 AND tenant_id = $2`, [id, tenantId]);
    if (rowCount === 0) return res.status(404).json({ error: 'Override not found' });
    return res.json({ success: true });
  } catch (err) {
    logger.error('Failed to delete override', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to delete override' });
  }
};

// ─── APPOINTMENT TYPES ───

const listAppointmentTypesHandler: RequestHandler = async (req, res) => {
  const { tenantId } = req.user!;
  const pool = getPlatformPool();
  try {
    const { rows } = await pool.query(
      `SELECT * FROM scheduling_appointment_types WHERE tenant_id = $1 ORDER BY name ASC`,
      [tenantId],
    );
    return res.json({ appointment_types: rows });
  } catch (err) {
    logger.error('Failed to list appointment types', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to list appointment types' });
  }
};

const createAppointmentTypeHandler: RequestHandler = async (req, res) => {
  const { tenantId } = req.user!;
  const { name, description, duration_minutes, buffer_minutes, capacity, color, required_resources, intake_fields, allow_self_scheduling } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });
  const pool = getPlatformPool();
  try {
    const { rows } = await pool.query(
      `INSERT INTO scheduling_appointment_types (tenant_id, name, description, duration_minutes, buffer_minutes, capacity, color, required_resources, intake_fields, allow_self_scheduling)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
      [tenantId, name, description || '', duration_minutes || 30, buffer_minutes || 0, capacity || 1, color || '#3b82f6',
        JSON.stringify(required_resources || []), JSON.stringify(intake_fields || []), allow_self_scheduling || false],
    );
    return res.status(201).json({ appointment_type: rows[0] });
  } catch (err) {
    logger.error('Failed to create appointment type', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to create appointment type' });
  }
};

const updateAppointmentTypeHandler: RequestHandler = async (req, res) => {
  const { tenantId } = req.user!;
  const { id } = req.params;
  const { name, description, duration_minutes, buffer_minutes, capacity, color, required_resources, intake_fields, is_active, allow_self_scheduling } = req.body;
  const pool = getPlatformPool();
  try {
    const { rows } = await pool.query(
      `UPDATE scheduling_appointment_types SET
        name = COALESCE($3, name), description = COALESCE($4, description),
        duration_minutes = COALESCE($5, duration_minutes), buffer_minutes = COALESCE($6, buffer_minutes),
        capacity = COALESCE($7, capacity), color = COALESCE($8, color),
        required_resources = COALESCE($9, required_resources), intake_fields = COALESCE($10, intake_fields),
        is_active = COALESCE($11, is_active), allow_self_scheduling = COALESCE($12, allow_self_scheduling),
        updated_at = NOW()
       WHERE id = $1 AND tenant_id = $2 RETURNING *`,
      [id, tenantId, name, description, duration_minutes, buffer_minutes, capacity, color,
        required_resources ? JSON.stringify(required_resources) : null, intake_fields ? JSON.stringify(intake_fields) : null, is_active, allow_self_scheduling],
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Appointment type not found' });
    return res.json({ appointment_type: rows[0] });
  } catch (err) {
    logger.error('Failed to update appointment type', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to update appointment type' });
  }
};

const deleteAppointmentTypeHandler: RequestHandler = async (req, res) => {
  const { tenantId } = req.user!;
  const { id } = req.params;
  const pool = getPlatformPool();
  try {
    const { rowCount } = await pool.query(`DELETE FROM scheduling_appointment_types WHERE id = $1 AND tenant_id = $2`, [id, tenantId]);
    if (rowCount === 0) return res.status(404).json({ error: 'Appointment type not found' });
    return res.json({ success: true });
  } catch (err) {
    logger.error('Failed to delete appointment type', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to delete appointment type' });
  }
};

// ─── RESOURCES CRUD ───

const listResourcesHandler: RequestHandler = async (req, res) => {
  const { tenantId } = req.user!;
  const pool = getPlatformPool();
  try {
    const { rows } = await pool.query(
      `SELECT * FROM scheduling_resources WHERE tenant_id = $1 ORDER BY name ASC`,
      [tenantId],
    );
    return res.json({ resources: rows });
  } catch (err) {
    logger.error('Failed to list resources', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to list resources' });
  }
};

const createResourceHandler: RequestHandler = async (req, res) => {
  const { tenantId } = req.user!;
  const { name, type, location, capacity, metadata } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });
  const pool = getPlatformPool();
  try {
    const { rows } = await pool.query(
      `INSERT INTO scheduling_resources (tenant_id, name, type, location, capacity, metadata)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [tenantId, name, type || 'room', location || '', capacity || 1, JSON.stringify(metadata || {})],
    );
    return res.status(201).json({ resource: rows[0] });
  } catch (err) {
    logger.error('Failed to create resource', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to create resource' });
  }
};

const updateResourceHandler: RequestHandler = async (req, res) => {
  const { tenantId } = req.user!;
  const { id } = req.params;
  const { name, type, location, capacity, is_active, metadata } = req.body;
  const pool = getPlatformPool();
  try {
    const { rows } = await pool.query(
      `UPDATE scheduling_resources SET
        name = COALESCE($3, name), type = COALESCE($4, type),
        location = COALESCE($5, location), capacity = COALESCE($6, capacity),
        is_active = COALESCE($7, is_active), metadata = COALESCE($8, metadata), updated_at = NOW()
       WHERE id = $1 AND tenant_id = $2 RETURNING *`,
      [id, tenantId, name, type, location, capacity, is_active, metadata ? JSON.stringify(metadata) : null],
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Resource not found' });
    return res.json({ resource: rows[0] });
  } catch (err) {
    logger.error('Failed to update resource', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to update resource' });
  }
};

const deleteResourceHandler: RequestHandler = async (req, res) => {
  const { tenantId } = req.user!;
  const { id } = req.params;
  const pool = getPlatformPool();
  try {
    const { rowCount } = await pool.query(`DELETE FROM scheduling_resources WHERE id = $1 AND tenant_id = $2`, [id, tenantId]);
    if (rowCount === 0) return res.status(404).json({ error: 'Resource not found' });
    return res.json({ success: true });
  } catch (err) {
    logger.error('Failed to delete resource', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to delete resource' });
  }
};

// ─── BOOKING RULES ───

const listBookingRulesHandler: RequestHandler = async (req, res) => {
  const { tenantId } = req.user!;
  const pool = getPlatformPool();
  try {
    const { rows } = await pool.query(
      `SELECT r.*, at.name AS appointment_type_name
       FROM scheduling_booking_rules r
       LEFT JOIN scheduling_appointment_types at ON at.id = r.appointment_type_id
       WHERE r.tenant_id = $1 ORDER BY r.created_at ASC`,
      [tenantId],
    );
    return res.json({ rules: rows });
  } catch (err) {
    logger.error('Failed to list booking rules', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to list booking rules' });
  }
};

const upsertBookingRuleHandler: RequestHandler = async (req, res) => {
  const { tenantId } = req.user!;
  const { appointment_type_id, min_lead_time_hours, max_lead_time_days, allow_same_day, allow_double_book, max_daily_bookings, max_per_slot, cancellation_window_hours } = req.body;
  const pool = getPlatformPool();
  try {
    const { rows: existing } = await pool.query(
      `SELECT id FROM scheduling_booking_rules WHERE tenant_id = $1 AND ${appointment_type_id ? `appointment_type_id = $2` : `appointment_type_id IS NULL`}`,
      appointment_type_id ? [tenantId, appointment_type_id] : [tenantId],
    );

    if (existing.length > 0) {
      const { rows } = await pool.query(
        `UPDATE scheduling_booking_rules SET
          min_lead_time_hours = COALESCE($3, min_lead_time_hours),
          max_lead_time_days = COALESCE($4, max_lead_time_days),
          allow_same_day = COALESCE($5, allow_same_day),
          allow_double_book = COALESCE($6, allow_double_book),
          max_daily_bookings = COALESCE($7, max_daily_bookings),
          max_per_slot = COALESCE($8, max_per_slot),
          cancellation_window_hours = COALESCE($9, cancellation_window_hours),
          updated_at = NOW()
         WHERE id = $1 AND tenant_id = $2 RETURNING *`,
        [existing[0].id, tenantId, min_lead_time_hours, max_lead_time_days, allow_same_day, allow_double_book, max_daily_bookings, max_per_slot, cancellation_window_hours],
      );
      return res.json({ rule: rows[0] });
    }

    const { rows } = await pool.query(
      `INSERT INTO scheduling_booking_rules (tenant_id, appointment_type_id, min_lead_time_hours, max_lead_time_days, allow_same_day, allow_double_book, max_daily_bookings, max_per_slot, cancellation_window_hours)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [tenantId, appointment_type_id || null, min_lead_time_hours || 0, max_lead_time_days || 90, allow_same_day !== false, allow_double_book || false, max_daily_bookings || null, max_per_slot || 1, cancellation_window_hours || 24],
    );
    return res.status(201).json({ rule: rows[0] });
  } catch (err) {
    logger.error('Failed to upsert booking rule', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to upsert booking rule' });
  }
};

// ─── WAITLIST ───

const listWaitlistHandler: RequestHandler = async (req, res) => {
  const { tenantId } = req.user!;
  const { status } = req.query as Record<string, string>;
  const pool = getPlatformPool();
  try {
    const conditions: string[] = ['w.tenant_id = $1'];
    const values: unknown[] = [tenantId];
    if (status) { values.push(status); conditions.push(`w.status = $${values.length}`); }
    const { rows } = await pool.query(
      `SELECT w.*, at.name AS appointment_type_name, sp.name AS provider_name
       FROM scheduling_waitlist w
       LEFT JOIN scheduling_appointment_types at ON at.id = w.appointment_type_id
       LEFT JOIN scheduling_providers sp ON sp.id = w.provider_id
       WHERE ${conditions.join(' AND ')}
       ORDER BY w.created_at ASC`,
      values,
    );
    return res.json({ waitlist: rows });
  } catch (err) {
    logger.error('Failed to list waitlist', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to list waitlist' });
  }
};

const addToWaitlistHandler: RequestHandler = async (req, res) => {
  const { tenantId } = req.user!;
  const { contact_name, contact_phone, contact_email, appointment_type_id, provider_id, preferred_date_start, preferred_date_end, preferred_time_start, preferred_time_end, notes } = req.body;
  if (!contact_name) return res.status(400).json({ error: 'contact_name is required' });
  const pool = getPlatformPool();
  try {
    const { rows } = await pool.query(
      `INSERT INTO scheduling_waitlist (tenant_id, contact_name, contact_phone, contact_email, appointment_type_id, provider_id, preferred_date_start, preferred_date_end, preferred_time_start, preferred_time_end, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
      [tenantId, contact_name, contact_phone || '', contact_email || '', appointment_type_id || null, provider_id || null,
        preferred_date_start || null, preferred_date_end || null, preferred_time_start || null, preferred_time_end || null, notes || ''],
    );
    return res.status(201).json({ entry: rows[0] });
  } catch (err) {
    logger.error('Failed to add to waitlist', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to add to waitlist' });
  }
};

const updateWaitlistHandler: RequestHandler = async (req, res) => {
  const { tenantId } = req.user!;
  const { id } = req.params;
  const { status } = req.body;
  const pool = getPlatformPool();
  try {
    const { rows } = await pool.query(
      `UPDATE scheduling_waitlist SET status = COALESCE($3, status), updated_at = NOW() WHERE id = $1 AND tenant_id = $2 RETURNING *`,
      [id, tenantId, status],
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Waitlist entry not found' });
    return res.json({ entry: rows[0] });
  } catch (err) {
    logger.error('Failed to update waitlist', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to update waitlist entry' });
  }
};

const deleteWaitlistHandler: RequestHandler = async (req, res) => {
  const { tenantId } = req.user!;
  const { id } = req.params;
  const pool = getPlatformPool();
  try {
    const { rowCount } = await pool.query(`DELETE FROM scheduling_waitlist WHERE id = $1 AND tenant_id = $2`, [id, tenantId]);
    if (rowCount === 0) return res.status(404).json({ error: 'Waitlist entry not found' });
    return res.json({ success: true });
  } catch (err) {
    logger.error('Failed to delete waitlist entry', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to delete waitlist entry' });
  }
};

// ─── REMINDERS ───

const listReminderConfigsHandler: RequestHandler = async (req, res) => {
  const { tenantId } = req.user!;
  const pool = getPlatformPool();
  try {
    const { rows } = await pool.query(
      `SELECT rc.*, at.name AS appointment_type_name
       FROM scheduling_reminder_configs rc
       LEFT JOIN scheduling_appointment_types at ON at.id = rc.appointment_type_id
       WHERE rc.tenant_id = $1 ORDER BY rc.created_at ASC`,
      [tenantId],
    );
    return res.json({ reminders: rows });
  } catch (err) {
    logger.error('Failed to list reminder configs', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to list reminder configs' });
  }
};

const createReminderConfigHandler: RequestHandler = async (req, res) => {
  const { tenantId } = req.user!;
  const { appointment_type_id, reminder_type, channel, timing_minutes, template, is_active } = req.body;
  const pool = getPlatformPool();
  try {
    const { rows } = await pool.query(
      `INSERT INTO scheduling_reminder_configs (tenant_id, appointment_type_id, reminder_type, channel, timing_minutes, template, is_active)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [tenantId, appointment_type_id || null, reminder_type || 'reminder', channel || 'sms', timing_minutes || 1440, template || '', is_active !== false],
    );
    return res.status(201).json({ reminder: rows[0] });
  } catch (err) {
    logger.error('Failed to create reminder config', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to create reminder config' });
  }
};

const updateReminderConfigHandler: RequestHandler = async (req, res) => {
  const { tenantId } = req.user!;
  const { id } = req.params;
  const { reminder_type, channel, timing_minutes, template, is_active } = req.body;
  const pool = getPlatformPool();
  try {
    const { rows } = await pool.query(
      `UPDATE scheduling_reminder_configs SET
        reminder_type = COALESCE($3, reminder_type), channel = COALESCE($4, channel),
        timing_minutes = COALESCE($5, timing_minutes), template = COALESCE($6, template),
        is_active = COALESCE($7, is_active)
       WHERE id = $1 AND tenant_id = $2 RETURNING *`,
      [id, tenantId, reminder_type, channel, timing_minutes, template, is_active],
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Reminder config not found' });
    return res.json({ reminder: rows[0] });
  } catch (err) {
    logger.error('Failed to update reminder config', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to update reminder config' });
  }
};

const deleteReminderConfigHandler: RequestHandler = async (req, res) => {
  const { tenantId } = req.user!;
  const { id } = req.params;
  const pool = getPlatformPool();
  try {
    const { rowCount } = await pool.query(`DELETE FROM scheduling_reminder_configs WHERE id = $1 AND tenant_id = $2`, [id, tenantId]);
    if (rowCount === 0) return res.status(404).json({ error: 'Reminder config not found' });
    return res.json({ success: true });
  } catch (err) {
    logger.error('Failed to delete reminder config', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to delete reminder config' });
  }
};

// ─── RECURRING SERIES ───

const listRecurringSeriesHandler: RequestHandler = async (req, res) => {
  const { tenantId } = req.user!;
  const pool = getPlatformPool();
  try {
    const { rows } = await pool.query(
      `SELECT rs.*, sp.name AS provider_name, at.name AS appointment_type_name
       FROM scheduling_recurring_series rs
       LEFT JOIN scheduling_providers sp ON sp.id = rs.provider_id
       LEFT JOIN scheduling_appointment_types at ON at.id = rs.appointment_type_id
       WHERE rs.tenant_id = $1 ORDER BY rs.series_start ASC`,
      [tenantId],
    );
    return res.json({ series: rows });
  } catch (err) {
    logger.error('Failed to list recurring series', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to list recurring series' });
  }
};

const createRecurringSeriesHandler: RequestHandler = async (req, res) => {
  const { tenantId } = req.user!;
  const { title, provider_id, appointment_type_id, resource_id, recurrence_pattern, recurrence_day_of_week, recurrence_time, duration_minutes, series_start, series_end, contact_name, contact_phone, contact_email } = req.body;
  if (!title || !recurrence_time || !series_start) return res.status(400).json({ error: 'title, recurrence_time, and series_start are required' });
  const pool = getPlatformPool();
  try {
    const { rows } = await pool.query(
      `INSERT INTO scheduling_recurring_series (tenant_id, title, provider_id, appointment_type_id, resource_id, recurrence_pattern, recurrence_day_of_week, recurrence_time, duration_minutes, series_start, series_end, contact_name, contact_phone, contact_email, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) RETURNING *`,
      [tenantId, title, provider_id || null, appointment_type_id || null, resource_id || null, recurrence_pattern || 'weekly', recurrence_day_of_week ?? null, recurrence_time, duration_minutes || 30, series_start, series_end || null, contact_name || '', contact_phone || '', contact_email || '', req.user!.userId],
    );
    return res.status(201).json({ series: rows[0] });
  } catch (err) {
    logger.error('Failed to create recurring series', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to create recurring series' });
  }
};

// ─── AVAILABILITY ENGINE ───

const checkAvailabilityHandler: RequestHandler = async (req, res) => {
  const { tenantId } = req.user!;
  const { provider_id, date, appointment_type_id } = req.query as Record<string, string>;
  if (!date) return res.status(400).json({ error: 'date is required' });
  const pool = getPlatformPool();

  try {
    const targetDate = new Date(date);
    const dayOfWeek = targetDate.getDay();

    let scheduleBlocks: Array<{ start_time: string; end_time: string }> = [];
    if (provider_id) {
      const { rows } = await pool.query(
        `SELECT start_time, end_time FROM scheduling_provider_schedules
         WHERE tenant_id = $1 AND provider_id = $2 AND day_of_week = $3 AND is_active = true`,
        [tenantId, provider_id, dayOfWeek],
      );
      scheduleBlocks = rows;
    }

    if (scheduleBlocks.length === 0) {
      scheduleBlocks = [{ start_time: '08:00', end_time: '17:00' }];
    }

    const { rows: overrides } = await pool.query(
      `SELECT * FROM scheduling_overrides
       WHERE tenant_id = $1 AND override_date = $2::date
         AND (provider_id = $3 OR provider_id IS NULL)`,
      [tenantId, date, provider_id || null],
    );

    const isBlocked = overrides.some(o => !o.is_available && !o.start_time);
    if (isBlocked) {
      return res.json({ available: false, slots: [], reason: 'Date is blocked' });
    }

    let duration = 30;
    let buffer = 0;
    if (appointment_type_id) {
      const { rows: typeRows } = await pool.query(
        `SELECT duration_minutes, buffer_minutes FROM scheduling_appointment_types WHERE id = $1 AND tenant_id = $2`,
        [appointment_type_id, tenantId],
      );
      if (typeRows.length > 0) {
        duration = typeRows[0].duration_minutes;
        buffer = typeRows[0].buffer_minutes;
      }
    }

    const dayStart = `${date}T00:00:00.000Z`;
    const dayEnd = `${date}T23:59:59.999Z`;
    const { rows: existingBookings } = await pool.query(
      `SELECT start_time, end_time FROM bookings
       WHERE tenant_id = $1 AND start_time >= $2::timestamptz AND end_time <= $3::timestamptz
         AND status NOT IN ('cancelled', 'no_show', 'rescheduled')
         ${provider_id ? 'AND provider_id = $4' : ''}`,
      provider_id ? [tenantId, dayStart, dayEnd, provider_id] : [tenantId, dayStart, dayEnd],
    );

    const slots: Array<{ start: string; end: string; available: boolean }> = [];

    for (const block of scheduleBlocks) {
      const blockStart = new Date(`${date}T${block.start_time}`);
      const blockEnd = new Date(`${date}T${block.end_time}`);
      let current = new Date(blockStart);

      while (current.getTime() + duration * 60000 <= blockEnd.getTime()) {
        const slotEnd = new Date(current.getTime() + duration * 60000);
        const hasConflict = existingBookings.some((b: { start_time: string; end_time: string }) => {
          const bStart = new Date(b.start_time).getTime();
          const bEnd = new Date(b.end_time).getTime();
          return current.getTime() < bEnd && slotEnd.getTime() > bStart;
        });

        slots.push({
          start: current.toISOString(),
          end: slotEnd.toISOString(),
          available: !hasConflict,
        });

        current = new Date(current.getTime() + (duration + buffer) * 60000);
      }
    }

    return res.json({ available: true, slots, date, provider_id });
  } catch (err) {
    logger.error('Failed to check availability', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to check availability' });
  }
};

// ─── REPORTING ───

const reportingHandler: RequestHandler = async (req, res) => {
  const { tenantId } = req.user!;
  const { start, end, provider_id, appointment_type_id } = req.query as Record<string, string>;
  const pool = getPlatformPool();

  try {
    const conditions: string[] = ['tenant_id = $1'];
    const values: unknown[] = [tenantId];
    if (start) { values.push(start); conditions.push(`start_time >= $${values.length}::timestamptz`); }
    if (end) { values.push(end); conditions.push(`end_time <= $${values.length}::timestamptz`); }
    if (provider_id) { values.push(provider_id); conditions.push(`provider_id = $${values.length}`); }
    if (appointment_type_id) { values.push(appointment_type_id); conditions.push(`appointment_type_id = $${values.length}`); }
    const where = conditions.join(' AND ');

    const { rows: [stats] } = await pool.query(
      `SELECT
        COUNT(*)::int AS total_bookings,
        COUNT(*) FILTER (WHERE status = 'completed')::int AS completed,
        COUNT(*) FILTER (WHERE status = 'cancelled')::int AS cancelled,
        COUNT(*) FILTER (WHERE status = 'no_show')::int AS no_shows,
        COUNT(*) FILTER (WHERE status = 'confirmed')::int AS confirmed,
        COUNT(*) FILTER (WHERE status = 'pending')::int AS pending,
        COUNT(*) FILTER (WHERE status = 'checked_in')::int AS checked_in,
        ROUND(COUNT(*) FILTER (WHERE status = 'no_show')::numeric / NULLIF(COUNT(*) FILTER (WHERE status IN ('completed', 'no_show', 'checked_in')), 0) * 100, 1) AS no_show_rate,
        ROUND(COUNT(*) FILTER (WHERE status = 'cancelled')::numeric / NULLIF(COUNT(*), 0) * 100, 1) AS cancellation_rate,
        ROUND(COUNT(*) FILTER (WHERE status = 'completed')::numeric / NULLIF(COUNT(*) FILTER (WHERE status NOT IN ('cancelled', 'rescheduled')), 0) * 100, 1) AS fill_rate,
        ROUND(AVG(EXTRACT(EPOCH FROM (start_time - created_at)) / 3600)::numeric, 1) AS avg_hours_to_appointment
       FROM bookings WHERE ${where}`,
      values,
    );

    const { rows: byProvider } = await pool.query(
      `SELECT sp.name AS provider_name, b.provider_id,
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE b.status = 'completed')::int AS completed,
        COUNT(*) FILTER (WHERE b.status = 'no_show')::int AS no_shows,
        COUNT(*) FILTER (WHERE b.status = 'cancelled')::int AS cancelled,
        ROUND(SUM(EXTRACT(EPOCH FROM (b.end_time - b.start_time)))::numeric / 3600, 1) AS total_hours
       FROM bookings b
       LEFT JOIN scheduling_providers sp ON sp.id = b.provider_id
       WHERE ${where.replace(/tenant_id/g, 'b.tenant_id').replace(/start_time/g, 'b.start_time').replace(/end_time/g, 'b.end_time').replace(/provider_id/g, 'b.provider_id').replace(/appointment_type_id/g, 'b.appointment_type_id')}
       GROUP BY sp.name, b.provider_id`,
      values,
    );

    const { rows: byType } = await pool.query(
      `SELECT sat.name AS type_name, sat.color, b.appointment_type_id,
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE b.status = 'completed')::int AS completed,
        COUNT(*) FILTER (WHERE b.status = 'cancelled')::int AS cancelled
       FROM bookings b
       LEFT JOIN scheduling_appointment_types sat ON sat.id = b.appointment_type_id
       WHERE ${where.replace(/tenant_id/g, 'b.tenant_id').replace(/start_time/g, 'b.start_time').replace(/end_time/g, 'b.end_time').replace(/provider_id/g, 'b.provider_id').replace(/appointment_type_id/g, 'b.appointment_type_id')}
       GROUP BY sat.name, sat.color, b.appointment_type_id`,
      values,
    );

    const { rows: cancellationReasons } = await pool.query(
      `SELECT cancellation_reason, COUNT(*)::int AS count
       FROM bookings WHERE ${where} AND status = 'cancelled' AND cancellation_reason != ''
       GROUP BY cancellation_reason ORDER BY count DESC LIMIT 10`,
      values,
    );

    const { rows: dailyTrend } = await pool.query(
      `SELECT DATE(start_time) AS date,
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE status = 'completed')::int AS completed,
        COUNT(*) FILTER (WHERE status = 'cancelled')::int AS cancelled,
        COUNT(*) FILTER (WHERE status = 'no_show')::int AS no_shows
       FROM bookings WHERE ${where}
       GROUP BY DATE(start_time) ORDER BY date ASC`,
      values,
    );

    const { rows: bySource } = await pool.query(
      `SELECT booking_source, COUNT(*)::int AS count
       FROM bookings WHERE ${where}
       GROUP BY booking_source ORDER BY count DESC`,
      values,
    );

    return res.json({
      summary: stats,
      by_provider: byProvider,
      by_type: byType,
      cancellation_reasons: cancellationReasons,
      daily_trend: dailyTrend,
      by_source: bySource,
    });
  } catch (err) {
    logger.error('Failed to generate report', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to generate report' });
  }
};

// ─── UTILIZATION ───

const utilizationHandler: RequestHandler = async (req, res) => {
  const { tenantId } = req.user!;
  const { start, end } = req.query as Record<string, string>;
  const pool = getPlatformPool();

  try {
    const conditions: string[] = ['b.tenant_id = $1'];
    const values: unknown[] = [tenantId];
    if (start) { values.push(start); conditions.push(`b.start_time >= $${values.length}::timestamptz`); }
    if (end) { values.push(end); conditions.push(`b.end_time <= $${values.length}::timestamptz`); }
    const where = conditions.join(' AND ');

    const { rows: providerUtil } = await pool.query(
      `SELECT sp.id, sp.name,
        COUNT(b.id)::int AS total_bookings,
        ROUND(SUM(EXTRACT(EPOCH FROM (b.end_time - b.start_time)))::numeric / 3600, 1) AS booked_hours,
        COUNT(b.id) FILTER (WHERE b.status = 'completed')::int AS completed,
        COUNT(b.id) FILTER (WHERE b.status = 'no_show')::int AS no_shows
       FROM scheduling_providers sp
       LEFT JOIN bookings b ON b.provider_id = sp.id AND ${where}
       WHERE sp.tenant_id = $1 AND sp.is_active = true
       GROUP BY sp.id, sp.name ORDER BY sp.name`,
      values,
    );

    const { rows: resourceUtil } = await pool.query(
      `SELECT sr.id, sr.name, sr.type,
        COUNT(b.id)::int AS total_bookings,
        ROUND(SUM(EXTRACT(EPOCH FROM (b.end_time - b.start_time)))::numeric / 3600, 1) AS booked_hours
       FROM scheduling_resources sr
       LEFT JOIN bookings b ON b.resource_id = sr.id AND ${where.replace(/b\.tenant_id/g, 'sr.tenant_id')}
       WHERE sr.tenant_id = $1 AND sr.is_active = true
       GROUP BY sr.id, sr.name, sr.type ORDER BY sr.name`,
      values,
    );

    return res.json({ provider_utilization: providerUtil, resource_utilization: resourceUtil });
  } catch (err) {
    logger.error('Failed to get utilization', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to get utilization' });
  }
};

// ─── AUDIT LOG ───

const listAuditLogHandler: RequestHandler = async (req, res) => {
  const { tenantId } = req.user!;
  const { booking_id, limit: lim } = req.query as Record<string, string>;
  const pool = getPlatformPool();
  try {
    const conditions: string[] = ['al.tenant_id = $1'];
    const values: unknown[] = [tenantId];
    if (booking_id) { values.push(booking_id); conditions.push(`al.booking_id = $${values.length}`); }
    const { rows } = await pool.query(
      `SELECT al.*, u.email AS changed_by_email
       FROM scheduling_audit_log al
       LEFT JOIN users u ON u.id = al.changed_by
       WHERE ${conditions.join(' AND ')}
       ORDER BY al.created_at DESC
       LIMIT $${values.length + 1}`,
      [...values, Math.min(parseInt(lim || '100', 10), 500)],
    );
    return res.json({ audit_log: rows });
  } catch (err) {
    logger.error('Failed to list audit log', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to list audit log' });
  }
};

// ─── SELF-SCHEDULING CONFIG ───

const selfScheduleConfigHandler: RequestHandler = async (req, res) => {
  const { tenantId } = req.user!;
  const pool = getPlatformPool();
  try {
    const { rows: types } = await pool.query(
      `SELECT id, name, description, duration_minutes, intake_fields, color FROM scheduling_appointment_types
       WHERE tenant_id = $1 AND is_active = true AND allow_self_scheduling = true ORDER BY name`,
      [tenantId],
    );
    const { rows: providers } = await pool.query(
      `SELECT id, name, specialty, location FROM scheduling_providers WHERE tenant_id = $1 AND is_active = true ORDER BY name`,
      [tenantId],
    );
    return res.json({ appointment_types: types, providers });
  } catch (err) {
    logger.error('Failed to get self-schedule config', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to get self-schedule config' });
  }
};

// ─── REGISTER ROUTES ───

router.get('/scheduling/bookings', requireAuth, listBookingsHandler);
router.get('/scheduling/bookings/:id', requireAuth, getBookingHandler);
router.post('/scheduling/bookings', requireAuth, requireMiniSystemWrite, createBookingHandler);
router.put('/scheduling/bookings/:id', requireAuth, requireMiniSystemWrite, updateBookingHandler);
router.post('/scheduling/bookings/:id/transition', requireAuth, requireMiniSystemWrite, transitionBookingHandler);
router.delete('/scheduling/bookings/:id', requireAuth, requireMiniSystemWrite, deleteBookingHandler);

router.get('/scheduling/providers', requireAuth, listProvidersHandler);
router.post('/scheduling/providers', requireAuth, requireMiniSystemWrite, createProviderHandler);
router.put('/scheduling/providers/:id', requireAuth, requireMiniSystemWrite, updateProviderHandler);
router.delete('/scheduling/providers/:id', requireAuth, requireMiniSystemWrite, deleteProviderHandler);

router.get('/scheduling/providers/:provider_id/schedules', requireAuth, listProviderSchedulesHandler);
router.put('/scheduling/providers/:provider_id/schedules', requireAuth, requireMiniSystemWrite, upsertProviderScheduleHandler);

router.get('/scheduling/overrides', requireAuth, listOverridesHandler);
router.post('/scheduling/overrides', requireAuth, requireMiniSystemWrite, createOverrideHandler);
router.delete('/scheduling/overrides/:id', requireAuth, requireMiniSystemWrite, deleteOverrideHandler);

router.get('/scheduling/appointment-types', requireAuth, listAppointmentTypesHandler);
router.post('/scheduling/appointment-types', requireAuth, requireMiniSystemWrite, createAppointmentTypeHandler);
router.put('/scheduling/appointment-types/:id', requireAuth, requireMiniSystemWrite, updateAppointmentTypeHandler);
router.delete('/scheduling/appointment-types/:id', requireAuth, requireMiniSystemWrite, deleteAppointmentTypeHandler);

router.get('/scheduling/resources', requireAuth, listResourcesHandler);
router.post('/scheduling/resources', requireAuth, requireMiniSystemWrite, createResourceHandler);
router.put('/scheduling/resources/:id', requireAuth, requireMiniSystemWrite, updateResourceHandler);
router.delete('/scheduling/resources/:id', requireAuth, requireMiniSystemWrite, deleteResourceHandler);

router.get('/scheduling/rules', requireAuth, listBookingRulesHandler);
router.post('/scheduling/rules', requireAuth, requireMiniSystemWrite, upsertBookingRuleHandler);

router.get('/scheduling/waitlist', requireAuth, listWaitlistHandler);
router.post('/scheduling/waitlist', requireAuth, requireMiniSystemWrite, addToWaitlistHandler);
router.put('/scheduling/waitlist/:id', requireAuth, requireMiniSystemWrite, updateWaitlistHandler);
router.delete('/scheduling/waitlist/:id', requireAuth, requireMiniSystemWrite, deleteWaitlistHandler);

router.get('/scheduling/reminders', requireAuth, listReminderConfigsHandler);
router.post('/scheduling/reminders', requireAuth, requireMiniSystemWrite, createReminderConfigHandler);
router.put('/scheduling/reminders/:id', requireAuth, requireMiniSystemWrite, updateReminderConfigHandler);
router.delete('/scheduling/reminders/:id', requireAuth, requireMiniSystemWrite, deleteReminderConfigHandler);

router.get('/scheduling/recurring', requireAuth, listRecurringSeriesHandler);
router.post('/scheduling/recurring', requireAuth, requireMiniSystemWrite, createRecurringSeriesHandler);

router.get('/scheduling/availability', requireAuth, checkAvailabilityHandler);
router.get('/scheduling/reports', requireAuth, reportingHandler);
router.get('/scheduling/utilization', requireAuth, utilizationHandler);
router.get('/scheduling/audit-log', requireAuth, listAuditLogHandler);
router.get('/scheduling/self-schedule-config', requireAuth, selfScheduleConfigHandler);

export default router;
