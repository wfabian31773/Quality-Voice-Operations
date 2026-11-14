/**
 * Inbox replies through the real `sms.send` chokepoint (in-memory store +
 * mocked Twilio). Proves a double-click with the same Idempotency-Key
 * sends one text, and an opted-out recipient is a 4xx with nothing sent.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import express, { type Request, type Response, type NextFunction } from 'express';
import request from 'supertest';
import { smsInboxReplyIdempotencyKey } from './smsInboxSchemas';

const queryMock = vi.fn();
const releaseMock = vi.fn();
const connectMock = vi.fn(async () => ({
  query: queryMock,
  release: releaseMock,
}));

vi.mock('../../../platform/db', () => ({
  getPlatformPool: () => ({ query: queryMock, connect: connectMock }),
  getPrivilegedPool: () => ({ query: queryMock, connect: connectMock }),
  withTenantContext: vi.fn(async (_client: unknown, _tenantId: string, fn: () => Promise<void>) => fn()),
  withPrivilegedClient: vi.fn(),
}));

vi.mock('../../../platform/core/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('../../../platform/audit/AuditService', () => ({
  writeAuditLog: vi.fn(async () => {}),
  extractIp: () => '127.0.0.1',
}));

const smsFake = vi.hoisted(() => ({
  current: null as null | import('../../../platform/actions/sms/__fixtures__/fakeSmsChokepoint').FakeSmsChokepoint,
}));
vi.mock('../../../platform/actions/sms', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../platform/actions/sms')>();
  return {
    ...actual,
    sendUserSms: (req: Parameters<typeof actual.sendUserSms>[0]) => actual.sendUserSms(req, smsFake.current!.options),
    sendStoredSms: (req: Parameters<typeof actual.sendStoredSms>[0]) =>
      actual.sendStoredSms(req, smsFake.current!.options),
  };
});
import { createFakeSmsChokepoint } from '../../../platform/actions/sms/__fixtures__/fakeSmsChokepoint';

const isOnDncMock = vi.fn(async (_tenantId: string, _phone: string) => false);
vi.mock('../../../platform/campaigns/DncService', () => ({
  isOnDnc: (tenantId: string, phone: string) => isOnDncMock(tenantId, phone),
}));

vi.mock('../../../platform/sms/SmsQuietHours', () => ({
  evaluateSmsQuietHoursForTenant: vi.fn(async () => ({
    allowed: true,
    timezone: 'America/Chicago',
    localTimeIso: '2026-04-28T13:00:00',
  })),
  getEffectiveSmsQuietHoursWindow: vi.fn(async () => ({ start: '08:00', end: '21:00', isTenantOverride: false })),
  formatSmsQuietHoursWindow: vi.fn(() => '08:00–21:00 local'),
  nextSmsWindowStartForTenant: vi.fn(async () => new Date('2026-04-29T12:00:00Z')),
  SMS_QUIET_HOURS_WINDOW_START: '08:00',
  SMS_QUIET_HOURS_WINDOW_END: '21:00',
}));

const getConversationMock = vi.fn();
const getMessageMock = vi.fn();
const logActivityMock = vi.fn(
  async (
    _tenantId: string,
    _conversationId: string,
    _action: string,
    _actorUserId: string | null,
    _actorName: string | null,
    _details?: Record<string, unknown>,
  ) => {},
);

vi.mock('../../../platform/sms/SmsConversationService', () => ({
  getConversation: (tenantId: string, id: string) => getConversationMock(tenantId, id),
  getMessage: (tenantId: string, id: string) => getMessageMock(tenantId, id),
  logActivity: (
    tenantId: string,
    conversationId: string,
    action: string,
    actorUserId: string | null,
    actorName: string | null,
    details?: Record<string, unknown>,
  ) => logActivityMock(tenantId, conversationId, action, actorUserId, actorName, details),
  saveMessage: vi.fn(),
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
  claimDueScheduledMessages: vi.fn(),
  updateMessageStatus: vi.fn(),
}));

vi.mock('../middleware/auth', () => ({
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

vi.mock('../middleware/rbac', () => ({
  requireMiniSystemWrite: (_req: Request, _res: Response, next: NextFunction) => next(),
  requireRole: () => (_req: Request, _res: Response, next: NextFunction) => next(),
  requirePlatformAdmin: (_req: Request, _res: Response, next: NextFunction) => next(),
  requireOpsRole: (_req: Request, _res: Response, next: NextFunction) => next(),
}));

import smsInboxRouter from './smsInbox';

function buildApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use(smsInboxRouter);
  return app;
}

const conversation = {
  id: 'conv-1',
  tenantId: 'tenant-1',
  phoneNumberId: 'pn-1',
  remoteNumber: '+15555550142',
  status: 'open',
};

beforeEach(() => {
  queryMock.mockReset();
  releaseMock.mockReset();
  connectMock.mockClear();
  isOnDncMock.mockReset();
  isOnDncMock.mockResolvedValue(false);
  getConversationMock.mockReset();
  getConversationMock.mockResolvedValue(conversation);
  getMessageMock.mockReset();
  getMessageMock.mockImplementation(async (_tenantId: string, id: string) => ({
    id,
    tenantId: 'tenant-1',
    conversationId: 'conv-1',
    direction: 'outbound',
    status: 'queued',
    body: 'Thanks for booking',
  }));
  logActivityMock.mockReset();
  logActivityMock.mockResolvedValue(undefined);
  smsFake.current = createFakeSmsChokepoint({ from: '+15555550100' });
  queryMock.mockImplementation(async (sql: string) =>
    /SELECT phone_number FROM phone_numbers/i.test(sql)
      ? { rows: [{ phone_number: '+15555550100' }], rowCount: 1 }
      : { rows: [], rowCount: 0 },
  );
});

describe('POST /sms-inbox/threads/:id/messages through sms.send', () => {
  it('sends one SMS and returns the same body when the Idempotency-Key is replayed', async () => {
    const post = () =>
      request(buildApp())
        .post('/sms-inbox/threads/conv-1/messages')
        .set('Idempotency-Key', 'owner-double-click')
        .send({ body: 'Thanks for booking' });

    const first = await post();
    const second = await post();

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body.message.id).toBe(first.body.message.id);
    expect(smsFake.current!.transport.send).toHaveBeenCalledTimes(1);
    expect(smsFake.current!.store.reserveOutbound).toHaveBeenCalledTimes(1);
    expect(aSendKey()).toBe(smsInboxReplyIdempotencyKey('tenant-1', 'conv-1', 'owner-double-click'));
  });

  it('returns 403 with the chokepoint opt-out reason and never calls Twilio', async () => {
    smsFake.current!.state.optedOut.add('+15555550142');
    const res = await request(buildApp()).post('/sms-inbox/threads/conv-1/messages').send({ body: 'Hi there' });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({
      error: 'Recipient has opted out of SMS',
      reason: 'recipient_opted_out',
      code: 'RECIPIENT_OPTED_OUT',
    });
    expect(smsFake.current!.transport.send).not.toHaveBeenCalled();
    expect(smsFake.current!.rows.size).toBe(0);
    expect(logActivityMock).not.toHaveBeenCalled();
  });
});

function aSendKey(): string | undefined {
  const rows = [...smsFake.current!.rows.values()];
  const key = rows[0]?.metadata.idempotencyKey;
  return typeof key === 'string' ? key : undefined;
}
