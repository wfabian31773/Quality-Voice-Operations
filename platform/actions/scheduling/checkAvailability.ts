import { z } from 'zod';
import { actionFail, actionOk, defineAction } from '../core';
import {
  addDays,
  computeAvailability,
  isRealIsoDate,
  loadAvailabilityData,
  loadBookingRuleRows,
  loadCatalog,
  localDateOf,
  MAX_LIMIT,
  NO_SLOT_REASONS,
  PARTS_OF_DAY,
  resolveBookingRules,
  searchPlan,
  type CatalogService,
} from './availability';

/** Longest date window a caller can ask about in one check. */
export const MAX_WINDOW_DAYS = 14;

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a YYYY-MM-DD date')
  .refine(isRealIsoDate, 'Not a real calendar date');

const input = z
  .object({
    serviceIds: z.array(z.string().min(1).max(255)).min(1).max(3),
    /** A staff id from list_staff, or 'any'. */
    staffId: z.string().min(1).max(255).optional(),
    date: isoDate.optional(),
    window: z.object({ from: isoDate, to: isoDate }).optional(),
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
      const { from, to } = value.window;
      if (to < from) {
        issue.addIssue({ code: z.ZodIssueCode.custom, path: ['window', 'to'], message: 'window.to is before window.from' });
      } else if (isRealIsoDate(from) && isRealIsoDate(to) && addDays(from, MAX_WINDOW_DAYS - 1) < to) {
        issue.addIssue({ code: z.ZodIssueCode.custom, path: ['window', 'to'], message: `A window covers at most ${MAX_WINDOW_DAYS} days` });
      }
    }
  });

const output = z.object({
  slots: z.array(
    z.object({
      start: z.string(),
      end: z.string(),
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
    + "staffId is a staff id or 'any'. Give date (YYYY-MM-DD, resolved from the tenant's current time) "
    + 'or window {from,to}; with neither it finds the first available day. Optional partOfDay '
    + '(morning, afternoon, evening) and limit (max 5). Offer at most 3 slots using their spoken text. '
    + 'With no slots, say reasonIfNone truthfully and offer nextOpenDate. Re-check if more than 2 minutes pass before booking.',
  async run(ctx, args, tx) {
    const tz = ctx.tenantTimezone;
    const today = localDateOf(ctx.now.getTime(), tz);
    const firstDay = args.date ?? args.window?.from;
    if (firstDay && firstDay < today) {
      return actionFail('VALIDATION_FAILED', `Date ${firstDay} is before today (${today})`, {
        field: args.date ? 'date' : 'window.from',
        callerSafeMessage: 'That date has already passed.',
      });
    }

    const catalog = await loadCatalog(tx, ctx.tenantId);
    const services: CatalogService[] = [];
    for (const id of args.serviceIds) {
      const svc = catalog.services.find((s) => s.id === id);
      if (!svc) {
        return actionFail('NOT_FOUND', `Unknown service: ${id}`, {
          field: 'serviceIds',
          callerSafeMessage: "I couldn't find that service.",
        });
      }
      services.push(svc);
    }

    const performsAll = (staffId: string) =>
      services.every((s) => catalog.staffByService.get(s.id)!.has(staffId));
    const named = args.staffId && args.staffId !== 'any' ? args.staffId : null;
    if (named) {
      const member = catalog.staff.find((s) => s.id === named);
      if (!member) {
        return actionFail('NOT_FOUND', `Unknown staff member: ${named}`, {
          field: 'staffId',
          callerSafeMessage: "I couldn't find that staff member.",
        });
      }
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

    const rules = resolveBookingRules(await loadBookingRuleRows(tx, ctx.tenantId, args.serviceIds), args.serviceIds);
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
