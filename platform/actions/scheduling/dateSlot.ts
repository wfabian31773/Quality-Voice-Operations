// The date slot validator every scheduling date takes (check_availability's
// date and window, find_bookings' date). The model is told DATE_SLOT_FORMAT:
// YYYY-MM-DD in the tenant's timezone. It sometimes sends an unambiguous
// variant instead, and a failed call costs the caller a whole round trip, so
// these are accepted and turned into the tenant's YYYY-MM-DD:
//   - a full ISO datetime: with a zone, its date in the tenant timezone;
//     without one, the date it is written on (already the tenant's wall clock);
//   - YYYY/MM/DD;
//   - a weekday name next to an ISO date ("Wednesday 2026-10-21",
//     "2026-10-21 (miércoles)"), when the weekday is that date's.
// Anything a person could read two ways still fails with the same message:
// "10/21", "21/10/2026", "Wednesday" alone, "next Wednesday".
import { z } from 'zod';
import { isRealIsoDate, localDateOf } from './availability';

export const DATE_FORMAT_MESSAGE = 'Use a YYYY-MM-DD date';
export const NOT_A_REAL_DATE_MESSAGE = 'Not a real calendar date';
export const WEEKDAY_MISMATCH_MESSAGE = 'The weekday does not match the date. Use a YYYY-MM-DD date';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const SLASHED = /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/;
const DATETIME = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(Z|[+-]\d{2}(?::?\d{2})?)?$/i;
const WEEKDAY_FIRST = /^([\p{L}.]+),?\s+(\d{4}-\d{2}-\d{2})$/u;
const WEEKDAY_AFTER = /^(\d{4}-\d{2}-\d{2}),?\s+\(?([\p{L}.]+)\)?$/u;

/** Weekday words → 0 = Sunday … 6 = Saturday (English and Spanish, the call languages). */
const WEEKDAYS: ReadonlyMap<string, number> = new Map([
  ...['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'].map((w, i) => [w, i] as const),
  ...['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'].map((w, i) => [w, i] as const),
  ...['domingo', 'lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado'].map((w, i) => [w, i] as const),
]);

function weekdayIndex(word: string): number | undefined {
  const key = word.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '').replace(/\.$/, '');
  return WEEKDAYS.get(key);
}

function weekdayOf(isoDate: string): number {
  const [y, m, d] = isoDate.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** 'Z', '±HH', '±HHMM' or '±HH:MM' → minutes east of UTC. */
function zoneOffsetMinutes(zone: string): number | undefined {
  if (zone.toUpperCase() === 'Z') return 0;
  const m = /^([+-])(\d{2}):?(\d{2})?$/.exec(zone);
  if (!m) return undefined;
  const [hours, minutes] = [Number(m[2]), Number(m[3] ?? 0)];
  if (hours > 14 || minutes > 59) return undefined;
  return (m[1] === '-' ? -1 : 1) * (hours * 60 + minutes);
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

type Parsed =
  | { ok: true; date: string; instant?: number }
  | { ok: false; message: string };

/**
 * The date a slot value names, before the tenant timezone is applied: the
 * written date, plus the instant for a datetime that carries a zone.
 */
function parse(raw: string): Parsed {
  const value = raw.trim();
  const realOrNot = (date: string, instant?: number): Parsed =>
    isRealIsoDate(date) ? { ok: true, date, ...(instant === undefined ? {} : { instant }) } : { ok: false, message: NOT_A_REAL_DATE_MESSAGE };

  if (ISO_DATE.test(value)) return realOrNot(value);

  const slashed = SLASHED.exec(value);
  if (slashed) return realOrNot(`${slashed[1]}-${pad(Number(slashed[2]))}-${pad(Number(slashed[3]))}`);

  const datetime = DATETIME.exec(value);
  if (datetime) {
    const [, date, hh, mm, ss, zone] = datetime;
    if (Number(hh) > 23 || Number(mm) > 59 || (ss !== undefined && Number(ss) > 59)) return { ok: false, message: DATE_FORMAT_MESSAGE };
    if (!zone) return realOrNot(date);
    if (!isRealIsoDate(date)) return { ok: false, message: NOT_A_REAL_DATE_MESSAGE };
    const offset = zoneOffsetMinutes(zone);
    if (offset === undefined) return { ok: false, message: DATE_FORMAT_MESSAGE };
    const [y, mo, d] = date.split('-').map(Number);
    const instant = Date.UTC(y, mo - 1, d, Number(hh), Number(mm), Number(ss ?? 0)) - offset * 60_000;
    return { ok: true, date, instant };
  }

  const named = WEEKDAY_FIRST.exec(value) ?? WEEKDAY_AFTER.exec(value);
  if (named) {
    const [word, date] = ISO_DATE.test(named[1]) ? [named[2], named[1]] : [named[1], named[2]];
    const weekday = weekdayIndex(word);
    if (weekday === undefined) return { ok: false, message: DATE_FORMAT_MESSAGE };
    if (!isRealIsoDate(date)) return { ok: false, message: NOT_A_REAL_DATE_MESSAGE };
    return weekday === weekdayOf(date) ? { ok: true, date } : { ok: false, message: WEEKDAY_MISMATCH_MESSAGE };
  }

  return { ok: false, message: DATE_FORMAT_MESSAGE };
}

/** Why a date slot value is refused, or undefined when it is accepted. */
export function dateSlotIssue(raw: string): string | undefined {
  const parsed = parse(raw);
  return parsed.ok ? undefined : parsed.message;
}

/**
 * The tenant's YYYY-MM-DD for an accepted value (a zoned datetime lands on
 * its date in `timeZone`). Throws on a value dateSlotIssue refuses.
 */
export function toTenantDate(raw: string, timeZone: string): string {
  const parsed = parse(raw);
  if (!parsed.ok) throw new RangeError(parsed.message);
  return parsed.instant === undefined ? parsed.date : localDateOf(parsed.instant, timeZone);
}

/**
 * The date as written, without a timezone: what the schema's cross-field
 * checks (window order and length) compare. run() applies the tenant
 * timezone with toTenantDate.
 */
export function writtenDate(raw: string): string | undefined {
  const parsed = parse(raw);
  return parsed.ok ? parsed.date : undefined;
}

/** A date slot in an action's input schema: any accepted form, one issue per refusal. */
export const dateSlot = z.string().superRefine((value, ctx) => {
  const issue = dateSlotIssue(value);
  if (issue) ctx.addIssue({ code: z.ZodIssueCode.custom, message: issue });
});
