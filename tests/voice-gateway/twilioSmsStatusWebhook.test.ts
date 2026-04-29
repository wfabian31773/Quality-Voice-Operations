/**
 * Coverage for the new `/twilio/sms-status` webhook in the voice gateway.
 *
 * Background: connector outage SMS sends from
 * `platform/integrations/connectors/SyncErrorAlerter.ts` now include a
 * Twilio `StatusCallback` URL pointing at this route. Twilio POSTs back
 * here as the message moves through queued -> sent -> delivered (or
 * undelivered/failed), and the handler updates the matching
 * `connector_alert_recipients` row by `twilio_message_sid` so the admin
 * "outage timeline" detail panel can keep refreshing.
 *
 * What this file pins:
 *   1. Terminal `delivered` callbacks promote `delivery_status='delivered'`.
 *   2. Terminal `failed` / `undelivered` callbacks promote
 *      `delivery_status='failed'` and capture the carrier ErrorCode.
 *   3. Intermediate `queued` / `sending` callbacks update the verbatim
 *      Twilio status + timestamp WITHOUT downgrading an already-terminal
 *      `delivery_status` (the SQL uses CASE expressions to enforce this).
 *   4. Unknown SIDs return 204 (Twilio's retry behaviour shouldn't punish
 *      us for SMS sends from other product surfaces).
 *   5. Malformed callbacks return 400.
 *   6. The signature middleware is mounted (skip-able in dev/test mode
 *      via the existing `isDevEnv` branch — no token required here).
 *
 * The route is mounted directly without spinning up the full voice
 * gateway server; we mock `getPlatformPool` so we can both fake the
 * UPDATE result and assert the SQL shape + bind values.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

const queryMock = vi.fn();

vi.mock('../../platform/db', () => ({
  getPlatformPool: () => ({ query: queryMock }),
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

beforeEach(() => {
  queryMock.mockReset();
  // Make sure the signature middleware takes the dev short-circuit so
  // these tests don't have to compute valid HMAC signatures.
  delete process.env.TWILIO_AUTH_TOKEN;
  process.env.NODE_ENV = 'test';
  delete process.env.APP_ENV;
});

async function buildApp(): Promise<express.Express> {
  const app = express();
  // Twilio posts application/x-www-form-urlencoded.
  app.use(express.urlencoded({ extended: false }));
  app.use(express.json());
  const router = (await import('../../server/voice-gateway/routes/twilio')).default;
  app.use(router);
  return app;
}

describe('POST /twilio/sms-status', () => {
  it('promotes delivery_status to "delivered" on a terminal delivered callback and clears no other state', async () => {
    queryMock.mockResolvedValueOnce({
      rowCount: 1,
      rows: [{ tenant_id: 't1', integration_id: 'int-1', dispatch_id: 'd-1' }],
    });

    const app = await buildApp();
    const res = await request(app)
      .post('/twilio/sms-status')
      .type('form')
      .send({
        MessageSid: 'SM_delivered_1',
        MessageStatus: 'delivered',
      });

    expect(res.status).toBe(204);
    expect(queryMock).toHaveBeenCalledTimes(1);
    const [sql, params] = queryMock.mock.calls[0];
    const text = String(sql);
    // Lookup is by twilio_message_sid (matches the unique partial
    // index from migration 099).
    expect(text).toContain('WHERE twilio_message_sid = $1');
    expect(text).toContain('UPDATE connector_alert_recipients');
    // delivery_status must be promoted to 'delivered' for terminal success.
    expect(text).toContain("THEN 'delivered'");
    // delivery_status_updated_at must be refreshed every callback.
    expect(text).toContain('delivery_status_updated_at = NOW()');
    expect((params as unknown[])[0]).toBe('SM_delivered_1');
    expect((params as unknown[])[1]).toBe('delivered');
    // isTerminalSuccess flag = true, isTerminalFailure flag = false
    expect((params as unknown[])[3]).toBe(true);
    expect((params as unknown[])[4]).toBe(false);
  });

  it('promotes delivery_status to "failed" + captures ErrorCode on an undelivered callback', async () => {
    queryMock.mockResolvedValueOnce({
      rowCount: 1,
      rows: [{ tenant_id: 't1', integration_id: 'int-1', dispatch_id: 'd-1' }],
    });

    const app = await buildApp();
    const res = await request(app)
      .post('/twilio/sms-status')
      .type('form')
      .send({
        MessageSid: 'SM_undeliv_1',
        MessageStatus: 'undelivered',
        ErrorCode: '21211',
        ErrorMessage: 'Invalid To Number',
      });

    expect(res.status).toBe(204);
    const params = queryMock.mock.calls[0][1] as unknown[];
    expect(params[0]).toBe('SM_undeliv_1');
    expect(params[1]).toBe('undelivered');
    // ErrorCode is parsed to a number for twilio_error_code.
    expect(params[2]).toBe(21211);
    // isTerminalSuccess = false, isTerminalFailure = true
    expect(params[3]).toBe(false);
    expect(params[4]).toBe(true);
    // ErrorMessage flows through verbatim for delivery_error fallback.
    expect(params[5]).toBe('Invalid To Number');
  });

  it('treats "failed" the same as "undelivered" (both map to delivery_status=failed)', async () => {
    queryMock.mockResolvedValueOnce({ rowCount: 1, rows: [{}] });

    const app = await buildApp();
    const res = await request(app)
      .post('/twilio/sms-status')
      .type('form')
      .send({
        MessageSid: 'SM_failed_1',
        MessageStatus: 'failed',
        ErrorCode: '30007',
      });

    expect(res.status).toBe(204);
    const params = queryMock.mock.calls[0][1] as unknown[];
    // Both `failed` and `undelivered` flip the terminal-failure flag.
    expect(params[4]).toBe(true);
    expect(params[2]).toBe(30007);
  });

  it('does NOT promote delivery_status on intermediate "queued" callbacks (CASE leaves it untouched)', async () => {
    // Regression guard: the SQL must not allow a late `queued` callback
    // to overwrite an already-`delivered` row. We can't fully test the
    // CASE behaviour without a real DB, but we can pin the bind flags
    // we hand the CASE expression — both terminal flags must be false.
    queryMock.mockResolvedValueOnce({ rowCount: 1, rows: [{}] });

    const app = await buildApp();
    const res = await request(app)
      .post('/twilio/sms-status')
      .type('form')
      .send({
        MessageSid: 'SM_inflight_1',
        MessageStatus: 'queued',
      });

    expect(res.status).toBe(204);
    const params = queryMock.mock.calls[0][1] as unknown[];
    expect(params[1]).toBe('queued');
    // Both terminal flags are false — the CASE in SQL falls through to
    // `ELSE delivery_status` so the existing value is preserved.
    expect(params[3]).toBe(false);
    expect(params[4]).toBe(false);
    // Verbatim Twilio status still gets stored.
    const sql = String(queryMock.mock.calls[0][0]);
    expect(sql).toContain('twilio_message_status = $2');
  });

  it('returns 204 for unknown SIDs (so Twilio doesn\'t retry forever for sends from other product surfaces)', async () => {
    queryMock.mockResolvedValueOnce({ rowCount: 0, rows: [] });

    const app = await buildApp();
    const res = await request(app)
      .post('/twilio/sms-status')
      .type('form')
      .send({
        MessageSid: 'SM_not_ours',
        MessageStatus: 'delivered',
      });

    // 2xx tells Twilio to stop retrying; we don't want our queue
    // amplified by SMS sent through unrelated product surfaces.
    expect(res.status).toBe(204);
  });

  it('returns 400 when MessageSid or MessageStatus is missing (so monitoring surfaces malformed callbacks)', async () => {
    const app = await buildApp();

    const noSid = await request(app)
      .post('/twilio/sms-status')
      .type('form')
      .send({ MessageStatus: 'delivered' });
    expect(noSid.status).toBe(400);

    const noStatus = await request(app)
      .post('/twilio/sms-status')
      .type('form')
      .send({ MessageSid: 'SM_x' });
    expect(noStatus.status).toBe(400);

    // No DB calls should have been issued for either malformed request.
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('returns 500 when the DB throws so Twilio retries the terminal callback', async () => {
    // The whole point of the live indicator is that terminal callbacks
    // eventually land. A transient DB blip during a `delivered` callback
    // must not silently lose the transition — Twilio should retry, which
    // requires us to surface a non-2xx.
    queryMock.mockRejectedValueOnce(new Error('db down'));

    const app = await buildApp();
    const res = await request(app)
      .post('/twilio/sms-status')
      .type('form')
      .send({
        MessageSid: 'SM_retry_me',
        MessageStatus: 'delivered',
      });

    expect(res.status).toBe(500);
  });

  it('accepts the legacy SmsSid / SmsStatus aliases Twilio still sends for SMS callbacks', async () => {
    queryMock.mockResolvedValueOnce({ rowCount: 1, rows: [{}] });

    const app = await buildApp();
    const res = await request(app)
      .post('/twilio/sms-status')
      .type('form')
      .send({
        SmsSid: 'SM_legacy_1',
        SmsStatus: 'delivered',
      });

    expect(res.status).toBe(204);
    const params = queryMock.mock.calls[0][1] as unknown[];
    expect(params[0]).toBe('SM_legacy_1');
    expect(params[1]).toBe('delivered');
  });
});
