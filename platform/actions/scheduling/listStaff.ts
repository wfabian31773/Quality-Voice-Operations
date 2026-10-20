import { z } from 'zod';
import { actionOk, defineAction, isActionFailure } from '../core';
import { loadCatalog, loadWeeklySchedules, WEEKDAY_KEYS, weeklyHours } from './availability';
import { readbackLang } from './readback';
import { resolveServiceRefs } from './serviceRefs';

const input = z.object({
  /** Only staff who perform this service: its id, or its exact name or alias. */
  serviceId: z.string().min(1).max(255).optional(),
});

const weekday = z.enum(WEEKDAY_KEYS);

const staffMember = z.object({
  id: z.string(),
  displayName: z.string(),
  serviceIds: z.array(z.string()),
  /** Days they usually work, in the shop's time zone, Sunday first. */
  workingDays: z.array(weekday),
  /** Local hours per working day, e.g. { tue: '09:00-17:00' }. */
  hours: z.record(weekday, z.string()),
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
    + '(workingDays and hours, shop time). Pass serviceId to list only '
    + 'the staff who do that service: a service id from list_services is preferred, the exact service name '
    + '(or one of its aliases) also works. Use the id as staffId in check_availability. '
    + 'When asked when someone works, say their workingDays as given, not the shop hours; '
    + 'for a specific date, check_availability decides.',
  async run(ctx, args, tx) {
    const catalog = await loadCatalog(tx, ctx.tenantId);
    let serviceId: string | undefined;
    if (args.serviceId) {
      const found = resolveServiceRefs(catalog, [args.serviceId], {
        field: 'serviceId',
        lang: readbackLang(ctx.locale),
        unknownCode: 'NOT_FOUND',
      });
      if (isActionFailure(found)) return found;
      serviceId = found[0].id;
    }
    const members = catalog.staff
      .map((m) => ({
        member: m,
        serviceIds: catalog.services.filter((s) => catalog.staffByService.get(s.id)!.has(m.id)).map((s) => s.id),
      }))
      .filter((m) => !serviceId || m.serviceIds.includes(serviceId));
    // The same schedule rows check_availability reads, in tenant wall-clock.
    const week = await loadWeeklySchedules(tx, ctx.tenantId, members.map((m) => m.member.id));
    const items = members.map(({ member, serviceIds }) => ({
      id: member.id,
      displayName: member.name,
      serviceIds,
      ...weeklyHours(week.weeklyByStaff.get(member.id) ?? [], week.businessHours),
    }));
    return actionOk(items);
  },
});
