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

const VALID_STATUSES = ['pending', 'assigned', 'scheduled', 'en_route', 'on_site', 'in_progress', 'completed', 'incomplete', 'cancelled', 'done'];

async function validateTenantRef(pool: ReturnType<typeof getPlatformPool>, table: string, id: string, tenantId: string): Promise<boolean> {
  const { rows } = await pool.query(`SELECT id FROM ${table} WHERE id = $1 AND tenant_id = $2 LIMIT 1`, [id, tenantId]);
  return rows.length > 0;
}

async function validateResourceAssignment(
  pool: ReturnType<typeof getPlatformPool>,
  resourceId: string,
  tenantId: string,
  opts?: { territoryId?: string | null; requiredSkills?: string[]; scheduledAt?: string | null },
): Promise<{ valid: boolean; reason?: string }> {
  const { rows } = await pool.query(
    `SELECT r.id, r.current_status, r.max_concurrent_jobs, r.territory_id, r.status,
            r.shift_start, r.shift_end, r.shift_days,
            (SELECT COUNT(*)::int FROM dispatch_jobs dj
             WHERE dj.resource_id = r.id AND dj.status IN ('assigned','scheduled','en_route','on_site','in_progress')) AS active_jobs,
            (SELECT array_agg(st.name) FROM dispatch_resource_skills rs
             JOIN dispatch_skill_types st ON st.id = rs.skill_type_id
             WHERE rs.resource_id = r.id) AS skill_names
     FROM dispatch_resources r
     WHERE r.id = $1 AND r.tenant_id = $2`,
    [resourceId, tenantId],
  );

  if (rows.length === 0) return { valid: false, reason: 'Resource not found in this tenant' };

  const resource = rows[0];
  if (resource.status !== 'active') return { valid: false, reason: 'Resource is inactive' };
  if (resource.current_status === 'unavailable') return { valid: false, reason: 'Resource is currently unavailable' };
  if ((resource.active_jobs as number) >= (resource.max_concurrent_jobs as number)) {
    return { valid: false, reason: `Resource at capacity (${resource.active_jobs}/${resource.max_concurrent_jobs} jobs)` };
  }

  const territoryId = opts?.territoryId;
  if (territoryId && resource.territory_id && resource.territory_id !== territoryId) {
    return { valid: false, reason: 'Resource is assigned to a different territory' };
  }

  const requiredSkills = opts?.requiredSkills;
  if (requiredSkills && requiredSkills.length > 0) {
    const resourceSkills: string[] = (resource.skill_names as string[]) || [];
    const missing = requiredSkills.filter(s => !resourceSkills.includes(s));
    if (missing.length > 0) {
      return { valid: false, reason: `Resource missing required skills: ${missing.join(', ')}` };
    }
  }

  const scheduledAt = opts?.scheduledAt;
  if (scheduledAt && resource.shift_start && resource.shift_end) {
    const scheduled = new Date(scheduledAt);
    const dayOfWeek = scheduled.getDay() === 0 ? 7 : scheduled.getDay();
    const shiftDays: number[] = resource.shift_days || [1,2,3,4,5];
    if (!shiftDays.includes(dayOfWeek)) {
      return { valid: false, reason: `Resource is not scheduled to work on day ${dayOfWeek}` };
    }

    const timeStr = `${String(scheduled.getHours()).padStart(2, '0')}:${String(scheduled.getMinutes()).padStart(2, '0')}`;
    if (timeStr < resource.shift_start || timeStr > resource.shift_end) {
      return { valid: false, reason: `Scheduled time ${timeStr} is outside resource shift window (${resource.shift_start}-${resource.shift_end})` };
    }
  }

  return { valid: true };
}

const STATUS_TO_TRIGGER: Record<string, string> = {
  assigned: 'job_assigned',
  scheduled: 'job_scheduled',
  en_route: 'en_route',
  on_site: 'arrival',
  completed: 'completed',
  done: 'completed',
  cancelled: 'cancelled',
};

async function fireNotifications(
  pool: ReturnType<typeof getPlatformPool>,
  tenantId: string,
  jobId: string,
  triggerEvent: string,
): Promise<void> {
  try {
    const { rows: templates } = await pool.query(
      `SELECT id, channel, subject, body_template FROM dispatch_notification_templates
       WHERE tenant_id = $1 AND trigger_event = $2 AND is_active = true`,
      [tenantId, triggerEvent],
    );
    if (templates.length === 0) return;

    const { rows: jobRows } = await pool.query(
      `SELECT d.*, r.name AS resource_name, r.email AS resource_email, r.phone AS resource_phone
       FROM dispatch_jobs d
       LEFT JOIN dispatch_resources r ON r.id = d.resource_id AND r.tenant_id = d.tenant_id
       WHERE d.id = $1 AND d.tenant_id = $2`,
      [jobId, tenantId],
    );
    if (jobRows.length === 0) return;

    const job = jobRows[0];
    for (const tpl of templates) {
      let body = (tpl.body_template as string)
        .replace(/\{\{job_title\}\}/g, job.title as string || '')
        .replace(/\{\{contact_name\}\}/g, job.contact_name as string || '')
        .replace(/\{\{eta\}\}/g, job.eta_start ? new Date(job.eta_start as string).toLocaleString() : 'TBD')
        .replace(/\{\{resource_name\}\}/g, job.resource_name as string || '')
        .replace(/\{\{status\}\}/g, job.status as string || '')
        .replace(/\{\{address\}\}/g, job.address as string || '');

      let subject = (tpl.subject as string || '')
        .replace(/\{\{job_title\}\}/g, job.title as string || '')
        .replace(/\{\{status\}\}/g, job.status as string || '');

      const recipient = (job.contact_phone as string) || (job.contact_email as string) || '';
      if (!recipient) continue;

      await pool.query(
        `INSERT INTO dispatch_notifications_log (job_id, tenant_id, template_id, channel, recipient, subject, body, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'queued')`,
        [jobId, tenantId, tpl.id, tpl.channel, recipient, subject, body],
      );
    }
  } catch (err) {
    logger.error('Failed to fire notifications', { tenantId, jobId, triggerEvent, error: String(err) });
  }
}

const VALID_TRANSITIONS: Record<string, string[]> = {
  pending: ['assigned', 'cancelled'],
  assigned: ['scheduled', 'en_route', 'in_progress', 'cancelled', 'pending'],
  scheduled: ['en_route', 'in_progress', 'cancelled', 'assigned'],
  en_route: ['on_site', 'cancelled'],
  on_site: ['in_progress', 'cancelled'],
  in_progress: ['completed', 'incomplete', 'cancelled', 'done'],
  completed: ['done'],
  incomplete: ['pending', 'assigned', 'cancelled'],
  done: [],
  cancelled: ['pending'],
};

// ============ JOBS ============

const listJobsHandler: RequestHandler = async (req, res) => {
  const { tenantId } = req.user!;
  const { limit, offset } = paginate(req);
  const { status, assignee, priority, territory_id, resource_id, date_from, date_to, search, job_type } = req.query as Record<string, string>;
  const pool = getPlatformPool();

  try {
    const conditions: string[] = ['d.tenant_id = $1'];
    const values: unknown[] = [tenantId];

    if (status) { values.push(status); conditions.push(`d.status = $${values.length}`); }
    if (assignee) { values.push(assignee); conditions.push(`d.assignee_user_id = $${values.length}`); }
    if (priority) { values.push(priority); conditions.push(`d.priority = $${values.length}`); }
    if (territory_id) { values.push(territory_id); conditions.push(`d.territory_id = $${values.length}`); }
    if (resource_id) { values.push(resource_id); conditions.push(`d.resource_id = $${values.length}`); }
    if (job_type) { values.push(job_type); conditions.push(`d.job_type = $${values.length}`); }
    if (date_from) { values.push(date_from); conditions.push(`d.created_at >= $${values.length}::timestamptz`); }
    if (date_to) { values.push(date_to); conditions.push(`d.created_at <= $${values.length}::timestamptz`); }
    if (search) { values.push(`%${search}%`); conditions.push(`(d.title ILIKE $${values.length} OR d.description ILIKE $${values.length} OR d.contact_name ILIKE $${values.length})`); }

    const where = conditions.join(' AND ');

    const { rows } = await pool.query(
      `SELECT d.*, u.email AS assignee_email,
              r.name AS resource_name,
              t.name AS territory_name
       FROM dispatch_jobs d
       LEFT JOIN users u ON u.id = d.assignee_user_id
       LEFT JOIN dispatch_resources r ON r.id = d.resource_id AND r.tenant_id = d.tenant_id
       LEFT JOIN dispatch_territories t ON t.id = d.territory_id AND t.tenant_id = d.tenant_id
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

const getStatusCountsHandler: RequestHandler = async (req, res) => {
  const { tenantId } = req.user!;
  const pool = getPlatformPool();
  try {
    const { rows } = await pool.query(
      `SELECT status, COUNT(*)::int AS count FROM dispatch_jobs WHERE tenant_id = $1 GROUP BY status`,
      [tenantId],
    );
    const counts: Record<string, number> = {};
    for (const r of rows) counts[r.status as string] = r.count as number;
    return res.json({ counts });
  } catch (err) {
    logger.error('Failed to get status counts', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to get status counts' });
  }
};

const getJobHandler: RequestHandler = async (req, res) => {
  const { tenantId } = req.user!;
  const { id } = req.params;
  const pool = getPlatformPool();

  try {
    const { rows } = await pool.query(
      `SELECT d.*, u.email AS assignee_email,
              r.name AS resource_name,
              t.name AS territory_name
       FROM dispatch_jobs d
       LEFT JOIN users u ON u.id = d.assignee_user_id
       LEFT JOIN dispatch_resources r ON r.id = d.resource_id AND r.tenant_id = d.tenant_id
       LEFT JOIN dispatch_territories t ON t.id = d.territory_id AND t.tenant_id = d.tenant_id
       WHERE d.id = $1 AND d.tenant_id = $2`,
      [id, tenantId],
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Job not found' });
    }

    const { rows: events } = await pool.query(
      `SELECT * FROM dispatch_job_events WHERE job_id = $1 AND tenant_id = $2 ORDER BY created_at DESC LIMIT 50`,
      [id, tenantId],
    );
    const { rows: exceptions } = await pool.query(
      `SELECT * FROM dispatch_job_exceptions WHERE job_id = $1 AND tenant_id = $2 ORDER BY created_at DESC`,
      [id, tenantId],
    );
    const { rows: attachments } = await pool.query(
      `SELECT * FROM dispatch_job_attachments WHERE job_id = $1 AND tenant_id = $2 ORDER BY created_at DESC`,
      [id, tenantId],
    );

    return res.json({ job: rows[0], events, exceptions, attachments });
  } catch (err) {
    logger.error('Failed to get dispatch job', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to get job' });
  }
};

const createJobHandler: RequestHandler = async (req, res) => {
  const { tenantId, userId } = req.user!;
  const { title, description, status, priority, assignee_user_id, contact_id, contact_name,
          scheduled_at, notes, territory_id, resource_id, job_type, estimated_duration_minutes,
          eta_start, eta_end, address, contact_phone, contact_email, required_skills, parent_job_id,
          is_follow_up, metadata } = req.body;

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

    if (territory_id && !(await validateTenantRef(pool, 'dispatch_territories', territory_id, tenantId))) {
      return res.status(400).json({ error: 'Territory not found in this tenant' });
    }
    if (resource_id) {
      const check = await validateResourceAssignment(pool, resource_id, tenantId, {
        territoryId: territory_id, requiredSkills: required_skills, scheduledAt: scheduled_at,
      });
      if (!check.valid) {
        return res.status(400).json({ error: check.reason });
      }
    }
    if (parent_job_id && !(await validateTenantRef(pool, 'dispatch_jobs', parent_job_id, tenantId))) {
      return res.status(400).json({ error: 'Parent job not found in this tenant' });
    }

    const jobStatus = status || 'pending';
    const { rows } = await pool.query(
      `INSERT INTO dispatch_jobs (tenant_id, title, description, status, priority, assignee_user_id,
        contact_id, contact_name, scheduled_at, notes, territory_id, resource_id, job_type,
        estimated_duration_minutes, eta_start, eta_end, address, contact_phone, contact_email,
        required_skills, parent_job_id, is_follow_up, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)
       RETURNING *`,
      [tenantId, title, description || '', jobStatus, priority || 'medium',
       assignee_user_id || null, contact_id || null, contact_name || '', scheduled_at || null,
       notes || '', territory_id || null, resource_id || null, job_type || 'general',
       estimated_duration_minutes || null, eta_start || null, eta_end || null,
       address || '', contact_phone || '', contact_email || '',
       required_skills || '{}', parent_job_id || null, is_follow_up || false,
       JSON.stringify(metadata || {})],
    );

    await pool.query(
      `INSERT INTO dispatch_job_events (job_id, tenant_id, event_type, to_status, performed_by, notes)
       VALUES ($1, $2, 'created', $3, $4, 'Job created')`,
      [rows[0].id, tenantId, jobStatus, userId],
    );

    return res.status(201).json({ job: rows[0] });
  } catch (err) {
    logger.error('Failed to create dispatch job', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to create job' });
  }
};

const updateJobHandler: RequestHandler = async (req, res) => {
  const { tenantId, userId } = req.user!;
  const { id } = req.params;
  const { title, description, status, priority, assignee_user_id, contact_id, contact_name,
          scheduled_at, notes, territory_id, resource_id, job_type, estimated_duration_minutes,
          eta_start, eta_end, address, contact_phone, contact_email, required_skills, metadata } = req.body;
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

    if (territory_id && !(await validateTenantRef(pool, 'dispatch_territories', territory_id, tenantId))) {
      return res.status(400).json({ error: 'Territory not found in this tenant' });
    }
    const { rows: existing } = await pool.query(
      `SELECT id, status as current_status, assignee_user_id, territory_id AS cur_territory_id,
              required_skills AS cur_required_skills, scheduled_at AS cur_scheduled_at
       FROM dispatch_jobs WHERE id = $1 AND tenant_id = $2`,
      [id, tenantId],
    );

    if (existing.length === 0) {
      return res.status(404).json({ error: 'Job not found' });
    }

    if (resource_id) {
      const effectiveTerritoryId = territory_id || existing[0].cur_territory_id;
      const effectiveSkills = required_skills || existing[0].cur_required_skills || [];
      const effectiveScheduled = scheduled_at || existing[0].cur_scheduled_at;
      const check = await validateResourceAssignment(pool, resource_id, tenantId, {
        territoryId: effectiveTerritoryId, requiredSkills: effectiveSkills, scheduledAt: effectiveScheduled,
      });
      if (!check.valid) {
        return res.status(400).json({ error: check.reason });
      }
    }

    const currentStatus = existing[0].current_status as string;

    if (status && status !== currentStatus) {
      const allowed = VALID_TRANSITIONS[currentStatus] || [];
      if (!allowed.includes(status)) {
        return res.status(400).json({
          error: `Cannot transition from '${currentStatus}' to '${status}'. Allowed: ${allowed.join(', ')}`,
        });
      }
    }

    const setCompletedAt = (status === 'done' || status === 'completed') && currentStatus !== 'done' && currentStatus !== 'completed';

    const updates: string[] = ['updated_at = NOW()'];
    const values: unknown[] = [];
    let idx = 1;

    if (title !== undefined) { updates.push(`title = $${idx++}`); values.push(title); }
    if (description !== undefined) { updates.push(`description = $${idx++}`); values.push(description); }
    if (status !== undefined) { updates.push(`status = $${idx++}`); values.push(status); }
    if (priority !== undefined) { updates.push(`priority = $${idx++}`); values.push(priority); }
    if (assignee_user_id !== undefined) { updates.push(`assignee_user_id = $${idx++}`); values.push(assignee_user_id); }
    if (contact_id !== undefined) { updates.push(`contact_id = $${idx++}`); values.push(contact_id); }
    if (contact_name !== undefined) { updates.push(`contact_name = $${idx++}`); values.push(contact_name); }
    if (scheduled_at !== undefined) { updates.push(`scheduled_at = $${idx++}`); values.push(scheduled_at); }
    if (notes !== undefined) { updates.push(`notes = $${idx++}`); values.push(notes); }
    if (territory_id !== undefined) { updates.push(`territory_id = $${idx++}`); values.push(territory_id); }
    if (resource_id !== undefined) { updates.push(`resource_id = $${idx++}`); values.push(resource_id); }
    if (job_type !== undefined) { updates.push(`job_type = $${idx++}`); values.push(job_type); }
    if (estimated_duration_minutes !== undefined) { updates.push(`estimated_duration_minutes = $${idx++}`); values.push(estimated_duration_minutes); }
    if (eta_start !== undefined) { updates.push(`eta_start = $${idx++}`); values.push(eta_start); }
    if (eta_end !== undefined) { updates.push(`eta_end = $${idx++}`); values.push(eta_end); }
    if (address !== undefined) { updates.push(`address = $${idx++}`); values.push(address); }
    if (contact_phone !== undefined) { updates.push(`contact_phone = $${idx++}`); values.push(contact_phone); }
    if (contact_email !== undefined) { updates.push(`contact_email = $${idx++}`); values.push(contact_email); }
    if (required_skills !== undefined) { updates.push(`required_skills = $${idx++}`); values.push(required_skills); }
    if (metadata !== undefined) { updates.push(`metadata = $${idx++}`); values.push(metadata ? JSON.stringify(metadata) : null); }
    if (setCompletedAt) { updates.push('completed_at = NOW()'); }

    values.push(id, tenantId);
    const { rows } = await pool.query(
      `UPDATE dispatch_jobs SET ${updates.join(', ')} WHERE id = $${idx++} AND tenant_id = $${idx} RETURNING *`,
      values,
    );

    if (status && status !== currentStatus) {
      await pool.query(
        `INSERT INTO dispatch_job_events (job_id, tenant_id, event_type, from_status, to_status, performed_by, notes)
         VALUES ($1, $2, 'status_change', $3, $4, $5, $6)`,
        [id, tenantId, currentStatus, status, userId, `Status changed from ${currentStatus} to ${status}`],
      );
      const trigger = STATUS_TO_TRIGGER[status];
      if (trigger) {
        fireNotifications(pool, tenantId, id, trigger);
      }
    }

    if (assignee_user_id && assignee_user_id !== existing[0].assignee_user_id) {
      await pool.query(
        `INSERT INTO dispatch_job_events (job_id, tenant_id, event_type, performed_by, notes)
         VALUES ($1, $2, 'assignment', $3, 'Job assigned')`,
        [id, tenantId, userId],
      );
    }

    return res.json({ job: rows[0] });
  } catch (err) {
    logger.error('Failed to update dispatch job', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to update job' });
  }
};

const transitionJobHandler: RequestHandler = async (req, res) => {
  const { tenantId, userId } = req.user!;
  const { id } = req.params;
  const { status, notes } = req.body;
  const pool = getPlatformPool();

  if (!status || !VALID_STATUSES.includes(status)) {
    return res.status(400).json({ error: `Invalid status. Must be one of: ${VALID_STATUSES.join(', ')}` });
  }

  try {
    const { rows: existing } = await pool.query(
      `SELECT id, status FROM dispatch_jobs WHERE id = $1 AND tenant_id = $2`,
      [id, tenantId],
    );
    if (existing.length === 0) return res.status(404).json({ error: 'Job not found' });

    const currentStatus = existing[0].status as string;
    const allowed = VALID_TRANSITIONS[currentStatus] || [];
    if (!allowed.includes(status)) {
      return res.status(400).json({
        error: `Cannot transition from '${currentStatus}' to '${status}'. Allowed: ${allowed.join(', ')}`,
      });
    }

    const completedAt = (status === 'done' || status === 'completed') ? 'NOW()' : null;

    const { rows } = await pool.query(
      `UPDATE dispatch_jobs SET status = $3, ${completedAt ? 'completed_at = NOW(),' : ''} updated_at = NOW()
       WHERE id = $1 AND tenant_id = $2 RETURNING *`,
      [id, tenantId, status],
    );

    await pool.query(
      `INSERT INTO dispatch_job_events (job_id, tenant_id, event_type, from_status, to_status, performed_by, notes)
       VALUES ($1, $2, 'status_change', $3, $4, $5, $6)`,
      [id, tenantId, currentStatus, status, userId, notes || `Status changed to ${status}`],
    );

    const trigger = STATUS_TO_TRIGGER[status];
    if (trigger) {
      fireNotifications(pool, tenantId, id, trigger);
    }

    return res.json({ job: rows[0] });
  } catch (err) {
    logger.error('Failed to transition job', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to transition job' });
  }
};

const batchUpdateHandler: RequestHandler = async (req, res) => {
  const { tenantId, userId } = req.user!;
  const { job_ids, status, resource_id, assignee_user_id, priority } = req.body;
  const pool = getPlatformPool();

  if (!Array.isArray(job_ids) || job_ids.length === 0) {
    return res.status(400).json({ error: 'job_ids array is required' });
  }
  if (job_ids.length > 50) {
    return res.status(400).json({ error: 'Cannot batch update more than 50 jobs at once' });
  }
  if (status && !VALID_STATUSES.includes(status)) {
    return res.status(400).json({ error: `Invalid status '${status}'. Must be one of: ${VALID_STATUSES.join(', ')}` });
  }

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

    if (resource_id) {
      const check = await validateResourceAssignment(pool, resource_id, tenantId, {});
      if (!check.valid) {
        return res.status(400).json({ error: check.reason });
      }
    }

    if (status) {
      const { rows: currentJobs } = await pool.query(
        `SELECT id, status FROM dispatch_jobs WHERE tenant_id = $1 AND id = ANY($2)`,
        [tenantId, job_ids],
      );
      const blocked: string[] = [];
      for (const j of currentJobs) {
        const allowed = VALID_TRANSITIONS[j.status as string] || [];
        if (!allowed.includes(status)) {
          blocked.push(`${j.id} (${j.status})`);
        }
      }
      if (blocked.length > 0) {
        return res.status(400).json({
          error: `Cannot transition ${blocked.length} job(s) to '${status}': ${blocked.slice(0, 5).join(', ')}${blocked.length > 5 ? '...' : ''}`,
        });
      }

      const completedAt = (status === 'done' || status === 'completed') ? ', completed_at = NOW()' : '';
      const updates: string[] = [`status = $3${completedAt}`, 'updated_at = NOW()'];
      const values: unknown[] = [tenantId, job_ids, status];
      let idx = 4;

      if (resource_id) { updates.push(`resource_id = $${idx++}`); values.push(resource_id); }
      if (assignee_user_id) { updates.push(`assignee_user_id = $${idx++}`); values.push(assignee_user_id); }
      if (priority) { updates.push(`priority = $${idx++}`); values.push(priority); }

      const { rows, rowCount } = await pool.query(
        `UPDATE dispatch_jobs SET ${updates.join(', ')}
         WHERE tenant_id = $1 AND id = ANY($2) RETURNING id`,
        values,
      );

      for (const j of currentJobs) {
        await pool.query(
          `INSERT INTO dispatch_job_events (job_id, tenant_id, event_type, from_status, to_status, performed_by, notes)
           VALUES ($1, $2, 'batch_update', $3, $4, $5, 'Batch status update')`,
          [j.id, tenantId, j.status, status, userId],
        );
      }

      return res.json({ updated: rowCount, ids: rows.map(r => r.id) });
    } else {
      const updates: string[] = ['updated_at = NOW()'];
      const values: unknown[] = [tenantId, job_ids];
      let idx = 3;

      if (resource_id) { updates.push(`resource_id = $${idx++}`); values.push(resource_id); }
      if (assignee_user_id) { updates.push(`assignee_user_id = $${idx++}`); values.push(assignee_user_id); }
      if (priority) { updates.push(`priority = $${idx++}`); values.push(priority); }

      if (updates.length <= 1) {
        return res.status(400).json({ error: 'No update fields provided' });
      }

      const { rows, rowCount } = await pool.query(
        `UPDATE dispatch_jobs SET ${updates.join(', ')}
         WHERE tenant_id = $1 AND id = ANY($2) RETURNING id`,
        values,
      );

      return res.json({ updated: rowCount, ids: rows.map(r => r.id) });
    }
  } catch (err) {
    logger.error('Failed to batch update jobs', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to batch update jobs' });
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

const createFollowUpHandler: RequestHandler = async (req, res) => {
  const { tenantId, userId } = req.user!;
  const { id } = req.params;
  const { title, description, priority, notes, scheduled_at } = req.body;
  const pool = getPlatformPool();

  try {
    const { rows: parent } = await pool.query(
      `SELECT * FROM dispatch_jobs WHERE id = $1 AND tenant_id = $2`,
      [id, tenantId],
    );
    if (parent.length === 0) return res.status(404).json({ error: 'Parent job not found' });

    const p = parent[0];
    const { rows } = await pool.query(
      `INSERT INTO dispatch_jobs (tenant_id, title, description, status, priority, contact_id,
        contact_name, contact_phone, contact_email, address, territory_id, resource_id,
        job_type, required_skills, parent_job_id, is_follow_up, scheduled_at, notes)
       VALUES ($1,$2,$3,'pending',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,true,$15,$16)
       RETURNING *`,
      [tenantId, title || `Follow-up: ${p.title}`, description || p.description,
       priority || p.priority, p.contact_id, p.contact_name, p.contact_phone,
       p.contact_email, p.address, p.territory_id, p.resource_id, p.job_type,
       p.required_skills, id, scheduled_at || null, notes || ''],
    );

    await pool.query(
      `INSERT INTO dispatch_job_events (job_id, tenant_id, event_type, performed_by, notes, metadata)
       VALUES ($1, $2, 'follow_up_created', $3, 'Follow-up job created', $4)`,
      [rows[0].id, tenantId, userId, JSON.stringify({ parent_job_id: id })],
    );

    return res.status(201).json({ job: rows[0] });
  } catch (err) {
    logger.error('Failed to create follow-up job', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to create follow-up job' });
  }
};

// ============ EXCEPTIONS ============

const createExceptionHandler: RequestHandler = async (req, res) => {
  const { tenantId, userId } = req.user!;
  const { id } = req.params;
  const { exception_type, reason, resolution } = req.body;
  const pool = getPlatformPool();

  if (!exception_type || !reason) {
    return res.status(400).json({ error: 'exception_type and reason are required' });
  }

  try {
    const { rows: jobCheck } = await pool.query(
      `SELECT id FROM dispatch_jobs WHERE id = $1 AND tenant_id = $2`,
      [id, tenantId],
    );
    if (jobCheck.length === 0) return res.status(404).json({ error: 'Job not found' });

    const { rows } = await pool.query(
      `INSERT INTO dispatch_job_exceptions (job_id, tenant_id, exception_type, reason, resolution, reported_by)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [id, tenantId, exception_type, reason, resolution || '', userId],
    );

    await pool.query(
      `INSERT INTO dispatch_job_events (job_id, tenant_id, event_type, performed_by, notes, metadata)
       VALUES ($1, $2, 'exception_reported', $3, $4, $5)`,
      [id, tenantId, userId, `Exception: ${exception_type} - ${reason}`,
       JSON.stringify({ exception_id: rows[0].id, exception_type })],
    );

    fireNotifications(pool, tenantId, id, 'exception');

    if (exception_type === 'delay') {
      fireNotifications(pool, tenantId, id, 'delay');
    }

    return res.status(201).json({ exception: rows[0] });
  } catch (err) {
    logger.error('Failed to create exception', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to create exception' });
  }
};

const resolveExceptionHandler: RequestHandler = async (req, res) => {
  const { tenantId } = req.user!;
  const { exceptionId } = req.params;
  const { resolution } = req.body;
  const pool = getPlatformPool();

  try {
    const { rows } = await pool.query(
      `UPDATE dispatch_job_exceptions SET resolution = $3, resolved_at = NOW()
       WHERE id = $1 AND tenant_id = $2 RETURNING *`,
      [exceptionId, tenantId, resolution || ''],
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Exception not found' });
    return res.json({ exception: rows[0] });
  } catch (err) {
    logger.error('Failed to resolve exception', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to resolve exception' });
  }
};

// ============ ATTACHMENTS ============

const addAttachmentHandler: RequestHandler = async (req, res) => {
  const { tenantId, userId } = req.user!;
  const { id } = req.params;
  const { attachment_type, title, content, file_url } = req.body;
  const pool = getPlatformPool();

  try {
    if (!(await validateTenantRef(pool, 'dispatch_jobs', id, tenantId))) {
      return res.status(404).json({ error: 'Job not found' });
    }

    const { rows } = await pool.query(
      `INSERT INTO dispatch_job_attachments (job_id, tenant_id, attachment_type, title, content, file_url, uploaded_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [id, tenantId, attachment_type || 'note', title || '', content || '', file_url || null, userId],
    );
    return res.status(201).json({ attachment: rows[0] });
  } catch (err) {
    logger.error('Failed to add attachment', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to add attachment' });
  }
};

// ============ RESOURCES ============

const listResourcesHandler: RequestHandler = async (req, res) => {
  const { tenantId } = req.user!;
  const { limit, offset } = paginate(req);
  const { status: resStatus, territory_id } = req.query as Record<string, string>;
  const pool = getPlatformPool();

  try {
    const conditions: string[] = ['r.tenant_id = $1'];
    const values: unknown[] = [tenantId];

    if (resStatus) { values.push(resStatus); conditions.push(`r.current_status = $${values.length}`); }
    if (territory_id) { values.push(territory_id); conditions.push(`r.territory_id = $${values.length}`); }

    const where = conditions.join(' AND ');

    const { rows } = await pool.query(
      `SELECT r.*, t.name AS territory_name,
              (SELECT COUNT(*)::int FROM dispatch_jobs dj WHERE dj.resource_id = r.id AND dj.status IN ('assigned','scheduled','en_route','on_site','in_progress')) AS active_jobs,
              (SELECT array_agg(st.name) FROM dispatch_resource_skills rs JOIN dispatch_skill_types st ON st.id = rs.skill_type_id WHERE rs.resource_id = r.id) AS skills
       FROM dispatch_resources r
       LEFT JOIN dispatch_territories t ON t.id = r.territory_id
       WHERE ${where}
       ORDER BY r.name
       LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
      [...values, limit, offset],
    );

    const { rows: countRows } = await pool.query(
      `SELECT COUNT(*) AS total FROM dispatch_resources r WHERE ${where}`,
      values,
    );

    return res.json({ resources: rows, total: parseInt(countRows[0].total as string) });
  } catch (err) {
    logger.error('Failed to list resources', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to list resources' });
  }
};

const createResourceHandler: RequestHandler = async (req, res) => {
  const { tenantId } = req.user!;
  const { name, email, phone, role, territory_id, shift_start, shift_end, shift_days,
          max_concurrent_jobs, user_id, skills } = req.body;
  const pool = getPlatformPool();

  if (!name) return res.status(400).json({ error: 'name is required' });

  try {
    if (territory_id && !(await validateTenantRef(pool, 'dispatch_territories', territory_id, tenantId))) {
      return res.status(400).json({ error: 'Territory not found in this tenant' });
    }

    if (Array.isArray(skills) && skills.length > 0) {
      for (const skillId of skills) {
        if (!(await validateTenantRef(pool, 'dispatch_skill_types', skillId, tenantId))) {
          return res.status(400).json({ error: `Skill type ${skillId} not found in this tenant` });
        }
      }
    }

    const { rows } = await pool.query(
      `INSERT INTO dispatch_resources (tenant_id, name, email, phone, role, territory_id,
        shift_start, shift_end, shift_days, max_concurrent_jobs, user_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [tenantId, name, email || '', phone || '', role || 'field_worker',
       territory_id || null, shift_start || '08:00', shift_end || '17:00',
       shift_days || [1,2,3,4,5], max_concurrent_jobs || 3, user_id || null],
    );

    if (Array.isArray(skills) && skills.length > 0) {
      for (const skillId of skills) {
        await pool.query(
          `INSERT INTO dispatch_resource_skills (resource_id, skill_type_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
          [rows[0].id, skillId],
        );
      }
    }

    return res.status(201).json({ resource: rows[0] });
  } catch (err) {
    logger.error('Failed to create resource', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to create resource' });
  }
};

const updateResourceHandler: RequestHandler = async (req, res) => {
  const { tenantId } = req.user!;
  const { id } = req.params;
  const { name, email, phone, role, territory_id, shift_start, shift_end, shift_days,
          max_concurrent_jobs, current_status, status, skills } = req.body;
  const pool = getPlatformPool();

  try {
    if (territory_id && !(await validateTenantRef(pool, 'dispatch_territories', territory_id, tenantId))) {
      return res.status(400).json({ error: 'Territory not found in this tenant' });
    }

    if (Array.isArray(skills) && skills.length > 0) {
      for (const skillId of skills) {
        if (!(await validateTenantRef(pool, 'dispatch_skill_types', skillId, tenantId))) {
          return res.status(400).json({ error: `Skill type ${skillId} not found in this tenant` });
        }
      }
    }

    const updates: string[] = ['updated_at = NOW()'];
    const values: unknown[] = [];
    let idx = 1;

    if (name !== undefined) { updates.push(`name = $${idx++}`); values.push(name); }
    if (email !== undefined) { updates.push(`email = $${idx++}`); values.push(email); }
    if (phone !== undefined) { updates.push(`phone = $${idx++}`); values.push(phone); }
    if (role !== undefined) { updates.push(`role = $${idx++}`); values.push(role); }
    if (territory_id !== undefined) { updates.push(`territory_id = $${idx++}`); values.push(territory_id); }
    if (shift_start !== undefined) { updates.push(`shift_start = $${idx++}`); values.push(shift_start); }
    if (shift_end !== undefined) { updates.push(`shift_end = $${idx++}`); values.push(shift_end); }
    if (shift_days !== undefined) { updates.push(`shift_days = $${idx++}`); values.push(shift_days); }
    if (max_concurrent_jobs !== undefined) { updates.push(`max_concurrent_jobs = $${idx++}`); values.push(max_concurrent_jobs); }
    if (current_status !== undefined) { updates.push(`current_status = $${idx++}`); values.push(current_status); }
    if (status !== undefined) { updates.push(`status = $${idx++}`); values.push(status); }

    values.push(id, tenantId);
    const { rows } = await pool.query(
      `UPDATE dispatch_resources SET ${updates.join(', ')} WHERE id = $${idx++} AND tenant_id = $${idx} RETURNING *`,
      values,
    );

    if (rows.length === 0) return res.status(404).json({ error: 'Resource not found' });

    if (Array.isArray(skills)) {
      await pool.query(`DELETE FROM dispatch_resource_skills WHERE resource_id = $1`, [id]);
      for (const skillId of skills) {
        await pool.query(
          `INSERT INTO dispatch_resource_skills (resource_id, skill_type_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
          [id, skillId],
        );
      }
    }

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
    const { rowCount } = await pool.query(
      `DELETE FROM dispatch_resources WHERE id = $1 AND tenant_id = $2`,
      [id, tenantId],
    );
    if (rowCount === 0) return res.status(404).json({ error: 'Resource not found' });
    return res.json({ success: true });
  } catch (err) {
    logger.error('Failed to delete resource', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to delete resource' });
  }
};

const syncResourceSkillsHandler: RequestHandler = async (req, res) => {
  const { tenantId } = req.user!;
  const { id } = req.params;
  const { skill_type_ids } = req.body;
  const pool = getPlatformPool();

  if (!Array.isArray(skill_type_ids)) {
    return res.status(400).json({ error: 'skill_type_ids array is required' });
  }

  try {
    const { rows: resCheck } = await pool.query(
      `SELECT id FROM dispatch_resources WHERE id = $1 AND tenant_id = $2`,
      [id, tenantId],
    );
    if (resCheck.length === 0) return res.status(404).json({ error: 'Resource not found' });

    await pool.query(`DELETE FROM dispatch_resource_skills WHERE resource_id = $1`, [id]);

    for (const skillTypeId of skill_type_ids) {
      if (!(await validateTenantRef(pool, 'dispatch_skill_types', skillTypeId, tenantId))) {
        return res.status(400).json({ error: `Skill type ${skillTypeId} not found in this tenant` });
      }
      await pool.query(
        `INSERT INTO dispatch_resource_skills (resource_id, skill_type_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [id, skillTypeId],
      );
    }

    return res.json({ success: true });
  } catch (err) {
    logger.error('Failed to sync resource skills', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to sync resource skills' });
  }
};

// ============ TERRITORIES ============

const listTerritoriesHandler: RequestHandler = async (req, res) => {
  const { tenantId } = req.user!;
  const pool = getPlatformPool();
  try {
    const { rows } = await pool.query(
      `SELECT t.*,
              (SELECT COUNT(*)::int FROM dispatch_resources r WHERE r.territory_id = t.id) AS resource_count,
              (SELECT COUNT(*)::int FROM dispatch_jobs j WHERE j.territory_id = t.id AND j.status NOT IN ('done','completed','cancelled')) AS active_jobs
       FROM dispatch_territories t WHERE t.tenant_id = $1 ORDER BY t.name`,
      [tenantId],
    );
    return res.json({ territories: rows });
  } catch (err) {
    logger.error('Failed to list territories', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to list territories' });
  }
};

const createTerritoryHandler: RequestHandler = async (req, res) => {
  const { tenantId } = req.user!;
  const { name, description, region, zip_codes, metadata } = req.body;
  const pool = getPlatformPool();
  if (!name) return res.status(400).json({ error: 'name is required' });
  try {
    const { rows } = await pool.query(
      `INSERT INTO dispatch_territories (tenant_id, name, description, region, zip_codes, metadata)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [tenantId, name, description || '', region || '', zip_codes || [], JSON.stringify(metadata || {})],
    );
    return res.status(201).json({ territory: rows[0] });
  } catch (err) {
    logger.error('Failed to create territory', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to create territory' });
  }
};

const updateTerritoryHandler: RequestHandler = async (req, res) => {
  const { tenantId } = req.user!;
  const { id } = req.params;
  const { name, description, region, zip_codes, status, metadata } = req.body;
  const pool = getPlatformPool();
  try {
    const updates: string[] = ['updated_at = NOW()'];
    const values: unknown[] = [];
    let idx = 1;
    if (name !== undefined) { updates.push(`name = $${idx++}`); values.push(name); }
    if (description !== undefined) { updates.push(`description = $${idx++}`); values.push(description); }
    if (region !== undefined) { updates.push(`region = $${idx++}`); values.push(region); }
    if (zip_codes !== undefined) { updates.push(`zip_codes = $${idx++}`); values.push(zip_codes); }
    if (status !== undefined) { updates.push(`status = $${idx++}`); values.push(status); }
    if (metadata !== undefined) { updates.push(`metadata = $${idx++}`); values.push(JSON.stringify(metadata)); }
    values.push(id, tenantId);
    const { rows } = await pool.query(
      `UPDATE dispatch_territories SET ${updates.join(', ')} WHERE id = $${idx++} AND tenant_id = $${idx} RETURNING *`,
      values,
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Territory not found' });
    return res.json({ territory: rows[0] });
  } catch (err) {
    logger.error('Failed to update territory', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to update territory' });
  }
};

const deleteTerritoryHandler: RequestHandler = async (req, res) => {
  const { tenantId } = req.user!;
  const { id } = req.params;
  const pool = getPlatformPool();
  try {
    const { rowCount } = await pool.query(
      `DELETE FROM dispatch_territories WHERE id = $1 AND tenant_id = $2`, [id, tenantId]);
    if (rowCount === 0) return res.status(404).json({ error: 'Territory not found' });
    return res.json({ success: true });
  } catch (err) {
    logger.error('Failed to delete territory', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to delete territory' });
  }
};

// ============ SKILL TYPES ============

const listSkillTypesHandler: RequestHandler = async (req, res) => {
  const { tenantId } = req.user!;
  const pool = getPlatformPool();
  try {
    const { rows } = await pool.query(
      `SELECT s.*,
              (SELECT COUNT(*)::int FROM dispatch_resource_skills rs WHERE rs.skill_type_id = s.id) AS resource_count
       FROM dispatch_skill_types s WHERE s.tenant_id = $1 ORDER BY s.category, s.name`,
      [tenantId],
    );
    return res.json({ skillTypes: rows });
  } catch (err) {
    logger.error('Failed to list skill types', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to list skill types' });
  }
};

const createSkillTypeHandler: RequestHandler = async (req, res) => {
  const { tenantId } = req.user!;
  const { name, description, category } = req.body;
  const pool = getPlatformPool();
  if (!name) return res.status(400).json({ error: 'name is required' });
  try {
    const { rows } = await pool.query(
      `INSERT INTO dispatch_skill_types (tenant_id, name, description, category)
       VALUES ($1,$2,$3,$4) RETURNING *`,
      [tenantId, name, description || '', category || 'general'],
    );
    return res.status(201).json({ skillType: rows[0] });
  } catch (err) {
    logger.error('Failed to create skill type', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to create skill type' });
  }
};

const updateSkillTypeHandler: RequestHandler = async (req, res) => {
  const { tenantId } = req.user!;
  const { id } = req.params;
  const { name, description, category, status } = req.body;
  const pool = getPlatformPool();
  try {
    const updates: string[] = ['updated_at = NOW()'];
    const values: unknown[] = [];
    let idx = 1;
    if (name !== undefined) { updates.push(`name = $${idx++}`); values.push(name); }
    if (description !== undefined) { updates.push(`description = $${idx++}`); values.push(description); }
    if (category !== undefined) { updates.push(`category = $${idx++}`); values.push(category); }
    if (status !== undefined) { updates.push(`status = $${idx++}`); values.push(status); }
    values.push(id, tenantId);
    const { rows } = await pool.query(
      `UPDATE dispatch_skill_types SET ${updates.join(', ')} WHERE id = $${idx++} AND tenant_id = $${idx} RETURNING *`,
      values,
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Skill type not found' });
    return res.json({ skillType: rows[0] });
  } catch (err) {
    logger.error('Failed to update skill type', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to update skill type' });
  }
};

const deleteSkillTypeHandler: RequestHandler = async (req, res) => {
  const { tenantId } = req.user!;
  const { id } = req.params;
  const pool = getPlatformPool();
  try {
    const { rowCount } = await pool.query(
      `DELETE FROM dispatch_skill_types WHERE id = $1 AND tenant_id = $2`, [id, tenantId]);
    if (rowCount === 0) return res.status(404).json({ error: 'Skill type not found' });
    return res.json({ success: true });
  } catch (err) {
    logger.error('Failed to delete skill type', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to delete skill type' });
  }
};

// ============ NOTIFICATION TEMPLATES ============

const listNotificationTemplatesHandler: RequestHandler = async (req, res) => {
  const { tenantId } = req.user!;
  const pool = getPlatformPool();
  try {
    const { rows } = await pool.query(
      `SELECT * FROM dispatch_notification_templates WHERE tenant_id = $1 ORDER BY trigger_event, name`,
      [tenantId],
    );
    return res.json({ templates: rows });
  } catch (err) {
    logger.error('Failed to list notification templates', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to list notification templates' });
  }
};

const createNotificationTemplateHandler: RequestHandler = async (req, res) => {
  const { tenantId } = req.user!;
  const { name, trigger_event, channel, subject, body_template, is_active } = req.body;
  const pool = getPlatformPool();
  if (!name || !trigger_event || !body_template) {
    return res.status(400).json({ error: 'name, trigger_event, and body_template are required' });
  }
  try {
    const { rows } = await pool.query(
      `INSERT INTO dispatch_notification_templates (tenant_id, name, trigger_event, channel, subject, body_template, is_active)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [tenantId, name, trigger_event, channel || 'sms', subject || '', body_template, is_active !== false],
    );
    return res.status(201).json({ template: rows[0] });
  } catch (err) {
    logger.error('Failed to create notification template', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to create notification template' });
  }
};

const updateNotificationTemplateHandler: RequestHandler = async (req, res) => {
  const { tenantId } = req.user!;
  const { id } = req.params;
  const { name, trigger_event, channel, subject, body_template, is_active } = req.body;
  const pool = getPlatformPool();
  try {
    const updates: string[] = ['updated_at = NOW()'];
    const values: unknown[] = [];
    let idx = 1;
    if (name !== undefined) { updates.push(`name = $${idx++}`); values.push(name); }
    if (trigger_event !== undefined) { updates.push(`trigger_event = $${idx++}`); values.push(trigger_event); }
    if (channel !== undefined) { updates.push(`channel = $${idx++}`); values.push(channel); }
    if (subject !== undefined) { updates.push(`subject = $${idx++}`); values.push(subject); }
    if (body_template !== undefined) { updates.push(`body_template = $${idx++}`); values.push(body_template); }
    if (is_active !== undefined) { updates.push(`is_active = $${idx++}`); values.push(is_active); }
    values.push(id, tenantId);
    const { rows } = await pool.query(
      `UPDATE dispatch_notification_templates SET ${updates.join(', ')} WHERE id = $${idx++} AND tenant_id = $${idx} RETURNING *`,
      values,
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Template not found' });
    return res.json({ template: rows[0] });
  } catch (err) {
    logger.error('Failed to update notification template', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to update notification template' });
  }
};

const deleteNotificationTemplateHandler: RequestHandler = async (req, res) => {
  const { tenantId } = req.user!;
  const { id } = req.params;
  const pool = getPlatformPool();
  try {
    const { rowCount } = await pool.query(
      `DELETE FROM dispatch_notification_templates WHERE id = $1 AND tenant_id = $2`, [id, tenantId]);
    if (rowCount === 0) return res.status(404).json({ error: 'Template not found' });
    return res.json({ success: true });
  } catch (err) {
    logger.error('Failed to delete notification template', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to delete notification template' });
  }
};

// ============ ASSIGNMENT RULES ============

const listAssignmentRulesHandler: RequestHandler = async (req, res) => {
  const { tenantId } = req.user!;
  const pool = getPlatformPool();
  try {
    const { rows } = await pool.query(
      `SELECT * FROM dispatch_assignment_rules WHERE tenant_id = $1 ORDER BY priority, name`,
      [tenantId],
    );
    return res.json({ rules: rows });
  } catch (err) {
    logger.error('Failed to list assignment rules', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to list assignment rules' });
  }
};

const createAssignmentRuleHandler: RequestHandler = async (req, res) => {
  const { tenantId } = req.user!;
  const { name, description, rule_type, priority, conditions, is_active } = req.body;
  const pool = getPlatformPool();
  if (!name) return res.status(400).json({ error: 'name is required' });
  try {
    const { rows } = await pool.query(
      `INSERT INTO dispatch_assignment_rules (tenant_id, name, description, rule_type, priority, conditions, is_active)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [tenantId, name, description || '', rule_type || 'auto_assign', priority || 0,
       JSON.stringify(conditions || {}), is_active !== false],
    );
    return res.status(201).json({ rule: rows[0] });
  } catch (err) {
    logger.error('Failed to create assignment rule', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to create assignment rule' });
  }
};

const updateAssignmentRuleHandler: RequestHandler = async (req, res) => {
  const { tenantId } = req.user!;
  const { id } = req.params;
  const { name, description, rule_type, priority, conditions, is_active } = req.body;
  const pool = getPlatformPool();
  try {
    const updates: string[] = ['updated_at = NOW()'];
    const values: unknown[] = [];
    let idx = 1;
    if (name !== undefined) { updates.push(`name = $${idx++}`); values.push(name); }
    if (description !== undefined) { updates.push(`description = $${idx++}`); values.push(description); }
    if (rule_type !== undefined) { updates.push(`rule_type = $${idx++}`); values.push(rule_type); }
    if (priority !== undefined) { updates.push(`priority = $${idx++}`); values.push(priority); }
    if (conditions !== undefined) { updates.push(`conditions = $${idx++}`); values.push(JSON.stringify(conditions)); }
    if (is_active !== undefined) { updates.push(`is_active = $${idx++}`); values.push(is_active); }
    values.push(id, tenantId);
    const { rows } = await pool.query(
      `UPDATE dispatch_assignment_rules SET ${updates.join(', ')} WHERE id = $${idx++} AND tenant_id = $${idx} RETURNING *`,
      values,
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Rule not found' });
    return res.json({ rule: rows[0] });
  } catch (err) {
    logger.error('Failed to update assignment rule', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to update assignment rule' });
  }
};

const deleteAssignmentRuleHandler: RequestHandler = async (req, res) => {
  const { tenantId } = req.user!;
  const { id } = req.params;
  const pool = getPlatformPool();
  try {
    const { rowCount } = await pool.query(
      `DELETE FROM dispatch_assignment_rules WHERE id = $1 AND tenant_id = $2`, [id, tenantId]);
    if (rowCount === 0) return res.status(404).json({ error: 'Rule not found' });
    return res.json({ success: true });
  } catch (err) {
    logger.error('Failed to delete assignment rule', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to delete assignment rule' });
  }
};

// ============ REPORTING ============

const getReportingHandler: RequestHandler = async (req, res) => {
  const { tenantId } = req.user!;
  const { date_from, date_to, territory_id, resource_id } = req.query as Record<string, string>;
  const pool = getPlatformPool();

  try {
    const dateFrom = date_from || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const dateTo = date_to || new Date().toISOString();

    const conditions: string[] = ['d.tenant_id = $1', 'd.created_at >= $2::timestamptz', 'd.created_at <= $3::timestamptz'];
    const values: unknown[] = [tenantId, dateFrom, dateTo];

    if (territory_id) { values.push(territory_id); conditions.push(`d.territory_id = $${values.length}`); }
    if (resource_id) { values.push(resource_id); conditions.push(`d.resource_id = $${values.length}`); }

    const where = conditions.join(' AND ');

    const { rows: overview } = await pool.query(
      `SELECT
        COUNT(*)::int AS total_jobs,
        COUNT(*) FILTER (WHERE d.status IN ('completed','done'))::int AS completed_jobs,
        COUNT(*) FILTER (WHERE d.status = 'incomplete')::int AS incomplete_jobs,
        COUNT(*) FILTER (WHERE d.status = 'cancelled')::int AS cancelled_jobs,
        COUNT(*) FILTER (WHERE d.status IN ('pending','assigned','scheduled'))::int AS pending_jobs,
        COUNT(*) FILTER (WHERE d.status IN ('en_route','on_site','in_progress'))::int AS active_jobs,
        COALESCE(AVG(EXTRACT(EPOCH FROM (d.completed_at - d.created_at))/3600) FILTER (WHERE d.completed_at IS NOT NULL), 0)::float AS avg_completion_hours,
        COALESCE(AVG(d.actual_duration_minutes) FILTER (WHERE d.actual_duration_minutes > 0), 0)::float AS avg_time_on_job_minutes,
        COALESCE(AVG(EXTRACT(EPOCH FROM (
          (SELECT MIN(e.created_at) FROM dispatch_job_events e WHERE e.job_id = d.id AND e.event_type = 'status_change' AND e.to_status = 'assigned')
          - d.created_at
        ))/60) FILTER (WHERE d.status NOT IN ('pending')), 0)::float AS avg_time_to_dispatch_minutes
       FROM dispatch_jobs d WHERE ${where}`,
      values,
    );

    const { rows: exceptionStats } = await pool.query(
      `SELECT ex.exception_type, COUNT(*)::int AS count
       FROM dispatch_job_exceptions ex
       JOIN dispatch_jobs d ON d.id = ex.job_id
       WHERE ${where}
       GROUP BY ex.exception_type ORDER BY count DESC`,
      values,
    );

    const { rows: reassignmentCount } = await pool.query(
      `SELECT COUNT(*)::int AS count
       FROM dispatch_job_events ev
       JOIN dispatch_jobs d ON d.id = ev.job_id
       WHERE ev.event_type = 'assignment' AND ${where}`,
      values,
    );

    const { rows: territoryPerf } = await pool.query(
      `SELECT t.name AS territory_name, t.id AS territory_id,
              COUNT(*)::int AS total_jobs,
              COUNT(*) FILTER (WHERE d.status IN ('completed','done'))::int AS completed
       FROM dispatch_jobs d
       JOIN dispatch_territories t ON t.id = d.territory_id
       WHERE ${where}
       GROUP BY t.id, t.name ORDER BY total_jobs DESC`,
      values,
    );

    const { rows: resourcePerf } = await pool.query(
      `SELECT r.name AS resource_name, r.id AS resource_id,
              COUNT(*)::int AS total_jobs,
              COUNT(*) FILTER (WHERE d.status IN ('completed','done'))::int AS completed,
              COALESCE(AVG(d.actual_duration_minutes) FILTER (WHERE d.actual_duration_minutes > 0), 0)::float AS avg_duration
       FROM dispatch_jobs d
       JOIN dispatch_resources r ON r.id = d.resource_id
       WHERE ${where}
       GROUP BY r.id, r.name ORDER BY total_jobs DESC LIMIT 20`,
      values,
    );

    const { rows: dailyTrend } = await pool.query(
      `SELECT DATE(d.created_at) AS date,
              COUNT(*)::int AS created,
              COUNT(*) FILTER (WHERE d.status IN ('completed','done'))::int AS completed
       FROM dispatch_jobs d WHERE ${where}
       GROUP BY DATE(d.created_at) ORDER BY date`,
      values,
    );

    const stats = overview[0] || {};
    const totalJobs = (stats.total_jobs as number) || 0;
    const completedJobs = (stats.completed_jobs as number) || 0;
    const totalExceptions = exceptionStats.reduce((s, r) => s + (r.count as number), 0);

    return res.json({
      metrics: {
        totalJobs,
        completedJobs,
        incompleteJobs: stats.incomplete_jobs || 0,
        cancelledJobs: stats.cancelled_jobs || 0,
        pendingJobs: stats.pending_jobs || 0,
        activeJobs: stats.active_jobs || 0,
        completionRate: totalJobs > 0 ? ((completedJobs / totalJobs) * 100).toFixed(1) : '0.0',
        avgCompletionHours: Number((stats.avg_completion_hours as number || 0).toFixed(1)),
        avgTimeOnJobMinutes: Number((stats.avg_time_on_job_minutes as number || 0).toFixed(0)),
        avgTimeToDispatchMinutes: Number((stats.avg_time_to_dispatch_minutes as number || 0).toFixed(0)),
        reassignmentCount: reassignmentCount[0]?.count || 0,
        reassignmentRate: totalJobs > 0 ? (((reassignmentCount[0]?.count as number || 0) / totalJobs) * 100).toFixed(1) : '0.0',
        exceptionCount: totalExceptions,
        exceptionRate: totalJobs > 0 ? ((totalExceptions / totalJobs) * 100).toFixed(1) : '0.0',
      },
      exceptionBreakdown: exceptionStats,
      territoryPerformance: territoryPerf,
      resourcePerformance: resourcePerf,
      dailyTrend,
      dateRange: { from: dateFrom, to: dateTo },
    });
  } catch (err) {
    logger.error('Failed to get reporting data', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to get reporting data' });
  }
};

// ============ ROUTES ============

router.get('/dispatch/jobs', requireAuth, listJobsHandler);
router.get('/dispatch/jobs/counts', requireAuth, getStatusCountsHandler);
router.get('/dispatch/jobs/:id', requireAuth, getJobHandler);
router.post('/dispatch/jobs', requireAuth, requireMiniSystemWrite, createJobHandler);
router.put('/dispatch/jobs/:id', requireAuth, requireMiniSystemWrite, updateJobHandler);
router.post('/dispatch/jobs/:id/transition', requireAuth, requireMiniSystemWrite, transitionJobHandler);
router.post('/dispatch/jobs/:id/follow-up', requireAuth, requireMiniSystemWrite, createFollowUpHandler);
router.post('/dispatch/jobs/:id/exceptions', requireAuth, requireMiniSystemWrite, createExceptionHandler);
router.put('/dispatch/exceptions/:exceptionId/resolve', requireAuth, requireMiniSystemWrite, resolveExceptionHandler);
router.post('/dispatch/jobs/:id/attachments', requireAuth, requireMiniSystemWrite, addAttachmentHandler);
router.post('/dispatch/jobs/batch', requireAuth, requireMiniSystemWrite, batchUpdateHandler);
router.delete('/dispatch/jobs/:id', requireAuth, requireMiniSystemWrite, deleteJobHandler);

router.get('/dispatch/resources', requireAuth, listResourcesHandler);
router.post('/dispatch/resources', requireAuth, requireMiniSystemWrite, createResourceHandler);
router.put('/dispatch/resources/:id', requireAuth, requireMiniSystemWrite, updateResourceHandler);
router.delete('/dispatch/resources/:id', requireAuth, requireMiniSystemWrite, deleteResourceHandler);
router.put('/dispatch/resources/:id/skills', requireAuth, requireMiniSystemWrite, syncResourceSkillsHandler);

router.get('/dispatch/territories', requireAuth, listTerritoriesHandler);
router.post('/dispatch/territories', requireAuth, requireMiniSystemWrite, createTerritoryHandler);
router.put('/dispatch/territories/:id', requireAuth, requireMiniSystemWrite, updateTerritoryHandler);
router.delete('/dispatch/territories/:id', requireAuth, requireMiniSystemWrite, deleteTerritoryHandler);

router.get('/dispatch/skill-types', requireAuth, listSkillTypesHandler);
router.post('/dispatch/skill-types', requireAuth, requireMiniSystemWrite, createSkillTypeHandler);
router.put('/dispatch/skill-types/:id', requireAuth, requireMiniSystemWrite, updateSkillTypeHandler);
router.delete('/dispatch/skill-types/:id', requireAuth, requireMiniSystemWrite, deleteSkillTypeHandler);

router.get('/dispatch/notification-templates', requireAuth, listNotificationTemplatesHandler);
router.post('/dispatch/notification-templates', requireAuth, requireMiniSystemWrite, createNotificationTemplateHandler);
router.put('/dispatch/notification-templates/:id', requireAuth, requireMiniSystemWrite, updateNotificationTemplateHandler);
router.delete('/dispatch/notification-templates/:id', requireAuth, requireMiniSystemWrite, deleteNotificationTemplateHandler);

router.get('/dispatch/assignment-rules', requireAuth, listAssignmentRulesHandler);
router.post('/dispatch/assignment-rules', requireAuth, requireMiniSystemWrite, createAssignmentRuleHandler);
router.put('/dispatch/assignment-rules/:id', requireAuth, requireMiniSystemWrite, updateAssignmentRuleHandler);
router.delete('/dispatch/assignment-rules/:id', requireAuth, requireMiniSystemWrite, deleteAssignmentRuleHandler);

router.get('/dispatch/reporting', requireAuth, getReportingHandler);

export default router;
