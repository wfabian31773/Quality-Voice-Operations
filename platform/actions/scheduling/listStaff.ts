import { z } from 'zod';
import { actionFail, actionOk, defineAction } from '../core';
import { loadCatalog } from './availability';

const input = z.object({
  /** Only staff who perform this service. */
  serviceId: z.string().min(1).max(255).optional(),
});

const staffMember = z.object({
  id: z.string(),
  displayName: z.string(),
  serviceIds: z.array(z.string()),
});

export const listStaffAction = defineAction({
  name: 'scheduling.list_staff',
  tool: 'scheduling',
  kind: 'read',
  input,
  output: z.array(staffMember),
  permissions: { agent: true, mcpScope: 'qvo:read' },
  agentDescription:
    "List the shop's active staff and the services each performs. Pass serviceId to list only "
    + 'the staff who do that service. Use the id as staffId in check_availability.',
  async run(ctx, args, tx) {
    const catalog = await loadCatalog(tx, ctx.tenantId);
    if (args.serviceId && !catalog.staffByService.has(args.serviceId)) {
      return actionFail('NOT_FOUND', `Unknown service: ${args.serviceId}`, {
        field: 'serviceId',
        callerSafeMessage: "I couldn't find that service.",
      });
    }
    const items = catalog.staff
      .map((m) => ({
        id: m.id,
        displayName: m.name,
        serviceIds: catalog.services.filter((s) => catalog.staffByService.get(s.id)!.has(m.id)).map((s) => s.id),
      }))
      .filter((m) => !args.serviceId || m.serviceIds.includes(args.serviceId));
    return actionOk(items);
  },
});
