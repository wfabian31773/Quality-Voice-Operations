// Day boundaries for the call metrics. Always America/New_York, never the
// process or database time zone: a call belongs to the New York date it
// started on. Days are 23 or 25 hours long across a DST change.

export const METRICS_TIME_ZONE = 'America/New_York';

const DAY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

const wallClock = new Intl.DateTimeFormat('en-US', {
  timeZone: METRICS_TIME_ZONE,
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

function parts(instant: Date): Record<string, number> {
  const out: Record<string, number> = {};
  for (const part of wallClock.formatToParts(instant)) {
    if (part.type !== 'literal') out[part.type] = Number(part.value);
  }
  return out;
}

/** New York wall clock minus UTC at `instant`, in ms (-4h in EDT, -5h in EST). */
function offsetMs(instant: Date): number {
  const p = parts(instant);
  const wall = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return wall - (instant.getTime() - instant.getUTCMilliseconds());
}

const pad = (n: number, width = 2) => String(n).padStart(width, '0');

function isoDate(utcMs: number): string {
  const d = new Date(utcMs);
  return `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/** Throws unless `day` is a real calendar date written YYYY-MM-DD. */
export function parseDay(day: string): { year: number; month: number; date: number } {
  const match = DAY_PATTERN.exec(day);
  const [year, month, date] = match ? [Number(match[1]), Number(match[2]), Number(match[3])] : [0, 0, 0];
  if (!match || isoDate(Date.UTC(year, month - 1, date)) !== day) {
    throw new Error(`Invalid day "${day}": expected a YYYY-MM-DD date`);
  }
  return { year, month, date };
}

/** 00:00 New York on `day`. Midnight never falls in a DST gap (New York shifts at 02:00). */
function startOf(day: string): Date {
  const { year, month, date } = parseDay(day);
  const wall = Date.UTC(year, month - 1, date);
  const guess = wall - offsetMs(new Date(wall));
  // Second pass: the offset at the guessed instant is the one in force at local midnight.
  return new Date(wall - offsetMs(new Date(guess)));
}

/** [start, end) of the New York day, as UTC instants. */
export function dayBounds(day: string): { start: Date; end: Date } {
  const { year, month, date } = parseDay(day);
  return { start: startOf(day), end: startOf(isoDate(Date.UTC(year, month - 1, date + 1))) };
}

/** The New York date (YYYY-MM-DD) of an instant. */
export function dayOf(instant: Date): string {
  const p = parts(instant);
  return `${pad(p.year, 4)}-${pad(p.month)}-${pad(p.day)}`;
}
