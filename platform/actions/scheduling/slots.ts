// Slot checks for the scheduling write actions. Every rule (hours, staff
// schedules, overrides, lead time, max days, same-day, daily caps, buffers,
// existing bookings and live holds) comes from PR-08's availability engine:
// a requested start is bookable only if the engine offers exactly that start.

import { actionFail, isActionFailure, type ActionContext, type ActionResult, type TenantTx } from '../core';
import {
  addDays,
  computeAvailability,
  DEFAULT_SLOT_MINUTES,
  loadAvailabilityData,
  loadBookingRuleRows,
  loadCatalog,
  localDateOf,
  localMinuteOf,
  MAX_LIMIT,
  MINUTE_MS,
  resolveBookingRules,
  searchPlan,
  type AvailabilityInput,
  type BookingRules,
  type Catalog,
  type CatalogService,
  type CatalogStaff,
  type Slot,
} from './availability';
import {
  callerMessage,
  intlLocale,
  readbackLang,
  staffMismatchMessage,
  type MessageKey,
} from './readback';
import { resolveServiceRefs } from './serviceRefs';
import { resolveStaffRef } from './staffRefs';

/** Alternatives offered with a CONFLICT (spec §1.5: at most 3). */
export const MAX_ALTERNATIVES = 3;

export interface SlotRequest {
  serviceIds: string[];
  /** A staff id, or 'any' for the engine's pick. */
  staffId: string;
  start: Date;
}

export interface ResolvedSlot {
  slot: Slot;
  services: CatalogService[];
  staff: CatalogStaff;
  startMs: number;
  endMs: number;
  /** end + buffer (bookings.blocked_until), sized the way the engine checks overlaps. */
  blockedUntilMs: number;
}

/** Catalog, rules and eligible staff for one request; availability is loaded fresh per call. */
export interface SlotScope {
  services: CatalogService[];
  catalog: Catalog;
  named: string | null;
  eligible: CatalogStaff[];
  rules: BookingRules;
}

function fail(code: 'VALIDATION_FAILED' | 'NOT_FOUND', message: string, field: string, safe: string): ActionResult<never> {
  return actionFail(code, message, { field, callerSafeMessage: safe });
}

/** Validates services and staff against the tenant's active catalog. */
export async function slotScope(
  tx: TenantTx,
  ctx: ActionContext,
  req: Pick<SlotRequest, 'serviceIds' | 'staffId'>,
): Promise<SlotScope | ActionResult<never>> {
  const lang = readbackLang(ctx.locale);
  const catalog = await loadCatalog(tx, ctx.tenantId);
  // An id, or an exact name/alias of exactly one service: never a looser guess,
  // a hold is for the service the agent named. Inactive, unknown and
  // other-tenant services all look the same: not bookable here.
  const services = resolveServiceRefs(catalog, req.serviceIds, {
    field: 'serviceIds',
    lang,
    unknownCode: 'VALIDATION_FAILED',
    unknownLabel: 'Unknown or inactive service',
  });
  if (isActionFailure(services)) return services;
  const serviceIds = services.map((s) => s.id);

  const performsAll = (staffId: string) => services.every((s) => catalog.staffByService.get(s.id)!.has(staffId));
  let named: string | null = null;
  if (req.staffId !== 'any') {
    // An id, or the exact name of exactly one staff member (staffRefs.ts).
    const member = resolveStaffRef(catalog, req.staffId, lang);
    if (isActionFailure(member)) return member;
    named = member.id;
    if (!performsAll(named)) {
      return fail(
        'VALIDATION_FAILED',
        `${named} does not perform every requested service`,
        'staffId',
        staffMismatchMessage(member.name, services.length > 1, lang),
      );
    }
  }
  const eligible = catalog.staff.filter((s) => (!named || s.id === named) && performsAll(s.id));
  if (eligible.length === 0) {
    const key: MessageKey = services.length > 1 ? 'noStaffForAll' : 'noStaffForOne';
    return fail('VALIDATION_FAILED', 'No active staff member performs every requested service', 'serviceIds', callerMessage(key, lang));
  }
  const rules = resolveBookingRules(await loadBookingRuleRows(tx, ctx.tenantId, serviceIds), serviceIds);
  return { services, catalog, named, eligible, rules };
}

async function engineInput(
  tx: TenantTx,
  ctx: ActionContext,
  scope: SlotScope,
  fromDate: string,
  toDate: string,
): Promise<Omit<AvailabilityInput, 'date' | 'window'>> {
  const { catalog } = scope;
  const data = await loadAvailabilityData(tx, ctx.tenantId, {
    staffIds: catalog.staff.map((s) => s.id),
    bookingStaffIds: scope.eligible.map((s) => s.id),
    fromDate,
    toDate,
    timezone: ctx.tenantTimezone,
    now: ctx.now,
  });
  return {
    timezone: ctx.tenantTimezone,
    locale: intlLocale(ctx.locale),
    now: ctx.now,
    businessHours: data.businessHours,
    staff: catalog.staff.map((s) => ({
      id: s.id,
      name: s.name,
      serviceIds: catalog.services.filter((svc) => catalog.staffByService.get(svc.id)!.has(s.id)).map((svc) => svc.id),
      weekly: data.weeklyByStaff.get(s.id) ?? [],
    })),
    overrides: data.overrides,
    bookings: data.bookings,
    rules: scope.rules,
    services: scope.services.map((s) => ({ id: s.id, name: s.name, durationMin: s.durationMin, bufferMin: s.bufferMin })),
    staffId: scope.named ?? 'any',
  };
}

/**
 * Up to 3 engine slots near the requested start for the same services and
 * staff preference: the closest ones that day, else the first open day
 * after it. The requested start itself is never offered back.
 */
export async function findAlternatives(
  tx: TenantTx,
  ctx: ActionContext,
  scope: SlotScope,
  startMs: number,
): Promise<Slot[]> {
  const tz = ctx.tenantTimezone;
  const today = localDateOf(ctx.now.getTime(), tz);
  const asked = localDateOf(startMs, tz);
  const date = asked < today ? today : asked;
  const notAsked = (s: Slot) => Date.parse(s.start) !== startMs;

  const sameDay = computeAvailability({
    ...(await engineInput(tx, ctx, scope, addDays(date, -1), addDays(date, 1))),
    date,
    near: startMs,
    limit: MAX_LIMIT,
  }).slots.filter(notAsked);
  if (sameDay.length > 0) {
    return sameDay
      .sort((a, b) => Math.abs(Date.parse(a.start) - startMs) - Math.abs(Date.parse(b.start) - startMs))
      .slice(0, MAX_ALTERNATIVES)
      .sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
  }

  const window = { from: addDays(date, 1), to: addDays(date, 14) };
  const plan = searchPlan({ today, window, rules: scope.rules, maxSearchDays: 14 });
  return computeAvailability({
    ...(await engineInput(tx, ctx, scope, plan.loadFrom, plan.loadTo)),
    window,
    maxSearchDays: 14,
    limit: MAX_ALTERNATIVES,
  }).slots.filter(notAsked);
}

export async function slotConflict(
  tx: TenantTx,
  ctx: ActionContext,
  scope: SlotScope,
  startMs: number,
  message: string,
  safeKey: MessageKey,
): Promise<ActionResult<never>> {
  const alternatives = await findAlternatives(tx, ctx, scope, startMs);
  return actionFail('CONFLICT', message, {
    alternatives,
    callerSafeMessage: callerMessage(safeKey, readbackLang(ctx.locale)),
  });
}

/**
 * The engine's slot at exactly `start`, or the action error: off-grid and
 * lead-time/max-days/same-day misses are VALIDATION_FAILED; any other start
 * the engine doesn't offer (closed, staff off, booked, held) is CONFLICT with
 * alternatives. For 'any', the staff member is the one the engine assigns.
 */
export async function resolveSlot(
  tx: TenantTx,
  ctx: ActionContext,
  req: SlotRequest,
  scopeArg?: SlotScope,
): Promise<ResolvedSlot | ActionResult<never>> {
  const lang = readbackLang(ctx.locale);
  const scope = scopeArg ?? (await slotScope(tx, ctx, req));
  if (isActionFailure(scope)) return scope;

  const tz = ctx.tenantTimezone;
  const startMs = req.start.getTime();
  if (startMs % MINUTE_MS !== 0 || localMinuteOf(startMs, tz) % DEFAULT_SLOT_MINUTES !== 0) {
    return fail('VALIDATION_FAILED', `start must align to the ${DEFAULT_SLOT_MINUTES}-minute grid`, 'start', callerMessage('offGrid', lang));
  }

  const date = localDateOf(startMs, tz);
  const exact = computeAvailability({
    ...(await engineInput(tx, ctx, scope, addDays(date, -1), addDays(date, 1))),
    date,
    at: startMs,
    limit: 1,
  });
  const slot = exact.slots[0];
  if (slot) {
    const durationMs = scope.services.reduce((sum, s) => sum + s.durationMin, 0) * MINUTE_MS;
    // Same buffer rule as the engine's overlap check (largest buffer of the services).
    const bufferMs = scope.services.reduce((max, s) => Math.max(max, s.bufferMin), 0) * MINUTE_MS;
    const staff = scope.catalog.staff.find((s) => s.id === slot.staffId)!;
    return { slot, services: scope.services, staff, startMs, endMs: startMs + durationMs, blockedUntilMs: startMs + durationMs + bufferMs };
  }
  if (exact.reasonIfNone === 'outside_lead_time') {
    return fail('VALIDATION_FAILED', 'start is outside the booking lead-time window', 'start', callerMessage('outsideLead', lang));
  }
  return slotConflict(tx, ctx, scope, startMs, `Slot not offered (${exact.reasonIfNone ?? 'unavailable'})`, 'slotUnavailable');
}
