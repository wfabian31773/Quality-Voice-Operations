import { z } from 'zod';
import { isRealIsoDate, localDateOf, parseClock, wallClockToUtc } from './availability';

const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/;
const timestamp = z.string().datetime({ offset: true }).refine((value) => isRealIsoDate(value.slice(0, 10)) && Number.isFinite(Date.parse(value)));
export const START_TIME_MESSAGE = 'Use a shop-local 24-hour HH:MM time or a full ISO timestamp with Z or a timezone offset';

/** Keep timestamps as instants, including seconds, fractions and explicit offsets. */
export const availabilityStartTime = z.string().refine(
  (value) => CLOCK.test(value) || timestamp.safeParse(value).success,
  START_TIME_MESSAGE,
);

/** `date` has already been normalized to the shop's calendar date. */
export function resolveAvailabilityStart(startTime: string | undefined, date: string | undefined, timezone: string):
  | { ok: true; date: string | undefined; from: number | undefined }
  | { ok: false; message: string } {
  if (startTime === undefined) return { ok: true, date, from: undefined };
  if (!availabilityStartTime.safeParse(startTime).success) return { ok: false, message: START_TIME_MESSAGE };
  if (CLOCK.test(startTime)) {
    if (!date) return { ok: false, message: 'A shop-local HH:MM time needs a date.' };
    return { ok: true, date, from: wallClockToUtc(date, parseClock(startTime)!, timezone) };
  }
  const from = Date.parse(startTime);
  const timestampDate = localDateOf(from, timezone);
  if (date && date !== timestampDate) {
    return { ok: false, message: "That time falls on a different date at the shop. Please check the date and time." };
  }
  return { ok: true, date: timestampDate, from };
}
