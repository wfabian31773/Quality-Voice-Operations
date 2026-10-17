// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Client } from 'pg';

const holder = vi.hoisted(() => ({ client: null as null | { query: (sql: string, values?: unknown[]) => Promise<unknown> } }));

vi.mock('../../db', () => ({
  getPlatformPool: () => ({ query: async () => ({ rows: [] }) }),
  withTenantClient: async (_tenantId: string, fn: (c: unknown) => Promise<unknown>) => fn(holder.client),
  withPrivilegedClient: async (fn: (c: unknown) => Promise<unknown>) => fn(holder.client),
}));

import { liftSmsOptOutDnc } from './consent';
import { postgresSmsSendStore as store, smsStatusCallbackUrl } from './deps';
import type { TenantTx } from '../core';

describe('smsStatusCallbackUrl', () => {
  it('prefers VOICE_PUBLIC_BASE_URL and falls back to the gateway/Replit hosts', () => {
    expect(smsStatusCallbackUrl({ VOICE_PUBLIC_BASE_URL: 'https://voice.example.com/' })).toBe(
      'https://voice.example.com/twilio/sms-status',
    );
    expect(smsStatusCallbackUrl({ VOICE_GATEWAY_BASE_URL: 'https://gw.example.com' })).toBe(
      'https://gw.example.com/twilio/sms-status',
    );
    expect(smsStatusCallbackUrl({ REPLIT_DEV_DOMAIN: 'x.repl.co' })).toBe('https://x.repl.co/twilio/sms-status');
    expect(smsStatusCallbackUrl({})).toBeNull();
  });
});

// Real Postgres check of the store SQL (TEMP tables only; no migrations applied).
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

describe.skipIf(!dbUp)('postgresSmsSendStore (local Postgres)', () => {
  const client = new Client({ connectionString: DB_URL });
  const tx = { query: (sql: string, values?: unknown[]) => client.query(sql, values) } as unknown as TenantTx;
  const T = 't1';

  beforeAll(async () => {
    await client.connect();
    holder.client = { query: (sql, values) => client.query(sql, values as unknown[]) };
    await client.query(`CREATE TEMP TABLE tenants (id VARCHAR PRIMARY KEY, feature_flags JSONB DEFAULT '{}')`);
    await client.query(`CREATE TEMP TABLE phone_numbers (id VARCHAR PRIMARY KEY, tenant_id VARCHAR, phone_number VARCHAR)`);
    await client.query(`CREATE TEMP TABLE sms_consent_log (
      id VARCHAR PRIMARY KEY, tenant_id VARCHAR, phone_number VARCHAR, action VARCHAR, created_at TIMESTAMP DEFAULT NOW())`);
    await client.query(`CREATE TEMP TABLE sms_conversations (
      id VARCHAR PRIMARY KEY, tenant_id VARCHAR NOT NULL, phone_number_id VARCHAR NOT NULL, remote_number VARCHAR NOT NULL,
      status VARCHAR DEFAULT 'open', last_message_at TIMESTAMP, last_message_preview TEXT,
      updated_at TIMESTAMP DEFAULT NOW(), UNIQUE (tenant_id, phone_number_id, remote_number))`);
    await client.query(`CREATE TEMP TABLE sms_messages (
      id VARCHAR PRIMARY KEY, tenant_id VARCHAR NOT NULL, conversation_id VARCHAR NOT NULL, direction VARCHAR(10) NOT NULL,
      from_number VARCHAR(20) NOT NULL, to_number VARCHAR(20) NOT NULL, body TEXT NOT NULL, status VARCHAR(20) NOT NULL,
      twilio_sid VARCHAR(50), scheduled_at TIMESTAMP, sent_at TIMESTAMP, error_message TEXT, metadata JSONB DEFAULT '{}',
      created_at TIMESTAMP NOT NULL DEFAULT NOW())`);
    await client.query(`INSERT INTO tenants VALUES ('t1', '{"sms_messaging_enabled": true}'), ('t2', '{}'), ('t3', '{"sms_messaging_enabled": "yes"}')`);
    await client.query(`INSERT INTO phone_numbers VALUES ('pn1', 't1', '+13125550100')`);
    await client.query(`INSERT INTO sms_consent_log (id, tenant_id, phone_number, action, created_at) VALUES
      ('c1', 't1', '+13125550142', 'opt_out', NOW() - INTERVAL '2 days'),
      ('c2', 't1', '+13125550142', 'opt_in', NOW() - INTERVAL '1 day'),
      ('c3', 't1', '+13125550142', 'help_request', NOW()),
      ('c4', 't1', '+13125550199', 'opt_out', NOW())`);
  });
  afterAll(async () => {
    await client.end().catch(() => {});
  });

  it('reads the per-tenant flag (default off)', async () => {
    expect(await store.isTenantMessagingEnabled(tx, 't1')).toBe(true);
    expect(await store.isTenantMessagingEnabled(tx, 't2')).toBe(false);
    expect(await store.isTenantMessagingEnabled(tx, 't3')).toBe(false);
    expect(await store.isTenantMessagingEnabled(tx, 'missing')).toBe(false);
  });

  it('uses the latest opt_in/opt_out event and ignores HELP', async () => {
    expect(await store.latestConsentAction(tx, T, '+13125550142')).toBe('opt_in');
    expect(await store.latestConsentAction(tx, T, '+13125550199')).toBe('opt_out');
    expect(await store.latestConsentAction(tx, T, '+13125550000')).toBeNull();
  });

  it('checks tenant sender numbers', async () => {
    expect(await store.isTenantSender(tx, T, '+13125550100')).toBe(true);
    expect(await store.isTenantSender(tx, 't2', '+13125550100')).toBe(false);
  });

  it('reserves, updates and claims outbound messages', async () => {
    const TO = '+13125550142';
    const base = { tenantId: T, from: '+13125550100', to: TO, body: 'hi', metadata: { source: 'sms.send' } };
    const limit = (max: number) => ({ max, since: new Date(Date.now() - 3_600_000) });
    expect(await store.reserveOutbound({ ...base, id: 'm1', status: 'sending', scheduledAt: null }, limit(5))).toEqual({
      reserved: true,
    });
    await store.updateOutbound(T, 'm1', { status: 'queued', twilioSid: 'SM1', sentAt: new Date() });
    await store.reserveOutbound({ ...base, id: 'm2', status: 'sending', scheduledAt: null }, null);
    await store.updateOutbound(T, 'm2', {
      status: 'failed',
      errorMessage: 'UPSTREAM_UNAVAILABLE: 503',
      metadata: { releaseAttempts: 2 },
    });
    const due = new Date(Date.now() - 60_000);
    await store.insertOutbound({ ...base, id: 'm3', status: 'deferred_quiet_hours', scheduledAt: due });

    const { rows } = await client.query(
      `SELECT m.id, m.status, m.twilio_sid, m.error_message, m.metadata, c.phone_number_id
         FROM sms_messages m JOIN sms_conversations c ON c.id = m.conversation_id ORDER BY m.id`,
    );
    expect(rows).toEqual([
      { id: 'm1', status: 'queued', twilio_sid: 'SM1', error_message: null, metadata: { source: 'sms.send' }, phone_number_id: 'pn1' },
      {
        id: 'm2',
        status: 'failed',
        twilio_sid: null,
        error_message: 'UPSTREAM_UNAVAILABLE: 503',
        metadata: { source: 'sms.send', releaseAttempts: 2 },
        phone_number_id: 'pn1',
      },
      { id: 'm3', status: 'deferred_quiet_hours', twilio_sid: null, error_message: null, metadata: { source: 'sms.send' }, phone_number_id: 'pn1' },
    ]);
    const { rows: convs } = await client.query('SELECT COUNT(*)::int AS n FROM sms_conversations');
    expect(convs[0].n).toBe(1);

    // Only m1 was sent: failed and deferred rows don't count toward the limit,
    // and a refused reservation inserts nothing.
    expect(await store.reserveOutbound({ ...base, id: 'm4', status: 'sending', scheduledAt: null }, limit(1))).toEqual({
      reserved: false,
      recent: 1,
    });
    const { rows: m4 } = await client.query(`SELECT 1 FROM sms_messages WHERE id = 'm4'`);
    expect(m4).toEqual([]);

    const stuckBefore = () => new Date(Date.now() - 10 * 60_000);
    const claimed = await store.claimDueDeferred(new Date(), 10, stuckBefore());
    expect(claimed.map((r) => [r.id, r.status, r.to, r.reclaimed])).toEqual([['m3', 'sending', TO, false]]);
    expect(claimed[0].metadata).toMatchObject({ source: 'sms.send', releaseClaimedAt: expect.any(String) });
    // Just claimed: not stuck yet.
    expect(await store.claimDueDeferred(new Date(), 10, stuckBefore())).toEqual([]);

    // Release reservation: m1 counts, m3 itself doesn't; reserving stamps sent_at.
    const now = new Date();
    expect(await store.reserveDeferredSend({ id: 'm3', tenantId: T, to: TO }, limit(1), now)).toEqual({
      reserved: false,
      recent: 1,
    });
    expect(await store.reserveDeferredSend({ id: 'm3', tenantId: T, to: TO }, limit(2), now)).toEqual({ reserved: true });
    const { rows: m3 } = await client.query(`SELECT sent_at FROM sms_messages WHERE id = 'm3'`);
    expect(m3[0].sent_at).not.toBeNull();

    // Past the timeout a `sending` row with no SID is reclaimed; with a SID it never is.
    const later = new Date(Date.now() + 60_000);
    expect((await store.claimDueDeferred(later, 10, later)).map((r) => [r.id, r.reclaimed])).toEqual([['m3', true]]);
    await client.query(`UPDATE sms_messages SET twilio_sid = 'SM3' WHERE id = 'm3'`);
    const muchLater = new Date(Date.now() + 3_600_000);
    expect(await store.claimDueDeferred(muchLater, 10, muchLater)).toEqual([]);
  });

  it('START lifts only the SMS-sourced DNC entry', async () => {
    await client.query(`CREATE TEMP TABLE dnc_list (id VARCHAR PRIMARY KEY, tenant_id VARCHAR, phone_number VARCHAR, source VARCHAR)`);
    await client.query(`INSERT INTO dnc_list VALUES ('d1', 't1', '+13125550142', 'sms'), ('d2', 't1', '+13125550177', 'manual')`);
    expect(await liftSmsOptOutDnc(T, '+13125550142')).toBe(true);
    expect(await liftSmsOptOutDnc(T, '+13125550177')).toBe(false);
    const { rows } = await client.query(`SELECT id FROM dnc_list ORDER BY id`);
    expect(rows).toEqual([{ id: 'd2' }]);
  });
});
