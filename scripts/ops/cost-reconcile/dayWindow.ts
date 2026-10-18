// Day boundaries for the reconciler. A "day" is a calendar day in
// America/New_York (the barbershop-first market), half-open
// [00:00 local, next 00:00 local), expressed as UTC instants. DST days
// are 23 or 25 hours long; that is intended.

export const RECONCILE_TIME_ZONE = 'America/New_York';

export interface DayWindow {
  /** Local calendar date, YYYY-MM-DD. */
  date: string;
  timeZone: string;
  /** Inclusive start, ISO-8601 UTC. */
  startUtc: string;
  /** Exclusive end, ISO-8601 UTC. */
  endUtc: string;
  startMs: number;
  endMs: number;
}

function parseDate(date: string): { y: number; m: number; d: number } {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) throw new Error('Date must be YYYY-MM-DD');
  const y = Number(match[1]);
  const m = Number(match[2]);
  const d = Number(match[3]);
  const probe = new Date(Date.UTC(y, m - 1, d));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== m - 1 || probe.getUTCDate() !== d) {
    throw new Error('Date must be a real calendar date');
  }
  return { y, m, d };
}

/** Offset (local − UTC) in ms of `timeZone` at the instant `utcMs`. */
function zoneOffsetMs(utcMs: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(utcMs));
  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return asUtc - Math.floor(utcMs / 1000) * 1000;
}

/** UTC instant of local midnight starting `y-m-d` in `timeZone`. */
function localMidnightUtcMs(y: number, m: number, d: number, timeZone: string): number {
  const naive = Date.UTC(y, m - 1, d);
  let guess = naive - zoneOffsetMs(naive, timeZone);
  // Re-check once: the offset at the guess can differ from the offset at
  // the naive instant when a DST switch falls between them.
  guess = naive - zoneOffsetMs(guess, timeZone);
  return guess;
}

export function dayWindow(date: string, timeZone: string = RECONCILE_TIME_ZONE): DayWindow {
  const { y, m, d } = parseDate(date);
  const startMs = localMidnightUtcMs(y, m, d, timeZone);
  const next = new Date(Date.UTC(y, m - 1, d + 1));
  const endMs = localMidnightUtcMs(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), timeZone);
  return {
    date,
    timeZone,
    startUtc: new Date(startMs).toISOString(),
    endUtc: new Date(endMs).toISOString(),
    startMs,
    endMs,
  };
}

export function isInWindow(iso: string, window: DayWindow): boolean {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return false;
  return ms >= window.startMs && ms < window.endMs;
}

/** UTC calendar dates (YYYY-MM-DD) the window touches, for date-only API filters. */
export function utcDatesCovering(window: DayWindow): string[] {
  const dates: string[] = [];
  const cursor = new Date(window.startMs);
  cursor.setUTCHours(0, 0, 0, 0);
  while (cursor.getTime() < window.endMs) {
    dates.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dates;
}
