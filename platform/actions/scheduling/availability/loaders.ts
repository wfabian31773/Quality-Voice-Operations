// Read-only loaders for the scheduling read actions. They run on the action's
// tenant transaction (runAction → withTenantClient → withTenantContext, so
// RLS is bound to app.tenant_id) and also filter by tenant_id explicitly.
// QVO tables only: no external calendars.

import type { TenantTx } from '../../core/types';
import type { PriceKind } from '../types';
import { BUSY_STATUSES } from './engine';
import { addDays, wallClockToUtc } from './time';
import type { BookingRuleRow, BusyBooking, ClockBlock, DateOverride } from './types';

export interface CatalogService {
  id: string;
  name: string;
  durationMin: number;
  bufferMin: number;
  priceKind: PriceKind;
  priceCents: number | null;
  priceMaxCents: number | null;
  /** Spoken alternatives for the name (migration 125). Absent when the column is missing or empty. */
  aliases?: string[];
}

export interface CatalogStaff {
  id: string;
  name: string;
}

export interface Catalog {
  /** Active services, by name. */
  services: CatalogService[];
  /** Active staff, by name. */
  staff: CatalogStaff[];
  /** serviceId → ids of active staff who perform it. */
  staffByService: Map<string, Set<string>>;
}

function str(value: unknown): string {
  return value == null ? '' : String(value);
}

function intOrNull(value: unknown): number | null {
  if (value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function toDate(value: unknown): Date {
  return value instanceof Date ? value : new Date(String(value));
}

function aliasList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((a): a is string => typeof a === 'string' && a.trim() !== '').map((a) => a.trim());
}

export async function loadCatalog(tx: TenantTx, tenantId: string): Promise<Catalog> {
  // aliases is read through to_jsonb(row) so the query also works on a
  // database where migration 125 has not run yet (the key is just absent).
  const services = await tx.query(
    `SELECT id, name, duration_minutes, buffer_minutes, price_kind, price_cents, price_max_cents,
            to_jsonb(scheduling_appointment_types) -> 'aliases' AS aliases
       FROM scheduling_appointment_types
      WHERE tenant_id = $1 AND is_active = true
      ORDER BY name, id`,
    [tenantId],
  );
  const staff = await tx.query(
    `SELECT id, name
       FROM scheduling_providers
      WHERE tenant_id = $1 AND is_active = true
      ORDER BY name, id`,
    [tenantId],
  );
  const links = await tx.query(
    `SELECT provider_id, appointment_type_id
       FROM scheduling_provider_services
      WHERE tenant_id = $1`,
    [tenantId],
  );

  const catalog: Catalog = {
    services: services.rows.map((r) => {
      const aliases = aliasList(r.aliases);
      return {
        id: str(r.id),
        name: str(r.name),
        durationMin: intOrNull(r.duration_minutes) ?? 0,
        bufferMin: intOrNull(r.buffer_minutes) ?? 0,
        priceKind: (str(r.price_kind) || 'hidden') as PriceKind,
        priceCents: intOrNull(r.price_cents),
        priceMaxCents: intOrNull(r.price_max_cents),
        ...(aliases.length > 0 ? { aliases } : {}),
      };
    }),
    staff: staff.rows.map((r) => ({ id: str(r.id), name: str(r.name) })),
    staffByService: new Map(),
  };

  const activeStaff = new Set(catalog.staff.map((s) => s.id));
  for (const s of catalog.services) catalog.staffByService.set(s.id, new Set());
  for (const r of links.rows) {
    const set = catalog.staffByService.get(str(r.appointment_type_id));
    if (set && activeStaff.has(str(r.provider_id))) set.add(str(r.provider_id));
  }
  return catalog;
}

export async function loadBookingRuleRows(
  tx: TenantTx,
  tenantId: string,
  serviceIds: string[],
): Promise<BookingRuleRow[]> {
  const { rows } = await tx.query(
    `SELECT appointment_type_id, min_lead_time_hours, max_lead_time_days, allow_same_day, max_daily_bookings
       FROM scheduling_booking_rules
      WHERE tenant_id = $1
        AND (appointment_type_id IS NULL OR appointment_type_id = ANY($2::text[]))
      ORDER BY created_at, id`,
    [tenantId, serviceIds],
  );
  return rows.map((r) => ({
    serviceId: r.appointment_type_id == null ? null : str(r.appointment_type_id),
    minLeadHours: intOrNull(r.min_lead_time_hours) ?? 0,
    maxLeadDays: intOrNull(r.max_lead_time_days) ?? 90,
    allowSameDay: r.allow_same_day !== false,
    maxDailyBookings: intOrNull(r.max_daily_bookings),
  }));
}

export interface WeeklySchedules {
  businessHours: ClockBlock[];
  /** staffId → weekly blocks (missing = follows business hours). */
  weeklyByStaff: Map<string, ClockBlock[]>;
}

export interface AvailabilityData extends WeeklySchedules {
  overrides: DateOverride[];
  bookings: BusyBooking[];
}

/** Business hours and the weekly schedules of `staffIds` (tenant wall-clock). */
export async function loadWeeklySchedules(tx: TenantTx, tenantId: string, staffIds: string[]): Promise<WeeklySchedules> {
  const hours = await tx.query(
    `SELECT day_of_week, open_time::text AS open_time, close_time::text AS close_time
       FROM scheduling_business_hours
      WHERE tenant_id = $1
      ORDER BY day_of_week, open_time`,
    [tenantId],
  );
  const schedules = await tx.query(
    `SELECT provider_id, day_of_week, start_time::text AS start_time, end_time::text AS end_time
       FROM scheduling_provider_schedules
      WHERE tenant_id = $1 AND is_active = true AND provider_id = ANY($2::text[])
      ORDER BY provider_id, day_of_week, start_time`,
    [tenantId, staffIds],
  );

  const weeklyByStaff = new Map<string, ClockBlock[]>();
  for (const r of schedules.rows) {
    const id = str(r.provider_id);
    const list = weeklyByStaff.get(id) ?? [];
    list.push({ dayOfWeek: Number(r.day_of_week), start: str(r.start_time), end: str(r.end_time) });
    weeklyByStaff.set(id, list);
  }
  return {
    businessHours: hours.rows.map((r) => ({
      dayOfWeek: Number(r.day_of_week),
      start: str(r.open_time),
      end: str(r.close_time),
    })),
    weeklyByStaff,
  };
}

export async function loadAvailabilityData(
  tx: TenantTx,
  tenantId: string,
  opts: {
    /** Staff whose schedules and overrides are needed. */
    staffIds: string[];
    /** Staff whose bookings are needed (the eligible ones). */
    bookingStaffIds: string[];
    /** Inclusive tenant-local date range. */
    fromDate: string;
    toDate: string;
    timezone: string;
    now: Date;
  },
): Promise<AvailabilityData> {
  const weekly = await loadWeeklySchedules(tx, tenantId, opts.staffIds);
  const overrides = await tx.query(
    `SELECT provider_id, override_date::text AS override_date,
            start_time::text AS start_time, end_time::text AS end_time, is_available
       FROM scheduling_overrides
      WHERE tenant_id = $1
        AND override_date BETWEEN $2::date AND $3::date
        AND (provider_id IS NULL OR provider_id = ANY($4::text[]))`,
    [tenantId, opts.fromDate, opts.toDate, opts.staffIds],
  );
  const rangeStart = new Date(wallClockToUtc(opts.fromDate, 0, opts.timezone));
  const rangeEnd = new Date(wallClockToUtc(addDays(opts.toDate, 1), 0, opts.timezone));
  const bookings = await tx.query(
    `SELECT provider_id, start_time, COALESCE(blocked_until, end_time) AS blocked_until, status, hold_expires_at
       FROM bookings
      WHERE tenant_id = $1
        AND provider_id = ANY($2::text[])
        AND status = ANY($3::text[])
        AND (status <> 'held' OR hold_expires_at > $4)
        AND start_time < $6
        AND COALESCE(blocked_until, end_time) > $5`,
    [tenantId, opts.bookingStaffIds, [...BUSY_STATUSES], opts.now, rangeStart, rangeEnd],
  );

  return {
    ...weekly,
    overrides: overrides.rows.map((r) => ({
      date: str(r.override_date).slice(0, 10),
      staffId: r.provider_id == null ? null : str(r.provider_id),
      start: r.start_time == null ? null : str(r.start_time),
      end: r.end_time == null ? null : str(r.end_time),
      isAvailable: r.is_available === true,
    })),
    bookings: bookings.rows.map((r) => ({
      staffId: str(r.provider_id),
      start: toDate(r.start_time),
      blockedUntil: toDate(r.blocked_until),
      status: str(r.status),
      holdExpiresAt: r.hold_expires_at == null ? null : toDate(r.hold_expires_at),
    })),
  };
}
