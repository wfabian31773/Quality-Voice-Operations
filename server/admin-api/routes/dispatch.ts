import { Router } from 'express';
import type { RequestHandler } from 'express';
import crypto from 'crypto';
import JSZip from 'jszip';
import { requireAuth } from '../middleware/auth';
import { requireMiniSystemWrite } from '../middleware/rbac';
import { getPlatformPool } from '../../../platform/db';
import { createLogger } from '../../../platform/core/logger';
import { fireDispatchPush, type DispatchPushEvent } from '../../../platform/notifications/dispatchPush';
import {
  emitRouteExportStatusChanged,
  subscribeRouteExportEvents,
} from '../../../platform/notifications/routeExportEvents';
import {
  attachSseHeartbeat,
  getTenantSseConnectionLimiter,
  registerSseConnection,
  ackSseConnection,
  resolveLiveStreamCap,
} from '../../../platform/infra/rate-limit/sseConnectionLimiter';
import { randomUUID } from 'node:crypto';
import {
  ObjectStorageService,
  ObjectNotFoundError,
} from '../../replit_integrations/object_storage';
import {
  sendEmail,
  dispatchRouteExportReadyEmail,
  dispatchRouteExportFailedEmail,
} from '../../../platform/email';
import {
  geocodeAddressCached,
  getDriveEta,
  haversineMeters,
  type DriveEtaResult,
  type GeoPoint,
} from '../../../platform/integrations/routing';
import { createRateLimiter } from '../../../platform/infra/rate-limit/createRateLimiter';
import {
  DISPATCH_MERGE_TOKENS,
  countSmsSegments,
  findUnknownDispatchMergeTokens,
  renderDispatchTemplate,
} from '../../../shared/dispatch/mergeTokens';

const router = Router();
const logger = createLogger('ADMIN_DISPATCH');

// Maximum acceptable age (in seconds) of a technician's last GPS fix when
// computing the live ETA for an SMS notification. Anything older falls
// back to the friendlier "soon" placeholder rather than misleading the
// customer with a stale ETA.
const LIVE_ETA_MAX_FIX_AGE_SEC = 600;

// Build the absolute customer-facing booking-tracker URL for a job. The
// `tracking_token` (migration 088) is the only credential the public
// tracker endpoint accepts, so it must travel as part of the link we
// drop into outbound SMS bodies. We fall back through the same
// APP_URL → REPLIT_DEV_DOMAIN chain other outbound-link callers use so
// dev, preview, and prod all produce a tappable absolute URL.
function publicTrackerUrl(trackingToken: string): string {
  const base =
    process.env.APP_URL
    ?? (process.env.REPLIT_DEV_DOMAIN
      ? `https://${process.env.REPLIT_DEV_DOMAIN}`
      : 'http://localhost:5173');
  return `${base.replace(/\/+$/, '')}/track/${trackingToken}`;
}

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

    // Customers tap the {{tracking_url}} link in their SMS to reach the
    // public booking-tracker page. The token comes straight off the job
    // row (`SELECT d.*` above), so every job written since migration 088
    // already has one. If the column is somehow missing the substitution
    // collapses to an empty string rather than leaving a raw `{{...}}`
    // placeholder visible to the customer.
    const trackingToken =
      typeof job.tracking_token === 'string' && job.tracking_token.length > 0
        ? (job.tracking_token as string)
        : null;
    const trackingUrl = trackingToken ? publicTrackerUrl(trackingToken) : '';

    // The substitution map is keyed off DISPATCH_MERGE_TOKENS so this
    // renderer and the editor's "unknown token" warning can never
    // drift. Adding a token requires touching `shared/dispatch/mergeTokens.ts`,
    // which immediately surfaces missing handlers via the typed Record below.
    const tokenValues: Record<typeof DISPATCH_MERGE_TOKENS[number], string> = {
      job_title: (job.title as string) || '',
      contact_name: (job.contact_name as string) || '',
      eta: job.eta_start ? new Date(job.eta_start as string).toLocaleString() : 'TBD',
      eta_drive_minutes: liveEtaMinutes,
      eta_arrival_time: liveEtaArrival,
      resource_name: (job.resource_name as string) || '',
      status: (job.status as string) || '',
      address: (job.address as string) || '',
      tracking_url: trackingUrl,
    };
    const substitute = (raw: string): string => {
      let out = raw;
      for (const token of DISPATCH_MERGE_TOKENS) {
        // Tolerate optional inner whitespace (`{{ token }}`) so the
        // editor's tolerant warning matcher and the renderer agree.
        const re = new RegExp(`\\{\\{\\s*${token}\\s*\\}\\}`, 'g');
        out = out.replace(re, tokenValues[token]);
      }
      return out;
    };

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

// Maximum acceptable closest-approach distance (in meters) between the
// technician's GPS breadcrumbs and the customer's geocoded address. If
// the closest ping is farther than this, we treat it as a strong signal
// the tech serviced the wrong house and auto-flag the job as a dispatch
// exception when it completes. The dispatch board badge color reads
// the same value via GET /dispatch/settings so the passive UI signal
// and the active exception fire on identical math.
//
// This is only the platform-wide default; the live value is per-tenant
// (`tenants.dispatch_bad_arrival_threshold_m`, migration 091) so a
// rural HVAC company can loosen it for multi-acre lots and an urban
// locksmith can tighten it. Reads route through
// {@link readDispatchBadArrivalThresholdM} so the server can survive
// a transient threshold-lookup failure without skipping the flag.
const CLOSEST_APPROACH_BAD_M_DEFAULT = 250;

// CHECK constraint range from migration 091. Mirrored here so the
// settings endpoint rejects out-of-range writes with a 400 instead of
// bubbling a Postgres constraint error to the client.
const DISPATCH_BAD_ARRIVAL_THRESHOLD_M_MIN = 10;
const DISPATCH_BAD_ARRIVAL_THRESHOLD_M_MAX = 5000;

// Default per-tenant "tech has been driving too long" threshold (in
// minutes). Surfaced inline on each en_route board card next to the
// live customer ETA so dispatchers can spot stuck or stalled trucks
// at a glance — the duration badge stays grey below this value, flips
// amber once it crosses, and turns red once it doubles. Matches the
// column default in migration 092 (long-en-route).
const LONG_EN_ROUTE_THRESHOLD_MIN_DEFAULT = 30;

// CHECK constraint range from migration 092 (long-en-route). Mirrored
// here so the settings endpoint rejects out-of-range writes with a
// 400 instead of bubbling a Postgres constraint error to the client.
const DISPATCH_LONG_EN_ROUTE_THRESHOLD_MIN_MIN = 5;
const DISPATCH_LONG_EN_ROUTE_THRESHOLD_MIN_MAX = 480;

// CHECK constraint range from migration 092 (sms-segment-limit). The
// dispatch SMS segment cap is opt-in (NULL means "unlimited" — the
// historical behavior), and when set must be a positive integer up
// to the editor's offered max of 10. Carriers stop concatenating
// long messages well before then, so anything higher would be
// effectively no cap at all.
const DISPATCH_SMS_SEGMENT_LIMIT_MIN = 1;
const DISPATCH_SMS_SEGMENT_LIMIT_MAX = 10;

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

    // `closest_approach_m` powers the inline "X m from address" badge on
    // the dispatch board so supervisors can spot jobs that probably never
    // reached the right house at a glance — the same number the route
    // replay tab surfaces, but without forcing a click into the modal.
    //
    // Computed in SQL with the haversine formula against the cached
    // address geocode (populated by the route replay / live-map paths)
    // and the per-job breadcrumb ring. The LATERAL only does work for
    // jobs with both a cached geocode and at least one ping; otherwise
    // it returns NULL and the UI hides the badge.
    const { rows } = await pool.query(
      `SELECT d.*, u.email AS assignee_email,
              r.name AS resource_name,
              t.name AS territory_name,
              ca.closest_approach_m,
              CASE WHEN d.status = 'en_route' THEN (
                SELECT MAX(e.created_at)
                  FROM dispatch_job_events e
                 WHERE e.tenant_id = d.tenant_id
                   AND e.job_id = d.id
                   AND e.to_status = 'en_route'
              ) ELSE NULL END AS en_route_since,
              COUNT(*) OVER() AS _total_count
       FROM dispatch_jobs d
       LEFT JOIN users u ON u.id = d.assignee_user_id
       LEFT JOIN dispatch_resources r ON r.id = d.resource_id AND r.tenant_id = d.tenant_id
       LEFT JOIN dispatch_territories t ON t.id = d.territory_id AND t.tenant_id = d.tenant_id
       LEFT JOIN LATERAL (
         SELECT MIN(
           6371000 * 2 * ASIN(
             SQRT(LEAST(1.0,
               POWER(SIN(RADIANS((h.latitude - d.address_lat::float8) / 2)), 2)
               + COS(RADIANS(d.address_lat::float8)) * COS(RADIANS(h.latitude))
                 * POWER(SIN(RADIANS((h.longitude - d.address_lon::float8) / 2)), 2)
             ))
           )
         ) AS closest_approach_m
         FROM dispatch_resource_location_history h
         WHERE h.tenant_id = d.tenant_id
           AND h.active_job_id = d.id
           AND d.address_lat IS NOT NULL
           AND d.address_lon IS NOT NULL
       ) ca ON TRUE
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
      for (const r of rows) {
        delete (r as Record<string, unknown>)._total_count;
        // Pg returns DOUBLE PRECISION as a JS number already, but the
        // outer aggregate of an empty group is NULL. Normalize so the
        // client can treat it as `number | null` without coercion.
        const ca = (r as Record<string, unknown>).closest_approach_m;
        (r as Record<string, unknown>).closest_approach_m =
          ca == null ? null : Number(ca);
      }
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
              t.name AS territory_name,
              CASE WHEN d.status = 'en_route' THEN (
                SELECT MAX(e.created_at)
                  FROM dispatch_job_events e
                 WHERE e.tenant_id = d.tenant_id
                   AND e.job_id = d.id
                   AND e.to_status = 'en_route'
              ) ELSE NULL END AS en_route_since
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
    // Surface the `auto_flagged` tag that `flagBadArrivalIfNeeded` writes
    // onto the matching `exception_reported` event so dispatchers can tell
    // at a glance which exceptions came from the system vs. a human report.
    // The metadata lives on the event row (which carries `exception_id` →
    // this row); a correlated subquery is fine here — there is at most one
    // event per exception and the lookup is bounded by the per-job index.
    const { rows: exceptions } = await pool.query(
      `SELECT ex.*,
              (
                SELECT ev.metadata->>'auto_flagged'
                  FROM dispatch_job_events ev
                 WHERE ev.tenant_id = ex.tenant_id
                   AND ev.job_id = ex.job_id
                   AND ev.event_type = 'exception_reported'
                   AND ev.metadata->>'exception_id' = ex.id
                 LIMIT 1
              ) AS auto_flagged
         FROM dispatch_job_exceptions ex
        WHERE ex.job_id = $1 AND ex.tenant_id = $2
        ORDER BY ex.created_at DESC`,
      [id, tenantId],
    );
    const { rows: attachments } = await pool.query(
      `SELECT * FROM dispatch_job_attachments WHERE job_id = $1 AND tenant_id = $2 ORDER BY created_at DESC`,
      [id, tenantId],
    );

    // Live customer-facing ETA, surfaced here so dispatchers see the
    // same "~12 min away — arriving at 3:42 PM" string that the Live
    // Map popup, the SMS substitution, and the public booking-tracker
    // page all show. Computed only when the truck is actually rolling
    // (en_route) and the tech has both an assigned resource and a
    // geocodable address. The shared routing-adapter cache means
    // opening the panel does not trigger an extra geocode / drive-time
    // lookup per dispatcher view as long as the Live Map (or any
    // other surface) has computed it recently.
    const jobRow = rows[0] as Record<string, unknown>;
    let liveEta: { minutes: number; arrival_at: string } | null = null;
    const status = String(jobRow.status ?? '');
    const resourceId = (jobRow.resource_id as string | null) ?? null;
    const address = String(jobRow.address ?? '').trim();
    if (status === 'en_route' && resourceId && address) {
      const eta = await computeLiveEtaForJob(pool, tenantId, id, resourceId, address);
      if (eta) {
        liveEta = {
          minutes: eta.minutes,
          arrival_at: eta.arrivalDate.toISOString(),
        };
      }
    }

    return res.json({ job: jobRow, events, exceptions, attachments, live_eta: liveEta });
  } catch (err) {
    logger.error('Failed to get dispatch job', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to get job' });
  }
};

// Lightweight companion to `getJobHandler` for the dispatcher's
// job-detail panel. The panel polls every 15 seconds while a job is
// `en_route` just to keep the live customer ETA fresh — it does not
// need a full re-fetch of the job, events, exceptions, attachments,
// and joined resource/territory rows on each tick. This handler reads
// only the columns required to drive `computeLiveEtaForJob` (status,
// resource_id, address) plus the row-existence check, then reuses the
// same shared routing-adapter cache as the full handler so opening
// the panel does not trigger an extra geocode / drive-time provider
// call when the Live Map (or any other surface) has already computed
// the same job's ETA in the same window.
//
// Response shape mirrors the `live_eta` + `status` fields the full
// handler returns so the client can patch them in place without
// touching the rest of the panel state.
export const getJobLiveEtaHandler: RequestHandler = async (req, res) => {
  const { tenantId } = req.user!;
  const { id } = req.params;
  const pool = getPlatformPool();

  try {
    // Pull the row plus the most-recent `to_status='en_route'` event
    // timestamp. The latter powers the inline "driving X min" badge
    // on the en_route board card so dispatchers can spot trucks
    // that have been rolling far longer than the live ETA suggests
    // (e.g. ETA still 12 min, but already driving 45 min). Returned
    // null for non-en_route jobs and for jobs that somehow lack a
    // status_change event.
    const { rows } = await pool.query(
      `SELECT d.status, d.resource_id, d.address,
              CASE WHEN d.status = 'en_route' THEN (
                SELECT MAX(e.created_at)
                  FROM dispatch_job_events e
                 WHERE e.tenant_id = d.tenant_id
                   AND e.job_id = d.id
                   AND e.to_status = 'en_route'
              ) ELSE NULL END AS en_route_since
         FROM dispatch_jobs d
        WHERE d.id = $1 AND d.tenant_id = $2`,
      [id, tenantId],
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Job not found' });
    }

    const row = rows[0] as Record<string, unknown>;
    const status = String(row.status ?? '');
    const resourceId = (row.resource_id as string | null) ?? null;
    const address = String(row.address ?? '').trim();
    const enRouteSinceRaw = row.en_route_since;
    const enRouteSince =
      enRouteSinceRaw instanceof Date
        ? enRouteSinceRaw.toISOString()
        : enRouteSinceRaw == null
          ? null
          : String(enRouteSinceRaw);

    let liveEta: { minutes: number; arrival_at: string } | null = null;
    if (status === 'en_route' && resourceId && address) {
      const eta = await computeLiveEtaForJob(pool, tenantId, id, resourceId, address);
      if (eta) {
        liveEta = {
          minutes: eta.minutes,
          arrival_at: eta.arrivalDate.toISOString(),
        };
      }
    }

    return res.json({ live_eta: liveEta, status, en_route_since: enRouteSince });
  } catch (err) {
    logger.error('Failed to get dispatch job live ETA', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to get live ETA' });
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

/**
 * Read the current per-tenant "bad arrival" threshold (in meters). Falls
 * back to {@link CLOSEST_APPROACH_BAD_M_DEFAULT} when the tenant row is
 * missing, the column is NULL, or the value is non-numeric — the goal is
 * never to silently skip the auto-flag because the settings lookup
 * hiccupped. Out-of-range values are pinned by the column's CHECK
 * constraint, so we don't re-validate here.
 */
async function readDispatchBadArrivalThresholdM(
  pool: ReturnType<typeof getPlatformPool>,
  tenantId: string,
): Promise<number> {
  try {
    const { rows } = await pool.query(
      `SELECT dispatch_bad_arrival_threshold_m AS m
         FROM tenants WHERE id = $1 LIMIT 1`,
      [tenantId],
    );
    const raw = rows[0]?.m;
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) return CLOSEST_APPROACH_BAD_M_DEFAULT;
    return n;
  } catch (err) {
    logger.warn('Failed to read tenants.dispatch_bad_arrival_threshold_m, using default', {
      tenantId, error: String(err),
    });
    return CLOSEST_APPROACH_BAD_M_DEFAULT;
  }
}

/**
 * Read the per-tenant "tech has been driving too long" threshold (in
 * minutes). Falls back to {@link LONG_EN_ROUTE_THRESHOLD_MIN_DEFAULT}
 * when the tenant row is missing, the column is NULL, or the value is
 * non-numeric — we'd rather color the inline duration badge against
 * the platform default than silently leave dispatchers without a
 * visual signal. Out-of-range values are pinned by the column's CHECK
 * constraint, so we don't re-validate here.
 */
async function readDispatchLongEnRouteThresholdMinutes(
  pool: ReturnType<typeof getPlatformPool>,
  tenantId: string,
): Promise<number> {
  try {
    const { rows } = await pool.query(
      `SELECT dispatch_long_en_route_threshold_minutes AS m
         FROM tenants WHERE id = $1 LIMIT 1`,
      [tenantId],
    );
    const raw = rows[0]?.m;
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) return LONG_EN_ROUTE_THRESHOLD_MIN_DEFAULT;
    return n;
  } catch (err) {
    logger.warn('Failed to read tenants.dispatch_long_en_route_threshold_minutes, using default', {
      tenantId, error: String(err),
    });
    return LONG_EN_ROUTE_THRESHOLD_MIN_DEFAULT;
  }
}

/**
 * Read the per-tenant SMS segment cap for dispatch notification
 * templates. Returns `null` when the tenant has not opted in
 * (column NULL) — that's "unlimited", which preserves the historical
 * behavior so adding the column doesn't retroactively break templates
 * already in production.
 *
 * On a transient lookup failure we also return `null` rather than a
 * default cap: the worst case for "unlimited" is unchanged behavior,
 * whereas defaulting to a low cap on read-error would silently start
 * rejecting valid template saves.
 */
async function readDispatchSmsSegmentLimit(
  pool: ReturnType<typeof getPlatformPool>,
  tenantId: string,
): Promise<number | null> {
  try {
    const { rows } = await pool.query(
      `SELECT dispatch_sms_segment_limit AS n
         FROM tenants WHERE id = $1 LIMIT 1`,
      [tenantId],
    );
    const raw = rows[0]?.n;
    if (raw === null || raw === undefined) return null;
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) return null;
    return Math.floor(n);
  } catch (err) {
    logger.warn('Failed to read tenants.dispatch_sms_segment_limit, treating as unlimited', {
      tenantId, error: String(err),
    });
    return null;
  }
}

/**
 * Compute the closest distance (in meters) the technician's GPS breadcrumbs
 * came to the geocoded customer address for a single job, then — if it
 * exceeds the tenant's configured "bad arrival" threshold — auto-create a
 * dispatch exception of type `other` and fire the existing 'exception'
 * notification path so dispatchers see it on the exception feed before the
 * customer disputes the visit.
 *
 * The haversine SQL mirrors the LATERAL used by `listJobsHandler`, so the
 * passive "X m from address" badge on the board and this active flag fire
 * on identical math. Returns NULL when the job has no cached geocode or no
 * breadcrumbs (the LATERAL aggregate of an empty group is NULL), in which
 * case we skip silently — there's no signal to act on.
 *
 * The threshold is per-tenant (`tenants.dispatch_bad_arrival_threshold_m`,
 * migration 091) so different operations (rural HVAC vs. urban locksmith)
 * can tune it without a code change. The same value is exposed to the
 * client via GET /dispatch/settings for the inline board badge color.
 *
 * Idempotency is the caller's job: only invoke when transitioning into a
 * completion status from a non-completion status, so a `completed → done`
 * follow-up doesn't double-flag.
 *
 * Errors are logged and swallowed; this never blocks the underlying
 * status-change response.
 */
async function flagBadArrivalIfNeeded(
  pool: ReturnType<typeof getPlatformPool>,
  tenantId: string,
  jobId: string,
  performedBy: string | null,
): Promise<void> {
  try {
    // Single round-trip pulls both the tenant threshold and the
    // closest-approach distance. The threshold lookup is wrapped in a
    // COALESCE so a tenant row missing the column (e.g. mid-rollout)
    // still gets the platform default rather than silently no-flagging.
    const { rows } = await pool.query(
      `SELECT
         COALESCE(
           (SELECT dispatch_bad_arrival_threshold_m FROM tenants WHERE id = $2),
           $3::int
         ) AS threshold_m,
         (
           SELECT MIN(
             6371000 * 2 * ASIN(
               SQRT(LEAST(1.0,
                 POWER(SIN(RADIANS((h.latitude - d.address_lat::float8) / 2)), 2)
                 + COS(RADIANS(d.address_lat::float8)) * COS(RADIANS(h.latitude))
                   * POWER(SIN(RADIANS((h.longitude - d.address_lon::float8) / 2)), 2)
               ))
             )
           )
           FROM dispatch_resource_location_history h
           WHERE h.tenant_id = d.tenant_id
             AND h.active_job_id = d.id
         ) AS closest_approach_m
       FROM dispatch_jobs d
       WHERE d.id = $1
         AND d.tenant_id = $2
         AND d.address_lat IS NOT NULL
         AND d.address_lon IS NOT NULL`,
      [jobId, tenantId, CLOSEST_APPROACH_BAD_M_DEFAULT],
    );

    const raw = rows[0]?.closest_approach_m;
    // No row → no geocode (the WHERE filter dropped it). NULL → no
    // breadcrumbs landed against this job. Either way: no signal, skip.
    if (raw == null) return;

    const meters = Number(raw);
    if (!Number.isFinite(meters)) return;

    const thresholdRaw = rows[0]?.threshold_m;
    const threshold = Number.isFinite(Number(thresholdRaw))
      ? Number(thresholdRaw)
      : CLOSEST_APPROACH_BAD_M_DEFAULT;

    if (meters <= threshold) return;

    const rounded = Math.round(meters);
    const reason =
      `Auto-flagged: closest GPS ping was ${rounded} m from the customer address `
      + `(threshold ${threshold} m). The technician may have serviced the wrong location.`;

    const { rows: ex } = await pool.query(
      `INSERT INTO dispatch_job_exceptions
         (job_id, tenant_id, exception_type, reason, resolution, reported_by)
       VALUES ($1, $2, 'other', $3, '', $4)
       RETURNING id`,
      [jobId, tenantId, reason, performedBy],
    );

    await pool.query(
      `INSERT INTO dispatch_job_events
         (job_id, tenant_id, event_type, performed_by, notes, metadata)
       VALUES ($1, $2, 'exception_reported', $3, $4, $5)`,
      [
        jobId,
        tenantId,
        performedBy,
        `Auto-flagged on completion: ${rounded} m from address`,
        JSON.stringify({
          exception_id: ex[0]?.id,
          exception_type: 'other',
          auto_flagged: 'bad_arrival',
          closest_approach_m: meters,
          threshold_m: threshold,
        }),
      ],
    );

    fireNotifications(pool, tenantId, jobId, 'exception');
  } catch (err) {
    // Best-effort: a failure here must never break the status transition.
    logger.warn('Failed to evaluate bad-arrival flag on completion', {
      tenantId, jobId, error: String(err),
    });
  }
}

// ============ DISPATCH SETTINGS ============

/**
 * Returns the tenant-tunable dispatch settings. Today this is just the
 * "bad arrival" threshold (meters) used by both the auto-flag in
 * {@link flagBadArrivalIfNeeded} and the client-side board badge color
 * in `client-app/src/pages/Dispatch.tsx`. Defined as an object so we
 * can grow the surface without churning the URL.
 */
export const getDispatchSettingsHandler: RequestHandler = async (req, res) => {
  const { tenantId } = req.user!;
  const pool = getPlatformPool();
  try {
    const [m, longEnRouteMin, smsLimit] = await Promise.all([
      readDispatchBadArrivalThresholdM(pool, tenantId),
      readDispatchLongEnRouteThresholdMinutes(pool, tenantId),
      readDispatchSmsSegmentLimit(pool, tenantId),
    ]);
    return res.json({
      settings: {
        bad_arrival_threshold_m: m,
        bad_arrival_threshold_m_min: DISPATCH_BAD_ARRIVAL_THRESHOLD_M_MIN,
        bad_arrival_threshold_m_max: DISPATCH_BAD_ARRIVAL_THRESHOLD_M_MAX,
        bad_arrival_threshold_m_default: CLOSEST_APPROACH_BAD_M_DEFAULT,
        long_en_route_threshold_minutes: longEnRouteMin,
        long_en_route_threshold_minutes_min: DISPATCH_LONG_EN_ROUTE_THRESHOLD_MIN_MIN,
        long_en_route_threshold_minutes_max: DISPATCH_LONG_EN_ROUTE_THRESHOLD_MIN_MAX,
        long_en_route_threshold_minutes_default: LONG_EN_ROUTE_THRESHOLD_MIN_DEFAULT,
        sms_segment_limit: smsLimit,
        sms_segment_limit_min: DISPATCH_SMS_SEGMENT_LIMIT_MIN,
        sms_segment_limit_max: DISPATCH_SMS_SEGMENT_LIMIT_MAX,
      },
    });
  } catch (err) {
    logger.error('Failed to load dispatch settings', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to load dispatch settings' });
  }
};

/**
 * Updates the tenant-tunable dispatch settings. Validates the
 * threshold against the same range the column's CHECK constraint
 * enforces so the client gets a clean 400 instead of a Postgres
 * error. Returns the persisted value so the client can sync without
 * a follow-up GET.
 */
export const updateDispatchSettingsHandler: RequestHandler = async (req, res) => {
  const { tenantId } = req.user!;
  const body = (req.body ?? {}) as Record<string, unknown>;
  const pool = getPlatformPool();

  const updates: string[] = [];
  const values: unknown[] = [tenantId];

  if (body.bad_arrival_threshold_m !== undefined) {
    const n = Number(body.bad_arrival_threshold_m);
    if (
      !Number.isFinite(n)
      || !Number.isInteger(n)
      || n < DISPATCH_BAD_ARRIVAL_THRESHOLD_M_MIN
      || n > DISPATCH_BAD_ARRIVAL_THRESHOLD_M_MAX
    ) {
      return res.status(400).json({
        error: `bad_arrival_threshold_m must be an integer between ${DISPATCH_BAD_ARRIVAL_THRESHOLD_M_MIN} and ${DISPATCH_BAD_ARRIVAL_THRESHOLD_M_MAX} (meters)`,
      });
    }
    values.push(n);
    updates.push(`dispatch_bad_arrival_threshold_m = $${values.length}`);
  }

  if (body.long_en_route_threshold_minutes !== undefined) {
    const n = Number(body.long_en_route_threshold_minutes);
    if (
      !Number.isFinite(n)
      || !Number.isInteger(n)
      || n < DISPATCH_LONG_EN_ROUTE_THRESHOLD_MIN_MIN
      || n > DISPATCH_LONG_EN_ROUTE_THRESHOLD_MIN_MAX
    ) {
      return res.status(400).json({
        error: `long_en_route_threshold_minutes must be an integer between ${DISPATCH_LONG_EN_ROUTE_THRESHOLD_MIN_MIN} and ${DISPATCH_LONG_EN_ROUTE_THRESHOLD_MIN_MAX} (minutes)`,
      });
    }
    values.push(n);
    updates.push(`dispatch_long_en_route_threshold_minutes = $${values.length}`);
  }

  if (body.sms_segment_limit !== undefined) {
    // `null` is the explicit way to opt back out of the cap (returns
    // the tenant to "unlimited" without touching the other settings).
    // Any other value must be a positive integer in range.
    const raw = body.sms_segment_limit;
    if (raw === null) {
      values.push(null);
      updates.push(`dispatch_sms_segment_limit = $${values.length}`);
    } else {
      const n = Number(raw);
      if (
        !Number.isFinite(n)
        || !Number.isInteger(n)
        || n < DISPATCH_SMS_SEGMENT_LIMIT_MIN
        || n > DISPATCH_SMS_SEGMENT_LIMIT_MAX
      ) {
        return res.status(400).json({
          error: `sms_segment_limit must be null or an integer between ${DISPATCH_SMS_SEGMENT_LIMIT_MIN} and ${DISPATCH_SMS_SEGMENT_LIMIT_MAX}`,
        });
      }
      values.push(n);
      updates.push(`dispatch_sms_segment_limit = $${values.length}`);
    }
  }

  if (updates.length === 0) {
    return res.status(400).json({ error: 'No supported settings provided' });
  }

  try {
    await pool.query(
      `UPDATE tenants SET ${updates.join(', ')}, updated_at = NOW() WHERE id = $1`,
      values,
    );
    const [m, longEnRouteMin, smsLimit] = await Promise.all([
      readDispatchBadArrivalThresholdM(pool, tenantId),
      readDispatchLongEnRouteThresholdMinutes(pool, tenantId),
      readDispatchSmsSegmentLimit(pool, tenantId),
    ]);
    return res.json({
      settings: {
        bad_arrival_threshold_m: m,
        bad_arrival_threshold_m_min: DISPATCH_BAD_ARRIVAL_THRESHOLD_M_MIN,
        bad_arrival_threshold_m_max: DISPATCH_BAD_ARRIVAL_THRESHOLD_M_MAX,
        bad_arrival_threshold_m_default: CLOSEST_APPROACH_BAD_M_DEFAULT,
        long_en_route_threshold_minutes: longEnRouteMin,
        long_en_route_threshold_minutes_min: DISPATCH_LONG_EN_ROUTE_THRESHOLD_MIN_MIN,
        long_en_route_threshold_minutes_max: DISPATCH_LONG_EN_ROUTE_THRESHOLD_MIN_MAX,
        long_en_route_threshold_minutes_default: LONG_EN_ROUTE_THRESHOLD_MIN_DEFAULT,
        sms_segment_limit: smsLimit,
        sms_segment_limit_min: DISPATCH_SMS_SEGMENT_LIMIT_MIN,
        sms_segment_limit_max: DISPATCH_SMS_SEGMENT_LIMIT_MAX,
      },
    });
  } catch (err) {
    logger.error('Failed to update dispatch settings', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to update dispatch settings' });
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

    // When a job first reaches a completion status, promote the passive
    // "X m from address" board badge into an active dispatch exception so
    // a supervisor reviews bad-arrival jobs before the customer disputes
    // them. Gated on `currentStatus` not already being a completion to
    // avoid double-flagging on the `completed → done` follow-up. Runs as
    // fire-and-forget so it never blocks the transition response — same
    // pattern as `fireNotifications` / `pushAssigneeForJob` above.
    if (
      (status === 'completed' || status === 'done')
      && currentStatus !== 'completed'
      && currentStatus !== 'done'
    ) {
      void flagBadArrivalIfNeeded(pool, tenantId, id, userId);
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

      // Mirror the bad-arrival auto-flag from `transitionJobHandler` for
      // batch closeouts: every job that is *newly* entering a completion
      // status gets the same closest-approach check, so a dispatcher who
      // sweeps a queue closed can still see wrong-house visits. The
      // `currentStatus !== completed/done` gate prevents re-flagging on
      // a `completed → done` batch follow-up.
      if (status === 'completed' || status === 'done') {
        for (const j of currentJobs) {
          const prev = j.status as string;
          if (prev !== 'completed' && prev !== 'done') {
            void flagBadArrivalIfNeeded(pool, tenantId, j.id as string, userId);
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

        // Mirror the bad-arrival auto-flag from `transitionJobHandler`: when
        // a tech finishes via the mobile "complete with photos" flow, run
        // the same closest-approach check so wrong-house visits surface as
        // an exception regardless of which path closed the job. Gated on
        // `isCompleting` to skip the `completed → done` follow-up.
        if (isCompleting) {
          void flagBadArrivalIfNeeded(pool, tenantId, id, userId);
        }
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
    // `ca.closest_approach_m` is the same haversine-vs-cached-geocode
    // calculation the dispatch board / queue surface on each job card —
    // we recompute it here so the live map popup can flag "tech is
    // standing 400 m from the address" without forcing a click into the
    // route replay tab. The LATERAL only does work when the job has a
    // cached geocode AND at least one breadcrumb ping; otherwise it
    // returns NULL and the UI hides the badge.
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
              ca.closest_approach_m,
              EXTRACT(EPOCH FROM (NOW() - l.received_at))::int AS age_seconds
         FROM dispatch_resource_locations l
         JOIN dispatch_resources r
           ON r.id = l.resource_id AND r.tenant_id = l.tenant_id
         JOIN dispatch_jobs j
           ON j.id = l.active_job_id AND j.tenant_id = l.tenant_id
         LEFT JOIN LATERAL (
           SELECT MIN(
             6371000 * 2 * ASIN(
               SQRT(LEAST(1.0,
                 POWER(SIN(RADIANS((h.latitude - j.address_lat::float8) / 2)), 2)
                 + COS(RADIANS(j.address_lat::float8)) * COS(RADIANS(h.latitude))
                   * POWER(SIN(RADIANS((h.longitude - j.address_lon::float8) / 2)), 2)
               ))
             )
           ) AS closest_approach_m
           FROM dispatch_resource_location_history h
           WHERE h.tenant_id = j.tenant_id
             AND h.active_job_id = j.id
             AND j.address_lat IS NOT NULL
             AND j.address_lon IS NOT NULL
         ) ca ON TRUE
        WHERE l.tenant_id = $1
          AND l.active_job_id IS NOT NULL
          AND NOT (j.status = ANY($3::text[]))
          AND l.received_at > NOW() - ($2::int * INTERVAL '1 second')
        ORDER BY l.received_at DESC`,
      [tenantId, staleness, terminalArr],
    );

    // Pg returns DOUBLE PRECISION as a JS number already, but the outer
    // aggregate of an empty group comes back as NULL. Normalize so the
    // client can treat it as `number | null` without coercion.
    for (const r of rows) {
      const ca = (r as Record<string, unknown>).closest_approach_m;
      (r as Record<string, unknown>).closest_approach_m =
        ca == null ? null : Number(ca);
    }

    const enriched = await enrichLocationsWithEta(pool, tenantId, rows);
    return res.json({ locations: enriched, staleness_seconds: staleness });
  } catch (err) {
    logger.error('Failed to list resource locations', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to list resource locations' });
  }
};

// ---- Route export helpers (shared by per-job and bulk handlers) ----
//
// Both the single-job download (GET /dispatch/jobs/:id/route?format=…) and
// the bulk download (POST /dispatch/jobs/routes/export) need to render the
// same per-job GPX/CSV body and use the same `route-<jobId>-YYYY-MM-DD`
// filename pattern so files end up recognisable side-by-side in the zip
// archive or on the dispatcher's filesystem.

interface RoutePoint {
  lat: number;
  lng: number;
  accuracy_m: number | null;
  heading_deg: number | null;
  speed_mps: number | null;
  recorded_at: string | null;
  received_at: string | null;
}

function mapRoutePoint(row: Record<string, unknown>): RoutePoint {
  return {
    lat: Number(row.latitude),
    lng: Number(row.longitude),
    accuracy_m: row.accuracy_m === null || row.accuracy_m === undefined ? null : Number(row.accuracy_m),
    heading_deg: row.heading_deg === null || row.heading_deg === undefined ? null : Number(row.heading_deg),
    speed_mps: row.speed_mps === null || row.speed_mps === undefined ? null : Number(row.speed_mps),
    recorded_at: row.recorded_at ? new Date(row.recorded_at as string | Date).toISOString() : null,
    received_at: row.received_at ? new Date(row.received_at as string | Date).toISOString() : null,
  };
}

function buildRouteCsv(points: RoutePoint[]): string {
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
  return [header, ...lines].join('\n') + '\n';
}

function xmlEscape(s: string): string {
  return s.replace(/[<>&'"]/g, (c) =>
    c === '<' ? '&lt;'
      : c === '>' ? '&gt;'
      : c === '&' ? '&amp;'
      : c === "'" ? '&apos;'
      : '&quot;',
  );
}

function buildRouteGpx(jobId: string, jobTitle: string | null, points: RoutePoint[]): string {
  // GPX 1.1 — one <trk> with one <trkseg>. Each <trkpt> carries the ISO
  // timestamp; speed (m/s) and heading (degrees) ride along via the
  // standard Garmin TrackPointExtension v1 namespace so insurance and
  // accident-reconstruction tools see the same evidence as the in-app
  // replay.
  const trackName = xmlEscape(`Job ${jobId}${jobTitle ? ` — ${jobTitle}` : ''}`);
  const trkpts = points
    .map((p) => {
      const time = p.recorded_at ? `<time>${p.recorded_at}</time>` : '';
      const hasSpeed = p.speed_mps != null && Number.isFinite(Number(p.speed_mps));
      const hasHeading = p.heading_deg != null && Number.isFinite(Number(p.heading_deg));
      let extensions = '';
      if (hasSpeed || hasHeading) {
        const speedTag = hasSpeed
          ? `<gpxtpx:speed>${Number(p.speed_mps)}</gpxtpx:speed>`
          : '';
        const courseTag = hasHeading
          ? `<gpxtpx:course>${Number(p.heading_deg)}</gpxtpx:course>`
          : '';
        extensions =
          `<extensions>`
          + `<gpxtpx:TrackPointExtension>`
          + speedTag
          + courseTag
          + `</gpxtpx:TrackPointExtension>`
          + `</extensions>`;
      }
      return `      <trkpt lat="${p.lat}" lon="${p.lng}">${time}${extensions}</trkpt>`;
    })
    .join('\n');
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<gpx version="1.1" creator="Qvo Dispatch"`
    + ` xmlns="http://www.topografix.com/GPX/1/1"`
    + ` xmlns:gpxtpx="http://www.garmin.com/xmlschemas/TrackPointExtension/v1">\n` +
    `  <trk>\n` +
    `    <name>${trackName}</name>\n` +
    `    <trkseg>\n` +
    (trkpts ? trkpts + '\n' : '') +
    `    </trkseg>\n` +
    `  </trk>\n` +
    `</gpx>\n`
  );
}

function buildRouteKml(jobId: string, jobTitle: string | null, points: RoutePoint[]): string {
  // KML 2.2 — one <Placemark><LineString> for the styled track plus a
  // companion <Folder> of per-point <Placemark><Point> markers carrying
  // speed/heading/timestamps inside <ExtendedData>. Google Earth and
  // Google My Maps render the LineString as the visible route and surface
  // the per-point evidence on click, mirroring the GPX TrackPointExtension
  // payload so insurance adjusters and field-ops folks see the same data.
  const trackName = xmlEscape(`Job ${jobId}${jobTitle ? ` — ${jobTitle}` : ''}`);
  // KML coordinate tuples are lon,lat[,alt] — order matters; flipping
  // them silently mirrors the route across the equator/meridian.
  const coords = points.map((p) => `${p.lng},${p.lat},0`).join(' ');
  const lineString = points.length > 0
    ? `    <Placemark>\n`
      + `      <name>${trackName}</name>\n`
      + `      <styleUrl>#routeLine</styleUrl>\n`
      + `      <LineString>\n`
      + `        <tessellate>1</tessellate>\n`
      + `        <coordinates>${coords}</coordinates>\n`
      + `      </LineString>\n`
      + `    </Placemark>\n`
    : '';
  // Per-point markers only get emitted when the row carries at least one
  // piece of evidence beyond lat/lng (timestamp, speed, or heading).
  // Otherwise we'd flood Google Earth with anonymous pins that add no
  // forensic value over the LineString itself.
  const pointPlacemarks = points
    .map((p, idx) => {
      const hasSpeed = p.speed_mps != null && Number.isFinite(Number(p.speed_mps));
      const hasHeading = p.heading_deg != null && Number.isFinite(Number(p.heading_deg));
      const hasTime = !!p.recorded_at;
      if (!hasSpeed && !hasHeading && !hasTime) return '';
      const time = hasTime
        ? `        <TimeStamp><when>${p.recorded_at}</when></TimeStamp>\n`
        : '';
      const dataParts: string[] = [];
      if (hasSpeed) {
        dataParts.push(
          `          <Data name="speed_mps"><value>${Number(p.speed_mps)}</value></Data>`,
        );
      }
      if (hasHeading) {
        dataParts.push(
          `          <Data name="heading_deg"><value>${Number(p.heading_deg)}</value></Data>`,
        );
      }
      const extended = dataParts.length > 0
        ? `        <ExtendedData>\n${dataParts.join('\n')}\n        </ExtendedData>\n`
        : '';
      const seq = idx + 1;
      return `    <Placemark>\n`
        + `      <name>Point ${seq}</name>\n`
        + time
        + extended
        + `      <Point><coordinates>${p.lng},${p.lat},0</coordinates></Point>\n`
        + `    </Placemark>\n`;
    })
    .filter((s) => s.length > 0)
    .join('');
  const pointsFolder = pointPlacemarks
    ? `    <Folder>\n      <name>Breadcrumb points</name>\n${pointPlacemarks}    </Folder>\n`
    : '';
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n`
    + `<kml xmlns="http://www.opengis.net/kml/2.2">\n`
    + `  <Document>\n`
    + `    <name>${trackName}</name>\n`
    + `    <Style id="routeLine">\n`
    + `      <LineStyle>\n`
    + `        <color>ff0066ff</color>\n`
    + `        <width>4</width>\n`
    + `      </LineStyle>\n`
    + `    </Style>\n`
    + lineString
    + pointsFolder
    + `  </Document>\n`
    + `</kml>\n`
  );
}

function safeJobIdForFilename(jobId: string): string {
  return jobId.replace(/[^A-Za-z0-9_-]/g, '');
}

/**
 * Build the canonical per-job route filename used by both the single-job
 * download and the bulk archive entry. Date is the breadcrumb start when
 * available; otherwise we fall back through scheduled_at, completed_at,
 * and finally "today" so we never produce an `undefined` filename.
 */
function buildRouteFilename(
  jobId: string,
  format: 'gpx' | 'csv' | 'kml',
  windowStart: string | null,
  scheduledAt: string | Date | null | undefined,
  completedAt: string | Date | null | undefined,
): string {
  const filenameDateSource =
    windowStart
      || (scheduledAt ? new Date(scheduledAt as string | Date).toISOString() : null)
      || (completedAt ? new Date(completedAt as string | Date).toISOString() : null)
      || new Date().toISOString();
  const filenameDate = filenameDateSource.slice(0, 10);
  return `route-${safeJobIdForFilename(jobId)}-${filenameDate}.${format}`;
}

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

  // Optional `?format=gpx|csv|kml` turns the response into a downloadable
  // breadcrumb file (used by the dispatcher's "Route taken" tab for
  // disputes — handing the data to a customer, lawyer, or external
  // mapping tool without screenshots). KML opens directly in Google Earth
  // and Google My Maps. Default (no format) keeps the JSON shape that the
  // in-app map replay depends on.
  const formatRaw = typeof req.query.format === 'string' ? req.query.format.toLowerCase() : '';
  const exportFormat: 'gpx' | 'csv' | 'kml' | null =
    formatRaw === 'gpx'
      ? 'gpx'
      : formatRaw === 'csv'
        ? 'csv'
        : formatRaw === 'kml'
          ? 'kml'
          : null;

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

    const points = pointRows.map((p) => mapRoutePoint(p as Record<string, unknown>));

    const window = points.length > 0
      ? { start: points[0].recorded_at, end: points[points.length - 1].recorded_at }
      : { start: null, end: null };

    if (exportFormat) {
      const filename = buildRouteFilename(
        String(job.id),
        exportFormat,
        window.start,
        job.scheduled_at as string | Date | null | undefined,
        job.completed_at as string | Date | null | undefined,
      );
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

      if (exportFormat === 'csv') {
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        return res.send(buildRouteCsv(points));
      }

      if (exportFormat === 'kml') {
        // KML 2.2 — styled <LineString> for the route plus a folder of
        // per-point <Point> placemarks with speed/heading/timestamps in
        // <ExtendedData>. Opens directly in Google Earth and Google My
        // Maps (handled inside `buildRouteKml`).
        res.setHeader('Content-Type', 'application/vnd.google-earth.kml+xml; charset=utf-8');
        return res.send(
          buildRouteKml(
            String(job.id),
            job.title ? String(job.title) : null,
            points,
          ),
        );
      }

      // GPX 1.1 — one <trk> with one <trkseg>. Each <trkpt> carries the
      // ISO timestamp plus optional Garmin TrackPointExtension v1 tags
      // for speed/heading (handled inside `buildRouteGpx`).
      res.setHeader('Content-Type', 'application/gpx+xml; charset=utf-8');
      return res.send(
        buildRouteGpx(
          String(job.id),
          job.title ? String(job.title) : null,
          points,
        ),
      );
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

// Hard cap on the number of jobs a single bulk-route export request may
// pull. Keeps both the SQL fan-out and the in-memory ZIP build bounded
// even if a dispatcher casts a very wide filter net. The UI also surfaces
// this number when it's exceeded so the dispatcher can tighten filters.
const BULK_ROUTE_EXPORT_MAX_JOBS = 500;

// Async-mode cap. The async path runs the same archive build inside a
// background worker after returning a 202 to the dispatcher, so we can
// stomach a much larger batch — but we still bound it so a single
// quarterly insurance review can't pin a worker for hours, blow Node's
// heap on the manifest, or balloon into a multi-GB ZIP that exceeds
// SMTP-friendly download URLs. 5000 jobs ≈ ~10× the sync cap and lines
// up with the dispatcher persona's "every job last quarter" workflow.
const BULK_ROUTE_EXPORT_ASYNC_MAX_JOBS = 5000;

// How long the emailed download link stays valid. Long enough to
// weather a long weekend / out-of-office; short enough that stale
// links don't accumulate forever in mail clients. The worker stamps
// `download_expires_at = now() + this` once the archive is uploaded;
// the unauthenticated download endpoint hard-rejects clicks past it.
const ROUTE_EXPORT_DOWNLOAD_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// Filter columns we accept for the "no explicit selection" mode. Mirrors
// the subset of `listJobsHandler` filters that actually scope rows the
// dispatcher cares about for a route audit. Anything not listed here is
// silently ignored — never trust caller-supplied column names.
const BULK_ROUTE_EXPORT_ALLOWED_FILTERS = new Set([
  'status', 'priority', 'territory_id', 'resource_id', 'job_type', 'assignee_user_id',
]);

// Shape used by both the sync and async paths once a job set has been
// resolved against the DB. Keeping this typed (rather than passing
// untyped pg rows around) makes the archive-build helper trivially
// testable and prevents drift between the two callers.
interface ResolvedRouteJob {
  id: string;
  title: string | null;
  status: string | null;
  scheduled_at: string | Date | null;
  completed_at: string | Date | null;
  resource_name: string | null;
}

interface ResolveExportJobsInput {
  pool: ReturnType<typeof getPlatformPool>;
  tenantId: string;
  uniqueJobIds: string[];
  filters: Record<string, unknown>;
  search: string;
  dateFrom: string;
  dateTo: string;
  cap: number;
}

interface ResolveExportJobsResult {
  jobs: ResolvedRouteJob[];
  // When the filter mode matches more rows than `cap`, we surface the
  // "at least N" count to the caller so it can produce a friendly error
  // ("Filter matched more than 500 jobs ..."). null when within the cap.
  matchedAtLeast: number | null;
}

/**
 * Resolves the dispatcher's selection (explicit job_ids or filter
 * criteria) to the concrete `ResolvedRouteJob[]` we'll archive. Used by
 * both the sync handler (`bulkExportJobRoutesHandler`) and the async
 * worker (`processRouteExportJob`) so the two paths can never diverge
 * on which jobs end up in the export.
 *
 * Tenant scoping is enforced via the explicit `j.tenant_id = $1`
 * predicate (and again by the RLS policy on `dispatch_jobs`); we never
 * inject caller-supplied keys, only the predefined whitelist.
 */
async function resolveExportJobs(
  input: ResolveExportJobsInput,
): Promise<ResolveExportJobsResult> {
  const { pool, tenantId, uniqueJobIds, filters, search, dateFrom, dateTo, cap } = input;

  if (uniqueJobIds.length > 0) {
    const { rows } = await pool.query(
      `SELECT j.id, j.title, j.status, j.scheduled_at, j.completed_at,
              r.name AS resource_name
         FROM dispatch_jobs j
         LEFT JOIN dispatch_resources r ON r.id = j.resource_id AND r.tenant_id = j.tenant_id
        WHERE j.tenant_id = $1 AND j.id = ANY($2::uuid[])
        ORDER BY j.scheduled_at ASC NULLS LAST, j.created_at ASC`,
      [tenantId, uniqueJobIds],
    );
    return {
      jobs: rows.map((r) => ({
        id: String(r.id),
        title: (r.title as string | null) ?? null,
        status: (r.status as string | null) ?? null,
        scheduled_at: (r.scheduled_at as string | Date | null) ?? null,
        completed_at: (r.completed_at as string | Date | null) ?? null,
        resource_name: (r.resource_name as string | null) ?? null,
      })),
      matchedAtLeast: null,
    };
  }

  const conditions: string[] = ['j.tenant_id = $1'];
  const values: unknown[] = [tenantId];
  for (const key of BULK_ROUTE_EXPORT_ALLOWED_FILTERS) {
    const val = filters[key];
    if (val != null && String(val).length > 0) {
      values.push(val);
      conditions.push(`j.${key} = $${values.length}`);
    }
  }
  if (search) {
    values.push(`%${search}%`);
    conditions.push(
      `(j.title ILIKE $${values.length} OR j.description ILIKE $${values.length} OR j.contact_name ILIKE $${values.length})`,
    );
  }
  if (dateFrom) {
    values.push(dateFrom);
    conditions.push(`COALESCE(j.scheduled_at, j.created_at) >= $${values.length}::timestamptz`);
  }
  if (dateTo) {
    values.push(dateTo);
    conditions.push(`COALESCE(j.scheduled_at, j.created_at) <= $${values.length}::timestamptz`);
  }
  // Cap+1 lets the caller distinguish "exactly at cap" from "exceeded
  // cap" without a separate COUNT(*) round trip.
  values.push(cap + 1);
  const limitParam = `$${values.length}`;
  const { rows } = await pool.query(
    `SELECT j.id, j.title, j.status, j.scheduled_at, j.completed_at,
            r.name AS resource_name
       FROM dispatch_jobs j
       LEFT JOIN dispatch_resources r ON r.id = j.resource_id AND r.tenant_id = j.tenant_id
      WHERE ${conditions.join(' AND ')}
      ORDER BY j.scheduled_at ASC NULLS LAST, j.created_at ASC
      LIMIT ${limitParam}`,
    values,
  );
  if (rows.length > cap) {
    return { jobs: [], matchedAtLeast: rows.length };
  }
  return {
    jobs: rows.map((r) => ({
      id: String(r.id),
      title: (r.title as string | null) ?? null,
      status: (r.status as string | null) ?? null,
      scheduled_at: (r.scheduled_at as string | Date | null) ?? null,
      completed_at: (r.completed_at as string | Date | null) ?? null,
      resource_name: (r.resource_name as string | null) ?? null,
    })),
    matchedAtLeast: null,
  };
}

interface BuildRouteArchiveResult {
  buffer: Buffer;
  archiveFilename: string;
  jobCount: number;
  includedCount: number;
  skippedEmpty: number;
}

/**
 * Builds the in-memory ZIP archive (per-job route file in `format` plus
 * a `manifest.csv` index) for a resolved set of jobs. Hits the
 * breadcrumb table once for the whole batch so we don't fan out into
 * hundreds of N+1 queries while a dispatcher waits.
 *
 * Pure-ish: all I/O is the single breadcrumb SELECT against the pool;
 * no email/storage side effects. Both the sync handler and the async
 * worker call this so the two paths produce byte-identical archives.
 */
async function buildRouteArchive(input: {
  pool: ReturnType<typeof getPlatformPool>;
  tenantId: string;
  jobs: ResolvedRouteJob[];
  format: 'gpx' | 'csv';
  includeEmpty: boolean;
}): Promise<BuildRouteArchiveResult> {
  const { pool, tenantId, jobs, format, includeEmpty } = input;

  const jobIdList = jobs.map((j) => j.id);
  const { rows: pointRows } = await pool.query(
    `SELECT active_job_id, latitude, longitude, accuracy_m, heading_deg, speed_mps,
            recorded_at, received_at
       FROM dispatch_resource_location_history
      WHERE tenant_id = $1
        AND active_job_id = ANY($2::uuid[])
      ORDER BY active_job_id ASC, recorded_at ASC, id ASC`,
    [tenantId, jobIdList],
  );

  const pointsByJob = new Map<string, RoutePoint[]>();
  for (const row of pointRows) {
    const jid = String(row.active_job_id);
    const list = pointsByJob.get(jid) ?? [];
    list.push(mapRoutePoint(row as Record<string, unknown>));
    pointsByJob.set(jid, list);
  }

  const zip = new JSZip();

  type ManifestRow = {
    job_id: string;
    title: string;
    resource_name: string;
    status: string;
    scheduled_at: string;
    completed_at: string;
    points: number;
    window_start: string;
    window_end: string;
    file: string;
  };
  const manifest: ManifestRow[] = [];

  let includedCount = 0;
  let skippedEmpty = 0;
  const usedFilenames = new Set<string>();

  for (const job of jobs) {
    const points = pointsByJob.get(job.id) ?? [];
    const windowStart = points.length > 0 ? points[0].recorded_at : null;
    const windowEnd = points.length > 0 ? points[points.length - 1].recorded_at : null;

    if (points.length === 0 && !includeEmpty) {
      skippedEmpty++;
      manifest.push({
        job_id: job.id,
        title: job.title ?? '',
        resource_name: job.resource_name ?? '',
        status: job.status ?? '',
        scheduled_at: job.scheduled_at ? new Date(job.scheduled_at).toISOString() : '',
        completed_at: job.completed_at ? new Date(job.completed_at).toISOString() : '',
        points: 0,
        window_start: '',
        window_end: '',
        file: '',
      });
      continue;
    }

    // The canonical filename is collision-free across distinct job ids,
    // but if a dispatcher manually re-uses ids in the selection (or two
    // jobs share a date and the safe-id strip happens to collide) we
    // disambiguate with a numeric suffix so JSZip doesn't silently
    // overwrite an entry.
    let filename = buildRouteFilename(
      job.id, format, windowStart, job.scheduled_at, job.completed_at,
    );
    if (usedFilenames.has(filename)) {
      const dot = filename.lastIndexOf('.');
      const stem = dot === -1 ? filename : filename.slice(0, dot);
      const ext = dot === -1 ? '' : filename.slice(dot);
      let suffix = 2;
      while (usedFilenames.has(`${stem}-${suffix}${ext}`)) suffix++;
      filename = `${stem}-${suffix}${ext}`;
    }
    usedFilenames.add(filename);

    const body = format === 'csv'
      ? buildRouteCsv(points)
      : buildRouteGpx(job.id, job.title, points);
    zip.file(filename, body);
    includedCount++;

    manifest.push({
      job_id: job.id,
      title: job.title ?? '',
      resource_name: job.resource_name ?? '',
      status: job.status ?? '',
      scheduled_at: job.scheduled_at ? new Date(job.scheduled_at).toISOString() : '',
      completed_at: job.completed_at ? new Date(job.completed_at).toISOString() : '',
      points: points.length,
      window_start: windowStart ?? '',
      window_end: windowEnd ?? '',
      file: filename,
    });
  }

  // CSV-escape per RFC 4180: wrap in quotes when the value contains a
  // comma, quote, or newline; double up embedded quotes. Matches what
  // Excel and Google Sheets expect.
  const csvField = (raw: string): string => {
    if (/[",\n\r]/.test(raw)) return `"${raw.replace(/"/g, '""')}"`;
    return raw;
  };
  const manifestHeader = [
    'job_id', 'title', 'resource_name', 'status', 'scheduled_at',
    'completed_at', 'points', 'window_start', 'window_end', 'file',
  ];
  const manifestLines = manifest.map((m) =>
    manifestHeader.map((h) => csvField(String(m[h as keyof ManifestRow] ?? ''))).join(','),
  );
  zip.file('manifest.csv', [manifestHeader.join(','), ...manifestLines].join('\n') + '\n');

  const generatedAt = new Date().toISOString();
  const datePart = generatedAt.slice(0, 10);
  const archiveFilename = `dispatch-routes-${datePart}.zip`;

  const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });

  return {
    buffer,
    archiveFilename,
    jobCount: jobs.length,
    includedCount,
    skippedEmpty,
  };
}

/**
 * POST /dispatch/jobs/routes/export
 *
 * Bulk download of every dispatch job's GPS breadcrumb as a single
 * archive. Used for weekly insurance reviews, audits, and chargeback
 * batches where the dispatcher would otherwise open each job's "Route
 * taken" tab and click Download one at a time (Task #762 ⇒ #776).
 *
 * Two selection modes (the request must use exactly one):
 *
 *  1. Explicit `job_ids: string[]` — for the multi-select toolbar on the
 *     dispatch board. Tenant scoping is enforced when we re-fetch the
 *     jobs (jobs not owned by this tenant simply drop out of the result).
 *
 *  2. Filter mode (any combination of `status`, `priority`, `territory_id`,
 *     `resource_id`, `job_type`, `assignee_user_id`, `search`, plus a
 *     `date_from`/`date_to` range applied to `COALESCE(scheduled_at,
 *     created_at)`). Mirrors the dispatch board's active filters so the
 *     download produces the same set the dispatcher is currently looking
 *     at.
 *
 * Body:
 *   {
 *     job_ids?: string[],
 *     filters?: { status?, priority?, territory_id?, resource_id?,
 *                 job_type?, assignee_user_id?, search? },
 *     date_from?: string,   // ISO8601, applied to COALESCE(scheduled_at, created_at)
 *     date_to?: string,
 *     format?: 'gpx' | 'csv',  // default 'gpx'
 *     include_empty?: boolean   // default true — see note below
 *   }
 *
 * Empty-job policy: by default we *include* an empty file for jobs that
 * have no recorded pings so the file count matches the job count. That's
 * what auditors expect ("we know this job had no breadcrumb data"). Pass
 * `include_empty: false` to skip those jobs entirely. Either way the
 * archive's `manifest.csv` records every considered job, including the
 * point count, so dispatchers can see at a glance which jobs were empty.
 *
 * Filenames inside the archive use the same `route-<jobId>-YYYY-MM-DD`
 * pattern as the per-job download so files are recognisable side-by-side.
 */
export const bulkExportJobRoutesHandler: RequestHandler = async (req, res) => {
  const { tenantId } = req.user!;
  const pool = getPlatformPool();

  const body = (req.body ?? {}) as Record<string, unknown>;

  const formatRaw = typeof body.format === 'string' ? body.format.toLowerCase() : '';
  const exportFormat: 'gpx' | 'csv' =
    formatRaw === 'csv' ? 'csv' : formatRaw === 'gpx' ? 'gpx' : 'gpx';

  const includeEmpty = body.include_empty === false ? false : true;

  const rawJobIds = Array.isArray(body.job_ids) ? body.job_ids : [];
  const jobIdsInput: string[] = rawJobIds
    .filter((v): v is string => typeof v === 'string')
    .map((v) => v.trim())
    .filter((v) => v.length > 0);
  // De-duplicate so the dispatcher selecting the same job twice doesn't
  // double-count against the cap or produce duplicate archive entries.
  const uniqueJobIds = Array.from(new Set(jobIdsInput));

  const filters = (body.filters ?? {}) as Record<string, unknown>;
  const dateFrom = typeof body.date_from === 'string' ? body.date_from : '';
  const dateTo = typeof body.date_to === 'string' ? body.date_to : '';
  const search = typeof filters.search === 'string' ? filters.search : '';

  const hasFilterCriteria =
    Object.keys(filters).some((k) =>
      BULK_ROUTE_EXPORT_ALLOWED_FILTERS.has(k) && filters[k] != null && String(filters[k]).length > 0,
    )
    || search.length > 0
    || dateFrom.length > 0
    || dateTo.length > 0;

  if (uniqueJobIds.length === 0 && !hasFilterCriteria) {
    return res.status(400).json({
      error: 'Specify either job_ids or at least one filter / date range to export.',
    });
  }

  // The dispatcher can opt into the async path explicitly via
  // `async: true`. The sync path keeps the original 500-job cap (so a
  // dispatcher who clicks "Download" gets a fast response or a clear
  // "narrow your filters" error); the async path raises the cap to
  // BULK_ROUTE_EXPORT_ASYNC_MAX_JOBS and emails the dispatcher a
  // download link when the worker finishes.
  const asyncMode = body.async === true;
  const cap = asyncMode ? BULK_ROUTE_EXPORT_ASYNC_MAX_JOBS : BULK_ROUTE_EXPORT_MAX_JOBS;

  // The async path emails the resulting link to whoever requested the
  // export — bail early if we don't have an address to send to. This
  // happens vanishingly rarely (the auth middleware already requires
  // an email-bearing JWT) but the worker can't recover from a missing
  // email later, so we'd rather refuse the request now than let the
  // archive land in object storage with no way to deliver it.
  const requesterEmail = (req.user?.email ?? '').trim();
  if (asyncMode && !requesterEmail) {
    return res.status(400).json({
      error: 'No email address on file for this user — cannot deliver the archive.',
    });
  }

  try {
    if (uniqueJobIds.length > cap) {
      return res.status(400).json({
        error: `Too many jobs selected (${uniqueJobIds.length}). Limit is ${cap} per ${asyncMode ? 'async ' : ''}export.`,
      });
    }

    const { jobs, matchedAtLeast } = await resolveExportJobs({
      pool,
      tenantId,
      uniqueJobIds,
      filters,
      search,
      dateFrom,
      dateTo,
      cap,
    });

    if (matchedAtLeast != null) {
      return res.status(400).json({
        error: `Filter matched more than ${cap} jobs. Narrow the date range or filters and try again.`,
        matched_at_least: matchedAtLeast,
      });
    }

    if (jobs.length === 0) {
      return res.status(404).json({ error: 'No jobs matched the selection.' });
    }

    if (asyncMode) {
      // Snapshot the resolved job ids so the worker doesn't drift if a
      // dispatcher edits / deletes jobs between request time and the
      // moment the worker actually runs. We persist the ids (not the
      // filter criteria) precisely so the archive matches what the
      // dispatcher saw on screen when they clicked "Email me".
      const resolvedJobIds = jobs.map((j) => j.id);

      const { rows: insertRows } = await pool.query(
        `INSERT INTO dispatch_route_export_jobs (
           tenant_id, requested_by_user_id, requested_by_email,
           status, format, include_empty, selection, job_count
         ) VALUES ($1, $2, $3, 'pending', $4, $5, $6, $7)
         RETURNING id, status, created_at`,
        [
          tenantId,
          req.user!.userId,
          requesterEmail,
          exportFormat,
          includeEmpty,
          JSON.stringify({ resolved_job_ids: resolvedJobIds }),
          jobs.length,
        ],
      );
      const exportJobId = String(insertRows[0].id);

      // Fire the worker on the next tick so the HTTP response goes out
      // immediately. The worker swallows its own errors and writes the
      // failure mode back to the row (and a failure email), so we do
      // NOT await it here.
      setImmediate(() => {
        processRouteExportJob(exportJobId).catch((err) => {
          logger.error('processRouteExportJob crashed outside its own try/catch', {
            exportJobId,
            error: String(err),
          });
        });
      });

      return res.status(202).json({
        export_job: {
          id: exportJobId,
          status: 'pending',
          job_count: jobs.length,
          format: exportFormat,
          requested_email: requesterEmail,
        },
      });
    }

    // ---- Sync path: build the archive in-process and stream it back ----
    const archive = await buildRouteArchive({
      pool,
      tenantId,
      jobs,
      format: exportFormat,
      includeEmpty,
    });

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${archive.archiveFilename}"`);
    res.setHeader('X-Route-Export-Job-Count', String(archive.jobCount));
    res.setHeader('X-Route-Export-Included', String(archive.includedCount));
    res.setHeader('X-Route-Export-Skipped-Empty', String(archive.skippedEmpty));
    res.setHeader('X-Route-Export-Format', exportFormat);
    return res.send(archive.buffer);
  } catch (err) {
    logger.error('Failed to bulk export dispatch routes', {
      tenantId,
      jobIdCount: uniqueJobIds.length,
      filterMode: uniqueJobIds.length === 0,
      asyncMode,
      error: String(err),
    });
    return res.status(500).json({ error: 'Failed to export routes' });
  }
};

// Resolve the absolute base URL we should embed in outbound emails. We
// re-derive the same APP_URL → REPLIT_DEV_DOMAIN → localhost chain used
// by `publicTrackerUrl` so dev / preview / prod all produce a tappable
// link. Defined here (and not via a shared util) to keep the
// dispatch-route export self-contained — it's the only async-email
// surface in this file.
function dispatchAppBaseUrl(): string {
  const base =
    process.env.APP_URL
    ?? (process.env.REPLIT_DEV_DOMAIN
      ? `https://${process.env.REPLIT_DEV_DOMAIN}`
      : 'http://localhost:5173');
  return base.replace(/\/+$/, '');
}

/**
 * Background worker for the async route-export path.
 *
 * Runs after `bulkExportJobRoutesHandler` has already accepted the
 * request, inserted the `dispatch_route_export_jobs` row in `pending`,
 * and returned a 202 to the dispatcher. From here it owns the row's
 * lifecycle:
 *
 *   pending → running → ready  (archive uploaded, email sent)
 *   pending → running → failed (record error, send failure email)
 *
 * All errors are caught inside the function so a worker crash can never
 * surface to the original Express response — instead we mark the row
 * `failed` and send a failure email so the dispatcher knows to retry
 * rather than waiting forever for a "ready" notification that never
 * arrives. The function is exported only for tests; production callers
 * always go through the handler above.
 */
export async function processRouteExportJob(exportJobId: string): Promise<void> {
  const pool = getPlatformPool();

  // Pull the export-job row first so subsequent error paths can email
  // the requester. We deliberately read the email + format from the
  // row (rather than re-deriving from a request) so a long-running
  // worker can survive deploys without losing its delivery target.
  let row: {
    tenant_id: string;
    requested_by_email: string;
    requested_by_user_id: string | null;
    format: 'gpx' | 'csv';
    include_empty: boolean;
    selection: { resolved_job_ids?: string[] } | null;
  } | null = null;

  try {
    const { rows } = await pool.query(
      `SELECT tenant_id, requested_by_email, requested_by_user_id,
              format, include_empty, selection
         FROM dispatch_route_export_jobs
        WHERE id = $1
        LIMIT 1`,
      [exportJobId],
    );
    if (rows.length === 0) {
      logger.warn('processRouteExportJob: row not found', { exportJobId });
      return;
    }
    const r = rows[0] as Record<string, unknown>;
    const rawSelection = r.selection;
    const selection = typeof rawSelection === 'string'
      ? JSON.parse(rawSelection)
      : (rawSelection as { resolved_job_ids?: string[] } | null);
    row = {
      tenant_id: String(r.tenant_id),
      requested_by_email: String(r.requested_by_email),
      requested_by_user_id: (r.requested_by_user_id as string | null) ?? null,
      format: (r.format as 'gpx' | 'csv'),
      include_empty: r.include_empty !== false,
      selection,
    };

    await pool.query(
      `UPDATE dispatch_route_export_jobs
          SET status = 'running', started_at = NOW()
        WHERE id = $1 AND status = 'pending'`,
      [exportJobId],
    );

    // Push the pending → running transition out over SSE so the
    // dispatcher's "Recent exports" panel can flip the row to "Building"
    // without waiting for its 5s poll. Best-effort — the broker
    // swallows listener errors, so a missing client connection (or no
    // subscribers at all) can never disrupt the worker.
    emitRouteExportStatusChanged(row.tenant_id, {
      exportJobId,
      status: 'running',
    });

    const resolvedJobIds = Array.isArray(row.selection?.resolved_job_ids)
      ? row.selection!.resolved_job_ids!.filter((s): s is string => typeof s === 'string')
      : [];
    if (resolvedJobIds.length === 0) {
      throw new Error('Export job has no resolved job ids in selection');
    }

    // Re-resolve the jobs through the same helper the sync path uses,
    // scoped by the snapshotted ids. This deliberately re-applies tenant
    // scoping (in case a job was reassigned to another tenant — defence
    // in depth, since the original handler already filtered by tenant).
    const { jobs } = await resolveExportJobs({
      pool,
      tenantId: row.tenant_id,
      uniqueJobIds: resolvedJobIds,
      filters: {},
      search: '',
      dateFrom: '',
      dateTo: '',
      cap: BULK_ROUTE_EXPORT_ASYNC_MAX_JOBS,
    });

    if (jobs.length === 0) {
      throw new Error('No jobs matched the snapshotted selection — they may have been deleted.');
    }

    const archive = await buildRouteArchive({
      pool,
      tenantId: row.tenant_id,
      jobs,
      format: row.format,
      includeEmpty: row.include_empty,
    });

    // Park the archive under the private object dir, namespaced by
    // tenant + export id so every tenant's exports share the same
    // bucket but never collide. The download endpoint maps a token →
    // this path, so the random id alone is enough; the tenant prefix
    // is just for human-readable triage of the bucket.
    const objectKey = `dispatch-route-exports/${row.tenant_id}/${exportJobId}.zip`;
    const storage = new ObjectStorageService();
    const archiveObjectPath = await storage.uploadPrivateObject(
      objectKey,
      archive.buffer,
      'application/zip',
    );

    // The download token is the only credential the unauthenticated
    // download endpoint accepts. 32 random bytes (256 bits) is well
    // beyond brute-force reach even at internet scale.
    const downloadToken = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + ROUTE_EXPORT_DOWNLOAD_TTL_MS);

    await pool.query(
      `UPDATE dispatch_route_export_jobs
          SET status = 'ready',
              archive_object_path = $2,
              archive_filename    = $3,
              archive_bytes       = $4,
              download_token      = $5,
              download_expires_at = $6,
              included_count      = $7,
              skipped_empty       = $8,
              completed_at        = NOW()
        WHERE id = $1`,
      [
        exportJobId,
        archiveObjectPath,
        archive.archiveFilename,
        archive.buffer.length,
        downloadToken,
        expiresAt.toISOString(),
        archive.includedCount,
        archive.skippedEmpty,
      ],
    );

    // Push the running → ready transition out over SSE so the
    // dispatcher's "Recent exports" panel can flip the row to "Ready"
    // (and surface the download link) the instant the archive lands —
    // ahead of the email round-trip and ahead of the next 5s poll tick.
    emitRouteExportStatusChanged(row.tenant_id, {
      exportJobId,
      status: 'ready',
    });

    // Look up the requester's first name + tenant display name so the
    // email reads like a personal note rather than a system noise. Both
    // queries are best-effort — missing data falls back to neutral
    // defaults inside the template.
    let firstName: string | null = null;
    let tenantName: string | null = null;
    try {
      if (row.requested_by_user_id) {
        const { rows: uRows } = await pool.query(
          `SELECT first_name FROM users WHERE id = $1 LIMIT 1`,
          [row.requested_by_user_id],
        );
        firstName = (uRows[0]?.first_name as string | null) ?? null;
      }
      const { rows: tRows } = await pool.query(
        `SELECT name FROM tenants WHERE id = $1 LIMIT 1`,
        [row.tenant_id],
      );
      tenantName = (tRows[0]?.name as string | null) ?? null;
    } catch (lookupErr) {
      logger.warn('processRouteExportJob: requester/tenant lookup failed', {
        exportJobId,
        error: String(lookupErr),
      });
    }

    const downloadUrl = `${dispatchAppBaseUrl()}/api/dispatch/route-exports/${exportJobId}/download?token=${downloadToken}`;
    const expiresAtHuman = expiresAt.toUTCString();

    const email = dispatchRouteExportReadyEmail({
      tenantName: tenantName ?? undefined,
      requesterFirstName: firstName,
      jobCount: archive.jobCount,
      includedCount: archive.includedCount,
      skippedEmpty: archive.skippedEmpty,
      format: row.format,
      archiveFilename: archive.archiveFilename,
      archiveBytes: archive.buffer.length,
      downloadUrl,
      expiresAt: expiresAtHuman,
    });

    const sendResult = await sendEmail({
      to: row.requested_by_email,
      subject: email.subject,
      html: email.html,
      text: email.text,
    });

    if (sendResult.success && sendResult.messageId) {
      await pool.query(
        `UPDATE dispatch_route_export_jobs
            SET email_sent_at = NOW(), email_message_id = $2
          WHERE id = $1`,
        [exportJobId, sendResult.messageId],
      );
    } else {
      // The archive is still ready and downloadable — only the email
      // failed. Log loudly but don't flip the row to `failed`, since
      // the dispatcher can still retrieve the archive via the status
      // endpoint + download token if the email is recovered.
      logger.error('processRouteExportJob: email send failed but archive is ready', {
        exportJobId,
        error: sendResult.error,
        permanent: sendResult.permanent,
      });
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    logger.error('processRouteExportJob failed', {
      exportJobId,
      error: errorMessage,
    });
    try {
      await pool.query(
        `UPDATE dispatch_route_export_jobs
            SET status = 'failed', error_message = $2, completed_at = NOW()
          WHERE id = $1`,
        [exportJobId, errorMessage.slice(0, 1000)],
      );
      // Notify any "Recent exports" panels that this row is terminal so
      // they can flip it to "Failed" and surface the retry control —
      // again, best-effort and gated on the row UPDATE actually
      // succeeding so we never tell the client about a status the DB
      // doesn't reflect. Fenced inside the same try/catch as the DB
      // write so a broker-side hiccup can't shadow the DB error.
      if (row?.tenant_id) {
        emitRouteExportStatusChanged(row.tenant_id, {
          exportJobId,
          status: 'failed',
          errorMessage: errorMessage.slice(0, 1000),
        });
      }
    } catch (updateErr) {
      logger.error('processRouteExportJob: failed to record failure status', {
        exportJobId,
        error: String(updateErr),
      });
    }

    if (row?.requested_by_email) {
      try {
        const failureEmail = dispatchRouteExportFailedEmail({
          requesterFirstName: null,
          format: row.format,
          errorMessage,
          dispatchBoardUrl: `${dispatchAppBaseUrl()}/dispatch`,
        });
        await sendEmail({
          to: row.requested_by_email,
          subject: failureEmail.subject,
          html: failureEmail.html,
          text: failureEmail.text,
        });
      } catch (mailErr) {
        logger.error('processRouteExportJob: failure-email send failed', {
          exportJobId,
          error: String(mailErr),
        });
      }
    }
  }
}

/**
 * GET /dispatch/route-exports/:id
 *
 * Status poll for the async route-export job. Used by the dispatcher
 * UI's "Recent exports" panel and by the modal's optimistic flow that
 * wants to confirm "we accepted your request" without waiting for the
 * email round-trip. Tenant-scoped through the explicit predicate (and
 * RLS on the table); returning 404 — instead of 403 — for a foreign
 * tenant id keeps export ids opaque across tenants.
 */
export const getRouteExportStatusHandler: RequestHandler = async (req, res) => {
  const { tenantId } = req.user!;
  const { id } = req.params;
  const pool = getPlatformPool();

  try {
    const { rows } = await pool.query(
      `SELECT id, status, format, job_count, included_count, skipped_empty,
              archive_filename, archive_bytes, download_expires_at,
              error_message, created_at, started_at, completed_at,
              email_sent_at
         FROM dispatch_route_export_jobs
        WHERE id = $1 AND tenant_id = $2
        LIMIT 1`,
      [id, tenantId],
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Export job not found' });
    }
    const r = rows[0] as Record<string, unknown>;
    return res.json({
      id: String(r.id),
      status: r.status,
      format: r.format,
      job_count: r.job_count,
      included_count: r.included_count,
      skipped_empty: r.skipped_empty,
      archive_filename: r.archive_filename,
      archive_bytes: r.archive_bytes ? Number(r.archive_bytes) : null,
      download_expires_at: r.download_expires_at,
      error_message: r.error_message,
      created_at: r.created_at,
      started_at: r.started_at,
      completed_at: r.completed_at,
      email_sent_at: r.email_sent_at,
    });
  } catch (err) {
    logger.error('Failed to load route export status', {
      tenantId,
      exportJobId: id,
      error: String(err),
    });
    return res.status(500).json({ error: 'Failed to load export status' });
  }
};

/**
 * GET /dispatch/route-exports
 *
 * Lists the most recent route-export jobs for the calling tenant. Backs
 * the dispatcher's "Recent exports" panel inside the bulk download
 * modal — that view polls this endpoint while any rows are still
 * pending/running so the dispatcher can watch their archive go from
 * "running" → "ready" without having to wait for the email.
 *
 * Tenant-scoped explicitly (and by RLS). The optional `limit` query
 * parameter caps how many rows we return; we clamp it server-side so a
 * forged client can't ask for the entire history.
 */
const ROUTE_EXPORTS_LIST_DEFAULT_LIMIT = 10;
const ROUTE_EXPORTS_LIST_MAX_LIMIT = 50;

export const listRouteExportsHandler: RequestHandler = async (req, res) => {
  const { tenantId } = req.user!;
  const pool = getPlatformPool();

  const rawLimit = Number(req.query.limit);
  const limit = Number.isFinite(rawLimit) && rawLimit > 0
    ? Math.min(Math.floor(rawLimit), ROUTE_EXPORTS_LIST_MAX_LIMIT)
    : ROUTE_EXPORTS_LIST_DEFAULT_LIMIT;

  try {
    const { rows } = await pool.query(
      `SELECT id, status, format, job_count, included_count, skipped_empty,
              archive_filename, archive_bytes, download_expires_at,
              error_message, created_at, started_at, completed_at,
              email_sent_at, requested_by_email
         FROM dispatch_route_export_jobs
        WHERE tenant_id = $1
        ORDER BY created_at DESC
        LIMIT $2`,
      [tenantId, limit],
    );
    return res.json({
      exports: rows.map((r: Record<string, unknown>) => ({
        id: String(r.id),
        status: r.status,
        format: r.format,
        job_count: r.job_count,
        included_count: r.included_count,
        skipped_empty: r.skipped_empty,
        archive_filename: r.archive_filename,
        archive_bytes: r.archive_bytes ? Number(r.archive_bytes) : null,
        download_expires_at: r.download_expires_at,
        error_message: r.error_message,
        created_at: r.created_at,
        started_at: r.started_at,
        completed_at: r.completed_at,
        email_sent_at: r.email_sent_at,
        requested_by_email: r.requested_by_email,
      })),
    });
  } catch (err) {
    logger.error('Failed to list route exports', {
      tenantId,
      error: String(err),
    });
    return res.status(500).json({ error: 'Failed to list exports' });
  }
};

/**
 * GET /dispatch/route-exports/stream
 *
 * Server-Sent Events channel that pushes `route_export.status_changed`
 * notifications for the calling tenant. The dispatcher's "Recent
 * exports" panel subscribes here so each `pending → running → ready`
 * (or `* → failed`) transition flips the row instantly instead of
 * waiting for the next 5s poll tick. Polling stays in the UI as a
 * fallback that only kicks in if this stream isn't connected.
 *
 * Tenant-scoped through `requireAuth` (which writes `req.user.tenantId`)
 * and the broker subscription key. Shares the platform-wide SSE
 * concurrency limiter and idle-disconnect heartbeat with the live-call
 * streams so a runaway client can't blow past the per-tenant cap.
 *
 * The companion `POST /dispatch/route-exports/stream/ack` lets the
 * client extend its idle deadline without bouncing the connection
 * (mirroring `/calls/live/ack`). Only the route-export scope is
 * accepted, so an ack from an unrelated stream can't keep this one
 * alive.
 */
const ROUTE_EXPORT_STREAM_TENANT_CAP = resolveLiveStreamCap(
  process.env.TENANT_LIVE_STREAM_CAP,
);

export const routeExportsStreamHandler: RequestHandler = (req, res) => {
  const { tenantId } = req.user!;

  if (!getTenantSseConnectionLimiter().acquire(req, res)) {
    logger.warn('Rejected route-exports stream — tenant concurrency cap reached', {
      tenantId,
      cap: ROUTE_EXPORT_STREAM_TENANT_CAP,
    });
    return;
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  // The connection envelope mirrors the other tenant SSE streams so
  // the client's reusable open-handler logic can treat them uniformly.
  // The `connectionId` doubles as the key for the ack endpoint.
  const connectionId = randomUUID();
  res.write(`event: connection\ndata: ${JSON.stringify({ connectionId })}\n\n`);

  const detachHeartbeat = attachSseHeartbeat(req, res, {
    intervalMs: 15_000,
    idleTimeoutMs: 60_000,
  });
  const unregister = registerSseConnection(
    tenantId,
    connectionId,
    detachHeartbeat.ack,
    { stream: 'route_exports' },
  );

  const unsubscribe = subscribeRouteExportEvents(tenantId, (payload) => {
    if (res.writableEnded || res.destroyed) return;
    res.write(
      `event: route_export.status_changed\ndata: ${JSON.stringify(payload)}\n\n`,
    );
  });

  req.on('close', () => {
    unsubscribe();
    unregister();
    detachHeartbeat();
  });
};

export const routeExportsStreamAckHandler: RequestHandler = (req, res) => {
  const { tenantId } = req.user!;
  const connectionId =
    (req.body && typeof req.body === 'object' &&
      (req.body as { connectionId?: unknown }).connectionId) ||
    req.query.connectionId;
  if (typeof connectionId !== 'string' || !connectionId) {
    return res.status(400).json({ error: 'connectionId required' });
  }
  const ok = ackSseConnection(tenantId, connectionId, { stream: 'route_exports' });
  if (!ok) return res.status(404).json({ error: 'unknown connectionId' });
  return res.status(204).end();
};

/**
 * POST /dispatch/route-exports/:id/retry
 *
 * Re-queues a failed route export by copying the original selection
 * (the snapshotted `resolved_job_ids`, format, and include_empty flag)
 * into a fresh row. Only `failed` rows are eligible — re-running a
 * `ready` row would duplicate emails, and a `pending`/`running` row is
 * already in flight. Returns the new export-job id so the UI can swap
 * the failed row for the new one in its "Recent exports" list.
 */
export const retryRouteExportHandler: RequestHandler = async (req, res) => {
  const { tenantId, userId, email } = req.user!;
  const { id } = req.params;
  const pool = getPlatformPool();

  const requesterEmail = (email ?? '').trim();
  if (!requesterEmail) {
    return res.status(400).json({
      error: 'No email address on file for this user — cannot deliver the archive.',
    });
  }

  try {
    const { rows } = await pool.query(
      `SELECT id, status, format, include_empty, selection, job_count
         FROM dispatch_route_export_jobs
        WHERE id = $1 AND tenant_id = $2
        LIMIT 1`,
      [id, tenantId],
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Export job not found' });
    }
    const original = rows[0] as Record<string, unknown>;
    if (original.status !== 'failed') {
      return res.status(409).json({
        error: `Only failed exports can be retried (current status: ${String(original.status)})`,
      });
    }

    const rawSelection = original.selection;
    const selection = typeof rawSelection === 'string'
      ? JSON.parse(rawSelection)
      : (rawSelection as { resolved_job_ids?: unknown } | null);
    const resolvedJobIds = Array.isArray(selection?.resolved_job_ids)
      ? selection!.resolved_job_ids!.filter((s: unknown): s is string => typeof s === 'string')
      : [];
    if (resolvedJobIds.length === 0) {
      return res.status(409).json({
        error: 'Original export has no recorded job selection — start a new export instead.',
      });
    }

    const { rows: insertRows } = await pool.query(
      `INSERT INTO dispatch_route_export_jobs (
         tenant_id, requested_by_user_id, requested_by_email,
         status, format, include_empty, selection, job_count
       ) VALUES ($1, $2, $3, 'pending', $4, $5, $6, $7)
       RETURNING id, status, created_at`,
      [
        tenantId,
        userId,
        requesterEmail,
        original.format,
        original.include_empty,
        JSON.stringify({ resolved_job_ids: resolvedJobIds }),
        resolvedJobIds.length,
      ],
    );
    const newExportJobId = String(insertRows[0].id);

    setImmediate(() => {
      processRouteExportJob(newExportJobId).catch((err) => {
        logger.error('processRouteExportJob crashed outside its own try/catch', {
          exportJobId: newExportJobId,
          error: String(err),
        });
      });
    });

    return res.status(202).json({
      export_job: {
        id: newExportJobId,
        status: 'pending',
        job_count: resolvedJobIds.length,
        format: original.format,
        requested_email: requesterEmail,
      },
    });
  } catch (err) {
    logger.error('Failed to retry route export', {
      tenantId,
      exportJobId: id,
      error: String(err),
    });
    return res.status(500).json({ error: 'Failed to retry export' });
  }
};

/**
 * GET /dispatch/route-exports/:id/download?token=...
 *
 * Token-authenticated download of a ready route-export archive. This
 * endpoint is intentionally **unauthenticated** (no JWT) because the
 * link is delivered by email, where the dispatcher's mail client
 * fetches it without our session cookie. The opaque `download_token`
 * (32 random bytes, unique per export) acts as the only credential —
 * combined with the explicit `download_expires_at` enforcement and the
 * `status = 'ready'` gate, that gives us a tight, self-contained
 * authorization surface that doesn't leak archives across tenants.
 */
export const downloadRouteExportHandler: RequestHandler = async (req, res) => {
  const { id } = req.params;
  const token = typeof req.query.token === 'string' ? req.query.token : '';

  if (!token) {
    return res.status(400).json({ error: 'Missing download token' });
  }

  const pool = getPlatformPool();
  try {
    // RLS on dispatch_route_export_jobs is keyed on `app.tenant_id`,
    // which we have no way to set on this unauthenticated request — so
    // we fetch the row through `withPrivilegedClient` (which disables
    // row_security in the surrounding transaction). The token itself
    // is still the credential gating access.
    const { withPrivilegedClient } = await import('../../../platform/db');
    const row = await withPrivilegedClient(async (client) => {
      const { rows } = await client.query(
        `SELECT id, tenant_id, status, archive_object_path, archive_filename,
                download_token, download_expires_at
           FROM dispatch_route_export_jobs
          WHERE id = $1 AND download_token = $2
          LIMIT 1`,
        [id, token],
      );
      return rows[0] as Record<string, unknown> | undefined;
    });

    if (!row) {
      return res.status(404).json({ error: 'Export not found or token invalid' });
    }
    if (row.status !== 'ready') {
      return res.status(409).json({ error: `Export is not ready (status: ${row.status})` });
    }
    const expiresAt = row.download_expires_at
      ? new Date(row.download_expires_at as string | Date)
      : null;
    if (!expiresAt || expiresAt.getTime() < Date.now()) {
      return res.status(410).json({ error: 'Download link has expired' });
    }
    if (!row.archive_object_path) {
      return res.status(500).json({ error: 'Archive path missing on export job' });
    }

    const storage = new ObjectStorageService();
    await storage.streamPrivateObject(
      String(row.archive_object_path),
      res,
      {
        downloadFilename: String(row.archive_filename ?? `dispatch-routes-${id}.zip`),
      },
    );
  } catch (err) {
    if (err instanceof ObjectNotFoundError) {
      return res.status(404).json({ error: 'Archive file no longer in storage' });
    }
    logger.error('Failed to stream route export archive', {
      exportJobId: id,
      error: String(err),
    });
    if (!res.headersSent) {
      return res.status(500).json({ error: 'Failed to download archive' });
    }
  }
};

/**
 * GET /dispatch/route-exports/:id/file
 *
 * Authenticated, in-app download of a ready route-export archive.
 * Mirrors `downloadRouteExportHandler` but identifies the export by
 * (tenant + id) instead of an opaque download token, so the
 * dispatcher's "Recent exports" panel can offer a one-click download
 * without having to round-trip through the email link. Same expiry +
 * status gates as the token-based path.
 */
export const downloadRouteExportAuthenticatedHandler: RequestHandler = async (req, res) => {
  const { tenantId } = req.user!;
  const { id } = req.params;
  const pool = getPlatformPool();

  try {
    const { rows } = await pool.query(
      `SELECT id, status, archive_object_path, archive_filename,
              download_expires_at
         FROM dispatch_route_export_jobs
        WHERE id = $1 AND tenant_id = $2
        LIMIT 1`,
      [id, tenantId],
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Export job not found' });
    }
    const row = rows[0] as Record<string, unknown>;
    if (row.status !== 'ready') {
      return res.status(409).json({ error: `Export is not ready (status: ${String(row.status)})` });
    }
    const expiresAt = row.download_expires_at
      ? new Date(row.download_expires_at as string | Date)
      : null;
    if (!expiresAt || expiresAt.getTime() < Date.now()) {
      return res.status(410).json({ error: 'Download link has expired' });
    }
    if (!row.archive_object_path) {
      return res.status(500).json({ error: 'Archive path missing on export job' });
    }

    const storage = new ObjectStorageService();
    await storage.streamPrivateObject(
      String(row.archive_object_path),
      res,
      {
        downloadFilename: String(row.archive_filename ?? `dispatch-routes-${id}.zip`),
      },
    );
  } catch (err) {
    if (err instanceof ObjectNotFoundError) {
      return res.status(404).json({ error: 'Archive file no longer in storage' });
    }
    logger.error('Failed to stream authenticated route export archive', {
      tenantId,
      exportJobId: id,
      error: String(err),
    });
    if (!res.headersSent) {
      return res.status(500).json({ error: 'Failed to download archive' });
    }
  }
};

// How often the customer-facing booking-tracker page should re-poll
// while the job is en_route. Long enough to keep provider call volume
// bounded — the per-(tenant, resource, job) routing cache absorbs
// most repeats from concurrent visitors anyway.
const PUBLIC_TRACKER_POLL_INTERVAL_MS = 30_000;

// Lifecycle states the customer's tracker page is allowed to display.
// Anything else (including unknown values) is rendered as the generic
// "Your appointment is on the schedule" pre-en-route view so we never
// leak internal status names to customers.
const TRACKER_PUBLIC_STATUSES = new Set([
  'pending',
  'assigned',
  'scheduled',
  'en_route',
  'on_site',
  'in_progress',
  'completed',
  'done',
  'cancelled',
]);

// Terminal statuses for the *public* tracker. Once a job lands in one
// of these and stays there past the grace period below, the tracking
// link stops resolving and we serve the same 404 used for unknown
// tokens — which the public UI then displays as a warm "this visit
// has wrapped up" page that reads gracefully whether the visitor is
// a real customer revisiting a stale link or a bot probing random
// tokens. This keeps the SMS link useful for a day after the visit
// (so the customer can revisit "what time were they here?") without
// leaving the tech's first name + appointment window indefinitely
// accessible to anyone who keeps the URL.
const TRACKER_TERMINAL_STATUSES = new Set(['completed', 'cancelled', 'no_show']);

// Grace period after a job enters a terminal status during which the
// tracking link still resolves. Tune this single constant to make the
// link expire faster or linger longer.
const TRACKER_TERMINAL_GRACE_MS = 24 * 60 * 60 * 1000;

/**
 * GET /public/dispatch/track/:token
 *
 * Customer-facing endpoint backing the booking-tracker page. Auth is
 * the per-job opaque `tracking_token` (migration 088) — no session,
 * no API key. Returns the minimum information the customer already
 * knows about their own visit (status, address, scheduled window,
 * tech first name) plus the live driving ETA when the job is en route
 * and the technician has reported a recent fix.
 *
 * Intentional omissions:
 *   - tenant_id, internal job UUID, contact phone/email
 *   - technician's GPS coordinates or device id
 *
 * The same routing-adapter cache used by the dispatcher live map and
 * the SMS template substitution is reused here, so concurrent visitors
 * don't trigger extra provider calls per poll.
 */
export const getPublicJobTrackerHandler: RequestHandler = async (req, res) => {
  const token = String(req.params.token ?? '').trim();
  // Tokens are gen_random_uuid()::text — exactly 36 chars including
  // dashes. Reject obviously malformed inputs cheaply before hitting
  // the DB, both as a smoke screen against scrapers and to keep the
  // 404 path off the query path.
  if (!token || token.length > 64 || !/^[a-zA-Z0-9-]+$/.test(token)) {
    return res.status(404).json({ error: 'Tracking link not found' });
  }

  const pool = getPlatformPool();
  try {
    const { rows } = await pool.query(
      `SELECT j.id, j.tenant_id, j.title, j.status,
              j.address, j.scheduled_at, j.eta_start, j.eta_end,
              j.completed_at, j.updated_at, j.resource_id,
              j.address_lat, j.address_lon, j.address_geocoded_for,
              r.name AS resource_name
         FROM dispatch_jobs j
         LEFT JOIN dispatch_resources r
           ON r.id = j.resource_id AND r.tenant_id = j.tenant_id
        WHERE j.tracking_token = $1
        LIMIT 1`,
      [token],
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Tracking link not found' });
    }
    const row = rows[0] as Record<string, unknown>;
    const tenantId = String(row.tenant_id);
    const jobId = String(row.id);
    const status = String(row.status ?? '');
    const address = String(row.address ?? '').trim();
    const resourceId = (row.resource_id as string | null) ?? null;

    // Expire the link once the job has been in a terminal state past
    // the grace period. We fall back to `updated_at` for cancelled /
    // no_show transitions where `completed_at` is never written; that
    // timestamp is updated on every status change so it's a safe proxy
    // for "when did this job leave the active queue?". We return the
    // same 404 shape used for unknown tokens — the public UI maps
    // that single 404 to a warm "this visit has wrapped up" page
    // that reads well for both real-customer and unknown-token cases
    // without confirming the job ever existed.
    if (TRACKER_TERMINAL_STATUSES.has(status)) {
      const refRaw =
        (row.completed_at as string | Date | null | undefined) ??
        (row.updated_at as string | Date | null | undefined) ??
        null;
      if (refRaw) {
        const refMs = new Date(refRaw as string | Date).getTime();
        if (
          Number.isFinite(refMs) &&
          Date.now() - refMs > TRACKER_TERMINAL_GRACE_MS
        ) {
          return res.status(404).json({ error: 'Tracking link not found' });
        }
      }
    }

    // Compute live ETA only when the customer actually benefits — the
    // tech is en route. Other statuses either don't have a meaningful
    // driving ETA (pending/assigned/scheduled — the truck hasn't left
    // yet) or are already over (on_site/completed/cancelled).
    let liveEta: { minutes: number; arrival_at: string } | null = null;
    if (status === 'en_route' && resourceId && address) {
      const eta = await computeLiveEtaForJob(pool, tenantId, jobId, resourceId, address);
      if (eta) {
        liveEta = {
          minutes: eta.minutes,
          arrival_at: eta.arrivalDate.toISOString(),
        };
      }
    }

    // Only the public-safe display name of the status — we map a few
    // synonyms together so the customer sees a stable label even when
    // dispatchers transition through lifecycle aliases.
    const safeStatus = TRACKER_PUBLIC_STATUSES.has(status) ? status : 'scheduled';

    // First-name only for the tech, to avoid leaking the rest of the
    // resource roster from a guessable URL.
    const techFirstName = (() => {
      const full = String(row.resource_name ?? '').trim();
      if (!full) return null;
      const first = full.split(/\s+/)[0];
      return first.length > 32 ? first.slice(0, 32) : first;
    })();

    return res.json({
      job: {
        title: (row.title as string | null) ?? null,
        status: safeStatus,
        address: address || null,
        scheduled_at: row.scheduled_at
          ? new Date(row.scheduled_at as string | Date).toISOString()
          : null,
        eta_start: row.eta_start
          ? new Date(row.eta_start as string | Date).toISOString()
          : null,
        eta_end: row.eta_end
          ? new Date(row.eta_end as string | Date).toISOString()
          : null,
        completed_at: row.completed_at
          ? new Date(row.completed_at as string | Date).toISOString()
          : null,
        resource_name: techFirstName,
      },
      live_eta: liveEta,
      poll_interval_ms: PUBLIC_TRACKER_POLL_INTERVAL_MS,
      now: new Date().toISOString(),
    });
  } catch (err) {
    logger.error('Failed to load public job tracker', { token, error: String(err) });
    return res.status(500).json({ error: 'Tracking link is temporarily unavailable' });
  }
};

// Per-IP rate limit on the public tracker endpoint. Keying by IP
// alone (not IP+token) hardens us against token-spray abuse — one
// attacker probing many guessed tokens from one address still hits
// a single shared bucket. The 120/min ceiling is generous enough
// that a shared NAT (apartment building, office) all watching the
// same job will not false-positive. Returns plain JSON 429s rather
// than the HTML default so the React poller can surface a soft
// retry message.
const publicTrackerLimiter = createRateLimiter({
  windowMs: 60_000,
  maxRequests: 120,
  message: 'Too many tracking requests. Please wait a moment.',
  keyGenerator: (req) => `dispatch-tracker:${req.ip ?? 'unknown'}`,
});

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

// Channels whose body actually ships as an SMS, so the per-tenant
// segment cap applies. Email-only templates are unaffected.
const SMS_CHANNELS = new Set(['sms', 'both']);

/**
 * Enforce the per-tenant SMS segment cap (task #844). Returns a 400
 * payload when the rendered preview would exceed the cap so the
 * caller can `return res.status(400).json(violation)` directly. The
 * preview is rendered with the same sample values the editor uses, so
 * a dispatcher hitting the API by hand sees the same segment count
 * the editor showed before they hit Save.
 */
function checkSmsSegmentLimit(args: {
  channel: string;
  body_template: string;
  limit: number | null;
}):
  | null
  | {
      error: string;
      segments: number;
      characters: number;
      encoding: 'GSM-7' | 'UCS-2';
      limit: number;
    } {
  if (args.limit == null) return null;
  if (!SMS_CHANNELS.has(args.channel)) return null;
  const rendered = renderDispatchTemplate(String(args.body_template ?? ''));
  const info = countSmsSegments(rendered);
  if (info.segments <= args.limit) return null;
  return {
    error:
      `SMS body would render to ${info.segments} segments, but this tenant caps `
      + `dispatch SMS templates at ${args.limit} segment${args.limit === 1 ? '' : 's'}. `
      + `Trim the body or raise the cap from Dispatch → Admin → Settings.`,
    segments: info.segments,
    characters: info.characters,
    encoding: info.encoding,
    limit: args.limit,
  };
}

const createNotificationTemplateHandler: RequestHandler = async (req, res) => {
  const { tenantId } = req.user!;
  const { name, trigger_event, channel, subject, body_template, is_active } = req.body;
  const pool = getPlatformPool();
  if (!name || !trigger_event || !body_template) {
    return res.status(400).json({ error: 'name, trigger_event, and body_template are required' });
  }
  const unknownTokens = [
    ...findUnknownDispatchMergeTokens(body_template),
    ...findUnknownDispatchMergeTokens(subject),
  ];
  if (unknownTokens.length > 0) {
    const unique = Array.from(new Set(unknownTokens));
    return res.status(400).json({
      error: `Unknown merge token${unique.length === 1 ? '' : 's'}: ${unique
        .map((t) => `{{${t}}}`)
        .join(', ')}. Supported tokens: ${DISPATCH_MERGE_TOKENS
        .map((t) => `{{${t}}}`)
        .join(', ')}.`,
      unknownTokens: unique,
      knownTokens: DISPATCH_MERGE_TOKENS,
    });
  }
  const effectiveChannel = channel || 'sms';
  const segmentLimit = await readDispatchSmsSegmentLimit(pool, tenantId);
  const violation = checkSmsSegmentLimit({
    channel: effectiveChannel,
    body_template,
    limit: segmentLimit,
  });
  if (violation) {
    return res.status(400).json(violation);
  }
  try {
    const { rows } = await pool.query(
      `INSERT INTO dispatch_notification_templates (tenant_id, name, trigger_event, channel, subject, body_template, is_active)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [tenantId, name, trigger_event, effectiveChannel, subject || '', body_template, is_active !== false],
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
  const unknownTokens = [
    ...(body_template !== undefined ? findUnknownDispatchMergeTokens(body_template) : []),
    ...(subject !== undefined ? findUnknownDispatchMergeTokens(subject) : []),
  ];
  if (unknownTokens.length > 0) {
    const unique = Array.from(new Set(unknownTokens));
    return res.status(400).json({
      error: `Unknown merge token${unique.length === 1 ? '' : 's'}: ${unique
        .map((t) => `{{${t}}}`)
        .join(', ')}. Supported tokens: ${DISPATCH_MERGE_TOKENS
        .map((t) => `{{${t}}}`)
        .join(', ')}.`,
      unknownTokens: unique,
      knownTokens: DISPATCH_MERGE_TOKENS,
    });
  }

  // The segment-limit check needs both the channel and the body the
  // patched row will end up with. When the tenant has opted in to a
  // cap we ALWAYS validate the effective post-update shape — even
  // when the patch only touches metadata like `name` or `is_active`
  // — because saving an already-over-cap template (without trimming
  // the body) silently keeps the violation alive on the next send,
  // which is exactly what task #844 is meant to prevent. Direct API
  // callers shouldn't be able to bypass the editor disable by
  // PATCHing around the body.
  const segmentLimit = await readDispatchSmsSegmentLimit(pool, tenantId);
  if (segmentLimit !== null) {
    let effectiveChannel: string | undefined = channel;
    let effectiveBody: string | undefined = body_template;
    if (effectiveChannel === undefined || effectiveBody === undefined) {
      const { rows: existing } = await pool.query(
        `SELECT channel, body_template
           FROM dispatch_notification_templates
          WHERE id = $1 AND tenant_id = $2 LIMIT 1`,
        [id, tenantId],
      );
      if (existing.length === 0) {
        return res.status(404).json({ error: 'Template not found' });
      }
      effectiveChannel = effectiveChannel ?? String(existing[0].channel ?? 'sms');
      effectiveBody = effectiveBody ?? String(existing[0].body_template ?? '');
    }
    const violation = checkSmsSegmentLimit({
      channel: effectiveChannel ?? 'sms',
      body_template: effectiveBody ?? '',
      limit: segmentLimit,
    });
    if (violation) {
      return res.status(400).json(violation);
    }
  }

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

    // "Visit-the-right-house" rollup. For every completed job in the
    // window we recompute the same closest-approach distance the board
    // badge / queue column / live-map popup show per job, then bucket
    // it. Jobs without an address geocode or without breadcrumbs land
    // in `no_data` so they don't pollute the rate. The thresholds
    // (50 / 100 / 250 m) are intentionally fixed across tenants — the
    // tenant-tunable `bad_arrival_threshold_m` only governs the auto-
    // flag exception, not this distribution view, so leaders can compare
    // technician behavior across tenants on the same axis.
    const { rows: approachBucketRows } = await pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE ca.closest_approach_m IS NOT NULL AND ca.closest_approach_m < 50)::int AS under_50,
         COUNT(*) FILTER (WHERE ca.closest_approach_m IS NOT NULL AND ca.closest_approach_m >= 50 AND ca.closest_approach_m < 100)::int AS m_50_100,
         COUNT(*) FILTER (WHERE ca.closest_approach_m IS NOT NULL AND ca.closest_approach_m >= 100 AND ca.closest_approach_m <= 250)::int AS m_100_250,
         COUNT(*) FILTER (WHERE ca.closest_approach_m IS NOT NULL AND ca.closest_approach_m > 250)::int AS over_250,
         COUNT(*) FILTER (WHERE ca.closest_approach_m IS NULL)::int AS no_data
       FROM dispatch_jobs d
       LEFT JOIN LATERAL (
         SELECT MIN(
           6371000 * 2 * ASIN(
             SQRT(LEAST(1.0,
               POWER(SIN(RADIANS((h.latitude - d.address_lat::float8) / 2)), 2)
               + COS(RADIANS(d.address_lat::float8)) * COS(RADIANS(h.latitude))
                 * POWER(SIN(RADIANS((h.longitude - d.address_lon::float8) / 2)), 2)
             ))
           )
         ) AS closest_approach_m
         FROM dispatch_resource_location_history h
         WHERE h.tenant_id = d.tenant_id
           AND h.active_job_id = d.id
           AND d.address_lat IS NOT NULL
           AND d.address_lon IS NOT NULL
       ) ca ON TRUE
       WHERE ${where} AND d.status IN ('completed','done')`,
      values,
    );

    // Daily "% within 50 m" trend over the same window. Keyed off
    // `created_at` (matches `dailyTrend` and the date-range filter so
    // dates align across charts in the UI). `with_data` counts jobs
    // where we could compute a distance — the rate denominator — and
    // `good` counts the under-50 m wins. The client renders a sparkline
    // so a single dot per day is fine; missing days are simply absent.
    const { rows: approachTrendRows } = await pool.query(
      `SELECT DATE(d.created_at) AS date,
              COUNT(*) FILTER (WHERE ca.closest_approach_m IS NOT NULL)::int AS with_data,
              COUNT(*) FILTER (WHERE ca.closest_approach_m IS NOT NULL AND ca.closest_approach_m < 50)::int AS good
       FROM dispatch_jobs d
       LEFT JOIN LATERAL (
         SELECT MIN(
           6371000 * 2 * ASIN(
             SQRT(LEAST(1.0,
               POWER(SIN(RADIANS((h.latitude - d.address_lat::float8) / 2)), 2)
               + COS(RADIANS(d.address_lat::float8)) * COS(RADIANS(h.latitude))
                 * POWER(SIN(RADIANS((h.longitude - d.address_lon::float8) / 2)), 2)
             ))
           )
         ) AS closest_approach_m
         FROM dispatch_resource_location_history h
         WHERE h.tenant_id = d.tenant_id
           AND h.active_job_id = d.id
           AND d.address_lat IS NOT NULL
           AND d.address_lon IS NOT NULL
       ) ca ON TRUE
       WHERE ${where} AND d.status IN ('completed','done')
       GROUP BY DATE(d.created_at) ORDER BY date`,
      values,
    );

    const stats = overview[0] || {};
    const totalJobs = (stats.total_jobs as number) || 0;
    const completedJobs = (stats.completed_jobs as number) || 0;
    const totalExceptions = exceptionStats.reduce((s, r) => s + (r.count as number), 0);

    const ab = approachBucketRows[0] || {};
    const approachUnder50 = (ab.under_50 as number) || 0;
    const approach50to100 = (ab.m_50_100 as number) || 0;
    const approach100to250 = (ab.m_100_250 as number) || 0;
    const approachOver250 = (ab.over_250 as number) || 0;
    const approachNoData = (ab.no_data as number) || 0;
    const approachWithData =
      approachUnder50 + approach50to100 + approach100to250 + approachOver250;

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
      approachBuckets: {
        under_50: approachUnder50,
        m_50_100: approach50to100,
        m_100_250: approach100to250,
        over_250: approachOver250,
        no_data: approachNoData,
        with_data: approachWithData,
        good_rate: approachWithData > 0
          ? Number(((approachUnder50 / approachWithData) * 100).toFixed(1))
          : 0,
        bad_rate: approachWithData > 0
          ? Number(((approachOver250 / approachWithData) * 100).toFixed(1))
          : 0,
      },
      approachTrend: approachTrendRows.map(r => ({
        date: r.date,
        with_data: (r.with_data as number) || 0,
        good: (r.good as number) || 0,
      })),
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
router.get('/dispatch/jobs/:id/live-eta', requireAuth, getJobLiveEtaHandler);
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
router.post('/dispatch/jobs/routes/export', requireAuth, bulkExportJobRoutesHandler);
router.get('/dispatch/route-exports', requireAuth, listRouteExportsHandler);
// SSE channel + companion ack endpoint. Registered BEFORE the
// `/:id` parameterised routes so Express matches the literal "stream"
// path instead of treating it as an export-job id.
router.get('/dispatch/route-exports/stream', requireAuth, routeExportsStreamHandler);
router.post('/dispatch/route-exports/stream/ack', requireAuth, routeExportsStreamAckHandler);
router.get('/dispatch/route-exports/:id', requireAuth, getRouteExportStatusHandler);
router.post('/dispatch/route-exports/:id/retry', requireAuth, retryRouteExportHandler);
// Intentionally NOT behind requireAuth — the per-export `download_token`
// embedded in the email link is the only credential. See
// `downloadRouteExportHandler` for the full token / expiry / status
// gating that protects this endpoint.
router.get('/dispatch/route-exports/:id/download', downloadRouteExportHandler);
router.get(
  '/dispatch/route-exports/:id/file',
  requireAuth,
  downloadRouteExportAuthenticatedHandler,
);

// Public, token-authenticated booking-tracker endpoint. NO requireAuth —
// the per-job tracking_token (migration 088) is the only credential.
router.get(
  '/public/dispatch/track/:token',
  publicTrackerLimiter,
  getPublicJobTrackerHandler,
);

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

router.get('/dispatch/settings', requireAuth, getDispatchSettingsHandler);
router.put('/dispatch/settings', requireAuth, requireMiniSystemWrite, updateDispatchSettingsHandler);

export default router;
