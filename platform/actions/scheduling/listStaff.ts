import { z } from 'zod';
import { actionOk, defineAction, isActionFailure } from '../core';
import { loadCatalog } from './availability';
import { readbackLang } from './readback';
import { resolveServiceRefs } from './serviceRefs';

const input = z.object({
  /** Only staff who perform this service: its id, or its exact name or alias. */
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
    + 'the staff who do that service: a service id from list_services is preferred, the exact service name '
    + '(or one of its aliases) also works. Use the id as staffId in check_availability.',
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
    const items = catalog.staff
      .map((m) => ({
        id: m.id,
        displayName: m.name,
        serviceIds: catalog.services.filter((s) => catalog.staffByService.get(s.id)!.has(m.id)).map((s) => s.id),
      }))
      .filter((m) => !serviceId || m.serviceIds.includes(serviceId));
    return actionOk(items);
  },
});
