// RT-13: the daily booked-or-filed per substantive call metric (gate G10).
// Exported function only; no scheduling or storage yet.

import { dayBounds } from './nyDay';
import { bookedOrFiledReport, type BookedOrFiledReport } from './report';
import type { CallMetricsSource } from './source';

/** The report for one New York day (YYYY-MM-DD), one tenant or all tenants (null). */
export async function bookedOrFiledForDay(
  source: CallMetricsSource,
  day: string,
  tenantId: string | null,
): Promise<BookedOrFiledReport> {
  const calls = await source.callsStartedBetween(dayBounds(day), tenantId);
  return bookedOrFiledReport({ day, tenantId, calls });
}

export { METRICS_TIME_ZONE, dayBounds, dayOf } from './nyDay';
export {
  bookedOrFiledReport,
  callOutcome,
  isWrittenBooking,
  rateBasisPoints,
  type BookedOrFiledReport,
  type CallBooking,
  type CallOutcome,
  type CallRecord,
  type CallTicket,
} from './report';
export { BOOKING_TOOLS, bookingFromToolRun, sqlCallMetricsSource, type CallMetricsDb, type CallMetricsSource } from './source';
export { REDACTED_NAME_STAND_IN, callerVerdict, floorCallerLines, unredactForFloor, type CallerVerdict } from './substantive';
