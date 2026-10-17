import { z } from 'zod';

export const TICKET_KINDS = ['message', 'callback', 'complaint', 'quote_request', 'intake', 'other'] as const;
export type TicketKind = (typeof TICKET_KINDS)[number];

export const TICKET_URGENCIES = ['normal', 'urgent'] as const;
export type TicketUrgency = (typeof TICKET_URGENCIES)[number];

// Mirrors tickets_status_check in 049_enterprise_ticketing.sql.
export const TICKET_STATUSES = ['open', 'in_progress', 'pending', 'escalated', 'resolved', 'closed', 'reopened'] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];

export const TICKET_PRIORITIES = ['low', 'medium', 'high', 'urgent'] as const;
export type TicketPriority = (typeof TICKET_PRIORITIES)[number];

/** Statuses that still need someone to act ("open" in list filters). */
export const ACTIVE_STATUSES: readonly TicketStatus[] = ['open', 'in_progress', 'pending', 'escalated', 'reopened'];

/**
 * Allowed status changes. Resolved/closed tickets must be reopened before
 * work resumes; nothing goes back to `open` once it has moved on.
 */
export const STATUS_TRANSITIONS: Record<TicketStatus, readonly TicketStatus[]> = {
  open: ['in_progress', 'pending', 'escalated', 'resolved', 'closed'],
  in_progress: ['pending', 'escalated', 'resolved', 'closed'],
  pending: ['in_progress', 'escalated', 'resolved', 'closed'],
  escalated: ['in_progress', 'pending', 'resolved', 'closed'],
  reopened: ['in_progress', 'pending', 'escalated', 'resolved', 'closed'],
  resolved: ['closed', 'reopened'],
  closed: ['reopened'],
};

export function canTransition(from: TicketStatus, to: TicketStatus): boolean {
  return from === to || STATUS_TRANSITIONS[from].includes(to);
}

const phoneSchema = z
  .string()
  .trim()
  .min(1)
  .max(32)
  .refine((value) => {
    const digits = value.replace(/\D/g, '').length;
    return digits >= 7 && digits <= 15;
  }, 'Phone number must have 7 to 15 digits');

const intakeFieldSchema = z.object({
  type: z.enum(['string', 'number', 'integer', 'boolean', 'array']),
  description: z.string().max(500).optional(),
  enum: z.array(z.union([z.string(), z.number()])).min(1).max(100).optional(),
  maxLength: z.number().int().positive().max(2000).optional(),
  minimum: z.number().optional(),
  maximum: z.number().optional(),
  items: z.object({ type: z.literal('string'), maxLength: z.number().int().positive().max(500).optional() }).optional(),
  maxItems: z.number().int().positive().max(50).optional(),
});

/**
 * A template's intake schema: a small JSON Schema subset (flat object of
 * primitives and string lists). Passed in the input for now; templates
 * will supply it once `platform/templates/use-cases` exists.
 */
export const intakeSchemaSchema = z.object({
  type: z.literal('object').optional(),
  properties: z.record(z.string().min(1).max(64), intakeFieldSchema),
  required: z.array(z.string()).max(50).optional(),
  additionalProperties: z.boolean().optional(),
});
export type IntakeSchema = z.infer<typeof intakeSchemaSchema>;

export const openPrepareInput = z.object({
  kind: z.enum(TICKET_KINDS),
  subject: z.string().trim().min(1).max(120),
  // No zod .default(): ActionDefinition.input is ZodType<I>, so input and output types must match.
  details: z.string().trim().max(2000).optional(),
  customer: z.object({
    name: z.string().trim().max(255).optional(),
    phone: phoneSchema,
  }),
  urgency: z.enum(TICKET_URGENCIES).optional(),
  callbackWindow: z.string().trim().min(1).max(120).optional(),
  intake: z.record(z.string(), z.unknown()).optional(),
  intakeSchema: intakeSchemaSchema.optional(),
  related: z.object({ type: z.string().trim().min(1).max(50), id: z.string().trim().min(1).max(255) }).optional(),
});
export type OpenPrepareInput = z.infer<typeof openPrepareInput>;

export const openPrepareOutput = z.object({
  confirmationToken: z.string(),
  expiresAt: z.string(),
  readback: z.string(),
  payloadHash: z.string(),
});

export const openCommitInput = z.object({
  confirmationToken: z.string().uuid(),
  payloadHash: z.string().length(64),
});

export const openCommitOutput = z.object({
  ticketId: z.string(),
  ticketNumber: z.number().int().nullable(),
  dueAt: z.string().nullable(),
  deduped: z.boolean(),
});

export const addNoteInput = z.object({
  ticketId: z.string().trim().min(1).max(255),
  note: z.string().trim().min(1).max(2000),
});

export const addNoteOutput = z.object({
  ticketId: z.string(),
  noted: z.literal(true),
});

export const updateInput = z
  .object({
    ticketId: z.string().trim().min(1).max(255),
    status: z.enum(TICKET_STATUSES).optional(),
    assigneeId: z.string().trim().min(1).max(255).nullable().optional(),
    priority: z.enum(TICKET_PRIORITIES).optional(),
    dueAt: z.string().datetime({ offset: true }).nullable().optional(),
  })
  .refine(
    (value) =>
      value.status !== undefined ||
      value.assigneeId !== undefined ||
      value.priority !== undefined ||
      value.dueAt !== undefined,
    { message: 'Nothing to update', path: ['status'] },
  );

export const ticketSummary = z.object({
  id: z.string(),
  ticketNumber: z.number().int().nullable(),
  kind: z.enum(TICKET_KINDS),
  status: z.enum(TICKET_STATUSES),
  priority: z.enum(TICKET_PRIORITIES),
  urgency: z.enum(TICKET_URGENCIES),
  subject: z.string(),
  contactName: z.string(),
  contactPhone: z.string(),
  assigneeId: z.string().nullable(),
  callbackDueAt: z.string().nullable(),
  overdue: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type TicketSummary = z.infer<typeof ticketSummary>;

export const listInput = z.object({
  status: z.enum(['open', 'overdue', 'all']).optional(),
  kind: z.enum(TICKET_KINDS).optional(),
  limit: z.number().int().min(1).max(100).optional(),
});

export const listOutput = z.object({ tickets: z.array(ticketSummary) });

export const getInput = z.object({ ticketId: z.string().trim().min(1).max(255) });

export const ticketDetail = ticketSummary.extend({
  details: z.string(),
  intake: z.record(z.string(), z.unknown()),
  callId: z.string().nullable(),
  sourceCallRef: z.string().nullable(),
  notes: z.array(z.object({ content: z.string(), createdAt: z.string() })),
});
export type TicketDetail = z.infer<typeof ticketDetail>;
