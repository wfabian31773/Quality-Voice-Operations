import { getPlatformPool } from '../db';
import { createLogger } from '../core/logger';

const logger = createLogger('PUSH_DISPATCHER');

const EXPO_PUSH_ENDPOINT = 'https://exp.host/--/api/v2/push/send';
const EXPO_BATCH_SIZE = 100;

export interface PushTarget {
  tenantId: string;
  /** Route by dispatch_resources.id — primary path for the technician app. */
  resourceIds?: string[];
  /** Route by users.id — used when we have a real JWT user. */
  userIds?: string[];
  /**
   * Optional lifecycle event name (e.g. 'job_assigned'). Persisted alongside
   * the push delivery telemetry so the Platform Admin "push delivery health"
   * panel can break failures down by event type.
   */
  event?: string;
}

export interface PushPayload {
  title: string;
  body: string;
  /** Free-form payload delivered to the app for routing/deep-linking. */
  data?: Record<string, unknown>;
  /** Defaults to 'default' so iOS plays the system sound. Pass null to silence. */
  sound?: 'default' | null;
  /** Android channel id. Should match a channel registered by the client. */
  channelId?: string;
  /** Optional priority hint (Expo: 'default' | 'normal' | 'high'). */
  priority?: 'default' | 'normal' | 'high';
}

export interface PushResult {
  /** Devices we attempted to deliver to. */
  attempted: number;
  /** Expo accepted these tokens. */
  accepted: number;
  /** Tokens marked as unregistered (push_enabled flipped to FALSE). */
  retired: number;
  /**
   * Devices we attempted to deliver to but neither accepted nor retired —
   * dropped on the floor (transient ticket errors, HTTP 5xx, network blip,
   * non-JSON body, etc.). Surfaced to operators so a flaky upstream is
   * visible instead of silently swallowed.
   */
  dropped: number;
  /**
   * Coarse, single-string summary of the most recent failure category
   * encountered during this fan-out. NULL when every device succeeded
   * cleanly. Used to power the "recent failures" table.
   */
  failureReason: string | null;
}

interface DeviceRow {
  id: string;
  push_token: string;
}

/**
 * Look up the active devices for a (tenant, resource/user) target. Devices
 * with `push_enabled = FALSE` are excluded — that's the per-device toggle the
 * mobile app's Profile tab controls.
 */
async function loadDevices(target: PushTarget): Promise<DeviceRow[]> {
  if (!target.tenantId) return [];
  const resourceIds = (target.resourceIds ?? []).filter((id) => Boolean(id));
  const userIds = (target.userIds ?? []).filter((id) => Boolean(id));
  if (resourceIds.length === 0 && userIds.length === 0) return [];

  const pool = getPlatformPool();
  const conditions: string[] = ['tenant_id = $1', 'push_enabled = TRUE', "platform = 'expo'"];
  const values: unknown[] = [target.tenantId];
  const orParts: string[] = [];
  if (resourceIds.length > 0) {
    values.push(resourceIds);
    orParts.push(`resource_id = ANY($${values.length}::varchar[])`);
  }
  if (userIds.length > 0) {
    values.push(userIds);
    orParts.push(`user_id = ANY($${values.length}::varchar[])`);
  }
  conditions.push(`(${orParts.join(' OR ')})`);

  try {
    const { rows } = await pool.query<DeviceRow>(
      `SELECT id, push_token
         FROM user_devices
        WHERE ${conditions.join(' AND ')}`,
      values,
    );
    // Dedupe by token in case the same device is registered against both a
    // user and a resource — we only want one push per physical device.
    const seen = new Set<string>();
    const deduped: DeviceRow[] = [];
    for (const row of rows) {
      if (seen.has(row.push_token)) continue;
      seen.add(row.push_token);
      deduped.push(row);
    }
    return deduped;
  } catch (err) {
    logger.warn('Failed to load devices for push fan-out', {
      tenantId: target.tenantId,
      error: String(err),
    });
    return [];
  }
}

interface ExpoTicket {
  status: 'ok' | 'error';
  id?: string;
  message?: string;
  details?: { error?: string };
}

interface ExpoResponse {
  data?: ExpoTicket[];
  errors?: Array<{ code?: string; message?: string }>;
}

/**
 * Persist a single fan-out outcome to the push_delivery_attempts table so
 * the Platform Admin "push delivery health" panel has data to render.
 * Errors are swallowed — telemetry must never break delivery.
 */
async function recordPushAttempt(
  target: PushTarget,
  result: PushResult,
): Promise<void> {
  // Skip no-op fan-outs (no devices matched the target). The panel only
  // cares about real attempts; recording empty rows would just bloat the
  // table without surfacing any useful operational signal.
  if (result.attempted === 0) return;
  try {
    const pool = getPlatformPool();
    await pool.query(
      `INSERT INTO push_delivery_attempts
         (tenant_id, event, attempted, accepted, retired, dropped, failure_reason)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        target.tenantId,
        target.event ?? null,
        result.attempted,
        result.accepted,
        result.retired,
        result.dropped,
        result.failureReason,
      ],
    );
  } catch (err) {
    logger.warn('Failed to persist push delivery telemetry', {
      tenantId: target.tenantId,
      error: String(err),
    });
  }
}

/**
 * Send a push to every active device matching the target. Network/Expo
 * errors are logged but never thrown — push delivery is fire-and-forget so
 * a flaky upstream cannot block the dispatch state-machine.
 */
export async function sendDispatchPush(
  target: PushTarget,
  payload: PushPayload,
  fetchImpl: typeof fetch = fetch,
): Promise<PushResult> {
  const devices = await loadDevices(target);
  const result: PushResult = {
    attempted: devices.length,
    accepted: 0,
    retired: 0,
    dropped: 0,
    failureReason: null,
  };
  if (devices.length === 0) return result;

  const pool = getPlatformPool();
  const messages = devices.map((d) => ({
    to: d.push_token,
    title: payload.title,
    body: payload.body,
    sound: payload.sound === null ? null : (payload.sound ?? 'default'),
    data: payload.data ?? {},
    channelId: payload.channelId,
    priority: payload.priority ?? 'high',
  }));

  for (let i = 0; i < messages.length; i += EXPO_BATCH_SIZE) {
    const slice = messages.slice(i, i + EXPO_BATCH_SIZE);
    const sliceDevices = devices.slice(i, i + EXPO_BATCH_SIZE);
    let response: Response;
    try {
      response = await fetchImpl(EXPO_PUSH_ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'Accept-Encoding': 'gzip, deflate',
        },
        body: JSON.stringify(slice),
      });
    } catch (err) {
      logger.warn('Expo push request failed', {
        tenantId: target.tenantId,
        error: String(err),
      });
      result.failureReason = 'network_error';
      continue;
    }

    if (!response.ok) {
      logger.warn('Expo push HTTP error', {
        tenantId: target.tenantId,
        status: response.status,
      });
      result.failureReason = `http_status_${response.status}`;
      continue;
    }

    let body: ExpoResponse;
    try {
      body = (await response.json()) as ExpoResponse;
    } catch (err) {
      logger.warn('Expo push response was not JSON', {
        tenantId: target.tenantId,
        error: String(err),
      });
      result.failureReason = 'invalid_json';
      continue;
    }

    const tickets = body.data ?? [];
    for (let j = 0; j < tickets.length; j++) {
      const ticket = tickets[j];
      const device = sliceDevices[j];
      if (!device) continue;
      if (ticket.status === 'ok') {
        result.accepted += 1;
        continue;
      }
      const errCode = ticket.details?.error;
      if (errCode === 'DeviceNotRegistered' || errCode === 'InvalidCredentials') {
        try {
          await pool.query(
            `UPDATE user_devices
                SET push_enabled = FALSE,
                    updated_at = NOW()
              WHERE id = $1`,
            [device.id],
          );
          result.retired += 1;
        } catch (err) {
          logger.warn('Failed to retire unregistered push device', {
            tenantId: target.tenantId,
            deviceId: device.id,
            error: String(err),
          });
          result.failureReason = 'retire_failed';
        }
      } else {
        logger.warn('Expo push ticket error', {
          tenantId: target.tenantId,
          deviceId: device.id,
          code: errCode,
          message: ticket.message,
        });
        result.failureReason = `ticket_error:${errCode ?? 'unknown'}`;
      }
    }
  }

  // Anything we attempted but neither accepted nor retired counts as
  // "dropped" — the operator-visible signal that something is silently
  // failing upstream (Expo 5xx, network blip, transient ticket error, etc.).
  result.dropped = Math.max(0, result.attempted - result.accepted - result.retired);

  // Fire-and-forget telemetry persistence. Errors are swallowed inside
  // recordPushAttempt so a hiccup writing the row never breaks delivery.
  await recordPushAttempt(target, result);

  return result;
}
