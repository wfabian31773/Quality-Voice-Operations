// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Client, Pool } from 'pg';

// Concurrent check-and-reserve against a real local Postgres. TEMP tables are
// per-connection, so this uses a throwaway schema (dropped in afterAll) and a
// pool whose every transaction is a real BEGIN/COMMIT on its own connection,
// like platform/db withTenantClient. No migrations are applied.
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

import { postgresSmsSendStore as store } from './deps';

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

describe.skipIf(!dbUp)('sms rate limit check-and-reserve under concurrency (local Postgres)', () => {
  const schema = `sms_rate_test_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  const T = 't1';
  const TO = '+13125550142';
  const FROM = '+13125550100';
  const MAX = 3;
  const CONCURRENT = 8;

  beforeAll(async () => {
    const pool = new Pool({ connectionString: DB_URL, max: CONCURRENT + 2 });
    pool.on('connect', (c) => {
      void c.query(`SET search_path TO ${schema}`);
    });
    holder.pool = pool;
    const admin = await pool.connect();
    try {
      await admin.query(`CREATE SCHEMA ${schema}`);
      await admin.query(`SET search_path TO ${schema}`);
      await admin.query(`CREATE TABLE phone_numbers (id VARCHAR PRIMARY KEY, tenant_id VARCHAR, phone_number VARCHAR)`);
      await admin.query(`CREATE TABLE sms_conversations (
        id VARCHAR PRIMARY KEY, tenant_id VARCHAR NOT NULL, phone_number_id VARCHAR NOT NULL, remote_number VARCHAR NOT NULL,
        status VARCHAR DEFAULT 'open', last_message_at TIMESTAMP, last_message_preview TEXT,
        updated_at TIMESTAMP DEFAULT NOW(), UNIQUE (tenant_id, phone_number_id, remote_number))`);
      await admin.query(`CREATE TABLE sms_messages (
        id VARCHAR PRIMARY KEY, tenant_id VARCHAR NOT NULL, conversation_id VARCHAR NOT NULL, direction VARCHAR(10) NOT NULL,
        from_number VARCHAR(20) NOT NULL, to_number VARCHAR(20) NOT NULL, body TEXT NOT NULL, status VARCHAR(20) NOT NULL,
        twilio_sid VARCHAR(50), scheduled_at TIMESTAMP, sent_at TIMESTAMP, error_message TEXT, metadata JSONB DEFAULT '{}',
        created_at TIMESTAMP NOT NULL DEFAULT NOW())`);
      await admin.query(`INSERT INTO phone_numbers VALUES ('pn1', 't1', $1)`, [FROM]);
    } finally {
      admin.release();
    }
    // Open every connection up front so the concurrent sends really overlap.
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
    await holder.pool!.query(`DELETE FROM ${schema}.sms_messages`);
  });

  const record = (id: string, status: 'sending' | 'queued' | 'deferred_quiet_hours') => ({
    id,
    tenantId: T,
    from: FROM,
    to: TO,
    body: 'hi',
    status,
    scheduledAt: null,
    metadata: {},
  });
  const window = () => ({ max: MAX, since: new Date(Date.now() - 3_600_000) });

  async function seedSent(n: number): Promise<void> {
    for (let i = 0; i < n; i++) {
      expect(await store.reserveOutbound(record(`sent-${i}`, 'queued'), null)).toEqual({ reserved: true });
    }
  }

  it(`lets exactly one of ${CONCURRENT} concurrent live sends through one below the limit`, async () => {
    await seedSent(MAX - 1);
    const results = await Promise.all(
      Array.from({ length: CONCURRENT }, (_, i) => store.reserveOutbound(record(`live-${i}`, 'sending'), window())),
    );
    expect(results.filter((r) => r.reserved)).toHaveLength(1);
    expect(results.filter((r) => !r.reserved)).toEqual(
      Array.from({ length: CONCURRENT - 1 }, () => ({ reserved: false, recent: MAX })),
    );
    const { rows } = await holder.pool!.query(
      `SELECT COUNT(*)::int AS n FROM ${schema}.sms_messages WHERE to_number = $1`,
      [TO],
    );
    expect(rows[0].n).toBe(MAX);
  });

  it(`lets exactly one of ${CONCURRENT} concurrent deferred releases through one below the limit`, async () => {
    await seedSent(MAX - 1);
    for (let i = 0; i < CONCURRENT; i++) {
      await store.insertOutbound(record(`held-${i}`, 'deferred_quiet_hours'));
    }
    // As claimDueDeferred leaves them: `sending`, created hours ago, not yet sent.
    await holder.pool!.query(
      `UPDATE ${schema}.sms_messages SET status = 'sending', created_at = NOW() - INTERVAL '10 hours' WHERE id LIKE 'held-%'`,
    );
    const now = new Date();
    const results = await Promise.all(
      Array.from({ length: CONCURRENT }, (_, i) =>
        store.reserveDeferredSend({ id: `held-${i}`, tenantId: T, to: TO }, window(), now),
      ),
    );
    expect(results.filter((r) => r.reserved)).toHaveLength(1);
    const { rows } = await holder.pool!.query(
      `SELECT COUNT(*)::int AS n FROM ${schema}.sms_messages WHERE id LIKE 'held-%' AND sent_at IS NOT NULL`,
    );
    expect(rows[0].n).toBe(1);
  });
});
