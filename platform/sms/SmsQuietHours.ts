import { evaluateQuietHours, type QuietHoursDecision, type QuietHoursConfig } from '../campaigns/QuietHours';
import { getPlatformPool } from '../db';
import { createLogger } from '../core/logger';

/**
 * TCPA-aligned quiet hours for outbound SMS.
 *
 * The TCPA's 8:00am–9:00pm "called party local time" window applies to texts
 * just like voice calls. The platform-wide federal default is enforced for
 * every tenant; individual tenants can tighten the window via
 * `tenants.sms_quiet_hours_start` / `sms_quiet_hours_end` (Task #990) when
 * stricter state laws (e.g. FL HB 761) or enterprise contracts require it.
 *
 * Tenant overrides are clamped INSIDE the federal window — a tenant cannot
 * accidentally (or maliciously) loosen the platform default by configuring
 * 06:00–22:00. Any value outside the federal floor is silently snapped back
 * to it so a single misconfigured tenant cannot send after-hours blasts.
 *
 * The recipient's timezone is always inferred from their NANP area code via
 * the same map used by `CampaignScheduler` so voice and SMS stay consistent.
 */
export const SMS_QUIET_HOURS_WINDOW_START = '08:00';
export const SMS_QUIET_HOURS_WINDOW_END = '21:00';

const logger = createLogger('SMS_QUIET_HOURS');

const SMS_QUIET_HOURS_CONFIG: QuietHoursConfig = {
  callWindowStart: SMS_QUIET_HOURS_WINDOW_START,
  callWindowEnd: SMS_QUIET_HOURS_WINDOW_END,
  daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
  respectContactTimezone: true,
};

export interface SmsQuietHoursWindow {
  /** Effective window start (HH:MM, 24h). */
  start: string;
  /** Effective window end (HH:MM, 24h). */
  end: string;
  /** True when the tenant has narrowed at least one side of the window. */
  isTenantOverride: boolean;
}

/**
 * Evaluate whether an outbound SMS to `toNumber` is currently allowed under
 * the TCPA quiet-hours rules. Wraps the same `evaluateQuietHours` helper the
 * voice path uses so behavior stays consistent across channels.
 *
 * Pass `windowOverride` to evaluate against a tenant's narrowed window —
 * usually obtained via `getEffectiveSmsQuietHoursWindow(tenantId)` so the
 * result includes the federal-floor clamp. Without an override, the federal
 * default is used.
 */
export function evaluateSmsQuietHours(
  toNumber: string,
  now: Date = new Date(),
  windowOverride?: { start: string; end: string },
): QuietHoursDecision {
  if (!windowOverride) {
    return evaluateQuietHours(toNumber, SMS_QUIET_HOURS_CONFIG, now);
  }
  return evaluateQuietHours(
    toNumber,
    {
      ...SMS_QUIET_HOURS_CONFIG,
      callWindowStart: windowOverride.start,
      callWindowEnd: windowOverride.end,
    },
    now,
  );
}

/**
 * Compute the next UTC instant at which the SMS quiet-hours window opens for
 * `toNumber`'s local timezone. Used by the scheduled-message dispatcher to
 * defer messages that come due outside the window instead of dropping them.
 *
 * Returns `now` unchanged when the recipient is already inside the window.
 */
export function nextSmsWindowStart(
  toNumber: string,
  now: Date = new Date(),
  windowOverride?: { start: string; end: string },
): Date {
  const decision = evaluateSmsQuietHours(toNumber, now, windowOverride);
  if (decision.allowed) return now;
  const timezone = decision.timezone;

  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const parts = fmt.formatToParts(now);
  const lookup: Record<string, string> = {};
  for (const p of parts) lookup[p.type] = p.value;
  const localHour = parseInt(lookup.hour ?? '0', 10);
  const localMin = parseInt(lookup.minute ?? '0', 10);
  const localSec = parseInt(lookup.second ?? '0', 10);

  const minutesSinceMidnight = localHour * 60 + localMin;
  const startMin = parseHHMM(windowOverride?.start ?? SMS_QUIET_HOURS_WINDOW_START);
  const endMin = parseHHMM(windowOverride?.end ?? SMS_QUIET_HOURS_WINDOW_END);

  let minutesUntilWindow: number;
  if (minutesSinceMidnight < startMin) {
    minutesUntilWindow = startMin - minutesSinceMidnight;
  } else if (minutesSinceMidnight >= endMin) {
    minutesUntilWindow = (24 * 60 - minutesSinceMidnight) + startMin;
  } else {
    return now;
  }

  const millisUntilWindow = minutesUntilWindow * 60_000 - localSec * 1_000;
  return new Date(now.getTime() + Math.max(60_000, millisUntilWindow));
}

function parseHHMM(value: string): number {
  const [h, m] = value.split(':').map(Number);
  return h * 60 + m;
}

/**
 * Take a `HH:MM` or `HH:MM:SS` string (the format Postgres returns for a
 * `TIME` column) and reduce it to `HH:MM` so the runtime comparators don't
 * choke on the seconds suffix. Returns `null` for unparseable input so the
 * caller can fall back to the federal default.
 */
function normalizeHHMM(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const match = /^(\d{2}):(\d{2})/.exec(raw);
  if (!match) return null;
  return `${match[1]}:${match[2]}`;
}

/**
 * Clamp a tenant-supplied bound INSIDE the federal window so a tenant can
 * never weaken the platform default. `which` controls which boundary we're
 * clamping so the federal floor is the lower bound and the federal ceiling
 * is the upper bound for both sides.
 */
function clampToFederalWindow(value: string, which: 'start' | 'end'): string {
  const v = parseHHMM(value);
  const fStart = parseHHMM(SMS_QUIET_HOURS_WINDOW_START);
  const fEnd = parseHHMM(SMS_QUIET_HOURS_WINDOW_END);
  // For both start and end, the value must satisfy fStart <= v <= fEnd —
  // a tighter start (e.g. 09:00) is fine because it's still >= 08:00; a
  // looser start (e.g. 06:00) is snapped back up to 08:00. Same logic for
  // the end: 20:00 is fine, 22:00 snaps back to 21:00.
  void which;
  if (v < fStart) return SMS_QUIET_HOURS_WINDOW_START;
  if (v > fEnd) return SMS_QUIET_HOURS_WINDOW_END;
  return value;
}

interface CachedWindow {
  window: SmsQuietHoursWindow;
  expiresAt: number;
}

const TENANT_WINDOW_CACHE_TTL_MS = 30_000;
const tenantWindowCache = new Map<string, CachedWindow>();

/**
 * Drop the cached tenant override(s). The admin settings endpoint calls
 * this after a successful update so a subsequent send picks up the new
 * window immediately rather than waiting out the 30s TTL. Tests use it
 * to keep cache state from bleeding between cases.
 *
 * Pass `tenantId` to invalidate a single tenant; omit to flush all.
 */
export function clearSmsQuietHoursCache(tenantId?: string): void {
  if (tenantId) tenantWindowCache.delete(tenantId);
  else tenantWindowCache.clear();
}

/** @deprecated Use `clearSmsQuietHoursCache`. */
export const _resetSmsQuietHoursCacheForTests = clearSmsQuietHoursCache;

/**
 * Load the effective SMS quiet-hours window for a tenant. Reads
 * `tenants.sms_quiet_hours_start` / `_end`, clamps each side inside the
 * federal default, and falls back to the federal default for any side the
 * tenant hasn't configured (or when the read fails).
 *
 * Cached for `TENANT_WINDOW_CACHE_TTL_MS` so a high-throughput SMS sender
 * doesn't add a DB round-trip per message. The TTL is short enough that an
 * admin tightening the window sees the new value within ~30s without a
 * restart.
 */
export async function getEffectiveSmsQuietHoursWindow(
  tenantId: string,
): Promise<SmsQuietHoursWindow> {
  const now = Date.now();
  const cached = tenantWindowCache.get(tenantId);
  if (cached && cached.expiresAt > now) {
    return cached.window;
  }

  let startRaw: unknown = null;
  let endRaw: unknown = null;
  try {
    const pool = getPlatformPool();
    const { rows } = await pool.query(
      `SELECT sms_quiet_hours_start, sms_quiet_hours_end
         FROM tenants WHERE id = $1 LIMIT 1`,
      [tenantId],
    );
    if (rows.length > 0) {
      startRaw = rows[0].sms_quiet_hours_start;
      endRaw = rows[0].sms_quiet_hours_end;
    }
  } catch (err) {
    logger.warn('Failed to read tenant SMS quiet-hours override; using federal default', {
      tenantId,
      error: String(err),
    });
  }

  const startNormalized = normalizeHHMM(startRaw);
  const endNormalized = normalizeHHMM(endRaw);
  const start = startNormalized
    ? clampToFederalWindow(startNormalized, 'start')
    : SMS_QUIET_HOURS_WINDOW_START;
  const end = endNormalized
    ? clampToFederalWindow(endNormalized, 'end')
    : SMS_QUIET_HOURS_WINDOW_END;
  const window: SmsQuietHoursWindow = {
    start,
    end,
    isTenantOverride:
      start !== SMS_QUIET_HOURS_WINDOW_START || end !== SMS_QUIET_HOURS_WINDOW_END,
  };

  tenantWindowCache.set(tenantId, {
    window,
    expiresAt: now + TENANT_WINDOW_CACHE_TTL_MS,
  });
  return window;
}

/**
 * Tenant-aware variant of `evaluateSmsQuietHours` — loads the tenant's
 * override (or federal default) and uses it for the decision.
 */
export async function evaluateSmsQuietHoursForTenant(
  tenantId: string,
  toNumber: string,
  now: Date = new Date(),
): Promise<QuietHoursDecision> {
  const window = await getEffectiveSmsQuietHoursWindow(tenantId);
  return evaluateSmsQuietHours(toNumber, now, window);
}

/**
 * Tenant-aware variant of `nextSmsWindowStart` — loads the tenant's
 * override (or federal default) and uses it to compute the next opening.
 */
export async function nextSmsWindowStartForTenant(
  tenantId: string,
  toNumber: string,
  now: Date = new Date(),
): Promise<Date> {
  const window = await getEffectiveSmsQuietHoursWindow(tenantId);
  return nextSmsWindowStart(toNumber, now, window);
}

/**
 * Format an effective window for display in the compliance UI. Mirrors the
 * "08:00–21:00 local" string the panel previously hard-coded.
 */
export function formatSmsQuietHoursWindow(window: SmsQuietHoursWindow): string {
  return `${window.start}–${window.end} local`;
}
