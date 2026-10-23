import { z } from 'zod';
import { actionOk, defineAction, isActionFailure } from '../core';
import { loadCatalog, loadWeeklySchedules, WEEKDAY_KEYS, weeklyHours } from './availability';
import { readbackLang } from './readback';
import { resolveServiceRefs } from './serviceRefs';
import { spokenWeek } from './spokenHours';

const input = z.object({
  /** Only staff who perform this service: its id, or its exact name or alias. */
  serviceId: z.string().min(1).max(255).optional(),
});

const weekday = z.enum(WEEKDAY_KEYS);

const staffMember = z.object({
  id: z.string(),
  displayName: z.string(),
  /** The services they perform, by id and display name (the name list_services gives). */
  services: z.array(z.object({ id: z.string(), name: z.string() })),
  /** The same services' ids, in the same order; kept for older readers. */
  serviceIds: z.array(z.string()),
  /** Days they usually work, in the shop's time zone, Sunday first. */
  workingDays: z.array(weekday),
  /** Local hours per working day, e.g. { tue: '09:00-17:00' }. */
  hours: z.record(weekday, z.string()),
  /** The same hours as said on a call, in the caller's language, e.g. { tue: '9 AM to 5 PM' }. */
  spokenHours: z.record(weekday, z.string()),
});

export const listStaffAction = defineAction({
  name: 'scheduling.list_staff',
  tool: 'scheduling',
  kind: 'read',
  input,
  output: z.array(staffMember),
  permissions: { agent: true, mcpScope: 'qvo:read' },
  agentDescription:
    "List the shop's active staff, the services each performs, and the days and hours each usually works "
    + "(workingDays and hours, shop time). Each member's services come as {id, name}: match the caller's "
    + "service to a name there and send that entry's id; never infer a service from an id or its position "
    + '(service-1 is not the first or most common service). Pass serviceId to list only '
    + 'the staff who do that service: a service id from list_services is preferred, the exact service name '
    + '(or one of its aliases) also works. Use the member id as staffId in check_availability. '
    + 'When asked when someone works, say their workingDays as given, not the shop hours, '
    + 'and say their hours as spokenHours words them; for a specific date, check_availability decides.',
  async run(ctx, args, tx) {
    const catalog = await loadCatalog(tx, ctx.tenantId);
    const lang = readbackLang(ctx.locale);
    let serviceId: string | undefined;
    if (args.serviceId) {
      const found = resolveServiceRefs(catalog, [args.serviceId], {
        field: 'serviceId',
        lang,
        unknownCode: 'NOT_FOUND',
      });
      if (isActionFailure(found)) return found;
      serviceId = found[0].id;
    }
    const members = catalog.staff
      .map((m) => ({
        member: m,
        services: catalog.services
          .filter((s) => catalog.staffByService.get(s.id)!.has(m.id))
          .map((s) => ({ id: s.id, name: s.name })),
      }))
      .filter((m) => !serviceId || m.services.some((s) => s.id === serviceId));
    // The same schedule rows check_availability reads, in tenant wall-clock.
    const week = await loadWeeklySchedules(tx, ctx.tenantId, members.map((m) => m.member.id));
    const items = members.map(({ member, services }) => {
      const usual = weeklyHours(week.weeklyByStaff.get(member.id) ?? [], week.businessHours);
      return {
        id: member.id,
        displayName: member.name,
        services,
        serviceIds: services.map((s) => s.id),
        ...usual,
        spokenHours: spokenWeek(usual.hours, lang),
      };
    });
    return actionOk(items);
  },
});
