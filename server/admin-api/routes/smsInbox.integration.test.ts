/**
 * Inbox replies through the real `sms.send` chokepoint (in-memory store +
 * mocked Twilio). Proves a double-click with the same Idempotency-Key
 * sends one text, and an opted-out recipient is a 4xx with nothing sent.
 * Scheduled replies below exercise the conversation service and action store
 * against SQL, including local-Postgres concurrency and rollback checks.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Client, Pool } from 'pg';
import { DataType, newDb } from 'pg-mem';
import type { Request, Response, NextFunction } from 'express';
import type { ActionRuntime } from '../../../platform/actions/core/runtime';
import { TwilioApiError, TwilioSendOutcomeUnknownError } from '../../../platform/integrations/twilio/sender';
import { smsInboxReplyIdempotencyKey } from './smsInboxSchemas';
import { postgresActionStore } from '../../../platform/actions/core/postgresStore';

const scheduledDb = vi.hoisted(() => ({ pool: null as Pool | null, active: false }));

const queryMock = vi.fn();
const releaseMock = vi.fn();
const connectMock = vi.fn(async () => ({
  query: queryMock,
  release: releaseMock,
}));

vi.mock('../../../platform/db', () => ({
  getPlatformPool: () => scheduledDb.active ? scheduledDb.pool! : { query: queryMock, connect: connectMock },
  getPrivilegedPool: () => ({ query: queryMock, connect: connectMock }),
  withTenantContext: vi.fn(async (_client: unknown, _tenantId: string, fn: () => Promise<void>) => fn()),
  withTenantClient: async (tenantId: string, fn: (client: unknown) => Promise<unknown>) => {
    const client = await scheduledDb.pool!.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  },
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
vi.mock('./smsInboxSchemas', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./smsInboxSchemas')>();
  return {
    ...actual,
    releaseSmsInboxReplyIdempotency: async (tenantId: string, key: string) => {
      const runtime = smsFake.current!.options.runtime as ActionRuntime;
      await runtime.withTenantTx!(tenantId, (tx) =>
        runtime.store!.releaseIdempotency(tx, { tenantId, action: 'sms.send', key }),
      );
    },
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

vi.mock('../../../platform/sms/SmsConversationService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../platform/sms/SmsConversationService')>();
  return {
    ...actual,
    getConversation: (tenantId: string, id: string) => scheduledDb.active
      ? actual.getConversation(tenantId, id) : getConversationMock(tenantId, id),
    getMessage: (tenantId: string, id: string) => scheduledDb.active
      ? actual.getMessage(tenantId, id) : getMessageMock(tenantId, id),
    logActivity: (
      tenantId: string,
      conversationId: string,
      action: string,
      actorUserId: string | null,
      actorName: string | null,
      details?: Record<string, unknown>,
    ) => scheduledDb.active
      ? actual.logActivity(tenantId, conversationId, action, actorUserId, actorName, details)
      : logActivityMock(tenantId, conversationId, action, actorUserId, actorName, details),
  };
});

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

// Like postScheduled below, exercise the real handler without a local listener.
async function postReply(body = 'Thanks for booking', key?: string) {
  const route = smsInboxRouter.stack.find((layer) =>
    layer.route?.path === '/sms-inbox/threads/:id/messages' && layer.route.stack.some((entry) => entry.method === 'post'),
  )!.route!;
  const res = {
    statusCode: 200, body: {} as Record<string, any>, // eslint-disable-line @typescript-eslint/no-explicit-any
    status(code: number) { this.statusCode = code; return this; },
    json(value: Record<string, unknown>) { this.body = value; return this; },
  };
  await route.stack.at(-1)!.handle({
    params: { id: 'conv-1' }, body: { body }, headers: key ? { 'idempotency-key': key } : {},
    user: { tenantId: 'tenant-1', userId: 'user-1', email: 'op@example.com', role: 'tenant_owner' },
  } as unknown as Request, res as unknown as Response, vi.fn());
  return { status: res.statusCode, body: res.body };
}

const conversation = {
  id: 'conv-1',
  tenantId: 'tenant-1',
  phoneNumberId: 'pn-1',
  remoteNumber: '+15555550142',
  status: 'open',
};

beforeEach(() => {
  scheduledDb.active = false;
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
    const post = () => postReply('Thanks for booking', 'owner-double-click');

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
    const res = await postReply('Hi there');
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({
      error: 'Recipient has opted out of SMS',
      reason: 'recipient_opted_out',
      code: 'RECIPIENT_OPTED_OUT',
      final: true,
    });
    expect(smsFake.current!.transport.send).not.toHaveBeenCalled();
    expect(smsFake.current!.rows.size).toBe(0);
    expect(logActivityMock).not.toHaveBeenCalled();
  });

  it('marks a Twilio auth rejection final and lets the same key send after credentials are fixed', async () => {
    smsFake.current!.state.sendError = new TwilioApiError('Twilio API error: 401 Authenticate', 401, 20003);
    const post = () => postReply('Thanks for booking', 'auth-retry');

    const first = await post();
    expect(first.status).toBe(422);
    expect(first.body).toMatchObject({
      reason: 'provider_rejected',
      code: 'PROVIDER_REJECTED',
      final: true,
    });
    expect(smsFake.current!.transport.send).toHaveBeenCalledTimes(1);
    expect(logActivityMock).not.toHaveBeenCalled();

    smsFake.current!.state.sendError = null;
    const second = await post();
    expect(second.status).toBe(200);
    expect(smsFake.current!.transport.send).toHaveBeenCalledTimes(2);
    expect(second.body.message.body).toBe('Thanks for booking');
  });

  it('keeps a successful send replayable after a same-key different-body conflict', async () => {
    const send = (body: string) => postReply(body, 'owner-double-click');

    const first = await send('Thanks for booking');
    expect(first.status).toBe(200);
    const conflict = await send('A different reply');
    expect(conflict.status).toBe(409);
    expect(conflict.body).toMatchObject({
      reason: 'idempotency_key_reused',
      code: 'IDEMPOTENCY_KEY_REUSED',
      final: true,
    });

    const replay = await send('Thanks for booking');
    expect(replay.status).toBe(200);
    expect(replay.body.message.id).toBe(first.body.message.id);
    expect(smsFake.current!.transport.send).toHaveBeenCalledTimes(1);
  });

  it('returns 500 without a final marker for a definite retryable Twilio failure', async () => {
    smsFake.current!.state.sendError = new TwilioApiError('Twilio API error: 503 Service Unavailable', 503, null);
    const res = await postReply('Thanks for booking', 'timeout-retry');

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Failed to send message: Twilio API error: 503 Service Unavailable' });
    expect(res.body.final).toBeUndefined();
    expect(smsFake.current!.transport.send).toHaveBeenCalledTimes(1);
    expect(logActivityMock).not.toHaveBeenCalled();
  });
});

describe('ambiguous inbox reply replay', () => {
  it('warns with the original messageId on a timeout retry and never sends a second SMS', async () => {
    smsFake.current!.state.sendError = new TwilioSendOutcomeUnknownError(new Error('timeout'));
    const post = () => postReply('Thanks for booking', 'timeout');
    expect((await post()).status).toBe(500);
    smsFake.current!.state.sendError = null;
    const replay = await post();
    expect(replay.status).toBe(409);
    expect(replay.body).toEqual({
      error: 'This message may already have been sent. Check the thread before sending again.',
      code: 'SEND_OUTCOME_UNKNOWN', reason: 'send_outcome_unknown', messageId: 'sms-1',
    });
    expect(smsFake.current!.transport.send).toHaveBeenCalledTimes(1);
    expect(smsFake.current!.rows.size).toBe(1);
    expect(logActivityMock).not.toHaveBeenCalled();
    expect((await post()).body).toEqual(replay.body);
    const deliberate = await postReply('Thanks for booking', 'deliberate-resend');
    expect(deliberate.status).toBe(200);
    expect(smsFake.current!.transport.send).toHaveBeenCalledTimes(2);
  });
});

function aSendKey(): string | undefined {
  const rows = [...smsFake.current!.rows.values()];
  const key = rows[0]?.metadata.idempotencyKey;
  return typeof key === 'string' ? key : undefined;
}

// Use the real store + conversation service SQL. Like the other SMS Postgres
// suites, only connect to a configured local DB and use a disposable schema.
// pg-mem keeps the sequential regressions runnable without a local Postgres;
// it cannot prove locking or rollback, so those tests require Postgres.
const DB_URL = process.env.DATABASE_URL ?? '';
async function localPostgresAvailable(): Promise<boolean> {
  if (!/127\.0\.0\.1|localhost/.test(DB_URL)) return false;
  const client = new Client({ connectionString: DB_URL, connectionTimeoutMillis: 2_000 });
  try {
    await client.connect();
    await client.query('SELECT 1');
    return true;
  } catch {
    return false;
  } finally {
    await client.end().catch(() => {});
  }
}
const dbUp = await localPostgresAvailable();

describe(`scheduled inbox replies (${dbUp ? 'local Postgres' : 'pg-mem'})`, () => {
  const schema = `sms_schedule_test_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  const scheduledAt = '2026-11-20T18:00:00.000Z';

  beforeAll(async () => {
    if (dbUp) {
      scheduledDb.pool = new Pool({ connectionString: DB_URL, max: 12 });
      scheduledDb.pool.on('connect', (client) => {
        void client.query(`SET search_path TO ${schema}`);
      });
      await scheduledDb.pool.query(`CREATE SCHEMA ${schema}`);
    } else {
      const db = newDb();
      db.public.registerFunction({
        name: 'set_config', args: [DataType.text, DataType.text, DataType.bool], returns: DataType.text,
        implementation: (_name: string, value: string) => value,
      });
      // pg-mem incorrectly RETURNINGs the existing row for a targeted DO
      // NOTHING. The untargeted form has Postgres semantics and is equivalent
      // here: this table's only unique constraint is its primary key.
      db.public.interceptQueries((sql) => {
        const target = 'ON CONFLICT (tenant_id, action, key) DO NOTHING';
        return sql.includes(target) ? db.public.many(sql.replace(target, 'ON CONFLICT DO NOTHING')) : null;
      });
      scheduledDb.pool = new (db.adapters.createPg().Pool)() as Pool;
    }
    await scheduledDb.pool.query(`CREATE TABLE phone_numbers (
      id VARCHAR PRIMARY KEY, tenant_id VARCHAR NOT NULL, phone_number VARCHAR NOT NULL)`);
    await scheduledDb.pool.query(`CREATE TABLE sms_conversations (
      id VARCHAR PRIMARY KEY, tenant_id VARCHAR NOT NULL, phone_number_id VARCHAR NOT NULL,
      remote_number VARCHAR NOT NULL, status VARCHAR DEFAULT 'open', unread_count INTEGER DEFAULT 0,
      last_message_at TIMESTAMP, last_message_preview TEXT, updated_at TIMESTAMP DEFAULT NOW(),
      created_at TIMESTAMP DEFAULT NOW())`);
    await scheduledDb.pool.query(`CREATE TABLE sms_messages (
      id VARCHAR PRIMARY KEY, tenant_id VARCHAR NOT NULL, conversation_id VARCHAR NOT NULL,
      direction VARCHAR NOT NULL, from_number VARCHAR NOT NULL, to_number VARCHAR NOT NULL,
      body TEXT NOT NULL, status VARCHAR NOT NULL, twilio_sid VARCHAR, scheduled_at TIMESTAMP,
      sent_at TIMESTAMP, delivered_at TIMESTAMP, error_message TEXT, metadata JSONB DEFAULT '{}',
      created_at TIMESTAMP DEFAULT NOW())`);
    await scheduledDb.pool.query(`CREATE TABLE sms_conversation_activity_log (
      id VARCHAR PRIMARY KEY, tenant_id VARCHAR NOT NULL, conversation_id VARCHAR NOT NULL,
      action VARCHAR NOT NULL, actor_user_id VARCHAR, actor_name VARCHAR, details JSONB)`);
    // Same key and status constraints as migration 121; no migrations run here.
    await scheduledDb.pool.query(`CREATE TABLE action_idempotency (
      tenant_id VARCHAR NOT NULL, action VARCHAR(128) NOT NULL, key VARCHAR(256) NOT NULL,
      request_hash CHAR(64) NOT NULL, status VARCHAR(20) NOT NULL CHECK (status IN ('in_progress', 'completed')),
      response JSONB, expires_at TIMESTAMPTZ NOT NULL, created_at TIMESTAMPTZ, updated_at TIMESTAMPTZ,
      PRIMARY KEY (tenant_id, action, key))`);
    await scheduledDb.pool.query(`INSERT INTO phone_numbers VALUES
      ('pn-1', 'tenant-1', '+15555550100'), ('pn-2', 'tenant-2', '+15555550101')`);
    await scheduledDb.pool.query(`INSERT INTO sms_conversations (id, tenant_id, phone_number_id, remote_number) VALUES
      ('conv-1', 'tenant-1', 'pn-1', '+15555550142'), ('conv-2', 'tenant-2', 'pn-2', '+15555550142')`);
  });

  afterAll(async () => {
    scheduledDb.active = false;
    if (dbUp) await scheduledDb.pool?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await scheduledDb.pool?.end();
    scheduledDb.pool = null;
  });

  beforeEach(async () => {
    scheduledDb.active = true;
    for (const table of ['sms_messages', 'sms_conversation_activity_log', 'action_idempotency']) {
      await scheduledDb.pool!.query(`DELETE FROM ${table}`);
    }
    await scheduledDb.pool!.query('UPDATE sms_conversations SET last_message_preview = NULL');
  });

  type Reply = {
    message?: { id: string; tenantId: string; body: string; status: string };
    error?: string; code?: string; reason?: string; final?: boolean;
  };

  // Invoke the registered handler directly so these DB tests need no listener.
  async function postScheduled({ key = 'scheduled-retry', body = 'Thanks for booking', at = scheduledAt,
    tenantId = 'tenant-1', threadId = 'conv-1' }: {
    key?: string | null; body?: string; at?: string; tenantId?: string; threadId?: string;
  } = {}) {
    const route = smsInboxRouter.stack.find((layer) =>
      layer.route?.path === '/sms-inbox/threads/:id/messages' && layer.route.stack.some((entry) => entry.method === 'post'),
    )!.route!;
    const res = {
      statusCode: 200, body: {} as Reply,
      status(code: number) { this.statusCode = code; return this; },
      json(value: Reply) { this.body = value; return this; },
    };
    await route.stack.at(-1)!.handle({
      params: { id: threadId }, body: { body, scheduledAt: at },
      headers: key === null ? {} : { 'idempotency-key': key },
      user: { tenantId, userId: 'user-1', email: 'op@example.com', role: 'tenant_owner' },
    } as unknown as Request, res as unknown as Response, vi.fn());
    return res;
  }

  async function rows(table: 'sms_messages' | 'sms_conversation_activity_log' | 'action_idempotency') {
    return (await scheduledDb.pool!.query(`SELECT * FROM ${table}`)).rows;
  }

  it('stores one scheduled row and one activity when the same key is replayed', async () => {
    const first = await postScheduled();
    const replay = await postScheduled();
    expect(first.statusCode).toBe(200);
    expect(replay.statusCode).toBe(200);
    expect(replay.body).toEqual(first.body);
    expect(first.body.message!.status).toBe('scheduled');
    expect(await rows('sms_messages')).toHaveLength(1);
    expect(await rows('sms_conversation_activity_log')).toEqual([
      expect.objectContaining({ action: 'message_scheduled', details: { messageId: first.body.message!.id, scheduledAt } }),
    ]);
    expect(await rows('action_idempotency')).toEqual([
      expect.objectContaining({ action: 'sms.inbox.schedule', status: 'completed',
        key: smsInboxReplyIdempotencyKey('tenant-1', 'conv-1', 'scheduled-retry') }),
    ]);
  });

  it.each([
    ['body', { body: 'A different reply' }],
    ['time', { at: '2026-11-20T19:00:00.000Z' }],
  ])('rejects a scheduled key reused with a different %s', async (_field, changes) => {
    const first = await postScheduled();
    const conflict = await postScheduled(changes);
    expect(first.statusCode).toBe(200);
    expect(conflict.statusCode).toBe(409);
    expect(conflict.body).toMatchObject({
      error: expect.stringContaining('different payload'), code: 'IDEMPOTENCY_KEY_REUSED',
      reason: 'idempotency_key_reused', final: true,
    });
    const replay = await postScheduled();
    expect(replay.body.message!.id).toBe(first.body.message!.id);
    expect(await rows('sms_messages')).toHaveLength(1);
    expect(await rows('sms_conversation_activity_log')).toHaveLength(1);
  });

  it('normalizes scheduled timestamps before comparing a replay', async () => {
    const first = await postScheduled();
    const replay = await postScheduled({ at: '2026-11-20T13:00:00-05:00' });
    expect(first.statusCode).toBe(200);
    expect(replay.statusCode).toBe(200);
    expect(replay.body.message!.id).toBe(first.body.message!.id);
    expect(await rows('sms_messages')).toHaveLength(1);
  });

  it('stores two scheduled rows without an Idempotency-Key', async () => {
    const first = await postScheduled({ key: null });
    const second = await postScheduled({ key: null });
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(second.body.message!.id).not.toBe(first.body.message!.id);
    expect(await rows('sms_messages')).toHaveLength(2);
    expect(await rows('sms_conversation_activity_log')).toHaveLength(2);
    expect(await rows('action_idempotency')).toHaveLength(0);
  });

  it('schedules an independent row for tenant B with the same raw key', async () => {
    const first = await postScheduled();
    const second = await postScheduled({ tenantId: 'tenant-2', threadId: 'conv-2' });
    const replay = await postScheduled({ tenantId: 'tenant-2', threadId: 'conv-2' });
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(replay.statusCode).toBe(200);
    expect(second.body.message!.tenantId).toBe('tenant-2');
    expect(second.body.message!.id).not.toBe(first.body.message!.id);
    expect(replay.body.message!.id).toBe(second.body.message!.id);
    expect(await rows('sms_messages')).toHaveLength(2);
    expect(await rows('action_idempotency')).toEqual(expect.arrayContaining([
      expect.objectContaining({ tenant_id: 'tenant-1', key: smsInboxReplyIdempotencyKey('tenant-1', 'conv-1', 'scheduled-retry') }),
      expect.objectContaining({ tenant_id: 'tenant-2', key: smsInboxReplyIdempotencyKey('tenant-2', 'conv-2', 'scheduled-retry') }),
    ]));
  });

  it.skipIf(!dbUp)('stores one scheduled row for concurrent requests with the same key', async () => {
    let begun = 0;
    let allBegun!: () => void;
    const contenders = new Promise<void>((resolve) => { allBegun = resolve; });
    const originalBegin = postgresActionStore.beginIdempotency;
    const originalComplete = postgresActionStore.completeIdempotency;
    const begin = vi.spyOn(postgresActionStore, 'beginIdempotency').mockImplementation((tx, input) => {
      const result = originalBegin(tx, input);
      if (++begun === 8) allBegun();
      return result;
    });
    const complete = vi.spyOn(postgresActionStore, 'completeIdempotency').mockImplementation(async (tx, input) => {
      // Keep the first claim uncommitted until all contenders start their
      // INSERT, proving they encounter an in-progress transaction.
      await contenders;
      await originalComplete(tx, input);
    });
    try {
      const replies = await Promise.all(Array.from({ length: 8 }, () => postScheduled()));
      expect(replies.map((reply) => reply.statusCode)).toEqual(Array(8).fill(200));
      expect(new Set(replies.map((reply) => reply.body.message!.id)).size).toBe(1);
      expect(await rows('sms_messages')).toHaveLength(1);
      expect(await rows('sms_conversation_activity_log')).toHaveLength(1);
    } finally {
      begin.mockRestore();
      complete.mockRestore();
    }
  });

  it.skipIf(!dbUp)('rolls back the scheduled row and key when idempotency completion fails', async () => {
    const completion = vi.spyOn(postgresActionStore, 'completeIdempotency')
      .mockRejectedValueOnce(new Error('Completion failed'));
    try {
      const failure = await postScheduled();
      expect(failure.statusCode).toBe(500);
      expect(await rows('sms_messages')).toHaveLength(0);
      expect(await rows('action_idempotency')).toHaveLength(0);
      expect(await rows('sms_conversation_activity_log')).toHaveLength(0);
      const { rows: conversations } = await scheduledDb.pool!.query(
        "SELECT last_message_preview FROM sms_conversations WHERE id = 'conv-1'",
      );
      expect(conversations[0].last_message_preview).toBeNull();
      expect((await postScheduled()).statusCode).toBe(200);
      expect(await rows('sms_messages')).toHaveLength(1);
    } finally {
      completion.mockRestore();
    }
  });
});
