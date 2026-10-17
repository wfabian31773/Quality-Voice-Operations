// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Client } from 'pg';

vi.mock('../../db', () => ({ withPrivilegedClient: vi.fn() }));

import { applySmsStatusCallback, type PrivilegedRunner } from './statusCallback';

function fakeRunner(rowCount = 1) {
  const query = vi.fn(async () => ({ rows: [], rowCount }));
  const run: PrivilegedRunner = (fn) => fn({ query });
  return { run, query };
}

describe('applySmsStatusCallback (SQL shape)', () => {
  it('updates sms_messages by twilio_sid with the new status', async () => {
    const { run, query } = fakeRunner();
    const updated = await applySmsStatusCallback({ messageSid: 'SM1', messageStatus: 'delivered' }, run);
    expect(updated).toBe(1);
    const [sql, params] = query.mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).toContain('UPDATE sms_messages');
    expect(sql).toContain('WHERE twilio_sid = $1');
    expect(params.slice(0, 2)).toEqual(['SM1', 'delivered']);
  });

  it('ignores unknown statuses without touching the database', async () => {
    const { run, query } = fakeRunner();
    expect(await applySmsStatusCallback({ messageSid: 'SM1', messageStatus: 'exploded' }, run)).toBe(0);
    expect(query).not.toHaveBeenCalled();
  });
});

// Real Postgres check of the UPDATE (TEMP table only; no migrations applied).
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

describe.skipIf(!dbUp)('applySmsStatusCallback (local Postgres)', () => {
  const client = new Client({ connectionString: DB_URL });
  const run: PrivilegedRunner = (fn) => fn({ query: (sql, values) => client.query(sql, values) });

  beforeAll(async () => {
    await client.connect();
    await client.query(`CREATE TEMP TABLE sms_messages (
      id VARCHAR PRIMARY KEY,
      tenant_id VARCHAR,
      to_number VARCHAR,
      from_number VARCHAR,
      direction VARCHAR(10) NOT NULL,
      status VARCHAR(20) NOT NULL,
      twilio_sid VARCHAR(50),
      sent_at TIMESTAMP,
      delivered_at TIMESTAMP,
      error_message TEXT,
      metadata JSONB DEFAULT '{}'
    )`);
    await client.query(
      `INSERT INTO sms_messages (id, direction, status, twilio_sid) VALUES
         ('m1', 'outbound', 'queued', 'SM_A'),
         ('m2', 'outbound', 'queued', 'SM_B'),
         ('m3', 'inbound', 'received', 'SM_C')`,
    );
  });
  afterAll(async () => {
    await client.end().catch(() => {});
  });

  async function row(id: string) {
    const { rows } = await client.query('SELECT * FROM sms_messages WHERE id = $1', [id]);
    return rows[0];
  }

  it('moves a message forward to delivered and stamps delivered_at', async () => {
    expect(await applySmsStatusCallback({ messageSid: 'SM_A', messageStatus: 'sent' }, run)).toBe(1);
    expect((await row('m1')).status).toBe('sent');
    expect(await applySmsStatusCallback({ messageSid: 'SM_A', messageStatus: 'delivered' }, run)).toBe(1);
    const delivered = await row('m1');
    expect(delivered.status).toBe('delivered');
    expect(delivered.sent_at).not.toBeNull();
    expect(delivered.delivered_at).not.toBeNull();
  });

  it('never moves a delivered message backwards', async () => {
    expect(await applySmsStatusCallback({ messageSid: 'SM_A', messageStatus: 'sent' }, run)).toBe(0);
    expect((await row('m1')).status).toBe('delivered');
  });

  it('records the carrier error on undelivered', async () => {
    const updated = await applySmsStatusCallback(
      { messageSid: 'SM_B', messageStatus: 'undelivered', errorCode: 30003, errorMessage: 'Unreachable handset' },
      run,
    );
    expect(updated).toBe(1);
    const r = await row('m2');
    expect(r.status).toBe('undelivered');
    expect(r.error_message).toBe('Unreachable handset');
    expect(r.metadata).toMatchObject({ twilioErrorCode: 30003 });
  });

  it('ignores inbound rows and unknown SIDs', async () => {
    expect(await applySmsStatusCallback({ messageSid: 'SM_C', messageStatus: 'delivered' }, run)).toBe(0);
    expect(await applySmsStatusCallback({ messageSid: 'SM_nope', messageStatus: 'delivered' }, run)).toBe(0);
  });

  describe('rows whose SID was never saved (?mid=)', () => {
    const TO = '+13125550142';
    const FROM = '+13125550100';
    const accounts: Record<string, string> = { tA: 'AC_A', tB: 'AC_B' };
    const accountSidFor = async (tenantId: string) => accounts[tenantId] ?? null;
    const cb = (over: Record<string, unknown> = {}) => ({
      messageSid: 'SM_X',
      messageStatus: 'delivered',
      mid: 'm10',
      to: TO,
      from: FROM,
      accountSid: 'AC_A',
      ...over,
    });

    beforeAll(async () => {
      await client.query(
        `INSERT INTO sms_messages (id, tenant_id, to_number, from_number, direction, status, twilio_sid, error_message) VALUES
           ('m10', 'tA', $1, $2, 'outbound', 'sending', NULL, NULL),
           ('m11', 'tA', $1, $2, 'outbound', 'failed', NULL, 'SEND_OUTCOME_UNKNOWN'),
           ('m12', 'tB', $1, $2, 'outbound', 'sending', NULL, NULL)`,
        [TO, FROM],
      );
    });

    it('refuses a callback whose To/From or account does not match the row', async () => {
      expect(await applySmsStatusCallback(cb({ to: '+13125550199' }), run, accountSidFor)).toBe(0);
      expect(await applySmsStatusCallback(cb({ from: '+13125550111' }), run, accountSidFor)).toBe(0);
      // Tenant B's row, but the callback came from tenant A's Twilio account.
      expect(await applySmsStatusCallback(cb({ mid: 'm12', messageSid: 'SM_Y' }), run, accountSidFor)).toBe(0);
      expect(await applySmsStatusCallback(cb({ accountSid: undefined }), run, accountSidFor)).toBe(0);
      for (const id of ['m10', 'm12']) {
        expect(await row(id)).toMatchObject({ twilio_sid: null, status: 'sending' });
      }
    });

    it('attaches the SID to a SID-less row of the same tenant and applies the status', async () => {
      expect(await applySmsStatusCallback(cb(), run, accountSidFor)).toBe(1);
      expect(await row('m10')).toMatchObject({ twilio_sid: 'SM_X', status: 'delivered' });
    });

    it('never attaches a SID that is already on another row', async () => {
      expect(await applySmsStatusCallback(cb({ mid: 'm11' }), run, accountSidFor)).toBe(0);
      expect(await row('m11')).toMatchObject({ twilio_sid: null, status: 'failed' });
    });

    it('recovers a row marked SEND_OUTCOME_UNKNOWN when Twilio reports it', async () => {
      expect(await applySmsStatusCallback(cb({ mid: 'm11', messageSid: 'SM_Z', messageStatus: 'sent' }), run, accountSidFor)).toBe(1);
      expect(await row('m11')).toMatchObject({ twilio_sid: 'SM_Z', status: 'sent', error_message: null });
    });

    it('refuses a malformed mid without querying', async () => {
      const { run: fake, query } = fakeRunner(0);
      await applySmsStatusCallback(cb({ mid: "m10' OR 1=1" }), fake, accountSidFor);
      expect(query).toHaveBeenCalledTimes(1); // only the by-SID status update
    });
  });
});
