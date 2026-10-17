import { z } from 'zod';
import { formatCurrency } from '../../core/formatCurrency';
import { actionFail, actionOk, defineAction } from '../core';
import { loadCatalog, type CatalogService } from './availability';
import { resolveServiceByName } from './serviceMatch';

const input = z.object({
  /** Only services this staff member performs ('any' = no filter). */
  staffId: z.string().min(1).max(255).optional(),
  /** What the caller called the service ("a skin fade", "degradado"); only the matching services come back. */
  query: z.string().min(1).max(80).optional(),
  /** Caller's language; only breaks ties between equally long EN/ES terms in `query`. */
  lang: z.enum(['en', 'es']).optional(),
});

const service = z.object({
  id: z.string(),
  name: z.string(),
  durationMin: z.number().int(),
  /** Exactly what the agent says ("from $45"); null = the shop will confirm. */
  priceText: z.string().nullable(),
  staffIds: z.array(z.string()),
  /** Other names callers use for it (catalog aliases); omitted when there are none. */
  aliases: z.array(z.string()).optional(),
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
    + 'Pass staffId to list only what that staff member does. '
    + "Pass query with the caller's words for a service (\"skin fade\", \"degradado\") to get only the matching services: "
    + 'one result is the service; several mean either a tie or that the caller named several services, '
    + 'so ask which one (or whether they want each of them); none means the shop does not list it. '
    + 'Never offer a service that is not in this list.',
  async run(ctx, args, tx) {
    const catalog = await loadCatalog(tx, ctx.tenantId);
    const staffId = args.staffId && args.staffId !== 'any' ? args.staffId : null;
    if (staffId && !catalog.staff.some((s) => s.id === staffId)) {
      return actionFail('NOT_FOUND', `Unknown staff member: ${staffId}`, {
        field: 'staffId',
        callerSafeMessage: "I couldn't find that staff member.",
      });
    }
    // Spoken name → catalog services (name, then aliases, then the EN/ES
    // lexicon). Ties, and several services named at once, come back together
    // so the agent asks.
    const services = args.query
      ? resolveServiceByName(catalog, args.query, args.lang).candidates
      : catalog.services;
    const items = services
      .map((s) => ({
        id: s.id,
        name: s.name,
        durationMin: s.durationMin,
        priceText: priceText(s),
        staffIds: [...(catalog.staffByService.get(s.id) ?? [])],
        ...(s.aliases && s.aliases.length > 0 ? { aliases: s.aliases } : {}),
      }))
      .filter((s) => !staffId || s.staffIds.includes(staffId));
    return actionOk(items);
  },
});
