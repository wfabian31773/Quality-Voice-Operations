import { intakeSchemaSchema, TICKET_KINDS, type IntakeSchema, type TicketKind } from './schemas';

/** Accepts no intake fields at all (an empty intake still passes). */
const NO_FIELDS: IntakeSchema = { type: 'object', properties: {}, additionalProperties: false };

const shortText = (description: string, maxLength = 200) => ({ type: 'string' as const, description, maxLength });

/**
 * Built-in intake schema per ticket kind, used when the tenant has none
 * configured. Every field is optional; anything not listed is rejected.
 * Use-case templates will replace these later.
 */
export const DEFAULT_INTAKE_SCHEMAS: Record<TicketKind, IntakeSchema> = {
  message: NO_FIELDS,
  callback: NO_FIELDS,
  other: NO_FIELDS,
  complaint: {
    type: 'object',
    properties: {
      incidentDate: shortText('When it happened, as the caller said it', 100),
      reference: shortText('Booking, order or job reference', 100),
    },
    additionalProperties: false,
  },
  quote_request: {
    type: 'object',
    properties: {
      serviceType: shortText('What the caller wants a quote for'),
      address: shortText('Where the work would happen', 300),
      timeframe: shortText('When the caller needs it', 120),
      budget: shortText('Budget, as the caller said it', 100),
    },
    additionalProperties: false,
  },
  intake: {
    type: 'object',
    properties: {
      matterType: shortText('Type of matter or request', 120),
      otherParties: { type: 'array', items: { type: 'string', maxLength: 200 }, maxItems: 10 },
      deadline: shortText('Any deadline the caller mentioned', 120),
    },
    additionalProperties: false,
  },
};

export type TenantIntakeSchemas = Partial<Record<TicketKind, IntakeSchema>>;

/**
 * Parses `tenants.settings.tickets.intakeSchemas` ({ [kind]: schema }).
 * A configured but malformed schema fails closed to "no fields" rather than
 * falling back to the more permissive built-in default.
 */
export function parseTenantIntakeSchemas(value: unknown): TenantIntakeSchemas {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out: TenantIntakeSchemas = {};
  for (const kind of TICKET_KINDS) {
    const raw = (value as Record<string, unknown>)[kind];
    if (raw === undefined || raw === null) continue;
    const parsed = intakeSchemaSchema.safeParse(raw);
    out[kind] = parsed.success ? parsed.data : NO_FIELDS;
  }
  return out;
}

export function intakeSchemaFor(kind: TicketKind, tenantSchemas: TenantIntakeSchemas): IntakeSchema {
  return tenantSchemas[kind] ?? DEFAULT_INTAKE_SCHEMAS[kind];
}
