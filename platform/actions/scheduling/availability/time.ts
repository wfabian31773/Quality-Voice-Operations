// Pure tenant-timezone helpers for the availability engine. Dates are
// 'YYYY-MM-DD' calendar dates in the tenant timezone; instants are epoch ms.
// Wall-clock → instant conversion is DST-safe (two-pass offset lookup).

export const MINUTE_MS = 60_000;
export const DAY_MINUTES = 24 * 60;

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const CLOCK = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/;

const partsFormatters = new Map<string, Intl.DateTimeFormat>();

function partsFormatter(timeZone: string): Intl.DateTimeFormat {
  let dtf = partsFormatters.get(timeZone);
  if (!dtf) {
    dtf = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    partsFormatters.set(timeZone, dtf);
  }
  return dtf;
}

export interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

export function zonedParts(ms: number, timeZone: string): ZonedParts {
  const lookup: Record<string, number> = {};
  for (const part of partsFormatter(timeZone).formatToParts(new Date(ms))) {
    if (part.type !== 'literal') lookup[part.type] = Number(part.value);
  }
  return {
    year: lookup.year,
    month: lookup.month,
    day: lookup.day,
    // Some ICU versions still report midnight as 24 with h23.
    hour: lookup.hour === 24 ? 0 : lookup.hour,
    minute: lookup.minute,
    second: lookup.second,
  };
}

/** Minutes to add to UTC to get wall-clock time in `timeZone` at `ms`. */
export function offsetMinutes(ms: number, timeZone: string): number {
  const p = zonedParts(ms, timeZone);
  const wall = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((wall - Math.floor(ms / 1000) * 1000) / MINUTE_MS);
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

function formatUtcDate(d: Date): string {
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/** Calendar date of `ms` in `timeZone`. */
export function localDateOf(ms: number, timeZone: string): string {
  const p = zonedParts(ms, timeZone);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

/** Minute of the day (0..1439) of `ms` in `timeZone`. */
export function localMinuteOf(ms: number, timeZone: string): number {
  const p = zonedParts(ms, timeZone);
  return p.hour * 60 + p.minute;
}

/** True for a real calendar date in 'YYYY-MM-DD' form (rejects 2026-02-30). */
export function isRealIsoDate(value: string): boolean {
  const m = ISO_DATE.exec(value);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d;
}

function utcMidnight(date: string): number {
  const m = ISO_DATE.exec(date);
  if (!m) throw new RangeError(`Invalid date: ${date}`);
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

export function addDays(date: string, days: number): string {
  return formatUtcDate(new Date(utcMidnight(date) + days * DAY_MINUTES * MINUTE_MS));
}

/** Whole days from `from` to `to` (negative when `to` is earlier). */
export function diffDays(from: string, to: string): number {
  return Math.round((utcMidnight(to) - utcMidnight(from)) / (DAY_MINUTES * MINUTE_MS));
}

/** 0 = Sunday … 6 = Saturday, like scheduling_provider_schedules.day_of_week. */
export function dayOfWeek(date: string): number {
  return new Date(utcMidnight(date)).getUTCDay();
}

/** Inclusive list of dates from `from` to `to`. */
export function dateRange(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

/** 'HH:MM' or 'HH:MM:SS' → minutes since midnight; '24:00' → 1440. */
export function parseClock(value: string): number | null {
  const m = CLOCK.exec(value.trim());
  if (!m) return null;
  const minutes = Number(m[1]) * 60 + Number(m[2]);
  if (Number(m[2]) > 59 || minutes > DAY_MINUTES) return null;
  return minutes;
}

/**
 * Instant of wall-clock `minuteOfDay` on `date` in `timeZone`. Minutes past
 * 1440 roll into the next day (overnight windows). On the fall-back day an
 * ambiguous time resolves to its first occurrence.
 */
export function wallClockToUtc(date: string, minuteOfDay: number, timeZone: string): number {
  const guess = utcMidnight(date) + minuteOfDay * MINUTE_MS;
  let result = guess - offsetMinutes(guess, timeZone) * MINUTE_MS;
  result = guess - offsetMinutes(result, timeZone) * MINUTE_MS;
  return result;
}
