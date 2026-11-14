import { z } from 'zod';

/** Path ids are VARCHAR(255); historical fixtures are not always UUIDs. */
export const bookingIdSchema = z.string().trim().min(1).max(255);

export const bookingIdParamsSchema = z.object({
  id: bookingIdSchema,
});

const optionalId = z
  .string()
  .max(255)
  .nullable()
  .optional()
  .transform((value) => (value === '' ? null : value));

const optionalText = (max: number) => z.string().max(max).optional();

const optionalEmail = z
  .string()
  .max(255)
  .optional()
  .refine((value) => value === undefined || value === '' || z.string().email().safeParse(value).success, {
    message: 'Invalid email',
  });

/**
 * Client datetime-local values (`YYYY-MM-DDTHH:MM`) plus ISO instants with
 * `Z` or an offset. Keeps the Scheduling page payload valid.
 */
const ISO_DATE_TIME_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})?$/;

export const isoDateTimeSchema = z
  .string()
  .trim()
  .min(16)
  .max(40)
  .refine((value) => ISO_DATE_TIME_RE.test(value) && !Number.isNaN(Date.parse(value)), {
    message: 'Use an ISO date-time, e.g. 2026-10-20T15:30 or 2026-10-20T15:30:00Z',
  });

export const BOOKING_WRITE_STATUSES = [
  'pending',
  'confirmed',
  'cancelled',
  'completed',
  'no_show',
  'checked_in',
  'rescheduled',
] as const;

/** The Scheduling page PUT sends the row's current status, which may be `held`. */
export const BOOKING_UPDATE_STATUSES = [...BOOKING_WRITE_STATUSES, 'held'] as const;

export const BOOKING_SOURCES = ['manual', 'self_schedule', 'ai_agent', 'phone', 'api'] as const;

export const BOOKING_TRANSITIONS = [
  'confirm',
  'check_in',
  'complete',
  'no_show',
  'cancel',
  'reschedule',
  'reopen',
] as const;

function endAfterStart(start: string, end: string): boolean {
  return Date.parse(start) < Date.parse(end);
}

export const createBookingBodySchema = z.object({
  title: z.string().trim().min(1).max(500),
  description: optionalText(8_000),
  start_time: isoDateTimeSchema,
  end_time: isoDateTimeSchema,
  status: z.enum(BOOKING_WRITE_STATUSES).optional(),
  contact_name: optionalText(255),
  contact_phone: optionalText(50),
  contact_email: optionalEmail,
  agent_id: optionalId,
  notes: optionalText(8_000),
  provider_id: optionalId,
  appointment_type_id: optionalId,
  resource_id: optionalId,
  recurring_series_id: optionalId,
  intake_data: z.unknown().optional(),
  timezone: optionalText(50),
  location: optionalText(255),
  booking_source: z.enum(BOOKING_SOURCES).optional(),
  override_reason: optionalText(500),
}).superRefine((value, ctx) => {
  if (!endAfterStart(value.start_time, value.end_time)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['end_time'],
      message: 'end_time must be after start_time',
    });
  }
});

export const updateBookingBodySchema = z.object({
  title: z.string().trim().min(1).max(500).optional(),
  description: optionalText(8_000),
  start_time: isoDateTimeSchema.optional(),
  end_time: isoDateTimeSchema.optional(),
  status: z.enum(BOOKING_UPDATE_STATUSES).optional(),
  contact_name: optionalText(255),
  contact_phone: optionalText(50),
  contact_email: optionalEmail,
  agent_id: optionalId,
  notes: optionalText(8_000),
  provider_id: optionalId,
  appointment_type_id: optionalId,
  resource_id: optionalId,
  intake_data: z.unknown().optional(),
  timezone: optionalText(50),
  location: optionalText(255),
  override_reason: optionalText(500),
}).superRefine((value, ctx) => {
  if (value.start_time && value.end_time && !endAfterStart(value.start_time, value.end_time)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['end_time'],
      message: 'end_time must be after start_time',
    });
  }
});

export const transitionBookingBodySchema = z.object({
  action: z.enum(BOOKING_TRANSITIONS),
  cancellation_reason: optionalText(500),
  override_reason: optionalText(500),
  new_start_time: isoDateTimeSchema.optional(),
  new_end_time: isoDateTimeSchema.optional(),
}).superRefine((value, ctx) => {
  if (value.action !== 'reschedule') return;
  if (!value.new_start_time || !value.new_end_time) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['new_start_time'],
      message: 'new_start_time and new_end_time required for reschedule',
    });
    return;
  }
  if (!endAfterStart(value.new_start_time, value.new_end_time)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['new_end_time'],
      message: 'new_end_time must be after new_start_time',
    });
  }
});

/** Namespaces UI keys so they cannot collide with agent confirmation tokens. */
export const UI_IDEMPOTENCY_PREFIX = 'ui:';

export const idempotencyKeyHeaderSchema = z
  .string()
  .trim()
  .min(1)
  .max(200);

export type CreateBookingBody = z.infer<typeof createBookingBodySchema>;
export type UpdateBookingBody = z.infer<typeof updateBookingBodySchema>;
export type TransitionBookingBody = z.infer<typeof transitionBookingBodySchema>;

export function validationErrorBody(error: z.ZodError): { error: string; fields: Record<string, string> } {
  const fields: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path.length > 0 ? issue.path.map(String).join('.') : 'body';
    if (!fields[key]) fields[key] = issue.message;
  }
  return { error: 'Validation failed', fields };
}

function parse<T>(schema: z.ZodType<T>, value: unknown): { ok: true; data: T } | { ok: false; body: { error: string; fields: Record<string, string> } } {
  const parsed = schema.safeParse(value);
  if (parsed.success) return { ok: true, data: parsed.data };
  return { ok: false, body: validationErrorBody(parsed.error) };
}

export function parseBookingIdParams(params: unknown) {
  return parse(bookingIdParamsSchema, params);
}

export function parseCreateBookingBody(body: unknown) {
  return parse(createBookingBodySchema, body);
}

export function parseUpdateBookingBody(body: unknown) {
  return parse(updateBookingBodySchema, body);
}

export function parseTransitionBookingBody(body: unknown) {
  return parse(transitionBookingBodySchema, body);
}

export function parseUiIdempotencyKey(header: string | undefined): { ok: true; key: string | null } | { ok: false; body: { error: string; fields: Record<string, string> } } {
  if (header === undefined || header === '') return { ok: true, key: null };
  const parsed = idempotencyKeyHeaderSchema.safeParse(header);
  if (!parsed.success) {
    return {
      ok: false,
      body: {
        error: 'Validation failed',
        fields: { 'Idempotency-Key': parsed.error.issues[0]?.message ?? 'Invalid Idempotency-Key' },
      },
    };
  }
  return { ok: true, key: `${UI_IDEMPOTENCY_PREFIX}${parsed.data}` };
}

function asId(value: string | null | undefined): string | null {
  return value ? value : null;
}

function asText(value: string | null | undefined): string {
  return value ?? '';
}

function canonicalIntake(value: unknown): string {
  if (value == null || value === '') return '{}';
  if (typeof value === 'string') {
    try {
      return JSON.stringify(JSON.parse(value) ?? {});
    } catch {
      return JSON.stringify({ raw: value });
    }
  }
  try {
    return JSON.stringify(value);
  } catch {
    return '{}';
  }
}

function suppliedTimezone(value: string | undefined): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** Canonical create payload for same-key / different-body detection. */
export function createBookingFingerprint(input: CreateBookingBody): string {
  return JSON.stringify({
    title: input.title,
    description: asText(input.description),
    start_ms: Date.parse(input.start_time),
    end_ms: Date.parse(input.end_time),
    status: input.status ?? 'confirmed',
    contact_name: asText(input.contact_name),
    contact_phone: asText(input.contact_phone),
    contact_email: asText(input.contact_email),
    agent_id: asId(input.agent_id),
    notes: asText(input.notes),
    provider_id: asId(input.provider_id),
    appointment_type_id: asId(input.appointment_type_id),
    resource_id: asId(input.resource_id),
    recurring_series_id: asId(input.recurring_series_id),
    location: asText(input.location),
    booking_source: input.booking_source ?? 'manual',
    intake_data: canonicalIntake(input.intake_data),
    timezone: suppliedTimezone(input.timezone),
  });
}

export function bookingRowFingerprint(row: Record<string, unknown>): string {
  return JSON.stringify({
    title: String(row.title ?? ''),
    description: String(row.description ?? ''),
    start_ms: new Date(row.start_time as string | Date).getTime(),
    end_ms: new Date(row.end_time as string | Date).getTime(),
    status: String(row.status ?? 'confirmed'),
    contact_name: String(row.contact_name ?? ''),
    contact_phone: String(row.contact_phone ?? ''),
    contact_email: String(row.contact_email ?? ''),
    agent_id: row.agent_id == null || row.agent_id === '' ? null : String(row.agent_id),
    notes: String(row.notes ?? ''),
    provider_id: row.provider_id == null || row.provider_id === '' ? null : String(row.provider_id),
    appointment_type_id: row.appointment_type_id == null || row.appointment_type_id === '' ? null : String(row.appointment_type_id),
    resource_id: row.resource_id == null || row.resource_id === '' ? null : String(row.resource_id),
    recurring_series_id: row.recurring_series_id == null || row.recurring_series_id === '' ? null : String(row.recurring_series_id),
    location: String(row.location ?? ''),
    booking_source: String(row.booking_source ?? 'manual'),
    intake_data: canonicalIntake(row.intake_data),
    timezone: String(row.timezone ?? ''),
  });
}

export function formatHoldUntil(holdExpiresAt: Date, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour: 'numeric',
      minute: '2-digit',
    }).format(holdExpiresAt);
  } catch {
    return new Intl.DateTimeFormat('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      timeZone: 'UTC',
    }).format(holdExpiresAt);
  }
}

export function phoneHoldConflictBody(holdExpiresAt: Date, timeZone: string) {
  const until = formatHoldUntil(holdExpiresAt, timeZone);
  const message = `Held by a phone call until ${until}`;
  return {
    code: 'CONFLICT' as const,
    heldBy: 'phone_call' as const,
    holdExpiresAt: holdExpiresAt.toISOString(),
    error: message,
    message,
  };
}

export function isIdempotencyUniqueViolation(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const { code, constraint } = err as { code?: unknown; constraint?: unknown };
  if (code !== '23505') return false;
  return typeof constraint === 'string' && constraint.toLowerCase().includes('idempotency');
}
