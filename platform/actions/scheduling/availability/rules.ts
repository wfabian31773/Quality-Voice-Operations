import type { BookingRuleRow, BookingRules } from './types';

/** scheduling_booking_rules column defaults (migration 052). */
export const DEFAULT_BOOKING_RULES: BookingRules = {
  minLeadMinutes: 0,
  maxLeadDays: 90,
  allowSameDay: true,
  sameDayCutoffMinute: null,
  maxDailyBookings: null,
};

function fromRow(row: BookingRuleRow): BookingRules {
  return {
    minLeadMinutes: Math.max(0, row.minLeadHours) * 60,
    maxLeadDays: Math.max(0, row.maxLeadDays),
    allowSameDay: row.allowSameDay,
    sameDayCutoffMinute: null,
    maxDailyBookings: row.maxDailyBookings != null && row.maxDailyBookings > 0 ? row.maxDailyBookings : null,
  };
}

function minNullable(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return Math.min(a, b);
}

/**
 * Effective rules for a multi-service booking: each service uses its own
 * row, else the tenant-wide row, else the column defaults; then the
 * strictest value of each rule wins across the services.
 */
export function resolveBookingRules(rows: BookingRuleRow[], serviceIds: string[]): BookingRules {
  const tenantRow = rows.find((r) => r.serviceId === null);
  const fallback = tenantRow ? fromRow(tenantRow) : DEFAULT_BOOKING_RULES;
  if (serviceIds.length === 0) return { ...fallback };

  return serviceIds
    .map((id) => {
      const row = rows.find((r) => r.serviceId === id);
      return row ? fromRow(row) : fallback;
    })
    .reduce((acc, r) => ({
      minLeadMinutes: Math.max(acc.minLeadMinutes, r.minLeadMinutes),
      maxLeadDays: Math.min(acc.maxLeadDays, r.maxLeadDays),
      allowSameDay: acc.allowSameDay && r.allowSameDay,
      sameDayCutoffMinute: minNullable(acc.sameDayCutoffMinute, r.sameDayCutoffMinute),
      maxDailyBookings: minNullable(acc.maxDailyBookings, r.maxDailyBookings),
    }));
}
