import { Router } from 'express';
import type { RequestHandler } from 'express';
import { requireAuth } from '../middleware/auth';
import { requireMiniSystemWrite } from '../middleware/rbac';
import { requireRole } from '../middleware/rbac';
import { getPlatformPool } from '../../../platform/db';
import { createLogger } from '../../../platform/core/logger';
import { writeAuditLog, extractIp } from '../../../platform/audit/AuditService';
import * as SmsService from '../../../platform/sms/SmsConversationService';
import {
  evaluateSmsQuietHoursForTenant,
  formatSmsQuietHoursWindow,
  getEffectiveSmsQuietHoursWindow,
  nextSmsWindowStartForTenant,
  SMS_QUIET_HOURS_WINDOW_END,
  SMS_QUIET_HOURS_WINDOW_START,
} from '../../../platform/sms/SmsQuietHours';
import {
  SMS_CANNED_RESPONSE_TOKENS,
  findUnknownSmsCannedResponseTokens,
} from '../../../shared/sms/cannedResponseTokens';

const router = Router();
const logger = createLogger('ADMIN_SMS_INBOX');

interface TwilioCredentials {
  accountSid: string;
  apiKey: string;
  apiKeySecret: string;
  phoneNumber: string;
}

async function getTwilioCredentials(tenantId: string): Promise<TwilioCredentials | null> {
  const pool = getPlatformPool();
  try {
    const { rows } = await pool.query(
      `SELECT config FROM connectors WHERE tenant_id = $1 AND connector_type = 'sms' AND enabled = true LIMIT 1`,
      [tenantId],
    );
    if (rows.length > 0) {
      const config = rows[0].config as Record<string, unknown>;
      const creds = (config.credentials || config) as Record<string, string>;
      if (creds.account_sid && (creds.auth_token || creds.api_key_secret)) {
        return {
          accountSid: creds.account_sid,
          apiKey: creds.api_key || creds.account_sid,
          apiKeySecret: creds.api_key_secret || creds.auth_token,
          phoneNumber: creds.from_number || creds.phone_number || '',
        };
      }
    }
  } catch (err) {
    logger.warn('Failed to load tenant Twilio credentials from connectors', { tenantId, error: String(err) });
  }

  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const phoneNumber = process.env.TWILIO_PHONE_NUMBER || process.env.TWILIO_OUTBOUND_NUMBER || '';

  if (accountSid && authToken) {
    return { accountSid, apiKey: accountSid, apiKeySecret: authToken, phoneNumber };
  }

  return null;
}

async function twilioPost(creds: TwilioCredentials, path: string, body: Record<string, string>): Promise<Record<string, unknown>> {
  const url = `https://api.twilio.com/2010-04-01/Accounts/${creds.accountSid}${path}`;
  const auth = Buffer.from(`${creds.apiKey}:${creds.apiKeySecret}`).toString('base64');
  const formBody = new URLSearchParams(body);
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: formBody.toString(),
  });
  if (!response.ok) {
    const errData = await response.json().catch(() => ({})) as Record<string, unknown>;
    throw new Error(`Twilio API error: ${response.status} ${errData.message || response.statusText}`);
  }
  return response.json() as Promise<Record<string, unknown>>;
}

function paginate(req: { query: Record<string, unknown> }): { limit: number; offset: number } {
  const limit = Math.min(parseInt(String(req.query.limit ?? '50'), 10), 200);
  const page = Math.max(parseInt(String(req.query.page ?? '1'), 10), 1);
  return { limit, offset: (page - 1) * limit };
}

const listPhoneLinesHandler: RequestHandler = async (req, res) => {
  const { tenantId } = req.user!;
  const pool = getPlatformPool();
  try {
    const { rows: phoneNumbers } = await pool.query(
      `SELECT id, phone_number, friendly_name FROM phone_numbers WHERE tenant_id = $1`,
      [tenantId],
    );
    const conversations = phoneNumbers.map((pn: Record<string, unknown>) => ({
      phoneNumberId: pn.id,
      phoneNumber: pn.phone_number,
      friendlyName: pn.friendly_name,
    }));
    return res.json({ conversations, total: conversations.length });
  } catch (err) {
    logger.error('Failed to list phone lines', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to list phone lines' });
  }
};

const listConversationsHandler: RequestHandler = async (req, res) => {
  const { tenantId } = req.user!;
  const { limit, offset } = paginate(req);
  const { status, assignee, phoneNumberId, priority, pinned, followUp, unread, deferred, search } = req.query as Record<string, string>;

  const VALID_STATUSES = ['open', 'pending', 'closed', 'escalated', 'archived'];
  const VALID_PRIORITIES = ['normal', 'high', 'urgent'];
  if (status && !VALID_STATUSES.includes(status)) return res.status(400).json({ error: `Invalid status. Must be one of: ${VALID_STATUSES.join(', ')}` });
  if (priority && !VALID_PRIORITIES.includes(priority)) return res.status(400).json({ error: `Invalid priority. Must be one of: ${VALID_PRIORITIES.join(', ')}` });

  try {
    const result = await SmsService.listConversations(tenantId, {
      status: status as SmsService.ConversationStatus,
      assigneeUserId: assignee,
      phoneNumberId,
      priority: priority as SmsService.ConversationPriority,
      pinned: pinned === 'true' ? true : pinned === 'false' ? false : undefined,
      followUp: followUp === 'true' ? true : followUp === 'false' ? false : undefined,
      unreadOnly: unread === 'true',
      deferredOnly: deferred === 'true',
      search,
      limit,
      offset,
    });
    return res.json(result);
  } catch (err) {
    logger.error('Failed to list conversations', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to list conversations' });
  }
};

const getConversationHandler: RequestHandler = async (req, res) => {
  const { tenantId } = req.user!;
  const { id } = req.params;
  try {
    const conv = await SmsService.getConversation(tenantId, id);
    if (!conv) return res.status(404).json({ error: 'Conversation not found' });
    return res.json({ conversation: conv });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to get conversation' });
  }
};

const updateConversationHandler: RequestHandler = async (req, res) => {
  const { tenantId, userId } = req.user!;
  const { id } = req.params;
  const updates = req.body as {
    status?: SmsService.ConversationStatus;
    assigneeUserId?: string | null;
    assigneeTeam?: string | null;
    priority?: SmsService.ConversationPriority;
    pinned?: boolean;
    followUp?: boolean;
    followUpAt?: string;
    contactName?: string;
    contactEmail?: string;
    contactLocation?: string;
    tags?: string[];
  };

  const VALID_STATUSES = ['open', 'pending', 'closed', 'escalated', 'archived'];
  const VALID_PRIORITIES = ['normal', 'high', 'urgent'];
  if (updates.status && !VALID_STATUSES.includes(updates.status)) return res.status(400).json({ error: `Invalid status` });
  if (updates.priority && !VALID_PRIORITIES.includes(updates.priority)) return res.status(400).json({ error: `Invalid priority` });
  if (updates.followUpAt && isNaN(new Date(updates.followUpAt).getTime())) return res.status(400).json({ error: 'Invalid followUpAt date' });

  try {
    const before = await SmsService.getConversation(tenantId, id);
    if (!before) return res.status(404).json({ error: 'Conversation not found' });

    const conv = await SmsService.updateConversation(tenantId, id, {
      ...updates,
      followUpAt: updates.followUpAt ? new Date(updates.followUpAt) : undefined,
    });

    if (updates.status && updates.status !== before.status) {
      await SmsService.logActivity(tenantId, id, 'status_changed', userId, req.user!.email, { from: before.status, to: updates.status });
    }
    if (updates.assigneeUserId !== undefined && updates.assigneeUserId !== before.assigneeUserId) {
      await SmsService.logActivity(tenantId, id, 'assigned', userId, req.user!.email, { to: updates.assigneeUserId });
    }

    await writeAuditLog({
      tenantId,
      actorUserId: userId,
      actorRole: req.user!.role,
      action: 'sms_conversation.updated',
      resourceType: 'sms_conversation',
      resourceId: id,
      beforeState: { status: before.status, assigneeUserId: before.assigneeUserId },
      afterState: updates,
      ipAddress: extractIp(req),
      userAgent: req.headers['user-agent'],
    });

    return res.json({ conversation: conv });
  } catch (err) {
    logger.error('Failed to update conversation', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to update conversation' });
  }
};

const getMessagesHandler: RequestHandler = async (req, res) => {
  const { tenantId } = req.user!;
  const { id } = req.params;
  const { limit, offset } = paginate(req);
  try {
    const result = await SmsService.listMessages(tenantId, id, { limit, offset });
    await SmsService.markConversationRead(tenantId, id);
    return res.json(result);
  } catch (err) {
    return res.status(500).json({ error: 'Failed to get messages' });
  }
};

const sendMessageHandler: RequestHandler = async (req, res) => {
  const { tenantId, userId } = req.user!;
  const { id } = req.params;
  const { body, scheduledAt } = req.body as { body?: string; scheduledAt?: string };

  if (!body?.trim()) return res.status(400).json({ error: 'body is required' });

  try {
    const conv = await SmsService.getConversation(tenantId, id);
    if (!conv) return res.status(404).json({ error: 'Conversation not found' });

    const pool = getPlatformPool();
    const { rows: pnRows } = await pool.query(
      `SELECT phone_number FROM phone_numbers WHERE id = $1 AND tenant_id = $2`,
      [conv.phoneNumberId, tenantId],
    );
    if (pnRows.length === 0) return res.status(404).json({ error: 'Phone number not found' });
    const fromNumber = pnRows[0].phone_number as string;

    const onDnc = await (await import('../../../platform/campaigns/DncService')).isOnDnc(tenantId, conv.remoteNumber);
    if (onDnc) {
      return res.status(403).json({ error: 'This number is on the Do Not Contact list' });
    }

    const schedDate = scheduledAt ? new Date(scheduledAt) : undefined;
    if (scheduledAt && (!schedDate || isNaN(schedDate.getTime()))) {
      return res.status(400).json({ error: 'Invalid scheduledAt date' });
    }

    // TCPA quiet-hours enforcement (8am-9pm in the recipient's local time).
    // Mirrors the voice-side `evaluateQuietHours` pre-flight so SMS can't be
    // used to side-step the same regulatory window. For immediate sends we
    // reject with 403; for scheduled sends we reject if the operator picked
    // a `scheduledAt` that falls outside the recipient's local window so the
    // problem surfaces in the UI rather than silently deferring.
    const quietHoursAt = schedDate ?? new Date();
    const effectiveWindow = await getEffectiveSmsQuietHoursWindow(tenantId);
    const quietHours = await evaluateSmsQuietHoursForTenant(tenantId, conv.remoteNumber, quietHoursAt);
    if (!quietHours.allowed) {
      logger.info('SMS blocked by TCPA quiet hours', {
        tenantId,
        conversationId: id,
        to: conv.remoteNumber,
        timezone: quietHours.timezone,
        localTime: quietHours.localTimeIso,
        scheduled: Boolean(schedDate),
        windowStart: effectiveWindow.start,
        windowEnd: effectiveWindow.end,
        tenantOverride: effectiveWindow.isTenantOverride,
      });
      return res.status(403).json({
        error: 'Outside SMS quiet hours',
        reason: 'sms_quiet_hours',
        details: {
          recipientTimezone: quietHours.timezone,
          recipientLocalTime: quietHours.localTimeIso,
          windowStart: effectiveWindow.start,
          windowEnd: effectiveWindow.end,
          tenantOverride: effectiveWindow.isTenantOverride,
        },
        message: `${effectiveWindow.isTenantOverride ? 'Tenant SMS quiet-hours override' : 'TCPA'}: SMS to this recipient can only be sent between ${effectiveWindow.start} and ${effectiveWindow.end} in their local time (${quietHours.timezone}).`,
      });
    }

    if (!schedDate) {
      const creds = await getTwilioCredentials(tenantId);
      if (!creds) return res.status(503).json({ error: 'SMS service not configured' });

      const twilioResponse = await twilioPost(creds, '/Messages.json', {
        To: conv.remoteNumber,
        From: fromNumber,
        Body: body,
      });

      const message = await SmsService.saveMessage(tenantId, id, {
        direction: 'outbound',
        fromNumber,
        toNumber: conv.remoteNumber,
        body,
        status: (twilioResponse.status as string) || 'queued',
        twilioSid: twilioResponse.sid as string,
        // Reuse the pre-check instant so the chokepoint guard cannot throw
        // a false positive at the 21:00:00 boundary after Twilio already
        // accepted the send.
        quietHoursEvaluatedAt: quietHoursAt,
      });

      await SmsService.logActivity(tenantId, id, 'message_sent', userId, req.user!.email, { messageId: message.id });

      await writeAuditLog({
        tenantId,
        actorUserId: userId,
        actorRole: req.user!.role,
        action: 'sms_message.sent',
        resourceType: 'sms_message',
        resourceId: message.id,
        afterState: { to: conv.remoteNumber },
        ipAddress: extractIp(req),
        userAgent: req.headers['user-agent'],
      });

      return res.json({ message });
    } else {
      const message = await SmsService.saveMessage(tenantId, id, {
        direction: 'outbound',
        fromNumber,
        toNumber: conv.remoteNumber,
        body,
        status: 'scheduled',
        scheduledAt: schedDate,
      });

      await SmsService.logActivity(tenantId, id, 'message_scheduled', userId, req.user!.email, { messageId: message.id, scheduledAt });

      return res.json({ message });
    }
  } catch (err) {
    // Map the chokepoint quiet-hours throw to a 403 so the UI shows the
    // same friendly message regardless of which layer caught the violation.
    if (err && typeof err === 'object' && (err as { code?: string }).code === 'sms_quiet_hours') {
      const e = err as { recipientTimezone?: string; recipientLocalTime?: string };
      logger.info('SMS blocked by chokepoint quiet-hours guard', {
        tenantId,
        timezone: e.recipientTimezone,
        localTime: e.recipientLocalTime,
      });
      const effectiveWindow = await getEffectiveSmsQuietHoursWindow(tenantId);
      return res.status(403).json({
        error: 'Outside SMS quiet hours',
        reason: 'sms_quiet_hours',
        details: {
          recipientTimezone: e.recipientTimezone,
          recipientLocalTime: e.recipientLocalTime,
          windowStart: effectiveWindow.start,
          windowEnd: effectiveWindow.end,
          tenantOverride: effectiveWindow.isTenantOverride,
        },
      });
    }
    logger.error('Failed to send message', { tenantId, error: String(err) });
    return res.status(500).json({ error: `Failed to send message: ${err instanceof Error ? err.message : 'Unknown error'}` });
  }
};

const addNoteHandler: RequestHandler = async (req, res) => {
  const { tenantId, userId } = req.user!;
  const { id } = req.params;
  const { body } = req.body as { body?: string };
  if (!body?.trim()) return res.status(400).json({ error: 'body is required' });
  try {
    const note = await SmsService.addInternalNote(tenantId, id, userId, req.user!.email, body);
    await SmsService.logActivity(tenantId, id, 'note_added', userId, req.user!.email);
    return res.status(201).json({ note });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to add note' });
  }
};

const listNotesHandler: RequestHandler = async (req, res) => {
  const { tenantId } = req.user!;
  const { id } = req.params;
  try {
    const notes = await SmsService.listInternalNotes(tenantId, id);
    return res.json({ notes });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to list notes' });
  }
};

const activityLogHandler: RequestHandler = async (req, res) => {
  const { tenantId } = req.user!;
  const { id } = req.params;
  try {
    const log = await SmsService.listActivityLog(tenantId, id);
    return res.json({ log });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to get activity log' });
  }
};

const inboxCountsHandler: RequestHandler = async (req, res) => {
  const { tenantId } = req.user!;
  try {
    const counts = await SmsService.getInboxCounts(tenantId);
    return res.json({ counts });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to get inbox counts' });
  }
};

// Surface every outbound SMS that the dispatcher is currently holding back
// because the recipient was inside the TCPA quiet-hours window. The inbox
// UI joins this list to its conversation rows so operators can see "deferred
// until <time>" badges and a queue total without trawling server logs —
// task #989. Defense-in-depth: the dispatcher inserts the activity-log row
// every time it parks a message, so this is always derived from the source
// of truth for what's actually delayed (no separate flag column to drift).
const deferredMessagesHandler: RequestHandler = async (req, res) => {
  const { tenantId } = req.user!;
  try {
    const deferred = await SmsService.listDeferredMessages(tenantId);
    return res.json({ deferred });
  } catch (err) {
    logger.error('Failed to list deferred SMS', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to list deferred SMS' });
  }
};

const bulkUpdateHandler: RequestHandler = async (req, res) => {
  const { tenantId, userId } = req.user!;
  const { conversationIds, status, assigneeUserId, tags } = req.body as {
    conversationIds?: string[];
    status?: SmsService.ConversationStatus;
    assigneeUserId?: string | null;
    tags?: string[];
  };
  if (!Array.isArray(conversationIds) || conversationIds.length === 0) {
    return res.status(400).json({ error: 'conversationIds array is required' });
  }
  try {
    const updated = await SmsService.bulkUpdateConversations(tenantId, conversationIds, { status, assigneeUserId, tags });

    await writeAuditLog({
      tenantId,
      actorUserId: userId,
      actorRole: req.user!.role,
      action: 'sms_conversation.bulk_updated',
      resourceType: 'sms_conversation',
      afterState: { count: updated, status, assigneeUserId },
      ipAddress: extractIp(req),
      userAgent: req.headers['user-agent'],
    });

    return res.json({ updated });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to bulk update' });
  }
};

const listCannedResponsesHandler: RequestHandler = async (req, res) => {
  const { tenantId } = req.user!;
  try {
    const responses = await SmsService.listCannedResponses(tenantId);
    return res.json({ responses });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to list templates' });
  }
};

const createCannedResponseHandler: RequestHandler = async (req, res) => {
  const { tenantId, userId } = req.user!;
  const data = req.body as { title?: string; body?: string; category?: string; variables?: string[]; shortcut?: string; isGlobal?: boolean };
  if (!data.title || !data.body) return res.status(400).json({ error: 'title and body are required' });
  // Reject typos like {{custmer_name}} server-side too so the inline
  // editor warning can't be bypassed via direct API calls — see task
  // #806 and shared/sms/cannedResponseTokens.ts.
  const unknownTokens = findUnknownSmsCannedResponseTokens(data.body);
  if (unknownTokens.length > 0) {
    return res.status(400).json({
      error: `Unknown merge token${unknownTokens.length === 1 ? '' : 's'}: ${unknownTokens
        .map((t) => `{{${t}}}`)
        .join(', ')}. Supported tokens: ${SMS_CANNED_RESPONSE_TOKENS
        .map((t) => `{{${t}}}`)
        .join(', ')}.`,
      unknownTokens,
      knownTokens: SMS_CANNED_RESPONSE_TOKENS,
    });
  }
  try {
    const response = await SmsService.createCannedResponse(tenantId, { ...data, title: data.title, body: data.body, createdBy: userId });
    return res.status(201).json({ response });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to create template' });
  }
};

const updateCannedResponseHandler: RequestHandler = async (req, res) => {
  const { tenantId } = req.user!;
  const { id } = req.params;
  const { body } = req.body as { body?: string };
  if (body !== undefined) {
    const unknownTokens = findUnknownSmsCannedResponseTokens(body);
    if (unknownTokens.length > 0) {
      return res.status(400).json({
        error: `Unknown merge token${unknownTokens.length === 1 ? '' : 's'}: ${unknownTokens
          .map((t) => `{{${t}}}`)
          .join(', ')}. Supported tokens: ${SMS_CANNED_RESPONSE_TOKENS
          .map((t) => `{{${t}}}`)
          .join(', ')}.`,
        unknownTokens,
        knownTokens: SMS_CANNED_RESPONSE_TOKENS,
      });
    }
  }
  try {
    const response = await SmsService.updateCannedResponse(tenantId, id, req.body);
    if (!response) return res.status(404).json({ error: 'Template not found' });
    return res.json({ response });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to update template' });
  }
};

const deleteCannedResponseHandler: RequestHandler = async (req, res) => {
  const { tenantId } = req.user!;
  const { id } = req.params;
  try {
    const deleted = await SmsService.deleteCannedResponse(tenantId, id);
    if (!deleted) return res.status(404).json({ error: 'Template not found' });
    return res.json({ deleted: true });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to delete template' });
  }
};

const substituteHandler: RequestHandler = async (req, res) => {
  const { template, variables } = req.body as { template?: string; variables?: Record<string, string> };
  if (!template) return res.status(400).json({ error: 'template is required' });
  const result = await SmsService.substituteVariables(template, variables ?? {});
  return res.json({ result });
};

const listAutoReplyRulesHandler: RequestHandler = async (req, res) => {
  const { tenantId } = req.user!;
  try {
    const rules = await SmsService.listAutoReplyRules(tenantId);
    return res.json({ rules });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to list auto-reply rules' });
  }
};

const createAutoReplyRuleHandler: RequestHandler = async (req, res) => {
  const { tenantId } = req.user!;
  const data = req.body;
  if (!data.name || !data.replyBody) return res.status(400).json({ error: 'name and replyBody are required' });
  const unknownTokens = findUnknownSmsCannedResponseTokens(data.replyBody);
  if (unknownTokens.length > 0) {
    return res.status(400).json({
      error: `Unknown merge token${unknownTokens.length === 1 ? '' : 's'}: ${unknownTokens
        .map((t) => `{{${t}}}`)
        .join(', ')}. Supported tokens: ${SMS_CANNED_RESPONSE_TOKENS
        .map((t) => `{{${t}}}`)
        .join(', ')}.`,
      unknownTokens,
      knownTokens: SMS_CANNED_RESPONSE_TOKENS,
    });
  }
  try {
    const rule = await SmsService.createAutoReplyRule(tenantId, data);
    return res.status(201).json({ rule });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to create auto-reply rule' });
  }
};

const updateAutoReplyRuleHandler: RequestHandler = async (req, res) => {
  const { tenantId } = req.user!;
  const { id } = req.params;
  const { replyBody } = req.body as { replyBody?: string };
  if (replyBody !== undefined) {
    const unknownTokens = findUnknownSmsCannedResponseTokens(replyBody);
    if (unknownTokens.length > 0) {
      return res.status(400).json({
        error: `Unknown merge token${unknownTokens.length === 1 ? '' : 's'}: ${unknownTokens
          .map((t) => `{{${t}}}`)
          .join(', ')}. Supported tokens: ${SMS_CANNED_RESPONSE_TOKENS
          .map((t) => `{{${t}}}`)
          .join(', ')}.`,
        unknownTokens,
        knownTokens: SMS_CANNED_RESPONSE_TOKENS,
      });
    }
  }
  try {
    const rule = await SmsService.updateAutoReplyRule(tenantId, id, req.body);
    if (!rule) return res.status(404).json({ error: 'Rule not found' });
    return res.json({ rule });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to update rule' });
  }
};

const deleteAutoReplyRuleHandler: RequestHandler = async (req, res) => {
  const { tenantId } = req.user!;
  const { id } = req.params;
  try {
    const deleted = await SmsService.deleteAutoReplyRule(tenantId, id);
    if (!deleted) return res.status(404).json({ error: 'Rule not found' });
    return res.json({ deleted: true });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to delete rule' });
  }
};

const listAssignmentRulesHandler: RequestHandler = async (req, res) => {
  const { tenantId } = req.user!;
  try {
    const rules = await SmsService.listAssignmentRules(tenantId);
    return res.json({ rules });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to list assignment rules' });
  }
};

const createAssignmentRuleHandler: RequestHandler = async (req, res) => {
  const { tenantId } = req.user!;
  const data = req.body;
  if (!data.name || !data.matchField || !data.matchValue) {
    return res.status(400).json({ error: 'name, matchField, and matchValue are required' });
  }
  try {
    const rule = await SmsService.createAssignmentRule(tenantId, data);
    return res.status(201).json({ rule });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to create assignment rule' });
  }
};

const deleteAssignmentRuleHandler: RequestHandler = async (req, res) => {
  const { tenantId } = req.user!;
  const { id } = req.params;
  try {
    const deleted = await SmsService.deleteAssignmentRule(tenantId, id);
    if (!deleted) return res.status(404).json({ error: 'Rule not found' });
    return res.json({ deleted: true });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to delete rule' });
  }
};

const consentHistoryHandler: RequestHandler = async (req, res) => {
  const { tenantId } = req.user!;
  const { phoneNumber } = req.params;
  try {
    const history = await SmsService.getConsentHistory(tenantId, phoneNumber);
    return res.json({ history });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to get consent history' });
  }
};

const analyticsHandler: RequestHandler = async (req, res) => {
  const { tenantId } = req.user!;
  const { startDate, endDate, phoneNumberId, assignee } = req.query as Record<string, string>;
  try {
    const analytics = await SmsService.getAnalytics(tenantId, {
      startDate: startDate ? new Date(startDate) : undefined,
      endDate: endDate ? new Date(endDate) : undefined,
      phoneNumberId,
      assigneeUserId: assignee,
    });
    return res.json({ analytics });
  } catch (err) {
    logger.error('Failed to get SMS analytics', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to get analytics' });
  }
};

const aiDraftHandler: RequestHandler = async (req, res) => {
  const { tenantId } = req.user!;
  const { context } = req.body;

  try {
    const apiKey = process.env.OPENAI_API_KEY || process.env.OPENAI_ADMIN_API_KEY;
    if (!apiKey) {
      return res.json({ draft: 'Thank you for reaching out! I\'d be happy to help you with that. Let me check and get back to you shortly.' });
    }

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content: 'You are a helpful business assistant drafting SMS replies. Keep responses concise, professional, and friendly. Reply with just the message text, no quotation marks or labels.',
          },
          {
            role: 'user',
            content: `Based on this SMS conversation thread, draft a professional reply:\n\n${context || 'No conversation context provided.'}`,
          },
        ],
        max_tokens: 200,
        temperature: 0.7,
      }),
    });

    if (!response.ok) {
      throw new Error(`OpenAI API error: ${response.status}`);
    }

    const data = await response.json() as Record<string, unknown>;
    const choices = data.choices as Array<{ message: { content: string } }>;
    const draft = choices?.[0]?.message?.content?.trim() || 'Thank you for reaching out! I\'d be happy to help you with that.';

    return res.json({ draft });
  } catch (err) {
    logger.error('Failed to generate AI draft', { tenantId, error: String(err) });
    return res.json({ draft: 'Thank you for reaching out! I\'d be happy to help you with that. Let me check and get back to you shortly.' });
  }
};

/**
 * Tenant-tunable SMS quiet-hours window (Task #990).
 *
 * Returns the effective window currently being applied to outbound SMS
 * (post federal-floor clamp) plus the federal default and the raw tenant
 * override so the admin UI can show "Federal default" vs "Tenant override"
 * without doing the clamp itself.
 */
const getSmsComplianceSettingsHandler: RequestHandler = async (req, res) => {
  const { tenantId } = req.user!;
  try {
    const pool = getPlatformPool();
    let rawStart: string | null = null;
    let rawEnd: string | null = null;
    try {
      const { rows } = await pool.query(
        `SELECT to_char(sms_quiet_hours_start, 'HH24:MI') AS s,
                to_char(sms_quiet_hours_end,   'HH24:MI') AS e
           FROM tenants WHERE id = $1 LIMIT 1`,
        [tenantId],
      );
      if (rows.length > 0) {
        rawStart = (rows[0].s as string | null) ?? null;
        rawEnd = (rows[0].e as string | null) ?? null;
      }
    } catch (err) {
      logger.warn('Failed to read tenant SMS quiet-hours raw override', { tenantId, error: String(err) });
    }
    const effective = await getEffectiveSmsQuietHoursWindow(tenantId);
    return res.json({
      settings: {
        federalDefault: {
          windowStart: SMS_QUIET_HOURS_WINDOW_START,
          windowEnd: SMS_QUIET_HOURS_WINDOW_END,
        },
        tenantOverride: {
          // Raw, un-clamped values as the admin saved them. `null` on
          // either side means "use the federal default for this side".
          windowStart: rawStart,
          windowEnd: rawEnd,
        },
        effective: {
          windowStart: effective.start,
          windowEnd: effective.end,
          isTenantOverride: effective.isTenantOverride,
          display: formatSmsQuietHoursWindow(effective),
        },
      },
    });
  } catch (err) {
    logger.error('Failed to load SMS compliance settings', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to load SMS compliance settings' });
  }
};

const HHMM_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

function parseHHMM(value: string): number {
  const [h, m] = value.split(':').map(Number);
  return h * 60 + m;
}

const updateSmsComplianceSettingsHandler: RequestHandler = async (req, res) => {
  const { tenantId, userId } = req.user!;
  const body = (req.body ?? {}) as { windowStart?: string | null; windowEnd?: string | null };

  // `null` on either side clears that side back to the federal default.
  // `undefined` leaves it unchanged. Anything else must be HH:MM and must
  // sit inside (or equal to) the federal floor — we reject loosenings at
  // the API edge so the caller sees a clear 400, not a silent clamp.
  const fStart = parseHHMM(SMS_QUIET_HOURS_WINDOW_START);
  const fEnd = parseHHMM(SMS_QUIET_HOURS_WINDOW_END);

  function validate(side: 'windowStart' | 'windowEnd', value: string | null | undefined):
    | { kind: 'unchanged' }
    | { kind: 'clear' }
    | { kind: 'set'; value: string }
    | { kind: 'error'; message: string } {
    if (value === undefined) return { kind: 'unchanged' };
    if (value === null) return { kind: 'clear' };
    if (typeof value !== 'string' || !HHMM_RE.test(value)) {
      return { kind: 'error', message: `${side} must be a HH:MM string (24-hour) or null` };
    }
    const v = parseHHMM(value);
    if (v < fStart || v > fEnd) {
      return {
        kind: 'error',
        message: `${side} must sit inside the federal default (${SMS_QUIET_HOURS_WINDOW_START}–${SMS_QUIET_HOURS_WINDOW_END}); ${value} would weaken the platform protection`,
      };
    }
    return { kind: 'set', value };
  }

  const startResult = validate('windowStart', body.windowStart);
  const endResult = validate('windowEnd', body.windowEnd);
  if (startResult.kind === 'error') return res.status(400).json({ error: startResult.message });
  if (endResult.kind === 'error') return res.status(400).json({ error: endResult.message });
  if (startResult.kind === 'unchanged' && endResult.kind === 'unchanged') {
    return res.status(400).json({ error: 'Provide windowStart and/or windowEnd (use null to clear back to the federal default)' });
  }

  // Cross-side validation: if the resulting pair would be inverted (start
  // >= end), reject. Need to merge the requested change against the
  // currently-stored row so a one-sided update can't invert with the
  // existing value.
  const pool = getPlatformPool();
  const { rows: existingRows } = await pool.query(
    `SELECT to_char(sms_quiet_hours_start, 'HH24:MI') AS s,
            to_char(sms_quiet_hours_end,   'HH24:MI') AS e
       FROM tenants WHERE id = $1 LIMIT 1`,
    [tenantId],
  );
  const existing = existingRows[0] ?? {};
  const nextStart =
    startResult.kind === 'set' ? startResult.value
    : startResult.kind === 'clear' ? null
    : ((existing.s as string | null) ?? null);
  const nextEnd =
    endResult.kind === 'set' ? endResult.value
    : endResult.kind === 'clear' ? null
    : ((existing.e as string | null) ?? null);
  if (nextStart && nextEnd && parseHHMM(nextStart) >= parseHHMM(nextEnd)) {
    return res.status(400).json({
      error: `windowStart (${nextStart}) must be earlier than windowEnd (${nextEnd})`,
    });
  }

  const updates: string[] = [];
  const values: unknown[] = [tenantId];
  if (startResult.kind === 'set') {
    values.push(startResult.value);
    updates.push(`sms_quiet_hours_start = $${values.length}::time`);
  } else if (startResult.kind === 'clear') {
    updates.push(`sms_quiet_hours_start = NULL`);
  }
  if (endResult.kind === 'set') {
    values.push(endResult.value);
    updates.push(`sms_quiet_hours_end = $${values.length}::time`);
  } else if (endResult.kind === 'clear') {
    updates.push(`sms_quiet_hours_end = NULL`);
  }

  try {
    await pool.query(
      `UPDATE tenants SET ${updates.join(', ')} WHERE id = $1`,
      values,
    );
  } catch (err) {
    logger.error('Failed to update SMS compliance settings', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to update SMS compliance settings' });
  }

  // Drop the cached effective window so a subsequent send picks up the
  // new value immediately rather than waiting out the 30s TTL.
  const { clearSmsQuietHoursCache } = await import('../../../platform/sms/SmsQuietHours');
  clearSmsQuietHoursCache(tenantId);

  await writeAuditLog({
    tenantId,
    actorUserId: userId,
    actorRole: req.user!.role,
    action: 'sms_compliance.window_updated',
    resourceType: 'tenant_settings',
    resourceId: tenantId,
    afterState: { windowStart: nextStart, windowEnd: nextEnd },
    ipAddress: extractIp(req),
    userAgent: req.headers['user-agent'],
  });

  const effective = await getEffectiveSmsQuietHoursWindow(tenantId);
  return res.json({
    settings: {
      federalDefault: {
        windowStart: SMS_QUIET_HOURS_WINDOW_START,
        windowEnd: SMS_QUIET_HOURS_WINDOW_END,
      },
      tenantOverride: { windowStart: nextStart, windowEnd: nextEnd },
      effective: {
        windowStart: effective.start,
        windowEnd: effective.end,
        isTenantOverride: effective.isTenantOverride,
        display: formatSmsQuietHoursWindow(effective),
      },
    },
  });
};

router.get('/sms-inbox/compliance-settings', requireAuth, getSmsComplianceSettingsHandler);
router.put(
  '/sms-inbox/compliance-settings',
  requireAuth,
  requireRole('manager'),
  updateSmsComplianceSettingsHandler,
);

router.get('/sms-inbox/conversations', requireAuth, listPhoneLinesHandler);
router.get('/sms-inbox/threads', requireAuth, listConversationsHandler);
router.get('/sms-inbox/threads/:id', requireAuth, getConversationHandler);
router.patch('/sms-inbox/threads/:id', requireAuth, requireMiniSystemWrite, updateConversationHandler);
router.get('/sms-inbox/threads/:id/messages', requireAuth, getMessagesHandler);
router.post('/sms-inbox/threads/:id/messages', requireAuth, requireMiniSystemWrite, sendMessageHandler);
router.post('/sms-inbox/threads/:id/notes', requireAuth, requireMiniSystemWrite, addNoteHandler);
router.get('/sms-inbox/threads/:id/notes', requireAuth, listNotesHandler);
router.get('/sms-inbox/threads/:id/activity', requireAuth, activityLogHandler);
router.get('/sms-inbox/counts', requireAuth, inboxCountsHandler);
router.get('/sms-inbox/deferred', requireAuth, deferredMessagesHandler);
router.post('/sms-inbox/bulk-update', requireAuth, requireMiniSystemWrite, bulkUpdateHandler);

router.get('/sms-inbox/templates', requireAuth, listCannedResponsesHandler);
router.post('/sms-inbox/templates', requireAuth, requireRole('manager'), createCannedResponseHandler);
router.patch('/sms-inbox/templates/:id', requireAuth, requireRole('manager'), updateCannedResponseHandler);
router.delete('/sms-inbox/templates/:id', requireAuth, requireRole('manager'), deleteCannedResponseHandler);
router.post('/sms-inbox/templates/substitute', requireAuth, substituteHandler);

router.get('/sms-inbox/auto-reply-rules', requireAuth, requireRole('manager'), listAutoReplyRulesHandler);
router.post('/sms-inbox/auto-reply-rules', requireAuth, requireRole('manager'), createAutoReplyRuleHandler);
router.patch('/sms-inbox/auto-reply-rules/:id', requireAuth, requireRole('manager'), updateAutoReplyRuleHandler);
router.delete('/sms-inbox/auto-reply-rules/:id', requireAuth, requireRole('manager'), deleteAutoReplyRuleHandler);

router.get('/sms-inbox/assignment-rules', requireAuth, requireRole('manager'), listAssignmentRulesHandler);
router.post('/sms-inbox/assignment-rules', requireAuth, requireRole('manager'), createAssignmentRuleHandler);
router.delete('/sms-inbox/assignment-rules/:id', requireAuth, requireRole('manager'), deleteAssignmentRuleHandler);

router.get('/sms-inbox/consent/:phoneNumber', requireAuth, requireRole('manager'), consentHistoryHandler);
router.get('/sms-inbox/analytics', requireAuth, requireRole('manager'), analyticsHandler);
router.post('/sms-inbox/ai-draft', requireAuth, aiDraftHandler);

const SMS_SCHEDULER_INTERVAL = 30_000;
export async function processScheduledMessages(): Promise<void> {
  try {
    const dueMessages = await SmsService.claimDueScheduledMessages();
    if (dueMessages.length === 0) return;

    logger.info('Processing scheduled SMS messages', { count: dueMessages.length });

    for (const msg of dueMessages) {
      try {
        const conv = await SmsService.getConversation(msg.tenantId, msg.conversationId);
        if (!conv) {
          await SmsService.updateMessageStatus(msg.tenantId, msg.id, 'failed');
          continue;
        }

        const { isOnDnc } = await import('../../../platform/campaigns/DncService');
        const onDnc = await isOnDnc(msg.tenantId, msg.toNumber);
        if (onDnc) {
          await SmsService.updateMessageStatus(msg.tenantId, msg.id, 'failed');
          await SmsService.logActivity(msg.tenantId, msg.conversationId, 'message_sent', null, null, {
            messageId: msg.id,
            suppressed: true,
            reason: 'recipient_opted_out_after_schedule',
          });
          logger.info('Scheduled SMS suppressed — recipient on DNC', { tenantId: msg.tenantId, messageId: msg.id, to: msg.toNumber });
          continue;
        }

        // TCPA quiet-hours defense-in-depth at dispatch time. The send
        // handler already rejects sends that would land outside the window,
        // but the recipient's local time can drift across DST boundaries or
        // a tenant could enqueue a scheduled message via another path that
        // skips the route. Defer the message to the next 8am-local instead
        // of dropping it so the operator's intent is preserved.
        const quietHours = await evaluateSmsQuietHoursForTenant(msg.tenantId, msg.toNumber);
        if (!quietHours.allowed) {
          const deferUntil = await nextSmsWindowStartForTenant(msg.tenantId, msg.toNumber);
          const pool = getPlatformPool();
          await pool.query(
            `UPDATE sms_messages SET status = 'scheduled', scheduled_at = $1 WHERE id = $2 AND tenant_id = $3`,
            [deferUntil, msg.id, msg.tenantId],
          );
          await SmsService.logActivity(msg.tenantId, msg.conversationId, 'message_deferred', null, null, {
            messageId: msg.id,
            reason: 'sms_quiet_hours',
            recipientTimezone: quietHours.timezone,
            deferredUntil: deferUntil.toISOString(),
          });
          logger.info('Scheduled SMS deferred — outside TCPA quiet hours', {
            tenantId: msg.tenantId,
            messageId: msg.id,
            timezone: quietHours.timezone,
            deferredUntil: deferUntil.toISOString(),
          });
          continue;
        }

        const creds = await getTwilioCredentials(msg.tenantId);
        if (!creds) {
          await SmsService.updateMessageStatus(msg.tenantId, msg.id, 'failed');
          logger.warn('No Twilio credentials for scheduled message', { tenantId: msg.tenantId, messageId: msg.id });
          continue;
        }

        const twilioResponse = await twilioPost(creds, '/Messages.json', {
          To: msg.toNumber,
          From: msg.fromNumber,
          Body: msg.body,
        });

        await SmsService.updateMessageStatus(msg.tenantId, msg.id, 'sent', twilioResponse.sid as string);
        await SmsService.logActivity(msg.tenantId, msg.conversationId, 'message_sent', null, null, {
          messageId: msg.id,
          scheduled: true,
        });

        logger.info('Scheduled SMS sent', { tenantId: msg.tenantId, messageId: msg.id });
      } catch (err) {
        await SmsService.updateMessageStatus(msg.tenantId, msg.id, 'failed');
        logger.error('Failed to send scheduled SMS', { messageId: msg.id, error: String(err) });
      }
    }
  } catch (err) {
    logger.error('Scheduled SMS processor error', { error: String(err) });
  }
}

// Skip the recurring dispatcher under vitest so tests can drive
// `processScheduledMessages` directly without a stray timer firing during
// the run. Vitest sets `NODE_ENV='test'` by default.
if (process.env.NODE_ENV !== 'test') {
  setInterval(processScheduledMessages, SMS_SCHEDULER_INTERVAL);
  logger.info('SMS scheduled message dispatcher started', { intervalMs: SMS_SCHEDULER_INTERVAL });
}

export default router;
