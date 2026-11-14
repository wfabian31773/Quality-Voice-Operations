// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Client, Pool } from 'pg';
import { isSmsOptOut } from '../../campaigns/DncService';
import { isLikelySmsOptOut, isSmsHelp, isSmsOptIn } from './consent';
import {
  handleInboundSms,
  postgresSmsInboundStore,
  type SmsInboundDeps,
} from './inbound';

const holder = vi.hoisted(() => ({ pool: null as null | import('pg').Pool }));

vi.mock('../../db', () => ({
  getPlatformPool: () => ({ query: async () => ({ rows: [] }) }),
  withTenantClient: async (_tenantId: string, fn: (c: unknown) => Promise<unknown>) => {
    const client = await holder.pool!.connect();
    try {
      await client.query('BEGIN');
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

const DB_URL = process.env.DATABASE_URL ?? '';
async function reachable(): Promise<boolean> {
  if (!/127\.0\.0\.1|localhost/.test(DB_URL)) return false;
  const c = new Client({ connectionString: DB_URL, connectionTimeoutMillis: 2_000 });
  try {
    await c.connect();
    await c.query('SELECT 1');
    return true;
  } catch {
    return false;
  } finally {
    await c.end().catch(() => {});
  }
}
const dbUp = await reachable();

const TENANT_A = 'tenant-a';
const TENANT_B = 'tenant-b';
const FROM = '+13125550142';
const TO_A = '+13125550100';
const TO_B = '+13125550101';
const PN_A = 'pn-a';
const PN_B = 'pn-b';
const CONCURRENT = 8;

function sid(tag: string): string {
  return `SM${tag.replace(/[^a-zA-Z0-9]/g, '0').padEnd(32, '0').slice(0, 32)}`;
}

describe.skipIf(!dbUp)('handleInboundSms (local Postgres)', () => {
  const schema = `sms_inb_test_${randomUUID().replace(/-/g, '').slice(0, 12)}`;

  beforeAll(async () => {
    const pool = new Pool({ connectionString: DB_URL, max: CONCURRENT + 4 });
    pool.on('connect', (c) => {
      void c.query(`SET search_path TO ${schema}`);
    });
    holder.pool = pool;
    const admin = await pool.connect();
    try {
      await admin.query(`CREATE SCHEMA ${schema}`);
      await admin.query(`SET search_path TO ${schema}`);
      await admin.query(`CREATE TABLE dnc_list (
        id VARCHAR PRIMARY KEY,
        tenant_id VARCHAR NOT NULL,
        phone_number VARCHAR(20) NOT NULL,
        reason TEXT,
        source VARCHAR(20) NOT NULL DEFAULT 'manual',
        created_at TIMESTAMP DEFAULT NOW(),
        UNIQUE (tenant_id, phone_number)
      )`);
      await admin.query(`CREATE TABLE sms_conversations (
        id VARCHAR PRIMARY KEY,
        tenant_id VARCHAR NOT NULL,
        phone_number_id VARCHAR NOT NULL,
        remote_number VARCHAR NOT NULL,
        status VARCHAR DEFAULT 'open',
        assignee_user_id VARCHAR,
        assignee_team VARCHAR,
        contact_location VARCHAR,
        last_message_at TIMESTAMP,
        last_message_preview TEXT,
        unread_count INTEGER NOT NULL DEFAULT 0,
        updated_at TIMESTAMP DEFAULT NOW(),
        UNIQUE (tenant_id, phone_number_id, remote_number)
      )`);
      await admin.query(`CREATE TABLE sms_messages (
        id VARCHAR PRIMARY KEY,
        tenant_id VARCHAR NOT NULL,
        conversation_id VARCHAR NOT NULL,
        direction VARCHAR(10) NOT NULL,
        from_number VARCHAR(20) NOT NULL,
        to_number VARCHAR(20) NOT NULL,
        body TEXT NOT NULL,
        status VARCHAR(20) NOT NULL,
        twilio_sid VARCHAR(50),
        metadata JSONB DEFAULT '{}',
        created_at TIMESTAMP NOT NULL DEFAULT NOW()
      )`);
      await admin.query(`CREATE INDEX ON sms_messages (twilio_sid)`);
      await admin.query(`CREATE TABLE sms_consent_log (
        id VARCHAR PRIMARY KEY,
        tenant_id VARCHAR NOT NULL,
        phone_number VARCHAR(20) NOT NULL,
        action VARCHAR(20) NOT NULL,
        keyword VARCHAR(50),
        source VARCHAR(30) NOT NULL,
        twilio_sid VARCHAR(50),
        created_at TIMESTAMP NOT NULL DEFAULT NOW()
      )`);
      await admin.query(`CREATE TABLE sms_conversation_activity_log (
        id VARCHAR PRIMARY KEY,
        tenant_id VARCHAR NOT NULL,
        conversation_id VARCHAR NOT NULL,
        action VARCHAR(50) NOT NULL,
        actor_user_id VARCHAR,
        actor_name VARCHAR,
        details JSONB DEFAULT '{}',
        created_at TIMESTAMP NOT NULL DEFAULT NOW()
      )`);
    } finally {
      admin.release();
    }
    const warm = await Promise.all(Array.from({ length: CONCURRENT }, () => pool.connect()));
    await Promise.all(warm.map((c) => c.query('SELECT 1')));
    for (const c of warm) c.release();
  });

  afterAll(async () => {
    if (!holder.pool) return;
    await holder.pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {});
    await holder.pool.end().catch(() => {});
  });

  beforeEach(async () => {
    await holder.pool!.query(`
      DELETE FROM sms_conversation_activity_log;
      DELETE FROM sms_messages;
      DELETE FROM sms_consent_log;
      DELETE FROM sms_conversations;
      DELETE FROM dnc_list;
    `);
  });

  function depsFor(tenantId: string, phoneNumberId: string, to: string): SmsInboundDeps {
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    return {
      lookupByTo: vi.fn(async (lookedUp) =>
        lookedUp === to ? { tenantId, phoneNumberId } : null,
      ),
      store: postgresSmsInboundStore,
      isOptOut: isSmsOptOut,
      isOptIn: isSmsOptIn,
      isHelp: isSmsHelp,
      isLikelyOptOut: isLikelySmsOptOut,
      tryRecordCsat: vi.fn(async () => ({ handled: false as const })),
      markCsatOptedOut: vi.fn(async () => 0),
      evaluateAutoReplies: vi.fn(async () => null),
      evaluateAssignmentRules: vi.fn(async () => null),
      updateConversation: vi.fn(async () => null),
      logActivity: vi.fn(async () => {}),
      saveAutoReply: vi.fn(async () => {}),
      logger: log,
    };
  }

  async function count(table: string, where: string, values: unknown[]): Promise<number> {
    const { rows } = await holder.pool!.query(
      `SELECT COUNT(*)::int AS n FROM ${table} WHERE ${where}`,
      values,
    );
    return Number(rows[0].n);
  }

  it('two parallel deliveries of the same STOP write exactly one message row and one consent row', async () => {
    const messageSid = sid('dupstop');
    const body = {
      From: FROM,
      To: TO_A,
      MessageSid: messageSid,
      Body: 'STOP',
    };
    const results = await Promise.all(
      Array.from({ length: CONCURRENT }, () => handleInboundSms(body, depsFor(TENANT_A, PN_A, TO_A))),
    );
    expect(results.filter((r) => r.duplicate).length).toBe(CONCURRENT - 1);
    expect(results.filter((r) => !r.duplicate && r.httpStatus === 200)).toHaveLength(1);
    expect(await count('sms_messages', 'tenant_id = $1 AND twilio_sid = $2', [TENANT_A, messageSid])).toBe(1);
    expect(await count('sms_consent_log', 'tenant_id = $1 AND twilio_sid = $2', [TENANT_A, messageSid])).toBe(1);
    expect(await count('dnc_list', 'tenant_id = $1 AND phone_number = $2', [TENANT_A, FROM])).toBe(1);
  });

  it('a message to tenant A never reads or writes tenant B; the same phone can be opted out at A and opted in at B', async () => {
    const sidA = sid('tenanta');
    const sidB = sid('tenantb');
    await handleInboundSms(
      { From: FROM, To: TO_A, MessageSid: sidA, Body: 'STOP' },
      depsFor(TENANT_A, PN_A, TO_A),
    );
    await handleInboundSms(
      { From: FROM, To: TO_B, MessageSid: sidB, Body: 'START' },
      depsFor(TENANT_B, PN_B, TO_B),
    );

    expect(await count('sms_messages', 'tenant_id = $1', [TENANT_A])).toBe(1);
    expect(await count('sms_messages', 'tenant_id = $1', [TENANT_B])).toBe(1);
    expect(await count('sms_consent_log', "tenant_id = $1 AND action = 'opt_out'", [TENANT_A])).toBe(1);
    expect(await count('sms_consent_log', "tenant_id = $1 AND action = 'opt_in'", [TENANT_B])).toBe(1);
    expect(await count('sms_consent_log', 'tenant_id = $1', [TENANT_B])).toBe(1);
    expect(await count('dnc_list', 'tenant_id = $1 AND phone_number = $2', [TENANT_A, FROM])).toBe(1);
    expect(await count('dnc_list', 'tenant_id = $1 AND phone_number = $2', [TENANT_B, FROM])).toBe(0);
    const { rows: aMsgs } = await holder.pool!.query(
      `SELECT to_number FROM sms_messages WHERE tenant_id = $1`,
      [TENANT_A],
    );
    expect(aMsgs[0].to_number).toBe(TO_A);
  });

  it('STOP then START: latest consent is opt_in and the SMS-sourced DNC row is lifted', async () => {
    await handleInboundSms(
      { From: FROM, To: TO_A, MessageSid: sid('stop1'), Body: 'STOP' },
      depsFor(TENANT_A, PN_A, TO_A),
    );
    await handleInboundSms(
      { From: FROM, To: TO_A, MessageSid: sid('start1'), Body: 'START' },
      depsFor(TENANT_A, PN_A, TO_A),
    );
    const { rows } = await holder.pool!.query(
      `SELECT action FROM sms_consent_log WHERE tenant_id = $1 AND phone_number = $2 ORDER BY created_at`,
      [TENANT_A, FROM],
    );
    expect(rows.map((r) => r.action)).toEqual(['opt_out', 'opt_in']);
    expect(await count('dnc_list', 'tenant_id = $1 AND phone_number = $2', [TENANT_A, FROM])).toBe(0);
  });

  it('stores MMS NumMedia and media metadata on the inbound row without fetching', async () => {
    const messageSid = sid('mms1');
    await handleInboundSms(
      {
        From: FROM,
        To: TO_A,
        MessageSid: messageSid,
        Body: '',
        NumMedia: '1',
        MediaUrl0: 'https://api.twilio.test/media/photo.jpg',
        MediaContentType0: 'image/jpeg',
      },
      depsFor(TENANT_A, PN_A, TO_A),
    );
    const { rows } = await holder.pool!.query(
      `SELECT metadata FROM sms_messages WHERE tenant_id = $1 AND twilio_sid = $2`,
      [TENANT_A, messageSid],
    );
    expect(rows[0].metadata).toEqual({
      numMedia: 1,
      media: [{ url: 'https://api.twilio.test/media/photo.jpg', contentType: 'image/jpeg' }],
    });
  });

  it('records likely_opt_out on the conversation activity log for a non-exact phrase', async () => {
    await handleInboundSms(
      { From: FROM, To: TO_A, MessageSid: sid('likely'), Body: 'please stop' },
      depsFor(TENANT_A, PN_A, TO_A),
    );
    expect(await count('dnc_list', 'tenant_id = $1', [TENANT_A])).toBe(0);
    expect(
      await count('sms_conversation_activity_log', "tenant_id = $1 AND action = 'likely_opt_out'", [TENANT_A]),
    ).toBe(1);
  });
});
