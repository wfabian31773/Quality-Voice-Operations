import { Router } from 'express';
import type { RequestHandler } from 'express';
import crypto from 'crypto';
import { requireAuth } from '../middleware/auth';
import { requireMiniSystemWrite } from '../middleware/rbac';
import { getPlatformPool } from '../../../platform/db';
import { createLogger } from '../../../platform/core/logger';
import { fireDispatchPush, type DispatchPushEvent } from '../../../platform/notifications/dispatchPush';
import {
  ObjectStorageService,
  ObjectNotFoundError,
} from '../../replit_integrations/object_storage';
import {
  geocodeAddressCached,
  getDriveEta,
  haversineMeters,
  type DriveEtaResult,
  type GeoPoint,
} from '../../../platform/integrations/routing';

const router = Router();
const logger = createLogger('ADMIN_DISPATCH');

// Maximum acceptable age (in seconds) of a technician's last GPS fix when
// computing the live ETA for an SMS notification. Anything older falls
// back to the friendlier "soon" placeholder rather than misleading the
// customer with a stale ETA.
const LIVE_ETA_MAX_FIX_AGE_SEC = 600;

/**
 * Fire-and-forget push to the assigned technician for a dispatch lifecycle
 * event. Looks up the job's resource_id (and assignee_user_id) and routes
 * the push through PushDispatcher. Errors are swallowed so the surrounding
 * state-machine never depends on Expo or the notifications table being up.
 */
async function pushAssigneeForJob(
  pool: ReturnType<typeof getPlatformPool>,
  tenantId: string,
  jobId: string,
  event: DispatchPushEvent,
): Promise<void> {
  try {
    const { rows } = await pool.query(
      `SELECT id, title, status, contact_name, address, scheduled_at, eta_start,
              resource_id, assignee_user_id
         FROM dispatch_jobs
        WHERE id = $1 AND tenant_id = $2
        LIMIT 1`,
      [jobId, tenantId],
    );
    if (rows.length === 0) return;
    const job = rows[0] as Record<string, unknown>;
    const resourceId = (job.resource_id as string | null) || null;
    const assigneeUserId = (job.assignee_user_id as string | null) || null;
    if (!resourceId && !assigneeUserId) return;

    await fireDispatchPush({
      event,
      tenantId,
      resourceIds: resourceId ? [resourceId] : undefined,
      userIds: assigneeUserId ? [assigneeUserId] : undefined,
      job: {
        id: job.id as string,
        title: (job.title as string | null) ?? null,
        status: (job.status as string | null) ?? null,
        contact_name: (job.contact_name as string | null) ?? null,
        address: (job.address as string | null) ?? null,
        scheduled_at: job.scheduled_at ? String(job.scheduled_at) : null,
        eta_start: job.eta_start ? String(job.eta_start) : null,
      },
    });
  } catch (err) {
    logger.warn('pushAssigneeForJob failed', { tenantId, jobId, event, error: String(err) });
  }
}

const STATUS_TO_PUSH_EVENT: Record<string, DispatchPushEvent> = {
  en_route: 'job_status_en_route',
  on_site: 'job_status_on_site',
  cancelled: 'job_cancelled',
};

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

export async function fireNotifications(
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

    // Compute the live driving ETA when the trigger is en_route (or any
    // template body actually references one of the live-ETA tokens).
    // Customers care about "when will my tech show up" the moment they
    // hear the truck is on the way; for any other lifecycle event the
    // tech may not have a fix yet, so the {{eta_drive_*}} tokens
    // gracefully degrade to the scheduled window.
    const needsLiveEta = templates.some((t) => {
      const body = String(t.body_template ?? '');
      const subject = String(t.subject ?? '');
      return /\{\{eta_drive_minutes\}\}|\{\{eta_arrival_time\}\}/.test(body) ||
             /\{\{eta_drive_minutes\}\}|\{\{eta_arrival_time\}\}/.test(subject);
    });
    let liveEta: { minutes: number; arrivalDate: Date } | null = null;
    if ((triggerEvent === 'en_route' || needsLiveEta) && job.resource_id && job.address) {
      liveEta = await computeLiveEtaForJob(
        pool, tenantId, jobId, String(job.resource_id), String(job.address),
      );
    }

    const liveEtaMinutes = liveEta ? String(liveEta.minutes) : 'soon';
    const liveEtaArrival = liveEta
      ? liveEta.arrivalDate.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
      : (job.eta_start ? new Date(job.eta_start as string).toLocaleString() : 'TBD');

    const substitute = (raw: string): string => raw
      .replace(/\{\{job_title\}\}/g, job.title as string || '')
      .replace(/\{\{contact_name\}\}/g, job.contact_name as string || '')
      .replace(/\{\{eta\}\}/g, job.eta_start ? new Date(job.eta_start as string).toLocaleString() : 'TBD')
      .replace(/\{\{eta_drive_minutes\}\}/g, liveEtaMinutes)
      .replace(/\{\{eta_arrival_time\}\}/g, liveEtaArrival)
      .replace(/\{\{resource_name\}\}/g, job.resource_name as string || '')
      .replace(/\{\{status\}\}/g, job.status as string || '')
      .replace(/\{\{address\}\}/g, job.address as string || '');

    for (const tpl of templates) {
      const body = substitute(tpl.body_template as string);
      const subject = substitute(tpl.subject as string || '');

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

/**
 * Helper used by `fireNotifications` to look up the technician's most
 * recent fix and drive an ETA for the SMS substitution. Returns `null`
 * when we don't have the inputs to compute a real number — callers
 * should substitute a friendly fallback like "soon" instead of leaving
 * the unresolved token in the body.
 */
async function computeLiveEtaForJob(
  pool: ReturnType<typeof getPlatformPool>,
  tenantId: string,
  jobId: string,
  resourceId: string,
  address: string,
): Promise<{ minutes: number; arrivalDate: Date } | null> {
  try {
    // Always read the freshest fix — without the explicit ORDER BY, Postgres
    // is free to return any historical row, which would silently send SMS
    // ETAs based on stale coordinates.
    const { rows: locRows } = await pool.query(
      `SELECT latitude, longitude, received_at
         FROM dispatch_resource_locations
        WHERE tenant_id = $1 AND resource_id = $2
        ORDER BY received_at DESC
        LIMIT 1`,
      [tenantId, resourceId],
    );
    if (locRows.length === 0) return null;
    // Mirror the live-map staleness budget — if the tech hasn't pinged in a
    // while, treat the ETA as unknown rather than computing from a stale fix.
    const receivedAt = locRows[0].received_at instanceof Date
      ? locRows[0].received_at
      : new Date(String(locRows[0].received_at));
    if (!Number.isFinite(receivedAt.getTime())) return null;
    const ageSec = (Date.now() - receivedAt.getTime()) / 1000;
    if (ageSec > LIVE_ETA_MAX_FIX_AGE_SEC) return null;
    const origin: GeoPoint = {
      lat: Number(locRows[0].latitude),
      lon: Number(locRows[0].longitude),
    };
    if (!Number.isFinite(origin.lat) || !Number.isFinite(origin.lon)) return null;

    const { rows: jobRows } = await pool.query(
      `SELECT address_lat, address_lon, address_geocoded_for
         FROM dispatch_jobs WHERE id = $1 AND tenant_id = $2`,
      [jobId, tenantId],
    );
    let dest: GeoPoint | null = null;
    if (jobRows.length > 0) {
      const lat = jobRows[0].address_lat == null ? NaN : Number(jobRows[0].address_lat);
      const lon = jobRows[0].address_lon == null ? NaN : Number(jobRows[0].address_lon);
      const cachedFor = String(jobRows[0].address_geocoded_for ?? '').trim();
      if (Number.isFinite(lat) && Number.isFinite(lon) && cachedFor === address.trim()) {
        dest = { lat, lon };
      }
    }
    if (!dest) {
      dest = await geocodeAddressCached(tenantId, address);
      if (dest) {
        try {
          await pool.query(
            `UPDATE dispatch_jobs
                SET address_lat = $1, address_lon = $2,
                    address_geocoded_at = NOW(), address_geocoded_for = $3
              WHERE id = $4 AND tenant_id = $5`,
            [dest.lat, dest.lon, address.trim(), jobId, tenantId],
          );
        } catch (err) {
          logger.warn('Failed to persist geocoded coords for SMS ETA', {
            tenantId, jobId, error: String(err),
          });
        }
      }
    }
    if (!dest) return null;

    const eta = await getDriveEta({
      tenantId, resourceId, jobId, origin, destination: dest,
    });
    const minutes = Math.max(1, Math.round(eta.durationSeconds / 60));
    return {
      minutes,
      arrivalDate: new Date(Date.now() + eta.durationSeconds * 1000),
    };
  } catch (err) {
    logger.warn('Live ETA computation for SMS failed', {
      tenantId, jobId, resourceId, error: String(err),
    });
    return null;
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

// A job in one of these statuses is no longer "in the field", so the
// technician's mobile app should have stopped sending location pings and
// the live map should drop the marker.
const TERMINAL_JOB_STATUSES = new Set([
  'completed',
  'cancelled',
  'done',
  'incomplete',
]);

// Cap how many history rows we keep per resource. The live map only needs
// the most recent fix; the breadcrumb is a "last hour or so" replay tool.
// 200 pings ≈ ~1.5 hours at the 30-second mobile cadence.
const LOCATION_HISTORY_KEEP_PER_RESOURCE = 200;

// Server-side guard: if a ping arrives but the most recent fix was less
// than this many seconds ago, we still record it (mobile may legitimately
// burst on resume) but we *do not* prune more than one history row per
// burst to keep the indexed write cheap.
const LOCATION_HISTORY_PRUNE_PROBABILITY = 0.1;

// ============ JOBS ============

export const listJobsHandler: RequestHandler = async (req, res) => {
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
              t.name AS territory_name,
              COUNT(*) OVER() AS _total_count
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

    let total = 0;
    if (rows.length > 0) {
      total = parseInt(rows[0]._total_count as string, 10) || 0;
      for (const r of rows) delete (r as Record<string, unknown>)._total_count;
    } else if (offset > 0) {
      const { rows: countRows } = await pool.query(
        `SELECT COUNT(*)::int AS total FROM dispatch_jobs d WHERE ${where}`,
        values,
      );
      total = (countRows[0]?.total as number) ?? 0;
    }

    return res.json({ jobs: rows, total, limit, offset });
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

export const getJobHandler: RequestHandler = async (req, res) => {
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

    // If the job is being created already-assigned to a tech, fire the
    // "new job assigned" push so they don't have to refresh the app to
    // see it.
    if (rows[0].resource_id || rows[0].assignee_user_id) {
      void pushAssigneeForJob(pool, tenantId, rows[0].id as string, 'job_assigned');
    }

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
      const pushEvent = STATUS_TO_PUSH_EVENT[status];
      if (pushEvent) {
        void pushAssigneeForJob(pool, tenantId, id, pushEvent);
      }
    }

    const assignmentChanged =
      (assignee_user_id !== undefined && assignee_user_id !== existing[0].assignee_user_id) ||
      (resource_id !== undefined && resource_id !== existing[0].resource_id);

    if (assignee_user_id && assignee_user_id !== existing[0].assignee_user_id) {
      await pool.query(
        `INSERT INTO dispatch_job_events (job_id, tenant_id, event_type, performed_by, notes)
         VALUES ($1, $2, 'assignment', $3, 'Job assigned')`,
        [id, tenantId, userId],
      );
    }

    // Fire the "new job assigned" push when a job lands on a tech for the
    // first time (or moves to a new tech). We use the row we just wrote so
    // the push reflects the post-update resource_id / assignee.
    if (assignmentChanged && (rows[0].resource_id || rows[0].assignee_user_id)) {
      void pushAssigneeForJob(pool, tenantId, id, 'job_assigned');
    }

    return res.json({ job: rows[0] });
  } catch (err) {
    logger.error('Failed to update dispatch job', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to update job' });
  }
};

export const transitionJobHandler: RequestHandler = async (req, res) => {
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

    const pushEvent = STATUS_TO_PUSH_EVENT[status];
    if (pushEvent) {
      void pushAssigneeForJob(pool, tenantId, id, pushEvent);
    }

    // When a job hits a terminal status, the technician's mobile app stops
    // sending pings. Clear the resource's "active_job_id" pointer so the
    // dispatcher live map drops the marker immediately rather than waiting
    // on the staleness window. We only touch rows whose active_job_id is
    // still THIS job, so a tech who already moved on to another active job
    // keeps that pointer.
    if (TERMINAL_JOB_STATUSES.has(status)) {
      try {
        await pool.query(
          `UPDATE dispatch_resource_locations
              SET active_job_id = NULL,
                  active_status = NULL
            WHERE tenant_id = $1 AND active_job_id = $2`,
          [tenantId, id],
        );
      } catch (clearErr) {
        // Best-effort; the staleness filter on the map is the safety net.
        logger.warn('Failed to clear resource location active job', {
          tenantId, jobId: id, error: String(clearErr),
        });
      }
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

      const pushEvent = STATUS_TO_PUSH_EVENT[status];
      if (pushEvent || resource_id || assignee_user_id) {
        for (const j of currentJobs) {
          if (resource_id || assignee_user_id) {
            void pushAssigneeForJob(pool, tenantId, j.id as string, 'job_assigned');
          } else if (pushEvent) {
            void pushAssigneeForJob(pool, tenantId, j.id as string, pushEvent);
          }
        }
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

      if (resource_id || assignee_user_id) {
        for (const r of rows) {
          void pushAssigneeForJob(pool, tenantId, r.id as string, 'job_assigned');
        }
      }

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

const ALLOWED_ATTACHMENT_TYPES = new Set([
  'note',
  'photo',
  'document',
  'signature',
  'proof_of_service',
  'proof_of_completion',
]);

const ALLOWED_MIME_PREFIXES = ['image/', 'application/pdf', 'video/'];

function isAllowedMimeType(mime: string | null | undefined): boolean {
  if (!mime) return true;
  return ALLOWED_MIME_PREFIXES.some(p => mime.startsWith(p));
}

export const requestAttachmentUploadUrlHandler: RequestHandler = async (req, res) => {
  const { tenantId } = req.user!;
  const { mime_type, size_bytes } = req.body || {};

  if (mime_type && !isAllowedMimeType(mime_type)) {
    return res.status(400).json({ error: 'Unsupported file type' });
  }
  if (typeof size_bytes === 'number' && size_bytes > 25 * 1024 * 1024) {
    return res.status(400).json({ error: 'File exceeds 25 MB upload limit' });
  }

  try {
    const storage = new ObjectStorageService();
    const uploadURL = await storage.getObjectEntityUploadURL();
    const objectPath = storage.normalizeObjectEntityPath(uploadURL);
    return res.json({
      uploadURL,
      objectPath,
      tenantId,
    });
  } catch (err) {
    logger.error('Failed to issue attachment upload URL', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to prepare upload' });
  }
};

export const addAttachmentHandler: RequestHandler = async (req, res) => {
  const { tenantId, userId } = req.user!;
  const { id } = req.params;
  const {
    attachment_type,
    title,
    content,
    file_url,
    object_path,
    mime_type,
    file_size_bytes,
    completion_transition,
  } = req.body || {};
  const pool = getPlatformPool();

  const attachmentType = (attachment_type as string) || 'note';
  if (!ALLOWED_ATTACHMENT_TYPES.has(attachmentType)) {
    return res.status(400).json({ error: 'Invalid attachment_type' });
  }

  try {
    const { rows: jobRows } = await pool.query(
      `SELECT id, status FROM dispatch_jobs WHERE id = $1 AND tenant_id = $2`,
      [id, tenantId],
    );
    if (jobRows.length === 0) {
      return res.status(404).json({ error: 'Job not found' });
    }

    let normalizedObjectPath: string | null = null;
    let resolvedFileUrl: string | null = file_url || null;

    if (object_path) {
      const storage = new ObjectStorageService();
      try {
        normalizedObjectPath = await storage.trySetObjectEntityAclPolicy(
          String(object_path),
          { owner: `tenant:${tenantId}`, visibility: 'private' },
        );
      } catch (err) {
        if (err instanceof ObjectNotFoundError) {
          return res.status(400).json({
            error: 'Uploaded object not found - upload to the presigned URL before attaching',
          });
        }
        throw err;
      }
      resolvedFileUrl = normalizedObjectPath;
    }

    if (!resolvedFileUrl && !content && !title) {
      return res.status(400).json({
        error: 'Attachment must include a file (object_path) or note text (title/content)',
      });
    }

    if (mime_type && !isAllowedMimeType(mime_type)) {
      return res.status(400).json({ error: 'Unsupported file type' });
    }

    const { rows } = await pool.query(
      `INSERT INTO dispatch_job_attachments
        (job_id, tenant_id, attachment_type, title, content, file_url,
         object_path, mime_type, file_size_bytes, uploaded_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING *`,
      [
        id,
        tenantId,
        attachmentType,
        title || '',
        content || '',
        resolvedFileUrl,
        normalizedObjectPath,
        mime_type || null,
        typeof file_size_bytes === 'number' ? file_size_bytes : null,
        userId,
      ],
    );

    const attachment = rows[0];

    // Link to dispatch_job_events so the activity timeline shows the upload.
    const eventNote = title
      ? `${attachmentType.replace(/_/g, ' ')}: ${title}`
      : content
        ? `${attachmentType.replace(/_/g, ' ')}: ${content.slice(0, 280)}`
        : `${attachmentType.replace(/_/g, ' ')} added`;

    await pool.query(
      `INSERT INTO dispatch_job_events
        (job_id, tenant_id, event_type, performed_by, notes, metadata)
       VALUES ($1, $2, 'attachment_added', $3, $4, $5)`,
      [
        id,
        tenantId,
        userId,
        eventNote,
        JSON.stringify({
          attachment_id: attachment.id,
          attachment_type: attachmentType,
          mime_type: mime_type || null,
          object_path: normalizedObjectPath,
          file_size_bytes: typeof file_size_bytes === 'number' ? file_size_bytes : null,
        }),
      ],
    );

    // Optional: mobile "complete with photos" flow can pass completion_transition
    // to atomically move the job state once attachments are saved. We respect the
    // existing transition rules.
    let updatedJob = null;
    if (completion_transition && typeof completion_transition === 'string') {
      const currentStatus = jobRows[0].status as string;
      const allowed = VALID_TRANSITIONS[currentStatus] || [];
      if (allowed.includes(completion_transition)) {
        const isCompleting =
          (completion_transition === 'completed' || completion_transition === 'done') &&
          currentStatus !== 'completed' && currentStatus !== 'done';
        const { rows: u } = await pool.query(
          `UPDATE dispatch_jobs
             SET status = $3, ${isCompleting ? 'completed_at = NOW(),' : ''} updated_at = NOW()
           WHERE id = $1 AND tenant_id = $2
           RETURNING *`,
          [id, tenantId, completion_transition],
        );
        updatedJob = u[0] || null;
        await pool.query(
          `INSERT INTO dispatch_job_events
            (job_id, tenant_id, event_type, from_status, to_status, performed_by, notes)
           VALUES ($1, $2, 'status_change', $3, $4, $5, $6)`,
          [id, tenantId, currentStatus, completion_transition, userId, eventNote],
        );
        const trigger = STATUS_TO_TRIGGER[completion_transition];
        if (trigger) fireNotifications(pool, tenantId, id, trigger);
      }
    }

    return res.status(201).json({ attachment, job: updatedJob });
  } catch (err) {
    logger.error('Failed to add attachment', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to add attachment' });
  }
};

export const getAttachmentFileHandler: RequestHandler = async (req, res) => {
  const { tenantId } = req.user!;
  const { attachmentId } = req.params;
  const pool = getPlatformPool();

  try {
    const { rows } = await pool.query(
      `SELECT id, object_path, mime_type FROM dispatch_job_attachments
       WHERE id = $1 AND tenant_id = $2 LIMIT 1`,
      [attachmentId, tenantId],
    );
    if (rows.length === 0 || !rows[0].object_path) {
      return res.status(404).json({ error: 'Attachment file not found' });
    }
    const storage = new ObjectStorageService();
    const file = await storage.getObjectEntityFile(rows[0].object_path as string);
    await storage.downloadObject(file, res, 60);
    return;
  } catch (err) {
    if (err instanceof ObjectNotFoundError) {
      return res.status(404).json({ error: 'File no longer available' });
    }
    logger.error('Failed to stream attachment', { tenantId, error: String(err) });
    if (!res.headersSent) {
      return res.status(500).json({ error: 'Failed to fetch attachment file' });
    }
    return;
  }
};

// ============ RESOURCES ============

export const listResourcesHandler: RequestHandler = async (req, res) => {
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

// ============ RESOURCE LOCATION (live map) ============

/**
 * Validate and parse a numeric body field that must fall in a closed range.
 * Returns `null` if the field is missing/invalid (so callers can decide
 * whether that's a hard error or a soft "skip this field" outcome).
 */
function parseFiniteNumber(
  value: unknown,
  opts: { min?: number; max?: number } = {},
): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  if (opts.min !== undefined && value < opts.min) return null;
  if (opts.max !== undefined && value > opts.max) return null;
  return value;
}

// POST /dispatch/resources/:id/pairing-codes  (admin JWT only)
// Issues a one-time pairing code; the plaintext is returned exactly
// once and only the SHA-256 hash is persisted.
export const issueResourcePairingCodeHandler: RequestHandler = async (req, res) => {
  const { tenantId, userId } = req.user!;
  const { id: resourceId } = req.params;
  const body = (req.body ?? {}) as Record<string, unknown>;

  // Default 24h, max 7 days, min 5 minutes.
  const ttlMinutesRaw = Number(body.ttl_minutes);
  const ttlMinutes = Number.isFinite(ttlMinutesRaw) && ttlMinutesRaw > 0
    ? Math.min(Math.max(Math.floor(ttlMinutesRaw), 5), 60 * 24 * 7)
    : 60 * 24;

  const pool = getPlatformPool();
  try {
    // Confirm the resource is in this tenant.
    const { rows: rcheck } = await pool.query(
      `SELECT id, name FROM dispatch_resources
        WHERE id = $1 AND tenant_id = $2 LIMIT 1`,
      [resourceId, tenantId],
    );
    if (rcheck.length === 0) {
      res.status(404).json({ error: 'Resource not found' });
      return;
    }

    // Generate an 8-char A-Z + 2-9 code (32^8 ≈ 1.1e12 keyspace,
    // legibility chars 0/1/I/O removed). Re-roll on the (vanishingly
    // small) chance of a hash collision with an unconsumed code.
    const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const generateCode = (): string => {
      const buf = crypto.randomBytes(8);
      let out = '';
      for (let i = 0; i < 8; i++) out += ALPHABET[buf[i] % ALPHABET.length];
      return out;
    };

    let plaintext = '';
    let codeHash = '';
    let attempts = 0;
    while (attempts < 5) {
      plaintext = generateCode();
      codeHash = crypto.createHash('sha256').update(plaintext).digest('hex');
      const { rowCount } = await pool.query(
        `SELECT 1 FROM dispatch_resource_pairing_codes
          WHERE code_hash = $1 AND consumed_at IS NULL AND expires_at > NOW()`,
        [codeHash],
      );
      if (rowCount === 0) break;
      attempts++;
    }
    if (attempts >= 5) {
      res.status(500).json({ error: 'Could not allocate pairing code; please retry' });
      return;
    }

    const issuedBy = typeof userId === 'string' && !userId.startsWith('apikey:') ? userId : null;
    const expiresAt = new Date(Date.now() + ttlMinutes * 60_000);
    const { rows } = await pool.query(
      `INSERT INTO dispatch_resource_pairing_codes
         (tenant_id, resource_id, code_hash, issued_by_user, expires_at)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, expires_at`,
      [tenantId, resourceId, codeHash, issuedBy, expiresAt],
    );

    res.status(201).json({
      pairing_code: plaintext,
      resource_id: resourceId,
      resource_name: rcheck[0].name,
      expires_at: rows[0].expires_at,
      id: rows[0].id,
    });
  } catch (err) {
    logger.error('Failed to issue pairing code', { tenantId, resourceId, error: String(err) });
    res.status(500).json({ error: 'Failed to issue pairing code' });
  }
};

export const recordResourceLocationHandler: RequestHandler = async (req, res) => {
  const { tenantId } = req.user!;
  const { id: resourceId } = req.params;
  const body = (req.body ?? {}) as Record<string, unknown>;
  const pool = getPlatformPool();

  const latitude = parseFiniteNumber(body.latitude, { min: -90, max: 90 });
  const longitude = parseFiniteNumber(body.longitude, { min: -180, max: 180 });
  if (latitude === null || longitude === null) {
    return res.status(400).json({
      error: 'latitude and longitude are required and must be finite numbers in range',
    });
  }

  const accuracy = parseFiniteNumber(body.accuracy_m, { min: 0, max: 100_000 });
  const heading = parseFiniteNumber(body.heading_deg, { min: 0, max: 360 });
  const speed = parseFiniteNumber(body.speed_mps, { min: 0, max: 200 });

  let recordedAt: Date;
  if (typeof body.recorded_at === 'string' && body.recorded_at) {
    const parsed = new Date(body.recorded_at);
    if (Number.isNaN(parsed.getTime())) {
      return res.status(400).json({ error: 'recorded_at must be a valid ISO timestamp' });
    }
    // Reject pings claiming to be from the future or from before 2020 — both
    // indicate a clock-mis-set device whose data would mislead the breadcrumb.
    const now = Date.now();
    const ts = parsed.getTime();
    if (ts > now + 5 * 60_000 || ts < new Date('2020-01-01T00:00:00Z').getTime()) {
      return res.status(400).json({ error: 'recorded_at is outside the acceptable range' });
    }
    recordedAt = parsed;
  } else {
    recordedAt = new Date();
  }

  // X-Device-Secret binds the caller to a specific resource_id (mobile
  // API key is tenant-wide, so the URL :id alone is self-claimed).
  const headerSecret = (() => {
    const raw = req.header('x-device-secret');
    return typeof raw === 'string' ? raw.trim() : '';
  })();
  if (!headerSecret) {
    return res.status(401).json({
      error: 'X-Device-Secret header is required for location updates',
    });
  }
  const headerSecretHash = crypto
    .createHash('sha256')
    .update(headerSecret)
    .digest('hex');

  const requestedJobId =
    typeof body.active_job_id === 'string' && body.active_job_id
      ? body.active_job_id
      : null;
  if (!requestedJobId) {
    return res.status(400).json({
      error: 'active_job_id is required (location is only collected during an active job)',
    });
  }

  try {
    const { rows: drows } = await pool.query(
      `SELECT resource_id
         FROM user_devices
        WHERE tenant_id = $1
          AND device_secret_hash = $2
        LIMIT 1`,
      [tenantId, headerSecretHash],
    );
    if (drows.length === 0) {
      return res.status(401).json({ error: 'Invalid device secret' });
    }
    const deviceResourceId = (drows[0].resource_id as string | null) ?? null;
    if (!deviceResourceId || deviceResourceId !== resourceId) {
      return res.status(403).json({
        error: 'Device is not bound to this resource',
      });
    }

    const { rows: rcheck } = await pool.query(
      `SELECT id FROM dispatch_resources WHERE id = $1 AND tenant_id = $2 LIMIT 1`,
      [resourceId, tenantId],
    );
    if (rcheck.length === 0) {
      return res.status(404).json({ error: 'Resource not found in this tenant' });
    }

    const { rows: jrows } = await pool.query(
      `SELECT id, status, resource_id
         FROM dispatch_jobs
        WHERE id = $1 AND tenant_id = $2
        LIMIT 1`,
      [requestedJobId, tenantId],
    );
    if (jrows.length === 0) {
      return res.status(404).json({ error: 'active_job_id not found in this tenant' });
    }
    const jobRow = jrows[0] as Record<string, unknown>;
    const jobStatus = (jobRow.status as string | null) ?? null;
    const jobResourceId = (jobRow.resource_id as string | null) ?? null;
    if (!jobResourceId || jobResourceId !== resourceId) {
      return res.status(403).json({
        error: 'active_job_id is not assigned to this resource',
      });
    }
    if (!jobStatus || TERMINAL_JOB_STATUSES.has(jobStatus)) {
      // The job was completed/cancelled before this ping arrived. Wipe the
      // current-location row so the dispatcher map immediately drops the
      // marker, and instruct the client to stop tracking.
      try {
        await pool.query(
          `DELETE FROM dispatch_resource_locations WHERE resource_id = $1 AND tenant_id = $2`,
          [resourceId, tenantId],
        );
      } catch (delErr) {
        logger.warn('Failed to clear stale resource location', {
          tenantId, resourceId, error: String(delErr),
        });
      }
      return res.status(409).json({
        error: 'Job is no longer active; tracking should stop',
        job_status: jobStatus,
      });
    }
    const activeJobId = jobRow.id as string;
    const activeStatus = jobStatus;

    const { rows: upserted } = await pool.query(
      `INSERT INTO dispatch_resource_locations (
         resource_id, tenant_id, latitude, longitude,
         accuracy_m, heading_deg, speed_mps,
         active_job_id, active_status, recorded_at, received_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW())
       ON CONFLICT (resource_id) DO UPDATE SET
         tenant_id     = EXCLUDED.tenant_id,
         latitude      = EXCLUDED.latitude,
         longitude     = EXCLUDED.longitude,
         accuracy_m    = EXCLUDED.accuracy_m,
         heading_deg   = EXCLUDED.heading_deg,
         speed_mps     = EXCLUDED.speed_mps,
         active_job_id = EXCLUDED.active_job_id,
         active_status = EXCLUDED.active_status,
         recorded_at   = EXCLUDED.recorded_at,
         received_at   = NOW()
       RETURNING resource_id, tenant_id, latitude, longitude, accuracy_m,
                 heading_deg, speed_mps, active_job_id, active_status,
                 recorded_at, received_at`,
      [
        resourceId, tenantId, latitude, longitude,
        accuracy, heading, speed,
        activeJobId, activeStatus, recordedAt,
      ],
    );

    await pool.query(
      `INSERT INTO dispatch_resource_location_history (
         resource_id, tenant_id, latitude, longitude,
         accuracy_m, heading_deg, speed_mps,
         active_job_id, recorded_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        resourceId, tenantId, latitude, longitude,
        accuracy, heading, speed, activeJobId, recordedAt,
      ],
    );

    // Probabilistic pruning so we don't run a delete on every ping.
    if (Math.random() < LOCATION_HISTORY_PRUNE_PROBABILITY) {
      try {
        await pool.query(
          `DELETE FROM dispatch_resource_location_history
            WHERE resource_id = $1
              AND id NOT IN (
                SELECT id FROM dispatch_resource_location_history
                 WHERE resource_id = $1
                 ORDER BY recorded_at DESC
                 LIMIT $2
              )`,
          [resourceId, LOCATION_HISTORY_KEEP_PER_RESOURCE],
        );
      } catch (pruneErr) {
        logger.warn('Failed to prune location history', {
          tenantId, resourceId, error: String(pruneErr),
        });
      }
    }

    return res.json({ location: upserted[0] });
  } catch (err) {
    logger.error('Failed to record resource location', {
      tenantId, resourceId, error: String(err),
    });
    return res.status(500).json({ error: 'Failed to record resource location' });
  }
};

/**
 * GET /dispatch/resource-locations
 *
 * Admin-facing read used by the dispatch board map view. Returns the latest
 * fix for every resource in the tenant whose ping was received within
 * `staleness_seconds` seconds (default 600 = 10 minutes). Each row is
 * enriched with the resource's name and, when the location row points at
 * an active job, the job's title / customer / status — that's what the
 * UI uses to color the marker and label the popup.
 */
export const listResourceLocationsHandler: RequestHandler = async (req, res) => {
  const { tenantId } = req.user!;
  const pool = getPlatformPool();
  const staleness = Math.min(
    Math.max(parseInt(String(req.query.staleness_seconds ?? '600'), 10) || 600, 30),
    24 * 60 * 60,
  );

  try {
    // Only surface technicians who are currently on an active (non-terminal)
    // job. The done criteria for the live map is "marker per active tech";
    // techs who finished or cancelled their job should drop off immediately
    // even if their last fix is still within the staleness window. The
    // INNER JOIN to dispatch_jobs + the active_job_id filter + the explicit
    // terminal-status exclusion together enforce that contract.
    const terminalArr = Array.from(TERMINAL_JOB_STATUSES);
    const { rows } = await pool.query(
      `SELECT l.resource_id,
              l.latitude,
              l.longitude,
              l.accuracy_m,
              l.heading_deg,
              l.speed_mps,
              l.active_job_id,
              l.active_status,
              l.recorded_at,
              l.received_at,
              r.name        AS resource_name,
              r.role        AS resource_role,
              r.current_status AS resource_current_status,
              j.title       AS job_title,
              j.contact_name AS job_contact_name,
              j.address     AS job_address,
              j.status      AS job_status,
              j.address_lat AS job_address_lat,
              j.address_lon AS job_address_lon,
              j.address_geocoded_for AS job_address_geocoded_for,
              EXTRACT(EPOCH FROM (NOW() - l.received_at))::int AS age_seconds
         FROM dispatch_resource_locations l
         JOIN dispatch_resources r
           ON r.id = l.resource_id AND r.tenant_id = l.tenant_id
         JOIN dispatch_jobs j
           ON j.id = l.active_job_id AND j.tenant_id = l.tenant_id
        WHERE l.tenant_id = $1
          AND l.active_job_id IS NOT NULL
          AND NOT (j.status = ANY($3::text[]))
          AND l.received_at > NOW() - ($2::int * INTERVAL '1 second')
        ORDER BY l.received_at DESC`,
      [tenantId, staleness, terminalArr],
    );

    const enriched = await enrichLocationsWithEta(pool, tenantId, rows);
    return res.json({ locations: enriched, staleness_seconds: staleness });
  } catch (err) {
    logger.error('Failed to list resource locations', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to list resource locations' });
  }
};

/**
 * GET /dispatch/jobs/:id/route
 *
 * Returns the breadcrumb of GPS pings recorded for the technician who serviced
 * this job, ordered oldest → newest. Used by the dispatcher's "Route taken"
 * tab to replay where the tech drove (disputed ETAs, no-shows, route
 * audits).
 *
 * Source data is `dispatch_resource_location_history`. Mobile only stamps
 * `active_job_id` on a ping while the job is in a non-terminal state, so
 * filtering on that column already gives us the active window — no
 * separate timestamp bookkeeping required.
 *
 * Tenant scoping is enforced both via the explicit tenant_id predicate
 * and via the RLS policy on the table (migration 083).
 */
const getJobRouteHandler: RequestHandler = async (req, res) => {
  const { tenantId } = req.user!;
  const { id } = req.params;
  const pool = getPlatformPool();

  // Optional `?format=gpx|csv` turns the response into a downloadable
  // breadcrumb file (used by the dispatcher's "Route taken" tab for
  // disputes — handing the data to a customer, lawyer, or external
  // mapping tool without screenshots). Default (no format) keeps the
  // JSON shape that the in-app map replay depends on.
  const formatRaw = typeof req.query.format === 'string' ? req.query.format.toLowerCase() : '';
  const exportFormat: 'gpx' | 'csv' | null =
    formatRaw === 'gpx' ? 'gpx' : formatRaw === 'csv' ? 'csv' : null;

  try {
    const { rows: jobRows } = await pool.query(
      `SELECT j.id, j.title, j.status, j.scheduled_at, j.completed_at,
              j.resource_id, r.name AS resource_name,
              j.address, j.address_lat, j.address_lon, j.address_geocoded_for
         FROM dispatch_jobs j
         LEFT JOIN dispatch_resources r
           ON r.id = j.resource_id AND r.tenant_id = j.tenant_id
        WHERE j.id = $1 AND j.tenant_id = $2
        LIMIT 1`,
      [id, tenantId],
    );
    if (jobRows.length === 0) {
      return res.status(404).json({ error: 'Job not found' });
    }
    const job = jobRows[0] as Record<string, unknown>;

    const { rows: pointRows } = await pool.query(
      `SELECT latitude, longitude, accuracy_m, heading_deg, speed_mps,
              recorded_at, received_at
         FROM dispatch_resource_location_history
        WHERE tenant_id = $1
          AND active_job_id = $2
        ORDER BY recorded_at ASC, id ASC`,
      [tenantId, id],
    );

    const points = pointRows.map((p) => ({
      lat: Number(p.latitude),
      lng: Number(p.longitude),
      accuracy_m: p.accuracy_m === null ? null : Number(p.accuracy_m),
      heading_deg: p.heading_deg === null ? null : Number(p.heading_deg),
      speed_mps: p.speed_mps === null ? null : Number(p.speed_mps),
      recorded_at: p.recorded_at ? new Date(p.recorded_at as string | Date).toISOString() : null,
      received_at: p.received_at ? new Date(p.received_at as string | Date).toISOString() : null,
    }));

    const window = points.length > 0
      ? { start: points[0].recorded_at, end: points[points.length - 1].recorded_at }
      : { start: null, end: null };

    if (exportFormat) {
      // Pick a stable date for the filename. Prefer the actual breadcrumb
      // start; fall back to the job's scheduled/completed time so the file
      // is still recognizable when no pings were recorded. Final fallback
      // is "today" — better than an "undefined" filename.
      const filenameDateSource =
        window.start
          || (job.scheduled_at ? new Date(job.scheduled_at as string | Date).toISOString() : null)
          || (job.completed_at ? new Date(job.completed_at as string | Date).toISOString() : null)
          || new Date().toISOString();
      const filenameDate = filenameDateSource.slice(0, 10); // YYYY-MM-DD
      const safeJobId = String(job.id).replace(/[^A-Za-z0-9_-]/g, '');
      const filename = `route-${safeJobId}-${filenameDate}.${exportFormat}`;

      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

      if (exportFormat === 'csv') {
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        const header = 'recorded_at,latitude,longitude,accuracy_m,heading_deg,speed_mps';
        const lines = points.map((p) =>
          [
            p.recorded_at ?? '',
            p.lat,
            p.lng,
            p.accuracy_m ?? '',
            p.heading_deg ?? '',
            p.speed_mps ?? '',
          ].join(','),
        );
        return res.send([header, ...lines].join('\n') + '\n');
      }

      // GPX 1.1 — one <trk> with one <trkseg>. Each <trkpt> carries the
      // ISO timestamp; speed/heading are not part of the GPX 1.1 schema
      // proper, so we keep this minimal and interoperable.
      const xmlEscape = (s: string): string =>
        s.replace(/[<>&'"]/g, (c) =>
          c === '<' ? '&lt;'
            : c === '>' ? '&gt;'
            : c === '&' ? '&amp;'
            : c === "'" ? '&apos;'
            : '&quot;',
        );
      const trackName = xmlEscape(
        `Job ${String(job.id)}${job.title ? ` — ${String(job.title)}` : ''}`,
      );
      const trkpts = points
        .map((p) => {
          const time = p.recorded_at ? `<time>${p.recorded_at}</time>` : '';
          return `      <trkpt lat="${p.lat}" lon="${p.lng}">${time}</trkpt>`;
        })
        .join('\n');
      const gpx =
        `<?xml version="1.0" encoding="UTF-8"?>\n` +
        `<gpx version="1.1" creator="Qvo Dispatch" xmlns="http://www.topografix.com/GPX/1/1">\n` +
        `  <trk>\n` +
        `    <name>${trackName}</name>\n` +
        `    <trkseg>\n` +
        (trkpts ? trkpts + '\n' : '') +
        `    </trkseg>\n` +
        `  </trk>\n` +
        `</gpx>\n`;
      res.setHeader('Content-Type', 'application/gpx+xml; charset=utf-8');
      return res.send(gpx);
    }

    // Resolve the customer's address geocode. We prefer the cached coords
    // on the job row when they were geocoded for the *current* address
    // string. Otherwise we lazily geocode now and persist back so future
    // route-replay requests skip the provider entirely. Skipped for
    // GPX/CSV exports since neither format carries the address pin.
    const rawAddress = typeof job.address === 'string' ? job.address.trim() : '';
    let addressPoint: { lat: number; lng: number } | null = null;
    if (rawAddress) {
      const cachedFor = String(job.address_geocoded_for ?? '').trim();
      const cachedLat = job.address_lat == null ? NaN : Number(job.address_lat);
      const cachedLon = job.address_lon == null ? NaN : Number(job.address_lon);
      if (
        Number.isFinite(cachedLat)
        && Number.isFinite(cachedLon)
        && cachedFor === rawAddress
      ) {
        addressPoint = { lat: cachedLat, lng: cachedLon };
      } else {
        try {
          const geocoded = await geocodeAddressCached(tenantId, rawAddress);
          if (geocoded) {
            addressPoint = { lat: geocoded.lat, lng: geocoded.lon };
            try {
              await pool.query(
                `UPDATE dispatch_jobs
                    SET address_lat = $1, address_lon = $2,
                        address_geocoded_at = NOW(), address_geocoded_for = $3
                  WHERE id = $4 AND tenant_id = $5`,
                [geocoded.lat, geocoded.lon, rawAddress, id, tenantId],
              );
            } catch (persistErr) {
              // Persist is best-effort — if it fails the next replay will
              // simply re-geocode. We still return the resolved coords.
              logger.warn('Failed to persist geocoded coords for route replay', {
                tenantId, jobId: id, error: String(persistErr),
              });
            }
          }
        } catch (geoErr) {
          // Geocoder failures fall through to a null address pin: the UI
          // hides the marker gracefully rather than showing a broken one.
          logger.warn('On-demand geocode failed for route replay', {
            tenantId, jobId: id, error: String(geoErr),
          });
        }
      }
    }

    // Closest-approach distance in meters between any breadcrumb ping
    // and the customer's address. Powers the "closest approach: X m"
    // line in the route summary so dispatchers can settle "did the tech
    // actually get to the right house?" disputes at a glance.
    let closestApproachM: number | null = null;
    if (addressPoint && points.length > 0) {
      const addr = { lat: addressPoint.lat, lon: addressPoint.lng };
      let best = Infinity;
      for (const p of points) {
        const d = haversineMeters({ lat: p.lat, lon: p.lng }, addr);
        if (d < best) best = d;
      }
      if (Number.isFinite(best)) closestApproachM = best;
    }

    return res.json({
      job: {
        id: job.id,
        title: job.title,
        status: job.status,
        resource_id: job.resource_id,
        resource_name: job.resource_name ?? null,
        scheduled_at: job.scheduled_at ? new Date(job.scheduled_at as string | Date).toISOString() : null,
        completed_at: job.completed_at ? new Date(job.completed_at as string | Date).toISOString() : null,
        address: rawAddress || null,
        address_lat: addressPoint ? addressPoint.lat : null,
        address_lng: addressPoint ? addressPoint.lng : null,
      },
      points,
      window,
      closest_approach_m: closestApproachM,
    });
  } catch (err) {
    logger.error('Failed to get job route', { tenantId, jobId: id, error: String(err) });
    return res.status(500).json({ error: 'Failed to get job route' });
  }
};

interface LocationRowForEta {
  resource_id: string;
  latitude: number | string;
  longitude: number | string;
  active_job_id: string | null;
  job_address: string | null;
  job_address_lat: number | string | null;
  job_address_lon: number | string | null;
  job_address_geocoded_for: string | null;
  [k: string]: unknown;
}

/**
 * Walk the live-map result set, lazily geocode any job whose address
 * has changed (or never been geocoded), then attach a driving ETA to
 * every row that has a usable origin + destination. Failures from any
 * single row are isolated so one bad address doesn't blank the map.
 *
 * The persist step (`UPDATE dispatch_jobs SET address_lat ...`) writes
 * the geocode back so subsequent polls skip the geocoder entirely.
 */
async function enrichLocationsWithEta(
  pool: ReturnType<typeof getPlatformPool>,
  tenantId: string,
  rows: LocationRowForEta[],
): Promise<LocationRowForEta[]> {
  if (rows.length === 0) return rows;

  // Group by job to avoid duplicate geocode work when several techs
  // share a job (rare but possible during a hand-off window).
  const jobsToGeocode = new Map<string, { address: string; needsGeocode: boolean }>();
  for (const row of rows) {
    const jobId = row.active_job_id;
    const address = (row.job_address ?? '').trim();
    if (!jobId || !address) continue;
    const cachedFor = (row.job_address_geocoded_for ?? '').trim();
    const cachedLat = row.job_address_lat == null ? null : Number(row.job_address_lat);
    const cachedLon = row.job_address_lon == null ? null : Number(row.job_address_lon);
    const haveCoords =
      cachedLat != null && cachedLon != null &&
      Number.isFinite(cachedLat) && Number.isFinite(cachedLon);
    const stillValid = haveCoords && cachedFor === address;
    if (!jobsToGeocode.has(jobId)) {
      jobsToGeocode.set(jobId, { address, needsGeocode: !stillValid });
    }
  }

  const geocoded = new Map<string, GeoPoint | null>();
  for (const [jobId, info] of jobsToGeocode.entries()) {
    if (!info.needsGeocode) continue;
    try {
      const point = await geocodeAddressCached(tenantId, info.address);
      geocoded.set(jobId, point);
      if (point) {
        // Persist back so future polls skip the geocoder. We tolerate
        // failures here — the in-memory cache still helps.
        try {
          await pool.query(
            `UPDATE dispatch_jobs
                SET address_lat = $1, address_lon = $2,
                    address_geocoded_at = NOW(), address_geocoded_for = $3
              WHERE id = $4 AND tenant_id = $5`,
            [point.lat, point.lon, info.address, jobId, tenantId],
          );
        } catch (persistErr) {
          logger.warn('Failed to persist geocoded coords', {
            tenantId, jobId, error: String(persistErr),
          });
        }
      }
    } catch (err) {
      logger.warn('Geocode failed during live-map enrichment', {
        tenantId, jobId, error: String(err),
      });
      geocoded.set(jobId, null);
    }
  }

  return Promise.all(rows.map(async (row) => {
    const jobId = row.active_job_id;
    let dest: GeoPoint | null = null;
    if (jobId) {
      if (geocoded.has(jobId)) {
        dest = geocoded.get(jobId) ?? null;
      } else {
        const lat = row.job_address_lat == null ? NaN : Number(row.job_address_lat);
        const lon = row.job_address_lon == null ? NaN : Number(row.job_address_lon);
        if (Number.isFinite(lat) && Number.isFinite(lon)) {
          dest = { lat, lon };
        }
      }
    }

    if (!jobId || !dest) {
      return {
        ...row,
        eta_minutes: null,
        eta_seconds: null,
        eta_distance_m: null,
        eta_provider: null,
        eta_computed_at: null,
        eta_is_estimate: null,
      };
    }

    const origin: GeoPoint = {
      lat: Number(row.latitude),
      lon: Number(row.longitude),
    };
    if (!Number.isFinite(origin.lat) || !Number.isFinite(origin.lon)) {
      return {
        ...row,
        eta_minutes: null,
        eta_seconds: null,
        eta_distance_m: null,
        eta_provider: null,
        eta_computed_at: null,
        eta_is_estimate: null,
      };
    }

    let eta: DriveEtaResult;
    try {
      eta = await getDriveEta({
        tenantId,
        resourceId: row.resource_id,
        jobId,
        origin,
        destination: dest,
      });
    } catch (err) {
      logger.warn('getDriveEta unexpectedly threw', {
        tenantId, jobId, resourceId: row.resource_id, error: String(err),
      });
      return {
        ...row,
        eta_minutes: null,
        eta_seconds: null,
        eta_distance_m: null,
        eta_provider: null,
        eta_computed_at: null,
        eta_is_estimate: null,
      };
    }

    return {
      ...row,
      eta_minutes: Math.round(eta.durationSeconds / 60),
      eta_seconds: eta.durationSeconds,
      eta_distance_m: eta.distanceMeters,
      eta_provider: eta.provider,
      eta_computed_at: new Date(eta.computedAtMs).toISOString(),
      // The UI shows a subtle "estimate" badge when this is true, e.g.
      // when the haversine fallback kicks in for a transient routing
      // outage or when the haversine provider is the configured one.
      eta_is_estimate: eta.provider === 'haversine' || eta.fallback,
    };
  }));
}

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
router.post('/dispatch/uploads/request-url', requireAuth, requireMiniSystemWrite, requestAttachmentUploadUrlHandler);
router.get('/dispatch/attachments/:attachmentId/file', requireAuth, getAttachmentFileHandler);
router.post('/dispatch/jobs/batch', requireAuth, requireMiniSystemWrite, batchUpdateHandler);
router.delete('/dispatch/jobs/:id', requireAuth, requireMiniSystemWrite, deleteJobHandler);

router.get('/dispatch/resources', requireAuth, listResourcesHandler);
router.post('/dispatch/resources', requireAuth, requireMiniSystemWrite, createResourceHandler);
router.post(
  '/dispatch/resources/:id/pairing-codes',
  requireAuth,
  requireMiniSystemWrite,
  issueResourcePairingCodeHandler,
);
router.put('/dispatch/resources/:id', requireAuth, requireMiniSystemWrite, updateResourceHandler);
router.delete('/dispatch/resources/:id', requireAuth, requireMiniSystemWrite, deleteResourceHandler);
router.put('/dispatch/resources/:id/skills', requireAuth, requireMiniSystemWrite, syncResourceSkillsHandler);
router.get('/dispatch/resource-locations', requireAuth, listResourceLocationsHandler);
router.get('/dispatch/jobs/:id/route', requireAuth, getJobRouteHandler);

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
