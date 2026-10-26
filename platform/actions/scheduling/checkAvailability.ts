import { z } from 'zod';
import { DATE_SLOT_FORMAT } from '../../callcore/contracts';
import { actionFail, actionOk, defineAction, isActionFailure } from '../core';
import {
  addDays,
  computeAvailability,
  loadAvailabilityData,
  loadBookingRuleRows,
  loadCatalog,
  localDateOf,
  MAX_LIMIT,
  NO_SLOT_REASONS,
  PARTS_OF_DAY,
  resolveBookingRules,
  searchPlan,
} from './availability';
import { dateSlot, toTenantDate, writtenDate } from './dateSlot';
import { readbackLang } from './readback';
import { resolveServiceRefs } from './serviceRefs';
import { resolveStaffRef } from './staffRefs';

/** Longest date window a caller can ask about in one check. */
export const MAX_WINDOW_DAYS = 14;

/** What is wrong with a window (both ends real YYYY-MM-DD dates), or undefined. */
function windowIssue(from: string, to: string): string | undefined {
  if (to < from) return 'window.to is before window.from';
  if (addDays(from, MAX_WINDOW_DAYS - 1) < to) return `A window covers at most ${MAX_WINDOW_DAYS} days`;
  return undefined;
}

const input = z
  .object({
    /** Service ids from list_services; an exact service name or alias also resolves. */
    serviceIds: z.array(z.string().min(1).max(255)).min(1).max(3),
    /** A staff id from list_staff, or 'any'; an exact staff name also resolves. */
    staffId: z.string().min(1).max(255).optional(),
    date: dateSlot.optional(),
    window: z.object({ from: dateSlot, to: dateSlot }).optional(),
    partOfDay: z.enum(PARTS_OF_DAY).optional(),
    limit: z.number().int().min(1).max(MAX_LIMIT).optional(),
  })
  .superRefine((value, issue) => {
    if (new Set(value.serviceIds).size !== value.serviceIds.length) {
      issue.addIssue({ code: z.ZodIssueCode.custom, path: ['serviceIds'], message: 'Each service may appear once' });
    }
    if (value.date && value.window) {
      issue.addIssue({ code: z.ZodIssueCode.custom, path: ['window'], message: 'Send either date or window, not both' });
    }
    if (value.window) {
      const [from, to] = [writtenDate(value.window.from), writtenDate(value.window.to)];
      const problem = from && to ? windowIssue(from, to) : undefined;
      if (problem) issue.addIssue({ code: z.ZodIssueCode.custom, path: ['window', 'to'], message: problem });
    }
  });

const output = z.object({
  slots: z.array(
    z.object({
      start: z.string(),
      end: z.string(),
      blockedUntil: z.string(),
      staffId: z.string(),
      staffName: z.string(),
      spoken: z.string(),
    }),
  ),
  nextOpenDate: z.string().optional(),
  reasonIfNone: z.enum(NO_SLOT_REASONS).optional(),
});

export const checkAvailabilityAction = defineAction({
  name: 'scheduling.check_availability',
  tool: 'scheduling',
  kind: 'read',
  input,
  output,
  permissions: { agent: true, mcpScope: 'qvo:read' },
  agentDescription:
    'Find open appointment times for 1 to 3 services done back-to-back by one staff member. '
    + 'serviceIds: service ids from list_services are preferred; an exact service name (or alias) also works. '
    + `staffId is a staff id from list_staff or 'any'; their exact name also works. Give date (${DATE_SLOT_FORMAT}) `
    + 'or window {from,to} in the same format; with neither it finds the first available day. Optional partOfDay '
    + '(morning, afternoon, evening) and limit (max 5). Offer at most 3 slots using their spoken text. '
    + 'blockedUntil is when that staff member is free again (end plus clean-up time). '
    + 'With no slots, say reasonIfNone truthfully and offer nextOpenDate. Re-check if more than 2 minutes pass before booking.',
  async run(ctx, rawArgs, tx) {
    const tz = ctx.tenantTimezone;
    // Accepted date variants become the tenant's YYYY-MM-DD here (dateSlot.ts).
    const args = {
      ...rawArgs,
      date: rawArgs.date === undefined ? undefined : toTenantDate(rawArgs.date, tz),
      window: rawArgs.window && { from: toTenantDate(rawArgs.window.from, tz), to: toTenantDate(rawArgs.window.to, tz) },
    };
    if (args.window) {
      // A zoned datetime can land a day off its written date: check the window again.
      const problem = windowIssue(args.window.from, args.window.to);
      if (problem) return actionFail('VALIDATION_FAILED', problem, { field: 'window.to' });
    }
    const today = localDateOf(ctx.now.getTime(), tz);
    const firstDay = args.date ?? args.window?.from;
    if (firstDay && firstDay < today) {
      return actionFail('VALIDATION_FAILED', `Date ${firstDay} is before today (${today})`, {
        field: args.date ? 'date' : 'window.from',
        callerSafeMessage: 'That date has already passed.',
      });
    }

    const catalog = await loadCatalog(tx, ctx.tenantId);
    const lang = readbackLang(ctx.locale);
    const services = resolveServiceRefs(catalog, args.serviceIds, {
      field: 'serviceIds',
      lang,
      unknownCode: 'NOT_FOUND',
    });
    if (isActionFailure(services)) return services;
    const serviceIds = services.map((s) => s.id);

    const performsAll = (staffId: string) =>
      services.every((s) => catalog.staffByService.get(s.id)!.has(staffId));
    let named: string | null = null;
    if (args.staffId && args.staffId !== 'any') {
      const member = resolveStaffRef(catalog, args.staffId, lang);
      if (isActionFailure(member)) return member;
      named = member.id;
      if (!performsAll(named)) {
        return actionFail('VALIDATION_FAILED', `${named} does not perform every requested service`, {
          field: 'staffId',
          callerSafeMessage: `${member.name} doesn't do ${services.length > 1 ? 'all of those services' : 'that service'}.`,
        });
      }
    }
    const eligible = catalog.staff.filter((s) => (!named || s.id === named) && performsAll(s.id));
    if (eligible.length === 0) {
      return actionFail('VALIDATION_FAILED', 'No active staff member performs every requested service', {
        field: 'serviceIds',
        callerSafeMessage: services.length > 1
          ? "No one here does all of those services in one visit."
          : "No one is set up to do that service right now.",
      });
    }

    const rules = resolveBookingRules(await loadBookingRuleRows(tx, ctx.tenantId, serviceIds), serviceIds);
    const plan = searchPlan({ today, date: args.date, window: args.window, rules });
    const data = await loadAvailabilityData(tx, ctx.tenantId, {
      staffIds: catalog.staff.map((s) => s.id),
      bookingStaffIds: eligible.map((s) => s.id),
      fromDate: plan.loadFrom,
      toDate: plan.loadTo,
      timezone: tz,
      now: ctx.now,
    });

    const result = computeAvailability({
      timezone: tz,
      locale: ctx.locale,
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
      rules,
      services: services.map((s) => ({ id: s.id, name: s.name, durationMin: s.durationMin, bufferMin: s.bufferMin })),
      staffId: named ?? 'any',
      date: args.date,
      window: args.window,
      partOfDay: args.partOfDay,
      limit: args.limit,
    });
    return actionOk(result);
  },
});
