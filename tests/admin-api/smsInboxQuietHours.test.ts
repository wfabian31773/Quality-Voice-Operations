/**
 * Task #991 regression: end-to-end TCPA quiet-hours coverage for the SMS
 * inbox route and the scheduled-message dispatcher.
 *
 * The pure helpers (`evaluateSmsQuietHours`, `nextSmsWindowStart`) and the
 * `saveMessage` chokepoint are already covered in
 * `tests/admin-api/campaignCompliance.test.ts`. This file extends that
 * coverage to the actual HTTP route and the worker that processes due
 * messages, so a refactor that removed either guard would fail loudly here.
 *
 *   1. POST /sms-inbox/threads/:id/messages must return 403 with
 *      `reason: 'sms_quiet_hours'` for an immediate send to an east-coast
 *      number at 10pm Eastern, even when the tenant is configured in
 *      Pacific time.
 *   2. `processScheduledMessages` must defer (not fail) a scheduled message
 *      whose dispatch time falls outside the recipient's window: the
 *      message row is updated to `status='scheduled'` with a future
 *      `scheduled_at` matching `nextSmsWindowStart`.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express, { type Request, type Response, type NextFunction } from 'express';
import request from 'supertest';

const queryMock = vi.fn();
const releaseMock = vi.fn();
const connectMock = vi.fn(async () => ({
  query: queryMock,
  release: releaseMock,
}));

vi.mock('../../platform/db', () => ({
  getPlatformPool: () => ({ query: queryMock, connect: connectMock }),
  getPrivilegedPool: () => ({ query: queryMock, connect: connectMock }),
  withTenantContext: vi.fn(
    async (_client: unknown, _tenantId: string, fn: () => Promise<void>) => fn(),
  ),
  withPrivilegedClient: vi.fn(),
}));

vi.mock('../../platform/core/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('../../platform/audit/AuditService', () => ({
  writeAuditLog: vi.fn(async () => {}),
  extractIp: () => '127.0.0.1',
}));

// Sends go through the real `sms.send` action over an in-memory store and a
// mocked Twilio transport (no fetch, no DB).
const smsFake = vi.hoisted(() => ({
  current: null as null | import('../../platform/actions/sms/__fixtures__/fakeSmsChokepoint').FakeSmsChokepoint,
}));
vi.mock('../../platform/actions/sms', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../platform/actions/sms')>();
  return {
    ...actual,
    sendUserSms: (req: Parameters<typeof actual.sendUserSms>[0]) => actual.sendUserSms(req, smsFake.current!.options),
    sendStoredSms: (req: Parameters<typeof actual.sendStoredSms>[0]) =>
      actual.sendStoredSms(req, smsFake.current!.options),
  };
});
import { createFakeSmsChokepoint } from '../../platform/actions/sms/__fixtures__/fakeSmsChokepoint';
import { TwilioApiError } from '../../platform/integrations/twilio/sender';

const isOnDncMock = vi.fn(async () => false);
vi.mock('../../platform/campaigns/DncService', () => ({
  isOnDnc: (...args: unknown[]) => isOnDncMock(...(args as [string, string])),
}));

const getConversationMock = vi.fn();
const saveMessageMock = vi.fn();
const getMessageMock = vi.fn();
const logActivityMock = vi.fn(async () => {});
const claimDueScheduledMessagesMock = vi.fn();
const updateMessageStatusMock = vi.fn(async () => {});

vi.mock('../../platform/sms/SmsConversationService', () => ({
  getConversation: (...args: unknown[]) => getConversationMock(...args),
  saveMessage: (...args: unknown[]) => saveMessageMock(...args),
  getMessage: (...args: unknown[]) => getMessageMock(...args),
  logActivity: (...args: unknown[]) => logActivityMock(...args),
  claimDueScheduledMessages: (...args: unknown[]) =>
    claimDueScheduledMessagesMock(...args),
  updateMessageStatus: (...args: unknown[]) => updateMessageStatusMock(...args),
  // Stubs for the rest of the surface area the route imports as
  // `* as SmsService`. The route doesn't call them in the tested paths,
  // but the property accesses must not throw.
  listConversations: vi.fn(),
  updateConversation: vi.fn(),
  markConversationRead: vi.fn(),
  listMessages: vi.fn(),
  addInternalNote: vi.fn(),
  listInternalNotes: vi.fn(),
  listActivityLog: vi.fn(),
  getInboxCounts: vi.fn(),
  bulkUpdateConversations: vi.fn(),
  listCannedResponses: vi.fn(),
  createCannedResponse: vi.fn(),
  updateCannedResponse: vi.fn(),
  deleteCannedResponse: vi.fn(),
  substituteVariables: vi.fn(),
  listAutoReplyRules: vi.fn(),
  createAutoReplyRule: vi.fn(),
  updateAutoReplyRule: vi.fn(),
  deleteAutoReplyRule: vi.fn(),
  listAssignmentRules: vi.fn(),
  createAssignmentRule: vi.fn(),
  deleteAssignmentRule: vi.fn(),
  getConsentHistory: vi.fn(),
  getAnalytics: vi.fn(),
  SmsQuietHoursError: class extends Error {
    code = 'sms_quiet_hours' as const;
    recipientTimezone = '';
    recipientLocalTime: string | undefined = undefined;
  },
}));

vi.mock('../../server/admin-api/middleware/auth', () => ({
  requireAuth: (req: Request, _res: Response, next: NextFunction) => {
    (req as Request & { user?: unknown }).user = {
      tenantId: 'tenant-1',
      userId: 'user-1',
      email: 'op@example.com',
      role: 'tenant_owner',
      isPlatformAdmin: false,
    };
    next();
  },
}));

vi.mock('../../server/admin-api/middleware/rbac', () => ({
  requireMiniSystemWrite: (_req: Request, _res: Response, next: NextFunction) => next(),
  requireRole: () => (_req: Request, _res: Response, next: NextFunction) => next(),
  requirePlatformAdmin: (_req: Request, _res: Response, next: NextFunction) => next(),
  requireOpsRole: (_req: Request, _res: Response, next: NextFunction) => next(),
}));

import smsInboxRouter, { processScheduledMessages } from '../../server/admin-api/routes/smsInbox';

function buildApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use(smsInboxRouter);
  return app;
}

beforeEach(() => {
  queryMock.mockReset();
  releaseMock.mockReset();
  connectMock.mockClear();
  isOnDncMock.mockReset();
  isOnDncMock.mockResolvedValue(false);
  getConversationMock.mockReset();
  saveMessageMock.mockReset();
  getMessageMock.mockReset();
  getMessageMock.mockImplementation(async (_tenantId: string, id: string) => ({
    id,
    tenantId: 'tenant-1',
    conversationId: 'conv-1',
    direction: 'outbound',
    status: 'queued',
  }));
  smsFake.current = createFakeSmsChokepoint({ from: '+15555550100' });
  logActivityMock.mockReset();
  logActivityMock.mockResolvedValue(undefined);
  claimDueScheduledMessagesMock.mockReset();
  updateMessageStatusMock.mockReset();
  updateMessageStatusMock.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('POST /sms-inbox/threads/:id/messages quiet-hours enforcement', () => {
  it("returns 403 with reason 'sms_quiet_hours' for an immediate send to an east-coast number at 10pm Eastern", async () => {
    // 2026-04-28 02:00 UTC = 22:00 (10pm) America/New_York,
    //                        19:00 (7pm)  America/Los_Angeles.
    // The tenant is implicitly Pacific (we never reach a TZ-sensitive
    // branch on the route — the SMS check uses the recipient's local TZ).
    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.UTC(2026, 3, 28, 2, 0)));

    getConversationMock.mockResolvedValue({
      id: 'conv-1',
      tenantId: 'tenant-1',
      phoneNumberId: 'pn-1',
      remoteNumber: '+12025550100', // DC area code → America/New_York
      status: 'open',
      assigneeUserId: null,
      priority: 'normal',
      pinned: false,
      unreadCount: 0,
      followUp: false,
      followUpAt: null,
      lastMessageAt: null,
      lastMessagePreview: null,
      closedAt: null,
      escalatedAt: null,
      contactName: null,
      contactEmail: null,
      contactLocation: null,
      tags: [],
      metadata: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    queryMock.mockImplementation(async (sql: string) => {
      if (/SELECT phone_number FROM phone_numbers/i.test(sql)) {
        return { rows: [{ phone_number: '+15555550100' }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });

    const app = buildApp();
    const res = await request(app)
      .post('/sms-inbox/threads/conv-1/messages')
      .send({ body: 'Late-night ping' });

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({
      reason: 'sms_quiet_hours',
      details: {
        recipientTimezone: 'America/New_York',
        windowStart: '08:00',
        windowEnd: '21:00',
      },
    });
    expect(res.body.error).toMatch(/quiet hours/i);
    // We must reject before any message row is persisted.
    expect(saveMessageMock).not.toHaveBeenCalled();
  });

  it('allows the same send when the recipient is inside their local SMS window', async () => {
    // 2026-04-28 17:00 UTC = 13:00 Eastern (1pm), well inside the window.
    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.UTC(2026, 3, 28, 17, 0)));

    getConversationMock.mockResolvedValue({
      id: 'conv-1',
      tenantId: 'tenant-1',
      phoneNumberId: 'pn-1',
      remoteNumber: '+12025550100',
      status: 'open',
      assigneeUserId: null,
      priority: 'normal',
      pinned: false,
      unreadCount: 0,
      followUp: false,
      followUpAt: null,
      lastMessageAt: null,
      lastMessagePreview: null,
      closedAt: null,
      escalatedAt: null,
      contactName: null,
      contactEmail: null,
      contactLocation: null,
      tags: [],
      metadata: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    queryMock.mockImplementation(async (sql: string) => {
      if (/SELECT phone_number FROM phone_numbers/i.test(sql)) {
        return { rows: [{ phone_number: '+15555550100' }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });

    const app = buildApp();
    const res = await request(app)
      .post('/sms-inbox/threads/conv-1/messages')
      .send({ body: 'Daytime ping' });

    expect(res.status).toBe(200);
    expect(res.body.message).toMatchObject({ id: 'sms-1', status: 'queued' });
    // Sent through the chokepoint, from the thread's number, as the user.
    const fake = smsFake.current!;
    expect(fake.transport.send).toHaveBeenCalledTimes(1);
    expect(fake.transport.send.mock.calls[0][0]).toMatchObject({
      from: '+15555550100',
      to: '+12025550100',
      body: 'Daytime ping',
      statusCallback: 'https://voice.example.com/twilio/sms-status?mid=sms-1',
    });
    expect(fake.rows.get('sms-1')!.metadata).toMatchObject({ actor: { type: 'user', id: 'user-1' } });
    // The chokepoint's row is the message: no second row is saved.
    expect(saveMessageMock).not.toHaveBeenCalled();
    expect(fake.rows.size).toBe(1);
    expect(getMessageMock).toHaveBeenCalledWith('tenant-1', 'sms-1');
  });
});

describe('POST /sms-inbox/threads/:id/messages through the sms.send chokepoint', () => {
  const conversation = {
    id: 'conv-1',
    tenantId: 'tenant-1',
    phoneNumberId: 'pn-1',
    remoteNumber: '+12025550100',
    status: 'open',
  };
  const send = (body: string) => request(buildApp()).post('/sms-inbox/threads/conv-1/messages').send({ body });

  beforeEach(() => {
    // 13:00 Eastern: inside the recipient's window.
    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.UTC(2026, 3, 28, 17, 0)));
    getConversationMock.mockResolvedValue(conversation);
    queryMock.mockImplementation(async (sql: string) =>
      /SELECT phone_number FROM phone_numbers/i.test(sql)
        ? { rows: [{ phone_number: '+15555550100' }], rowCount: 1 }
        : { rows: [], rowCount: 0 },
    );
  });

  it('does not text an opted-out recipient (403)', async () => {
    smsFake.current!.state.optedOut.add('+12025550100');
    const res = await send('Hi');
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ reason: 'recipient_opted_out' });
    expect(smsFake.current!.transport.send).not.toHaveBeenCalled();
    expect(saveMessageMock).not.toHaveBeenCalled();
  });

  it('does not send while messaging is off (503, as before when SMS was not configured)', async () => {
    smsFake.current!.state.smsEnabled = false;
    const res = await send('Hi');
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('SMS service not configured');
    expect(smsFake.current!.transport.send).not.toHaveBeenCalled();
  });

  it('reports a Twilio error as before (500 "Failed to send message: …")', async () => {
    smsFake.current!.state.sendError = new TwilioApiError('Twilio API error: 400 Bad To', 400, 21604);
    const res = await send('Hi');
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Failed to send message: Twilio API error: 400 Bad To');
    expect(logActivityMock).not.toHaveBeenCalled();
  });

  it('rejects a body over 640 characters before sending', async () => {
    const res = await send('x'.repeat(641));
    expect(res.status).toBe(400);
    expect(smsFake.current!.transport.send).not.toHaveBeenCalled();
  });

  it('keeps the activity and audit rows on success', async () => {
    const res = await send('Hi');
    expect(res.status).toBe(200);
    expect(logActivityMock).toHaveBeenCalledWith('tenant-1', 'conv-1', 'message_sent', 'user-1', 'op@example.com', {
      messageId: 'sms-1',
    });
  });
});

describe('processScheduledMessages quiet-hours deferral', () => {
  it("updates the row to status='scheduled' with a future scheduled_at instead of failing", async () => {
    // 2026-04-28 02:00 UTC = 22:00 Eastern → recipient is past the SMS
    // quiet-hours window; the dispatcher must defer the row, not mark
    // it failed.
    vi.useFakeTimers();
    const now = new Date(Date.UTC(2026, 3, 28, 2, 0));
    vi.setSystemTime(now);

    claimDueScheduledMessagesMock.mockResolvedValue([
      {
        id: 'msg-1',
        tenantId: 'tenant-1',
        conversationId: 'conv-1',
        direction: 'outbound',
        fromNumber: '+15555550100',
        toNumber: '+12025550100', // east coast
        body: 'Hi from yesterday',
        status: 'sending',
        twilioSid: null,
        scheduledAt: new Date(now.getTime() - 60_000),
        sentAt: null,
        deliveredAt: null,
        errorMessage: null,
        metadata: {},
        createdAt: new Date(now.getTime() - 3_600_000),
      },
    ]);
    getConversationMock.mockResolvedValue({
      id: 'conv-1',
      tenantId: 'tenant-1',
      phoneNumberId: 'pn-1',
      remoteNumber: '+12025550100',
      status: 'open',
      assigneeUserId: null,
      priority: 'normal',
      pinned: false,
      unreadCount: 0,
      followUp: false,
      followUpAt: null,
      lastMessageAt: null,
      lastMessagePreview: null,
      closedAt: null,
      escalatedAt: null,
      contactName: null,
      contactEmail: null,
      contactLocation: null,
      tags: [],
      metadata: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const captured: Array<{ sql: string; values?: unknown[] }> = [];
    queryMock.mockImplementation(async (sql: string, values?: unknown[]) => {
      captured.push({ sql, values });
      return { rows: [], rowCount: 1 };
    });

    await processScheduledMessages();

    // Defense-in-depth: the dispatcher must NOT mark the message failed.
    expect(updateMessageStatusMock).not.toHaveBeenCalled();

    const updateCall = captured.find((c) =>
      /UPDATE sms_messages SET status = 'scheduled', scheduled_at =/i.test(c.sql),
    );
    expect(updateCall).toBeDefined();
    expect(updateCall!.sql).toMatch(/WHERE id = \$2 AND tenant_id = \$3/);

    const values = updateCall!.values as [Date, string, string];
    const [deferUntil, messageId, tenantId] = values;
    expect(messageId).toBe('msg-1');
    expect(tenantId).toBe('tenant-1');
    expect(deferUntil).toBeInstanceOf(Date);
    // The deferred-until instant must land in the future and inside the
    // recipient's local SMS window (08:00–21:00 America/New_York).
    expect(deferUntil.getTime()).toBeGreaterThan(now.getTime());
    const localHour = parseInt(
      new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/New_York',
        hour: '2-digit',
        hour12: false,
      }).format(deferUntil),
      10,
    );
    expect(localHour).toBeGreaterThanOrEqual(8);
    expect(localHour).toBeLessThan(21);

    // Activity log must record the deferral with the quiet-hours reason
    // so the operator-facing audit trail explains the slip.
    expect(logActivityMock).toHaveBeenCalledWith(
      'tenant-1',
      'conv-1',
      'message_deferred',
      null,
      null,
      expect.objectContaining({
        messageId: 'msg-1',
        reason: 'sms_quiet_hours',
        recipientTimezone: 'America/New_York',
      }),
    );
  });

  it('still dispatches scheduled messages when the recipient is inside their window', async () => {
    // 2026-04-28 17:00 UTC = 13:00 Eastern → inside window, must send.
    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.UTC(2026, 3, 28, 17, 0)));

    claimDueScheduledMessagesMock.mockResolvedValue([
      {
        id: 'msg-1',
        tenantId: 'tenant-1',
        conversationId: 'conv-1',
        direction: 'outbound',
        fromNumber: '+15555550100',
        toNumber: '+12025550100',
        body: 'Daytime ping',
        status: 'sending',
        twilioSid: null,
        scheduledAt: new Date(Date.UTC(2026, 3, 28, 16, 59)),
        sentAt: null,
        deliveredAt: null,
        errorMessage: null,
        metadata: {},
        createdAt: new Date(Date.UTC(2026, 3, 28, 12, 0)),
      },
    ]);
    getConversationMock.mockResolvedValue({
      id: 'conv-1',
      tenantId: 'tenant-1',
      phoneNumberId: 'pn-1',
      remoteNumber: '+12025550100',
      status: 'open',
      assigneeUserId: null,
      priority: 'normal',
      pinned: false,
      unreadCount: 0,
      followUp: false,
      followUpAt: null,
      lastMessageAt: null,
      lastMessagePreview: null,
      closedAt: null,
      escalatedAt: null,
      contactName: null,
      contactEmail: null,
      contactLocation: null,
      tags: [],
      metadata: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const captured: Array<{ sql: string; values?: unknown[] }> = [];
    queryMock.mockImplementation(async (sql: string, values?: unknown[]) => {
      captured.push({ sql, values });
      return { rows: [], rowCount: 0 };
    });
    // The scheduled row as stored by the inbox (claimed → 'sending').
    const fake = smsFake.current!;
    fake.rows.set('msg-1', {
      id: 'msg-1',
      tenantId: 'tenant-1',
      from: '+15555550100',
      to: '+12025550100',
      body: 'Daytime ping',
      status: 'sending',
      scheduledAt: new Date(Date.UTC(2026, 3, 28, 16, 59)),
      metadata: {},
    });

    await processScheduledMessages();

    // Send happened through the chokepoint, on the stored row (no new row).
    expect(fake.transport.send).toHaveBeenCalledTimes(1);
    expect(fake.transport.send.mock.calls[0][0]).toMatchObject({
      from: '+15555550100',
      to: '+12025550100',
      body: 'Daytime ping',
      statusCallback: 'https://voice.example.com/twilio/sms-status?mid=msg-1',
    });
    expect(fake.rows.size).toBe(1);
    // Status flipped to 'sent' with the Twilio SID, as before.
    expect(updateMessageStatusMock).toHaveBeenCalledWith(
      'tenant-1',
      'msg-1',
      'sent',
      'SM1',
    );
    expect(logActivityMock).toHaveBeenCalledWith('tenant-1', 'conv-1', 'message_sent', null, null, {
      messageId: 'msg-1',
      scheduled: true,
    });
    // No deferral UPDATE was issued.
    const deferCall = captured.find((c) =>
      /UPDATE sms_messages SET status = 'scheduled', scheduled_at =/i.test(c.sql),
    );
    expect(deferCall).toBeUndefined();
  });
});

describe('processScheduledMessages through the sms.send chokepoint', () => {
  const scheduledAt = new Date(Date.UTC(2026, 3, 28, 16, 59));

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.UTC(2026, 3, 28, 17, 0)));
    claimDueScheduledMessagesMock.mockResolvedValue([
      {
        id: 'msg-1',
        tenantId: 'tenant-1',
        conversationId: 'conv-1',
        direction: 'outbound',
        fromNumber: '+15555550100',
        toNumber: '+12025550100',
        body: 'Daytime ping',
        status: 'sending',
        twilioSid: null,
        scheduledAt,
        metadata: {},
      },
    ]);
    getConversationMock.mockResolvedValue({ id: 'conv-1', tenantId: 'tenant-1', remoteNumber: '+12025550100' });
    queryMock.mockResolvedValue({ rows: [], rowCount: 0 });
    smsFake.current!.rows.set('msg-1', {
      id: 'msg-1',
      tenantId: 'tenant-1',
      from: '+15555550100',
      to: '+12025550100',
      body: 'Daytime ping',
      status: 'sending',
      scheduledAt,
      metadata: {},
    });
  });

  it('does not text an opted-out recipient; marks the message failed with the suppression activity', async () => {
    smsFake.current!.state.optedOut.add('+12025550100');
    await processScheduledMessages();
    expect(smsFake.current!.transport.send).not.toHaveBeenCalled();
    expect(updateMessageStatusMock).toHaveBeenCalledWith('tenant-1', 'msg-1', 'failed');
    expect(logActivityMock).toHaveBeenCalledWith('tenant-1', 'conv-1', 'message_sent', null, null, {
      messageId: 'msg-1',
      suppressed: true,
      reason: 'recipient_opted_out_after_schedule',
    });
  });

  it('does not send while messaging is off; marks the message failed', async () => {
    smsFake.current!.state.tenantEnabled = false;
    await processScheduledMessages();
    expect(smsFake.current!.transport.send).not.toHaveBeenCalled();
    expect(updateMessageStatusMock).toHaveBeenCalledWith('tenant-1', 'msg-1', 'failed');
  });

  it('marks the message failed on a Twilio error, as before', async () => {
    smsFake.current!.state.sendError = new TwilioApiError('Twilio API error: 500 boom', 500, null);
    await processScheduledMessages();
    expect(smsFake.current!.transport.send).toHaveBeenCalledTimes(1);
    expect(updateMessageStatusMock).toHaveBeenCalledWith('tenant-1', 'msg-1', 'failed');
    expect(updateMessageStatusMock).not.toHaveBeenCalledWith('tenant-1', 'msg-1', 'sent', expect.anything());
  });
});
