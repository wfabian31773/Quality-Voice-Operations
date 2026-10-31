// Inputs and outputs of the pure availability engine. Loaders build these
// from QVO's own tables; the engine never touches the database.

export const PARTS_OF_DAY = ['morning', 'afternoon', 'evening'] as const;
export type PartOfDay = (typeof PARTS_OF_DAY)[number];

export const NO_SLOT_REASONS = ['closed', 'fully_booked', 'outside_lead_time', 'staff_off'] as const;
export type NoSlotReason = (typeof NO_SLOT_REASONS)[number];

/** Weekly wall-clock block. `end <= start` means it runs past midnight. */
export interface ClockBlock {
  /** 0 = Sunday … 6 = Saturday. */
  dayOfWeek: number;
  /** 'HH:MM' or 'HH:MM:SS' in the tenant timezone. */
  start: string;
  end: string;
}

/** One `scheduling_overrides` row (see the four shapes in routes/scheduling.ts). */
export interface DateOverride {
  /** 'YYYY-MM-DD' in the tenant timezone. */
  date: string;
  /** null = whole shop (holiday closure / special shop hours). */
  staffId: string | null;
  start: string | null;
  end: string | null;
  isAvailable: boolean;
}

export interface StaffMember {
  id: string;
  name: string;
  /** Services this staff member performs (scheduling_provider_services). */
  serviceIds: string[];
  /** Weekly schedule. Empty = follows the business hours. */
  weekly: ClockBlock[];
}

export interface ServiceSpec {
  id: string;
  name: string;
  durationMin: number;
  bufferMin: number;
}

/** A booking that occupies a staff member from `start` to `blockedUntil`. */
export interface BusyBooking {
  staffId: string;
  start: Date;
  /** end_time + buffer (bookings.blocked_until). */
  blockedUntil: Date;
  status: string;
  holdExpiresAt?: Date | null;
}

export interface BookingRules {
  minLeadMinutes: number;
  maxLeadDays: number;
  allowSameDay: boolean;
  /** Local minute of day after which same-day booking closes; null = none. */
  sameDayCutoffMinute: number | null;
  /** Per staff member per day; null = no cap. */
  maxDailyBookings: number | null;
}

/** One `scheduling_booking_rules` row (null service = tenant-wide). */
export interface BookingRuleRow {
  serviceId: string | null;
  minLeadHours: number;
  maxLeadDays: number;
  allowSameDay: boolean;
  maxDailyBookings: number | null;
}

export interface DateWindow {
  from: string;
  to: string;
}

export interface AvailabilityInput {
  timezone: string;
  locale?: string;
  now: Date;
  /** Slot grid in minutes (default 15). */
  slotMinutes?: number;
  /** Days searched for "first available" and for nextOpenDate (default 60). */
  maxSearchDays?: number;
  businessHours: ClockBlock[];
  /** Every active staff member (eligibility is decided by the engine). */
  staff: StaffMember[];
  overrides: DateOverride[];
  bookings: BusyBooking[];
  rules: BookingRules;
  /** Requested services, in order; performed back-to-back by one staff member. */
  services: ServiceSpec[];
  /** A staff id, or 'any' / undefined for any eligible staff member. */
  staffId?: string;
  date?: string;
  window?: DateWindow;
  partOfDay?: PartOfDay;
  /** At most 5 (default 3). */
  limit?: number;
  /** Only this exact start (epoch ms) is considered: validates one requested slot. */
  at?: number;
  /** Return the slots closest to this instant (epoch ms) instead of spreading them across the day. */
  near?: number;
  /** Only starts at or after this instant (epoch ms), earliest first instead of spread across the day. */
  from?: number;
}

export interface Slot {
  start: string;
  end: string;
  /** end + the largest service buffer: when this staff member is free again once booked. */
  blockedUntil: string;
  staffId: string;
  staffName: string;
  /** `start` with the shop's own offset at that instant, so nothing has to convert it. */
  localTime: string;
  spoken: string;
}

export interface AvailabilityResult {
  slots: Slot[];
  nextOpenDate?: string;
  reasonIfNone?: NoSlotReason;
}

export interface SearchPlan {
  /** Dates whose slots may be offered. */
  days: string[];
  /** Dates searched for nextOpenDate when `days` has no slots. */
  nextOpenDays: string[];
  /** Inclusive date range loaders must cover (one day of slack each side). */
  loadFrom: string;
  loadTo: string;
}
