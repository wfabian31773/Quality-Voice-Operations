import { randomUUID } from 'crypto';
import { getPlatformPool, withTenantContext } from '../db';
import { createLogger } from '../core/logger';

const logger = createLogger('SMS_CONVERSATION_SERVICE');

interface DbClient {
  query: (sql: string, values?: unknown[]) => Promise<{ rows: Record<string, unknown>[]; rowCount?: number | null }>;
}

async function withTenant<T>(tenantId: string, fn: (client: DbClient) => Promise<T>): Promise<T> {
  const pool = getPlatformPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await withTenantContext(client, tenantId, async () => {});
    const result = await fn(client as unknown as DbClient);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export type ConversationStatus = 'open' | 'pending' | 'closed' | 'escalated' | 'archived';
export type ConversationPriority = 'normal' | 'high' | 'urgent';

export interface SmsConversation {
  id: string;
  tenantId: string;
  phoneNumberId: string;
  remoteNumber: string;
  status: ConversationStatus;
  assigneeUserId: string | null;
  assigneeTeam: string | null;
  priority: ConversationPriority;
  pinned: boolean;
  unreadCount: number;
  followUp: boolean;
  followUpAt: Date | null;
  lastMessageAt: Date | null;
  lastMessagePreview: string | null;
  closedAt: Date | null;
  escalatedAt: Date | null;
  contactName: string | null;
  contactEmail: string | null;
  contactLocation: string | null;
  tags: string[];
  metadata: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

export interface SmsMessage {
  id: string;
  tenantId: string;
  conversationId: string;
  direction: 'inbound' | 'outbound';
  fromNumber: string;
  toNumber: string;
  body: string;
  status: string;
  twilioSid: string | null;
  scheduledAt: Date | null;
  sentAt: Date | null;
  deliveredAt: Date | null;
  errorMessage: string | null;
  metadata: Record<string, unknown>;
  createdAt: Date;
}

export interface SmsInternalNote {
  id: string;
  tenantId: string;
  conversationId: string;
  userId: string;
  userName: string | null;
  body: string;
  createdAt: Date;
}

export interface SmsCannedResponse {
  id: string;
  tenantId: string;
  title: string;
  body: string;
  category: string | null;
  variables: string[];
  shortcut: string | null;
  createdBy: string | null;
  isGlobal: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface SmsAutoReplyRule {
  id: string;
  tenantId: string;
  name: string;
  ruleType: string;
  keyword: string | null;
  matchType: string | null;
  replyBody: string;
  isBusinessHours: boolean | null;
  businessHoursStart: string | null;
  businessHoursEnd: string | null;
  businessDays: number[];
  timezone: string;
  enabled: boolean;
  priority: number;
  phoneNumberId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface SmsAssignmentRule {
  id: string;
  tenantId: string;
  name: string;
  ruleType: string;
  matchField: string;
  matchValue: string;
  assignToUserId: string | null;
  assignToTeam: string | null;
  enabled: boolean;
  priority: number;
  createdAt: Date;
  updatedAt: Date;
}

function rowToConversation(r: Record<string, unknown>): SmsConversation {
  return {
    id: r.id as string,
    tenantId: r.tenant_id as string,
    phoneNumberId: r.phone_number_id as string,
    remoteNumber: r.remote_number as string,
    status: r.status as ConversationStatus,
    assigneeUserId: r.assignee_user_id as string | null,
    assigneeTeam: r.assignee_team as string | null,
    priority: r.priority as ConversationPriority,
    pinned: r.pinned as boolean,
    unreadCount: parseInt(String(r.unread_count ?? '0'), 10),
    followUp: r.follow_up as boolean,
    followUpAt: r.follow_up_at ? new Date(r.follow_up_at as string) : null,
    lastMessageAt: r.last_message_at ? new Date(r.last_message_at as string) : null,
    lastMessagePreview: r.last_message_preview as string | null,
    closedAt: r.closed_at ? new Date(r.closed_at as string) : null,
    escalatedAt: r.escalated_at ? new Date(r.escalated_at as string) : null,
    contactName: r.contact_name as string | null,
    contactEmail: r.contact_email as string | null,
    contactLocation: r.contact_location as string | null,
    tags: (r.tags as string[]) ?? [],
    metadata: (typeof r.metadata === 'object' && r.metadata !== null ? r.metadata : {}) as Record<string, unknown>,
    createdAt: new Date(r.created_at as string),
    updatedAt: new Date(r.updated_at as string),
  };
}

function rowToMessage(r: Record<string, unknown>): SmsMessage {
  return {
    id: r.id as string,
    tenantId: r.tenant_id as string,
    conversationId: r.conversation_id as string,
    direction: r.direction as 'inbound' | 'outbound',
    fromNumber: r.from_number as string,
    toNumber: r.to_number as string,
    body: r.body as string,
    status: r.status as string,
    twilioSid: r.twilio_sid as string | null,
    scheduledAt: r.scheduled_at ? new Date(r.scheduled_at as string) : null,
    sentAt: r.sent_at ? new Date(r.sent_at as string) : null,
    deliveredAt: r.delivered_at ? new Date(r.delivered_at as string) : null,
    errorMessage: r.error_message as string | null,
    metadata: (typeof r.metadata === 'object' && r.metadata !== null ? r.metadata : {}) as Record<string, unknown>,
    createdAt: new Date(r.created_at as string),
  };
}

function rowToNote(r: Record<string, unknown>): SmsInternalNote {
  return {
    id: r.id as string,
    tenantId: r.tenant_id as string,
    conversationId: r.conversation_id as string,
    userId: r.user_id as string,
    userName: r.user_name as string | null,
    body: r.body as string,
    createdAt: new Date(r.created_at as string),
  };
}

function rowToCannedResponse(r: Record<string, unknown>): SmsCannedResponse {
  return {
    id: r.id as string,
    tenantId: r.tenant_id as string,
    title: r.title as string,
    body: r.body as string,
    category: r.category as string | null,
    variables: (r.variables as string[]) ?? [],
    shortcut: r.shortcut as string | null,
    createdBy: r.created_by as string | null,
    isGlobal: r.is_global as boolean,
    createdAt: new Date(r.created_at as string),
    updatedAt: new Date(r.updated_at as string),
  };
}

function rowToAutoReplyRule(r: Record<string, unknown>): SmsAutoReplyRule {
  return {
    id: r.id as string,
    tenantId: r.tenant_id as string,
    name: r.name as string,
    ruleType: r.rule_type as string,
    keyword: r.keyword as string | null,
    matchType: r.match_type as string | null,
    replyBody: r.reply_body as string,
    isBusinessHours: r.is_business_hours as boolean | null,
    businessHoursStart: r.business_hours_start as string | null,
    businessHoursEnd: r.business_hours_end as string | null,
    businessDays: (r.business_days as number[]) ?? [1, 2, 3, 4, 5],
    timezone: r.timezone as string || 'America/Chicago',
    enabled: r.enabled as boolean,
    priority: parseInt(String(r.priority ?? '0'), 10),
    phoneNumberId: r.phone_number_id as string | null,
    createdAt: new Date(r.created_at as string),
    updatedAt: new Date(r.updated_at as string),
  };
}

function rowToAssignmentRule(r: Record<string, unknown>): SmsAssignmentRule {
  return {
    id: r.id as string,
    tenantId: r.tenant_id as string,
    name: r.name as string,
    ruleType: r.rule_type as string,
    matchField: r.match_field as string,
    matchValue: r.match_value as string,
    assignToUserId: r.assign_to_user_id as string | null,
    assignToTeam: r.assign_to_team as string | null,
    enabled: r.enabled as boolean,
    priority: parseInt(String(r.priority ?? '0'), 10),
    createdAt: new Date(r.created_at as string),
    updatedAt: new Date(r.updated_at as string),
  };
}

export async function getOrCreateConversation(
  tenantId: string,
  phoneNumberId: string,
  remoteNumber: string,
  contactName?: string,
): Promise<SmsConversation> {
  return withTenant(tenantId, async (client) => {
    const { rows: existing } = await client.query(
      `SELECT * FROM sms_conversations WHERE tenant_id = $1 AND phone_number_id = $2 AND remote_number = $3 LIMIT 1`,
      [tenantId, phoneNumberId, remoteNumber],
    );
    if (existing.length > 0) return rowToConversation(existing[0]);

    const id = randomUUID();
    const { rows } = await client.query(
      `INSERT INTO sms_conversations (id, tenant_id, phone_number_id, remote_number, status, contact_name)
       VALUES ($1, $2, $3, $4, 'open', $5)
       ON CONFLICT (tenant_id, phone_number_id, remote_number) DO UPDATE SET updated_at = NOW()
       RETURNING *`,
      [id, tenantId, phoneNumberId, remoteNumber, contactName ?? null],
    );
    return rowToConversation(rows[0]);
  });
}

export async function listConversations(
  tenantId: string,
  opts: {
    status?: ConversationStatus;
    assigneeUserId?: string;
    phoneNumberId?: string;
    priority?: ConversationPriority;
    pinned?: boolean;
    followUp?: boolean;
    unreadOnly?: boolean;
    search?: string;
    limit?: number;
    offset?: number;
  } = {},
): Promise<{ conversations: SmsConversation[]; total: number }> {
  return withTenant(tenantId, async (client) => {
    const { limit = 50, offset = 0 } = opts;
    const conditions = ['c.tenant_id = $1'];
    const countConditions = ['tenant_id = $1'];
    const values: unknown[] = [tenantId];

    if (opts.status) { values.push(opts.status); conditions.push(`c.status = $${values.length}`); countConditions.push(`status = $${values.length}`); }
    if (opts.assigneeUserId) { values.push(opts.assigneeUserId); conditions.push(`c.assignee_user_id = $${values.length}`); countConditions.push(`assignee_user_id = $${values.length}`); }
    if (opts.phoneNumberId) { values.push(opts.phoneNumberId); conditions.push(`c.phone_number_id = $${values.length}`); countConditions.push(`phone_number_id = $${values.length}`); }
    if (opts.priority) { values.push(opts.priority); conditions.push(`c.priority = $${values.length}`); countConditions.push(`priority = $${values.length}`); }
    if (opts.pinned !== undefined) { values.push(opts.pinned); conditions.push(`c.pinned = $${values.length}`); countConditions.push(`pinned = $${values.length}`); }
    if (opts.followUp !== undefined) { values.push(opts.followUp); conditions.push(`c.follow_up = $${values.length}`); countConditions.push(`follow_up = $${values.length}`); }
    if (opts.unreadOnly) { conditions.push(`c.unread_count > 0`); countConditions.push(`unread_count > 0`); }
    if (opts.search) {
      values.push(`%${opts.search}%`);
      conditions.push(`(c.remote_number ILIKE $${values.length} OR c.contact_name ILIKE $${values.length} OR c.last_message_preview ILIKE $${values.length})`);
      countConditions.push(`(remote_number ILIKE $${values.length} OR contact_name ILIKE $${values.length} OR last_message_preview ILIKE $${values.length})`);
    }

    const where = conditions.join(' AND ');
    const countWhere = countConditions.join(' AND ');

    const { rows } = await client.query(
      `SELECT c.* FROM sms_conversations c WHERE ${where}
       ORDER BY c.pinned DESC, c.last_message_at DESC NULLS LAST
       LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
      [...values, limit, offset],
    );
    const { rows: countRows } = await client.query(
      `SELECT COUNT(*)::int AS total FROM sms_conversations WHERE ${countWhere}`,
      values,
    );
    return {
      conversations: rows.map(rowToConversation),
      total: (countRows[0]?.total as number) ?? 0,
    };
  });
}

export async function getConversation(tenantId: string, conversationId: string): Promise<SmsConversation | null> {
  return withTenant(tenantId, async (client) => {
    const { rows } = await client.query(
      `SELECT * FROM sms_conversations WHERE id = $1 AND tenant_id = $2`,
      [conversationId, tenantId],
    );
    return rows.length > 0 ? rowToConversation(rows[0]) : null;
  });
}

export async function updateConversation(
  tenantId: string,
  conversationId: string,
  updates: {
    status?: ConversationStatus;
    assigneeUserId?: string | null;
    assigneeTeam?: string | null;
    priority?: ConversationPriority;
    pinned?: boolean;
    followUp?: boolean;
    followUpAt?: Date | null;
    contactName?: string | null;
    contactEmail?: string | null;
    contactLocation?: string | null;
    tags?: string[];
  },
): Promise<SmsConversation | null> {
  return withTenant(tenantId, async (client) => {
    const sets: string[] = ['updated_at = NOW()'];
    const values: unknown[] = [conversationId, tenantId];

    if (updates.status !== undefined) { values.push(updates.status); sets.push(`status = $${values.length}`); }
    if (updates.assigneeUserId !== undefined) { values.push(updates.assigneeUserId); sets.push(`assignee_user_id = $${values.length}`); }
    if (updates.assigneeTeam !== undefined) { values.push(updates.assigneeTeam); sets.push(`assignee_team = $${values.length}`); }
    if (updates.priority !== undefined) { values.push(updates.priority); sets.push(`priority = $${values.length}`); }
    if (updates.pinned !== undefined) { values.push(updates.pinned); sets.push(`pinned = $${values.length}`); }
    if (updates.followUp !== undefined) { values.push(updates.followUp); sets.push(`follow_up = $${values.length}`); }
    if (updates.followUpAt !== undefined) { values.push(updates.followUpAt); sets.push(`follow_up_at = $${values.length}`); }
    if (updates.contactName !== undefined) { values.push(updates.contactName); sets.push(`contact_name = $${values.length}`); }
    if (updates.contactEmail !== undefined) { values.push(updates.contactEmail); sets.push(`contact_email = $${values.length}`); }
    if (updates.contactLocation !== undefined) { values.push(updates.contactLocation); sets.push(`contact_location = $${values.length}`); }
    if (updates.tags !== undefined) { values.push(updates.tags); sets.push(`tags = $${values.length}`); }

    if (updates.status === 'closed') sets.push(`closed_at = NOW()`);
    if (updates.status === 'escalated') sets.push(`escalated_at = NOW()`);
    if (updates.status === 'open') { sets.push(`closed_at = NULL`); sets.push(`escalated_at = NULL`); }

    const { rows } = await client.query(
      `UPDATE sms_conversations SET ${sets.join(', ')} WHERE id = $1 AND tenant_id = $2 RETURNING *`,
      values,
    );
    return rows.length > 0 ? rowToConversation(rows[0]) : null;
  });
}

export async function markConversationRead(tenantId: string, conversationId: string): Promise<void> {
  await withTenant(tenantId, async (client) => {
    await client.query(
      `UPDATE sms_conversations SET unread_count = 0, updated_at = NOW() WHERE id = $1 AND tenant_id = $2`,
      [conversationId, tenantId],
    );
  });
}

export async function saveMessage(
  tenantId: string,
  conversationId: string,
  msg: {
    direction: 'inbound' | 'outbound';
    fromNumber: string;
    toNumber: string;
    body: string;
    status: string;
    twilioSid?: string;
    scheduledAt?: Date;
  },
): Promise<SmsMessage> {
  return withTenant(tenantId, async (client) => {
    const id = randomUUID();
    const { rows } = await client.query(
      `INSERT INTO sms_messages (id, tenant_id, conversation_id, direction, from_number, to_number, body, status, twilio_sid, scheduled_at, sent_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING *`,
      [
        id, tenantId, conversationId, msg.direction, msg.fromNumber, msg.toNumber,
        msg.body, msg.scheduledAt ? 'scheduled' : msg.status, msg.twilioSid ?? null,
        msg.scheduledAt ?? null,
        msg.direction === 'outbound' && !msg.scheduledAt ? new Date() : null,
      ],
    );

    const preview = msg.body.length > 100 ? msg.body.slice(0, 100) + '...' : msg.body;
    const unreadIncrement = msg.direction === 'inbound' ? 1 : 0;
    await client.query(
      `UPDATE sms_conversations SET
         last_message_at = NOW(),
         last_message_preview = $1,
         unread_count = unread_count + $2,
         updated_at = NOW(),
         status = CASE WHEN status = 'closed' AND $3 = 'inbound' THEN 'open' ELSE status END
       WHERE id = $4 AND tenant_id = $5`,
      [preview, unreadIncrement, msg.direction, conversationId, tenantId],
    );

    return rowToMessage(rows[0]);
  });
}

export async function listMessages(
  tenantId: string,
  conversationId: string,
  opts: { limit?: number; offset?: number } = {},
): Promise<{ messages: SmsMessage[]; total: number }> {
  return withTenant(tenantId, async (client) => {
    const { limit = 100, offset = 0 } = opts;
    const { rows } = await client.query(
      `SELECT * FROM sms_messages WHERE conversation_id = $1 AND tenant_id = $2
       ORDER BY created_at ASC LIMIT $3 OFFSET $4`,
      [conversationId, tenantId, limit, offset],
    );
    const { rows: countRows } = await client.query(
      `SELECT COUNT(*)::int AS total FROM sms_messages WHERE conversation_id = $1 AND tenant_id = $2`,
      [conversationId, tenantId],
    );
    return {
      messages: rows.map(rowToMessage),
      total: (countRows[0]?.total as number) ?? 0,
    };
  });
}

export async function addInternalNote(
  tenantId: string,
  conversationId: string,
  userId: string,
  userName: string,
  body: string,
): Promise<SmsInternalNote> {
  return withTenant(tenantId, async (client) => {
    const id = randomUUID();
    const { rows } = await client.query(
      `INSERT INTO sms_internal_notes (id, tenant_id, conversation_id, user_id, user_name, body)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [id, tenantId, conversationId, userId, userName, body],
    );
    return rowToNote(rows[0]);
  });
}

export async function listInternalNotes(
  tenantId: string,
  conversationId: string,
): Promise<SmsInternalNote[]> {
  return withTenant(tenantId, async (client) => {
    const { rows } = await client.query(
      `SELECT * FROM sms_internal_notes WHERE conversation_id = $1 AND tenant_id = $2 ORDER BY created_at ASC`,
      [conversationId, tenantId],
    );
    return rows.map(rowToNote);
  });
}

export async function createCannedResponse(
  tenantId: string,
  data: { title: string; body: string; category?: string; variables?: string[]; shortcut?: string; createdBy?: string; isGlobal?: boolean },
): Promise<SmsCannedResponse> {
  return withTenant(tenantId, async (client) => {
    const id = randomUUID();
    const { rows } = await client.query(
      `INSERT INTO sms_canned_responses (id, tenant_id, title, body, category, variables, shortcut, created_by, is_global)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [id, tenantId, data.title, data.body, data.category ?? null, data.variables ?? [], data.shortcut ?? null, data.createdBy ?? null, data.isGlobal ?? false],
    );
    return rowToCannedResponse(rows[0]);
  });
}

export async function listCannedResponses(tenantId: string): Promise<SmsCannedResponse[]> {
  return withTenant(tenantId, async (client) => {
    const { rows } = await client.query(
      `SELECT * FROM sms_canned_responses WHERE tenant_id = $1 ORDER BY category, title`,
      [tenantId],
    );
    return rows.map(rowToCannedResponse);
  });
}

export async function updateCannedResponse(
  tenantId: string,
  id: string,
  data: { title?: string; body?: string; category?: string; variables?: string[]; shortcut?: string; isGlobal?: boolean },
): Promise<SmsCannedResponse | null> {
  return withTenant(tenantId, async (client) => {
    const sets: string[] = ['updated_at = NOW()'];
    const values: unknown[] = [id, tenantId];
    if (data.title !== undefined) { values.push(data.title); sets.push(`title = $${values.length}`); }
    if (data.body !== undefined) { values.push(data.body); sets.push(`body = $${values.length}`); }
    if (data.category !== undefined) { values.push(data.category); sets.push(`category = $${values.length}`); }
    if (data.variables !== undefined) { values.push(data.variables); sets.push(`variables = $${values.length}`); }
    if (data.shortcut !== undefined) { values.push(data.shortcut); sets.push(`shortcut = $${values.length}`); }
    if (data.isGlobal !== undefined) { values.push(data.isGlobal); sets.push(`is_global = $${values.length}`); }
    const { rows } = await client.query(
      `UPDATE sms_canned_responses SET ${sets.join(', ')} WHERE id = $1 AND tenant_id = $2 RETURNING *`,
      values,
    );
    return rows.length > 0 ? rowToCannedResponse(rows[0]) : null;
  });
}

export async function deleteCannedResponse(tenantId: string, id: string): Promise<boolean> {
  return withTenant(tenantId, async (client) => {
    const { rowCount } = await client.query(
      `DELETE FROM sms_canned_responses WHERE id = $1 AND tenant_id = $2`,
      [id, tenantId],
    );
    return (rowCount ?? 0) > 0;
  });
}

export async function substituteVariables(
  template: string,
  vars: Record<string, string>,
): Promise<string> {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] ?? `{{${key}}}`);
}

export async function createAutoReplyRule(
  tenantId: string,
  data: {
    name: string; ruleType: string; keyword?: string; matchType?: string; replyBody: string;
    isBusinessHours?: boolean; businessHoursStart?: string; businessHoursEnd?: string;
    businessDays?: number[]; timezone?: string; enabled?: boolean; priority?: number; phoneNumberId?: string;
  },
): Promise<SmsAutoReplyRule> {
  return withTenant(tenantId, async (client) => {
    const id = randomUUID();
    const { rows } = await client.query(
      `INSERT INTO sms_auto_reply_rules (id, tenant_id, name, rule_type, keyword, match_type, reply_body, is_business_hours, business_hours_start, business_hours_end, business_days, timezone, enabled, priority, phone_number_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
      [id, tenantId, data.name, data.ruleType, data.keyword ?? null, data.matchType ?? 'exact',
       data.replyBody, data.isBusinessHours ?? null, data.businessHoursStart ?? null,
       data.businessHoursEnd ?? null, data.businessDays ?? [1,2,3,4,5],
       data.timezone ?? 'America/Chicago', data.enabled ?? true, data.priority ?? 0, data.phoneNumberId ?? null],
    );
    return rowToAutoReplyRule(rows[0]);
  });
}

export async function listAutoReplyRules(tenantId: string): Promise<SmsAutoReplyRule[]> {
  return withTenant(tenantId, async (client) => {
    const { rows } = await client.query(
      `SELECT * FROM sms_auto_reply_rules WHERE tenant_id = $1 ORDER BY priority DESC, created_at`,
      [tenantId],
    );
    return rows.map(rowToAutoReplyRule);
  });
}

export async function updateAutoReplyRule(
  tenantId: string,
  id: string,
  data: Partial<Omit<SmsAutoReplyRule, 'id' | 'tenantId' | 'createdAt' | 'updatedAt'>>,
): Promise<SmsAutoReplyRule | null> {
  return withTenant(tenantId, async (client) => {
    const sets: string[] = ['updated_at = NOW()'];
    const values: unknown[] = [id, tenantId];
    if (data.name !== undefined) { values.push(data.name); sets.push(`name = $${values.length}`); }
    if (data.ruleType !== undefined) { values.push(data.ruleType); sets.push(`rule_type = $${values.length}`); }
    if (data.keyword !== undefined) { values.push(data.keyword); sets.push(`keyword = $${values.length}`); }
    if (data.matchType !== undefined) { values.push(data.matchType); sets.push(`match_type = $${values.length}`); }
    if (data.replyBody !== undefined) { values.push(data.replyBody); sets.push(`reply_body = $${values.length}`); }
    if (data.isBusinessHours !== undefined) { values.push(data.isBusinessHours); sets.push(`is_business_hours = $${values.length}`); }
    if (data.businessHoursStart !== undefined) { values.push(data.businessHoursStart); sets.push(`business_hours_start = $${values.length}`); }
    if (data.businessHoursEnd !== undefined) { values.push(data.businessHoursEnd); sets.push(`business_hours_end = $${values.length}`); }
    if (data.businessDays !== undefined) { values.push(data.businessDays); sets.push(`business_days = $${values.length}`); }
    if (data.timezone !== undefined) { values.push(data.timezone); sets.push(`timezone = $${values.length}`); }
    if (data.enabled !== undefined) { values.push(data.enabled); sets.push(`enabled = $${values.length}`); }
    if (data.priority !== undefined) { values.push(data.priority); sets.push(`priority = $${values.length}`); }
    if (data.phoneNumberId !== undefined) { values.push(data.phoneNumberId); sets.push(`phone_number_id = $${values.length}`); }
    const { rows } = await client.query(
      `UPDATE sms_auto_reply_rules SET ${sets.join(', ')} WHERE id = $1 AND tenant_id = $2 RETURNING *`,
      values,
    );
    return rows.length > 0 ? rowToAutoReplyRule(rows[0]) : null;
  });
}

export async function deleteAutoReplyRule(tenantId: string, id: string): Promise<boolean> {
  return withTenant(tenantId, async (client) => {
    const { rowCount } = await client.query(
      `DELETE FROM sms_auto_reply_rules WHERE id = $1 AND tenant_id = $2`,
      [id, tenantId],
    );
    return (rowCount ?? 0) > 0;
  });
}

export async function evaluateAutoReplies(
  tenantId: string,
  inboundBody: string,
  phoneNumberId: string,
): Promise<string | null> {
  return withTenant(tenantId, async (client) => {
    const { rows } = await client.query(
      `SELECT * FROM sms_auto_reply_rules
       WHERE tenant_id = $1 AND enabled = TRUE
         AND (phone_number_id IS NULL OR phone_number_id = $2)
       ORDER BY priority DESC, created_at`,
      [tenantId, phoneNumberId],
    );

    const now = new Date();
    const rules = rows.map(rowToAutoReplyRule);

    for (const rule of rules) {
      if (rule.isBusinessHours !== null) {
        const inWindow = isWithinBusinessHours(now, rule);
        if (rule.isBusinessHours && !inWindow) continue;
        if (!rule.isBusinessHours && inWindow) continue;
      }

      if (rule.ruleType === 'keyword' && rule.keyword) {
        const body = inboundBody.trim().toLowerCase();
        const kw = rule.keyword.toLowerCase();
        if (rule.matchType === 'exact' && body !== kw) continue;
        if (rule.matchType === 'contains' && !body.includes(kw)) continue;
        if (rule.matchType === 'starts_with' && !body.startsWith(kw)) continue;
        return rule.replyBody;
      }

      if (rule.ruleType === 'business_hours') {
        return rule.replyBody;
      }
    }

    return null;
  });
}

function isWithinBusinessHours(now: Date, rule: SmsAutoReplyRule): boolean {
  try {
    const localStr = now.toLocaleString('en-US', { timeZone: rule.timezone });
    const local = new Date(localStr);
    const day = local.getDay();
    if (!rule.businessDays.includes(day)) return false;
    const minutes = local.getHours() * 60 + local.getMinutes();
    if (rule.businessHoursStart && rule.businessHoursEnd) {
      const [sh, sm] = rule.businessHoursStart.split(':').map(Number);
      const [eh, em] = rule.businessHoursEnd.split(':').map(Number);
      return minutes >= sh * 60 + sm && minutes < eh * 60 + em;
    }
    return true;
  } catch {
    return true;
  }
}

export async function createAssignmentRule(
  tenantId: string,
  data: { name: string; ruleType: string; matchField: string; matchValue: string; assignToUserId?: string; assignToTeam?: string; enabled?: boolean; priority?: number },
): Promise<SmsAssignmentRule> {
  return withTenant(tenantId, async (client) => {
    const id = randomUUID();
    const { rows } = await client.query(
      `INSERT INTO sms_assignment_rules (id, tenant_id, name, rule_type, match_field, match_value, assign_to_user_id, assign_to_team, enabled, priority)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [id, tenantId, data.name, data.ruleType, data.matchField, data.matchValue,
       data.assignToUserId ?? null, data.assignToTeam ?? null, data.enabled ?? true, data.priority ?? 0],
    );
    return rowToAssignmentRule(rows[0]);
  });
}

export async function listAssignmentRules(tenantId: string): Promise<SmsAssignmentRule[]> {
  return withTenant(tenantId, async (client) => {
    const { rows } = await client.query(
      `SELECT * FROM sms_assignment_rules WHERE tenant_id = $1 ORDER BY priority DESC, created_at`,
      [tenantId],
    );
    return rows.map(rowToAssignmentRule);
  });
}

export async function deleteAssignmentRule(tenantId: string, id: string): Promise<boolean> {
  return withTenant(tenantId, async (client) => {
    const { rowCount } = await client.query(
      `DELETE FROM sms_assignment_rules WHERE id = $1 AND tenant_id = $2`,
      [id, tenantId],
    );
    return (rowCount ?? 0) > 0;
  });
}

export async function evaluateAssignmentRules(
  tenantId: string,
  conversation: SmsConversation,
  messageBody: string,
): Promise<{ userId?: string; team?: string } | null> {
  return withTenant(tenantId, async (client) => {
    const { rows } = await client.query(
      `SELECT * FROM sms_assignment_rules WHERE tenant_id = $1 AND enabled = TRUE ORDER BY priority DESC, created_at`,
      [tenantId],
    );
    const rules = rows.map(rowToAssignmentRule);

    for (const rule of rules) {
      let match = false;
      const val = rule.matchValue.toLowerCase();

      if (rule.matchField === 'keyword') {
        match = messageBody.toLowerCase().includes(val);
      } else if (rule.matchField === 'remote_number') {
        match = conversation.remoteNumber.includes(val);
      } else if (rule.matchField === 'phone_number_id') {
        match = conversation.phoneNumberId === rule.matchValue;
      } else if (rule.matchField === 'location') {
        match = (conversation.contactLocation ?? '').toLowerCase().includes(val);
      }

      if (match) {
        return { userId: rule.assignToUserId ?? undefined, team: rule.assignToTeam ?? undefined };
      }
    }
    return null;
  });
}

export async function logActivity(
  tenantId: string,
  conversationId: string,
  action: string,
  actorUserId: string | null,
  actorName: string | null,
  details?: Record<string, unknown>,
): Promise<void> {
  await withTenant(tenantId, async (client) => {
    await client.query(
      `INSERT INTO sms_conversation_activity_log (id, tenant_id, conversation_id, action, actor_user_id, actor_name, details)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [randomUUID(), tenantId, conversationId, action, actorUserId, actorName, JSON.stringify(details ?? {})],
    );
  });
}

export async function listActivityLog(
  tenantId: string,
  conversationId: string,
  opts: { limit?: number } = {},
): Promise<Array<{ id: string; action: string; actorName: string | null; details: Record<string, unknown>; createdAt: Date }>> {
  return withTenant(tenantId, async (client) => {
    const { rows } = await client.query(
      `SELECT * FROM sms_conversation_activity_log WHERE conversation_id = $1 AND tenant_id = $2
       ORDER BY created_at DESC LIMIT $3`,
      [conversationId, tenantId, opts.limit ?? 50],
    );
    return rows.map(r => ({
      id: r.id as string,
      action: r.action as string,
      actorName: r.actor_name as string | null,
      details: (typeof r.details === 'object' && r.details !== null ? r.details : {}) as Record<string, unknown>,
      createdAt: new Date(r.created_at as string),
    }));
  });
}

export async function logConsent(
  tenantId: string,
  phoneNumber: string,
  action: 'opt_in' | 'opt_out' | 'help_request',
  keyword: string,
  source: string = 'inbound_sms',
  twilioSid?: string,
): Promise<void> {
  await withTenant(tenantId, async (client) => {
    await client.query(
      `INSERT INTO sms_consent_log (id, tenant_id, phone_number, action, keyword, source, twilio_sid)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [randomUUID(), tenantId, phoneNumber, action, keyword, source, twilioSid ?? null],
    );
  });
}

export async function getConsentHistory(
  tenantId: string,
  phoneNumber: string,
): Promise<Array<{ action: string; keyword: string | null; source: string; createdAt: Date }>> {
  return withTenant(tenantId, async (client) => {
    const { rows } = await client.query(
      `SELECT * FROM sms_consent_log WHERE tenant_id = $1 AND phone_number = $2 ORDER BY created_at DESC LIMIT 50`,
      [tenantId, phoneNumber],
    );
    return rows.map(r => ({
      action: r.action as string,
      keyword: r.keyword as string | null,
      source: r.source as string,
      createdAt: new Date(r.created_at as string),
    }));
  });
}

export async function getScheduledMessages(tenantId: string): Promise<SmsMessage[]> {
  return withTenant(tenantId, async (client) => {
    const { rows } = await client.query(
      `SELECT * FROM sms_messages WHERE tenant_id = $1 AND status = 'scheduled' AND scheduled_at <= NOW()
       ORDER BY scheduled_at ASC LIMIT 100`,
      [tenantId],
    );
    return rows.map(rowToMessage);
  });
}

export async function claimDueScheduledMessages(): Promise<Array<SmsMessage & { conversationId: string }>> {
  const pool = getPlatformPool();
  const { rows } = await pool.query(
    `UPDATE sms_messages SET status = 'sending'
     WHERE id IN (
       SELECT id FROM sms_messages
       WHERE status = 'scheduled' AND scheduled_at <= NOW()
       ORDER BY scheduled_at ASC LIMIT 100
       FOR UPDATE SKIP LOCKED
     )
     RETURNING *`,
  );
  return rows.map(r => ({ ...rowToMessage(r), conversationId: r.conversation_id as string }));
}

export async function updateMessageStatus(tenantId: string, messageId: string, status: string, twilioSid?: string): Promise<void> {
  await withTenant(tenantId, async (client) => {
    const sets = ['status = $3'];
    const values: unknown[] = [messageId, tenantId, status];
    if (twilioSid) { values.push(twilioSid); sets.push(`twilio_sid = $${values.length}`); }
    if (status === 'sent' || status === 'delivered') { sets.push(`sent_at = COALESCE(sent_at, NOW())`); }
    if (status === 'delivered') { sets.push(`delivered_at = NOW()`); }
    await client.query(
      `UPDATE sms_messages SET ${sets.join(', ')} WHERE id = $1 AND tenant_id = $2`,
      values,
    );
  });
}

export async function getAnalytics(
  tenantId: string,
  opts: {
    startDate?: Date;
    endDate?: Date;
    phoneNumberId?: string;
    assigneeUserId?: string;
  } = {},
): Promise<{
  conversationVolume: { total: number; open: number; pending: number; closed: number; escalated: number };
  messageStats: { totalSent: number; totalReceived: number; delivered: number; failed: number };
  avgResponseTimeMinutes: number | null;
  avgResolutionTimeMinutes: number | null;
  optOutRate: number | null;
  agentProductivity: Array<{ userId: string; sent: number; conversations: number }>;
}> {
  return withTenant(tenantId, async (client) => {
    function buildFilters(alias: string) {
      const conds: string[] = [];
      const vals: unknown[] = [tenantId];
      const prefix = alias ? `${alias}.` : '';
      if (opts.startDate) { vals.push(opts.startDate); conds.push(`${prefix}created_at >= $${vals.length}`); }
      if (opts.endDate) { vals.push(opts.endDate); conds.push(`${prefix}created_at <= $${vals.length}`); }
      if (opts.phoneNumberId) { vals.push(opts.phoneNumberId); conds.push(`${prefix}phone_number_id = $${vals.length}`); }
      if (opts.assigneeUserId) { vals.push(opts.assigneeUserId); conds.push(`${prefix}assignee_user_id = $${vals.length}`); }
      return { where: conds.length > 0 ? ' AND ' + conds.join(' AND ') : '', values: vals };
    }

    const conv = buildFilters('');
    const convAliased = buildFilters('c');

    const dateVals: unknown[] = [tenantId];
    const dateConds: string[] = [];
    if (opts.startDate) { dateVals.push(opts.startDate); dateConds.push(`created_at >= $${dateVals.length}`); }
    if (opts.endDate) { dateVals.push(opts.endDate); dateConds.push(`created_at <= $${dateVals.length}`); }
    const dateWhere = dateConds.length > 0 ? ' AND ' + dateConds.join(' AND ') : '';

    const { rows: convStats } = await client.query(
      `SELECT status, COUNT(*)::int AS count FROM sms_conversations WHERE tenant_id = $1 ${conv.where} GROUP BY status`,
      conv.values,
    );
    const convCounts: Record<string, number> = {};
    for (const r of convStats) convCounts[r.status as string] = r.count as number;

    const msgVals: unknown[] = [tenantId];
    const msgConds: string[] = [];
    if (opts.startDate) { msgVals.push(opts.startDate); msgConds.push(`created_at >= $${msgVals.length}`); }
    if (opts.endDate) { msgVals.push(opts.endDate); msgConds.push(`created_at <= $${msgVals.length}`); }
    if (opts.phoneNumberId) { msgVals.push(opts.phoneNumberId); msgConds.push(`conversation_id IN (SELECT id FROM sms_conversations WHERE phone_number_id = $${msgVals.length})`); }
    const msgWhere = msgConds.length > 0 ? ' AND ' + msgConds.join(' AND ') : '';

    const { rows: msgStats } = await client.query(
      `SELECT direction, status, COUNT(*)::int AS count FROM sms_messages WHERE tenant_id = $1 ${msgWhere} GROUP BY direction, status`,
      msgVals,
    );
    let totalSent = 0, totalReceived = 0, delivered = 0, failed = 0;
    for (const r of msgStats) {
      const count = r.count as number;
      if (r.direction === 'outbound') { totalSent += count; if (r.status === 'delivered') delivered += count; if (r.status === 'failed') failed += count; }
      if (r.direction === 'inbound') totalReceived += count;
    }

    const respVals: unknown[] = [tenantId];
    const respConds: string[] = [];
    if (opts.startDate) { respVals.push(opts.startDate); respConds.push(`inbound.created_at >= $${respVals.length}`); }
    if (opts.endDate) { respVals.push(opts.endDate); respConds.push(`inbound.created_at <= $${respVals.length}`); }
    const respWhere = respConds.length > 0 ? ' AND ' + respConds.join(' AND ') : '';

    const { rows: responseTime } = await client.query(
      `SELECT AVG(EXTRACT(EPOCH FROM (reply.created_at - inbound.created_at)) / 60)::numeric(10,1) AS avg_minutes
       FROM sms_messages inbound
       JOIN LATERAL (
         SELECT created_at FROM sms_messages
         WHERE conversation_id = inbound.conversation_id AND direction = 'outbound' AND created_at > inbound.created_at
         ORDER BY created_at ASC LIMIT 1
       ) reply ON TRUE
       WHERE inbound.tenant_id = $1 AND inbound.direction = 'inbound' ${respWhere}`,
      respVals,
    );

    const { rows: resolutionTime } = await client.query(
      `SELECT AVG(EXTRACT(EPOCH FROM (closed_at - created_at)) / 60)::numeric(10,1) AS avg_minutes
       FROM sms_conversations WHERE tenant_id = $1 AND closed_at IS NOT NULL ${conv.where}`,
      conv.values,
    );

    const { rows: optOutData } = await client.query(
      `SELECT
         (SELECT COUNT(*)::int FROM sms_consent_log WHERE tenant_id = $1 AND action = 'opt_out' ${dateWhere}) AS opt_outs,
         (SELECT COUNT(*)::int FROM sms_messages WHERE tenant_id = $1 AND direction = 'inbound' ${dateWhere}) AS total_inbound`,
      dateVals,
    );
    const optOuts = (optOutData[0]?.opt_outs as number) ?? 0;
    const totalInbound = (optOutData[0]?.total_inbound as number) ?? 0;

    const { rows: agentRows } = await client.query(
      `SELECT
         c.assignee_user_id AS user_id,
         COUNT(DISTINCT m.id)::int AS sent,
         COUNT(DISTINCT c.id)::int AS conversations
       FROM sms_conversations c
       JOIN sms_messages m ON m.conversation_id = c.id AND m.direction = 'outbound'
       WHERE c.tenant_id = $1 AND c.assignee_user_id IS NOT NULL ${convAliased.where}
       GROUP BY c.assignee_user_id`,
      convAliased.values,
    );

    return {
      conversationVolume: {
        total: Object.values(convCounts).reduce((a, b) => a + b, 0),
        open: convCounts.open ?? 0,
        pending: convCounts.pending ?? 0,
        closed: convCounts.closed ?? 0,
        escalated: convCounts.escalated ?? 0,
      },
      messageStats: { totalSent, totalReceived, delivered, failed },
      avgResponseTimeMinutes: responseTime[0]?.avg_minutes !== null ? parseFloat(String(responseTime[0]?.avg_minutes)) : null,
      avgResolutionTimeMinutes: resolutionTime[0]?.avg_minutes !== null ? parseFloat(String(resolutionTime[0]?.avg_minutes)) : null,
      optOutRate: totalInbound > 0 ? parseFloat((optOuts / totalInbound * 100).toFixed(2)) : null,
      agentProductivity: agentRows.map(r => ({
        userId: r.user_id as string,
        sent: r.sent as number,
        conversations: r.conversations as number,
      })),
    };
  });
}

export async function bulkUpdateConversations(
  tenantId: string,
  conversationIds: string[],
  updates: { status?: ConversationStatus; assigneeUserId?: string | null; tags?: string[] },
): Promise<number> {
  return withTenant(tenantId, async (client) => {
    const sets: string[] = ['updated_at = NOW()'];
    const values: unknown[] = [tenantId];

    if (updates.status !== undefined) { values.push(updates.status); sets.push(`status = $${values.length}`); }
    if (updates.assigneeUserId !== undefined) { values.push(updates.assigneeUserId); sets.push(`assignee_user_id = $${values.length}`); }
    if (updates.tags !== undefined) { values.push(updates.tags); sets.push(`tags = $${values.length}`); }

    if (updates.status === 'closed') sets.push(`closed_at = NOW()`);
    if (updates.status === 'escalated') sets.push(`escalated_at = NOW()`);

    values.push(conversationIds);
    const { rowCount } = await client.query(
      `UPDATE sms_conversations SET ${sets.join(', ')} WHERE tenant_id = $1 AND id = ANY($${values.length})`,
      values,
    );
    return rowCount ?? 0;
  });
}

export async function getInboxCounts(tenantId: string): Promise<Record<string, number>> {
  return withTenant(tenantId, async (client) => {
    const { rows } = await client.query(
      `SELECT status, COUNT(*)::int AS count FROM sms_conversations WHERE tenant_id = $1 GROUP BY status`,
      [tenantId],
    );
    const counts: Record<string, number> = { open: 0, pending: 0, closed: 0, escalated: 0, archived: 0, unread: 0 };
    for (const r of rows) counts[r.status as string] = r.count as number;

    const { rows: unreadRows } = await client.query(
      `SELECT COUNT(*)::int AS count FROM sms_conversations WHERE tenant_id = $1 AND unread_count > 0`,
      [tenantId],
    );
    counts.unread = (unreadRows[0]?.count as number) ?? 0;
    return counts;
  });
}
