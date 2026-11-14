import { createHash } from 'node:crypto';
import { z, type ZodError, type ZodType } from 'zod';
import { SMS_MAX_BODY_CHARS } from '../../../platform/actions/sms';

/** Max conversation ids accepted by POST /sms-inbox/bulk-update. */
export const SMS_INBOX_BULK_ID_LIMIT = 200;

/** Max length of the client `Idempotency-Key` header (namespaced key fits VARCHAR(256)). */
export const SMS_INBOX_IDEMPOTENCY_KEY_MAX = 128;

const CONVERSATION_STATUSES = ['open', 'pending', 'closed', 'escalated', 'archived'] as const;
const CONVERSATION_PRIORITIES = ['normal', 'high', 'urgent'] as const;

const idString = z.string().min(1).max(128);
const optionalNullableId = idString.nullable().optional();
const shortText = (max: number) => z.string().max(max);
const optionalDateTime = z
  .string()
  .min(1)
  .refine((value) => !Number.isNaN(Date.parse(value)), { message: 'Invalid date' });

export const conversationStatusSchema = z.enum(CONVERSATION_STATUSES, {
  errorMap: () => ({ message: 'Invalid status' }),
});
export const conversationPrioritySchema = z.enum(CONVERSATION_PRIORITIES, {
  errorMap: () => ({ message: 'Invalid priority' }),
});

/** PUT/PATCH /sms-inbox/threads/:id — same partial shape the client-app sends. */
export const updateThreadSchema = z
  .object({
    status: conversationStatusSchema.optional(),
    assigneeUserId: optionalNullableId,
    assigneeTeam: shortText(128).nullable().optional(),
    priority: conversationPrioritySchema.optional(),
    pinned: z.boolean().optional(),
    followUp: z.boolean().optional(),
    followUpAt: optionalDateTime.optional(),
    contactName: shortText(255).nullable().optional(),
    contactEmail: shortText(320).nullable().optional(),
    contactLocation: shortText(255).nullable().optional(),
    tags: z.array(shortText(64)).max(50).optional(),
  })
  .strict();

/** POST /sms-inbox/threads/:id/messages */
export const sendMessageSchema = z
  .object({
    body: z.string({ required_error: 'body is required' }).trim().min(1, 'body is required').max(SMS_MAX_BODY_CHARS),
    scheduledAt: optionalDateTime.optional(),
  })
  .strict();

/** POST /sms-inbox/threads/:id/notes */
export const addNoteSchema = z
  .object({
    body: z.string({ required_error: 'body is required' }).trim().min(1, 'body is required').max(4000),
  })
  .strict();

/** POST /sms-inbox/bulk-update */
export const bulkUpdateSchema = z
  .object({
    conversationIds: z
      .array(idString)
      .min(1, 'conversationIds array is required')
      .max(SMS_INBOX_BULK_ID_LIMIT, `conversationIds must contain at most ${SMS_INBOX_BULK_ID_LIMIT} ids`),
    status: conversationStatusSchema.optional(),
    assigneeUserId: optionalNullableId,
    tags: z.array(shortText(64)).max(50).optional(),
  })
  .strict()
  .refine(
    (value) => value.status !== undefined || value.assigneeUserId !== undefined || value.tags !== undefined,
    { message: 'Provide status, assigneeUserId, and/or tags', path: ['status'] },
  );

const cannedFields = {
  title: z.string().trim().min(1).max(255),
  body: z.string().trim().min(1).max(2000),
  category: shortText(100).optional(),
  variables: z.array(shortText(64)).max(20).optional(),
  shortcut: shortText(50).optional(),
  isGlobal: z.boolean().optional(),
};

/** POST /sms-inbox/templates */
export const createTemplateSchema = z.object(cannedFields).strict();

/** PATCH /sms-inbox/templates/:id */
export const updateTemplateSchema = z
  .object({
    title: cannedFields.title.optional(),
    body: cannedFields.body.optional(),
    category: cannedFields.category,
    variables: cannedFields.variables,
    shortcut: cannedFields.shortcut,
    isGlobal: cannedFields.isGlobal,
  })
  .strict();

/** POST /sms-inbox/templates/substitute */
export const substituteTemplateSchema = z
  .object({
    template: z.string().min(1, 'template is required').max(4000),
    variables: z.record(z.string().max(SMS_MAX_BODY_CHARS)).optional(),
  })
  .strict();

const hhmm = z.string().max(16);

const autoReplyFields = {
  name: z.string().trim().min(1).max(255),
  ruleType: z.string().trim().min(1).max(64),
  keyword: shortText(255).optional(),
  matchType: shortText(32).optional(),
  replyBody: z.string().trim().min(1).max(2000),
  isBusinessHours: z.boolean().nullable().optional(),
  businessHoursStart: hhmm.optional(),
  businessHoursEnd: hhmm.optional(),
  businessDays: z.array(z.number().int().min(0).max(6)).max(7).optional(),
  timezone: shortText(64).optional(),
  enabled: z.boolean().optional(),
  priority: z.number().int().min(-1000).max(1000).optional(),
  phoneNumberId: optionalNullableId,
};

/** POST /sms-inbox/auto-reply-rules */
export const createAutoReplyRuleSchema = z.object(autoReplyFields).strict();

/** PATCH /sms-inbox/auto-reply-rules/:id */
export const updateAutoReplyRuleSchema = z
  .object({
    name: autoReplyFields.name.optional(),
    ruleType: autoReplyFields.ruleType.optional(),
    keyword: autoReplyFields.keyword,
    matchType: autoReplyFields.matchType,
    replyBody: autoReplyFields.replyBody.optional(),
    isBusinessHours: autoReplyFields.isBusinessHours,
    businessHoursStart: autoReplyFields.businessHoursStart,
    businessHoursEnd: autoReplyFields.businessHoursEnd,
    businessDays: autoReplyFields.businessDays,
    timezone: autoReplyFields.timezone,
    enabled: autoReplyFields.enabled,
    priority: autoReplyFields.priority,
    phoneNumberId: autoReplyFields.phoneNumberId,
  })
  .strict();

/** POST /sms-inbox/assignment-rules */
export const createAssignmentRuleSchema = z
  .object({
    name: z.string().trim().min(1).max(255),
    ruleType: z.string().trim().min(1).max(64).optional(),
    matchField: z.string().trim().min(1).max(64),
    matchValue: z.string().trim().min(1).max(255),
    assignToUserId: optionalNullableId,
    assignToTeam: shortText(128).optional(),
    enabled: z.boolean().optional(),
    priority: z.number().int().min(-1000).max(1000).optional(),
  })
  .strict();

export const idempotencyKeyHeaderSchema = z
  .string()
  .trim()
  .min(1, 'Idempotency-Key is required when provided')
  .max(SMS_INBOX_IDEMPOTENCY_KEY_MAX);

export type UpdateThreadInput = z.infer<typeof updateThreadSchema>;
export type SendMessageInput = z.infer<typeof sendMessageSchema>;
export type AddNoteInput = z.infer<typeof addNoteSchema>;
export type BulkUpdateInput = z.infer<typeof bulkUpdateSchema>;
export type CreateTemplateInput = z.infer<typeof createTemplateSchema>;
export type UpdateTemplateInput = z.infer<typeof updateTemplateSchema>;
export type CreateAutoReplyRuleInput = z.infer<typeof createAutoReplyRuleSchema>;
export type UpdateAutoReplyRuleInput = z.infer<typeof updateAutoReplyRuleSchema>;
export type CreateAssignmentRuleInput = z.infer<typeof createAssignmentRuleSchema>;

export function zodFieldsError(
  error: ZodError,
  fallbackField = '_root',
): { error: string; fields: Record<string, string> } {
  const fields: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path.length > 0 ? issue.path.map(String).join('.') : fallbackField;
    if (!fields[key]) fields[key] = issue.message;
  }
  return { error: 'Validation failed', fields };
}

/**
 * Namespaced idempotency key for an inbox reply. Tenant is also part of the
 * action_idempotency primary key; thread id keeps two threads from colliding
 * when the client reuses a key. Hashed if the readable form would exceed the
 * VARCHAR(256) column.
 */
export function smsInboxReplyIdempotencyKey(tenantId: string, threadId: string, headerKey: string): string {
  const readable = `sms:inbox:${tenantId}:${threadId}:${headerKey}`;
  if (readable.length <= 256) return readable;
  const digest = createHash('sha256').update(readable).digest('hex');
  return `sms:inbox:${digest}`;
}

export function parseWrite<T>(
  schema: ZodType<T>,
  body: unknown,
): { ok: true; data: T } | { ok: false; error: string; fields: Record<string, string> } {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    const payload = zodFieldsError(parsed.error);
    return { ok: false, ...payload };
  }
  return { ok: true, data: parsed.data };
}
