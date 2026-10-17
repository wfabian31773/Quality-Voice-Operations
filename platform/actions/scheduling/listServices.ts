import { z } from 'zod';
import { formatCurrency } from '../../core/formatCurrency';
import { actionFail, actionOk, defineAction } from '../core';
import { loadCatalog, type CatalogService } from './availability';

const input = z.object({
  /** Only services this staff member performs ('any' = no filter). */
  staffId: z.string().min(1).max(255).optional(),
});

const service = z.object({
  id: z.string(),
  name: z.string(),
  durationMin: z.number().int(),
  /** Exactly what the agent says ("from $45"); null = the shop will confirm. */
  priceText: z.string().nullable(),
  staffIds: z.array(z.string()),
});

export type ServiceListItem = z.infer<typeof service>;

function dollars(cents: number): string {
  const digits = cents % 100 === 0 ? 0 : 2;
  return formatCurrency(cents, { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

const PRICE_WORDS = {
  en: { from: 'from', to: 'to' },
  es: { from: 'desde', to: 'a' },
} as const;

/** Spoken price text for a service (§1.5: say it exactly). English unless `lang` is 'es'. */
export function priceText(
  s: Pick<CatalogService, 'priceKind' | 'priceCents' | 'priceMaxCents'>,
  lang: keyof typeof PRICE_WORDS = 'en',
): string | null {
  if (s.priceCents === null) return null;
  const words = PRICE_WORDS[lang];
  switch (s.priceKind) {
    case 'fixed':
      return dollars(s.priceCents);
    case 'from':
      return `${words.from} ${dollars(s.priceCents)}`;
    case 'range':
      return s.priceMaxCents === null
        ? `${words.from} ${dollars(s.priceCents)}`
        : `${dollars(s.priceCents)} ${words.to} ${dollars(s.priceMaxCents)}`;
    default:
      return null;
  }
}

export const listServicesAction = defineAction({
  name: 'scheduling.list_services',
  tool: 'scheduling',
  kind: 'read',
  input,
  output: z.array(service),
  permissions: { agent: true, mcpScope: 'qvo:read' },
  agentDescription:
    "List the shop's bookable services with duration, spoken price text and who performs each. "
    + 'Pass staffId to list only what that staff member does. Never offer a service that is not in this list.',
  async run(ctx, args, tx) {
    const catalog = await loadCatalog(tx, ctx.tenantId);
    const staffId = args.staffId && args.staffId !== 'any' ? args.staffId : null;
    if (staffId && !catalog.staff.some((s) => s.id === staffId)) {
      return actionFail('NOT_FOUND', `Unknown staff member: ${staffId}`, {
        field: 'staffId',
        callerSafeMessage: "I couldn't find that staff member.",
      });
    }
    const items = catalog.services
      .map((s) => ({
        id: s.id,
        name: s.name,
        durationMin: s.durationMin,
        priceText: priceText(s),
        staffIds: [...(catalog.staffByService.get(s.id) ?? [])],
      }))
      .filter((s) => !staffId || s.staffIds.includes(staffId));
    return actionOk(items);
  },
});
