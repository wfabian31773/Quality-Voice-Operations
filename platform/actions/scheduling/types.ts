// Scheduling v2 data types (migration 122). Types only; the scheduling
// actions that use them land in later PRs.

export const BOOKING_STATUSES = [
  'pending',
  'confirmed',
  'cancelled',
  'completed',
  'no_show',
  'checked_in',
  'rescheduled',
  'held',
] as const;
export type BookingStatus = (typeof BOOKING_STATUSES)[number];

/** Statuses that occupy a provider/resource slot under the exclusion constraints. */
export const SLOT_BLOCKING_STATUSES = ['held', 'confirmed'] as const satisfies readonly BookingStatus[];
export type SlotBlockingStatus = (typeof SLOT_BLOCKING_STATUSES)[number];

export const PRICE_KINDS = ['fixed', 'from', 'range', 'hidden'] as const;
export type PriceKind = (typeof PRICE_KINDS)[number];

/** SQLSTATE for exclusion_violation; actions map it to CONFLICT. */
export const EXCLUSION_VIOLATION_SQLSTATE = '23P01';

export const BOOKING_OVERLAP_CONSTRAINTS = {
  provider: 'bookings_no_provider_overlap',
  resource: 'bookings_no_resource_overlap',
} as const;
export type BookingOverlapKind = keyof typeof BOOKING_OVERLAP_CONSTRAINTS;

/** cancellation_reason written on holds released by expireStaleHolds. */
export const HOLD_EXPIRED_REASON = 'hold_expired';

/** v2 columns on `bookings` (048/052 columns omitted). */
export interface BookingV2Columns {
  status: BookingStatus;
  hold_expires_at: Date | null;
  /** end_time + buffer; defaults to end_time when a writer omits it. */
  blocked_until: Date;
  idempotency_key: string | null;
}

/** v2 columns on `scheduling_appointment_types`. */
export interface AppointmentTypePriceColumns {
  price_cents: number | null;
  price_kind: PriceKind;
  price_max_cents: number | null;
}

/** Row of `scheduling_provider_services` (who performs what). */
export interface ProviderServiceRow {
  tenant_id: string;
  provider_id: string;
  appointment_type_id: string;
  created_at: Date;
}

/** Row of `scheduling_business_hours`; times are wall-clock in the tenant timezone. */
export interface BusinessHoursRow {
  id: string;
  tenant_id: string;
  /** 0 = Sunday … 6 = Saturday, same as scheduling_provider_schedules. */
  day_of_week: number;
  /** 'HH:MM:SS' */
  open_time: string;
  /** 'HH:MM:SS', strictly after open_time. */
  close_time: string;
  created_at: Date;
  updated_at: Date;
}

export interface ExpireStaleHoldsOptions {
  /** Also release stale holds on this shared resource (chair/room). */
  resourceId?: string | null;
  /** Clock override (ActionContext.now). Defaults to the database clock. */
  now?: Date;
}

export interface ExpireStaleHoldsResult {
  expiredBookingIds: string[];
}
