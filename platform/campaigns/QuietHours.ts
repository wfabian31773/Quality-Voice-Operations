import { getTimezoneForPhone, extractAreaCode } from './AreaCodeTimezone';

/**
 * TCPA-aligned quiet-hours evaluation for outbound campaign dialing.
 *
 * The federal TCPA prohibits telemarketing calls outside 8:00am–9:00pm at the
 * called party's location. We default to a slightly more conservative
 * 9:00am–8:00pm window so customer-initiated changes still leave a buffer,
 * and we evaluate the local time at the contact's area code (not the
 * campaign owner's timezone) when `respectContactTimezone` is enabled.
 */

export interface QuietHoursConfig {
  /** Default IANA timezone for contacts whose area code we cannot resolve. */
  timezone?: string;
  /** Allowed-call window start (HH:MM, 24h). */
  callWindowStart?: string;
  /** Allowed-call window end (HH:MM, 24h). */
  callWindowEnd?: string;
  /** Days of the week (0 = Sunday) when calls are permitted. */
  daysOfWeek?: number[];
  /** Multiple call windows; takes precedence over single window when set. */
  callWindows?: Array<{ start: string; end: string; days: number[] }>;
  /** Whether to evaluate quiet hours in the contact's local timezone. */
  respectContactTimezone?: boolean;
  /** Per-area-code timezone overrides. */
  areaCodeTimezones?: Record<string, string>;
}

export interface QuietHoursDecision {
  allowed: boolean;
  reason?: 'outside_window' | 'wrong_day' | 'invalid_timezone';
  timezone: string;
  localTimeIso?: string;
}

const DEFAULT_TIMEZONE = 'America/Chicago';
const DEFAULT_WINDOW_START = '09:00';
const DEFAULT_WINDOW_END = '20:00';
const DEFAULT_DAYS = [1, 2, 3, 4, 5];

function parseHHMM(value: string): number {
  const [h, m] = value.split(':').map(Number);
  return h * 60 + m;
}

/**
 * Compute the local wall-clock components for an arbitrary IANA timezone
 * without pulling in a date-time library. Uses Intl.DateTimeFormat with the
 * `en-CA` locale because it returns ISO-style YYYY-MM-DD HH:MM:SS parts.
 */
function getLocalParts(now: Date, timezone: string): {
  dayOfWeek: number;
  minutesSinceMidnight: number;
  iso: string;
} {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    weekday: 'short',
  });
  const parts = fmt.formatToParts(now);
  const lookup: Record<string, string> = {};
  for (const part of parts) lookup[part.type] = part.value;

  const weekdayIdx = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(lookup.weekday ?? '');
  const hour = parseInt(lookup.hour ?? '0', 10);
  const minute = parseInt(lookup.minute ?? '0', 10);
  const second = parseInt(lookup.second ?? '0', 10);

  return {
    dayOfWeek: weekdayIdx === -1 ? now.getUTCDay() : weekdayIdx,
    minutesSinceMidnight: hour * 60 + minute,
    iso: `${lookup.year}-${lookup.month}-${lookup.day}T${lookup.hour}:${lookup.minute}:${String(second).padStart(2, '0')}`,
  };
}

/**
 * Resolve the timezone we should use for a given contact. Priority:
 *   1. Explicit per-area-code override on the campaign config.
 *   2. NANP area-code map (when respectContactTimezone is on).
 *   3. Campaign-level timezone (or default).
 */
export function resolveTimezoneForContact(
  phoneNumber: string,
  config: QuietHoursConfig,
): string {
  const fallback = config.timezone || DEFAULT_TIMEZONE;
  if (config.respectContactTimezone === false) return fallback;
  const area = extractAreaCode(phoneNumber);
  if (area && config.areaCodeTimezones && config.areaCodeTimezones[area]) {
    return config.areaCodeTimezones[area];
  }
  return getTimezoneForPhone(phoneNumber, fallback);
}

/**
 * Evaluate whether a given contact is currently within the allowed call
 * window. Defaults to TCPA-safe behavior: contact's local timezone derived
 * from area code, 9am–8pm Mon–Fri.
 */
export function evaluateQuietHours(
  phoneNumber: string,
  config: QuietHoursConfig,
  now: Date = new Date(),
): QuietHoursDecision {
  const timezone = resolveTimezoneForContact(phoneNumber, config);
  let local;
  try {
    local = getLocalParts(now, timezone);
  } catch {
    return { allowed: true, reason: 'invalid_timezone', timezone };
  }

  const callWindows = config.callWindows;
  if (Array.isArray(callWindows) && callWindows.length > 0) {
    const allowed = callWindows.some((w) => {
      if (!w.days?.includes(local.dayOfWeek)) return false;
      return local.minutesSinceMidnight >= parseHHMM(w.start)
        && local.minutesSinceMidnight < parseHHMM(w.end);
    });
    return {
      allowed,
      reason: allowed ? undefined : 'outside_window',
      timezone,
      localTimeIso: local.iso,
    };
  }

  const days = config.daysOfWeek ?? DEFAULT_DAYS;
  if (!days.includes(local.dayOfWeek)) {
    return { allowed: false, reason: 'wrong_day', timezone, localTimeIso: local.iso };
  }

  const start = parseHHMM(config.callWindowStart || DEFAULT_WINDOW_START);
  const end = parseHHMM(config.callWindowEnd || DEFAULT_WINDOW_END);
  const allowed = local.minutesSinceMidnight >= start
    && local.minutesSinceMidnight < end;
  return {
    allowed,
    reason: allowed ? undefined : 'outside_window',
    timezone,
    localTimeIso: local.iso,
  };
}
