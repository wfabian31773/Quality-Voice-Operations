import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import express from 'express';
import request from 'supertest';

import { parseBounceWebhookPayload } from '../../platform/email/bounceWebhookParser';

// ---- Static contract checks -------------------------------------------------
//
// Mirrors the static checks for /support/inbound: pin down the auth pattern,
// the env-var gate, and the wire-up to both `addSupportEmailSuppression`
// and `raiseRecipientFirstBounceAlert` so a future refactor that drops one
// of those calls fails CI rather than production.

const supportFile = readFileSync(
  join(process.cwd(), 'server/admin-api/routes/support.ts'),
  'utf8',
);
const parserFile = readFileSync(
  join(process.cwd(), 'platform/email/bounceWebhookParser.ts'),
  'utf8',
);

describe('POST /support/email-bounce — static guards', () => {
  it('exposes the route', () => {
    expect(supportFile).toMatch(/router\.post\('\/support\/email-bounce'/);
  });

  it('reads its shared secret from SUPPORT_BOUNCE_WEBHOOK_SECRET', () => {
    // Distinct env var from SUPPORT_INBOUND_SECRET — providers usually
    // configure separate webhooks for inbound parse vs. bounce notifications,
    // and rotating one shouldn't force a rotation of the other.
    expect(supportFile).toMatch(/SUPPORT_BOUNCE_WEBHOOK_SECRET/);
    expect(supportFile).toMatch(/BOUNCE_WEBHOOK_SECRET/);
  });

  it('rejects requests in production when the secret env var is unset', () => {
    expect(supportFile).toMatch(
      /isProduction && !BOUNCE_WEBHOOK_SECRET/,
    );
  });

  it('verifies the shared secret from header or query when configured', () => {
    // Same pattern as /support/inbound: header `X-Webhook-Secret` OR `?secret=`.
    expect(supportFile).toMatch(/x-webhook-secret/);
    expect(supportFile).toMatch(/req\.query\.secret/);
    expect(supportFile).toMatch(/provided !== BOUNCE_WEBHOOK_SECRET/);
  });

  it('wires both addSupportEmailSuppression and raiseRecipientFirstBounceAlert into the bounce path', () => {
    // The whole point of the task: webhook bounces must land on the
    // suppression list AND page ops via the same helper the retry loop uses.
    // A future refactor that drops either call breaks the alerting contract.
    const handler = supportFile.slice(supportFile.indexOf("'/support/email-bounce'"));
    expect(handler).toMatch(/addSupportEmailSuppression/);
    expect(handler).toMatch(/raiseRecipientFirstBounceAlert/);
  });
});

// ---- Runtime auth enforcement ----------------------------------------------

describe('POST /support/email-bounce — runtime auth enforcement', () => {
  const ORIGINAL_NODE_ENV = process.env.NODE_ENV;
  const ORIGINAL_SECRET = process.env.SUPPORT_BOUNCE_WEBHOOK_SECRET;

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    if (ORIGINAL_NODE_ENV === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = ORIGINAL_NODE_ENV;
    if (ORIGINAL_SECRET === undefined) delete process.env.SUPPORT_BOUNCE_WEBHOOK_SECRET;
    else process.env.SUPPORT_BOUNCE_WEBHOOK_SECRET = ORIGINAL_SECRET;
  });

  async function buildApp() {
    const router = (await import('../../server/admin-api/routes/support')).default;
    const app = express();
    app.use(express.json());
    app.use(router);
    return app;
  }

  it('rejects with 401 in production when the secret env var is missing', async () => {
    process.env.NODE_ENV = 'production';
    delete process.env.SUPPORT_BOUNCE_WEBHOOK_SECRET;
    const app = await buildApp();
    const r = await request(app).post('/support/email-bounce').send({});
    expect(r.status).toBe(401);
    expect(r.body).toEqual({ error: 'unauthorized' });
  });

  it('rejects with 401 when the secret is set but the request omits it', async () => {
    process.env.NODE_ENV = 'production';
    process.env.SUPPORT_BOUNCE_WEBHOOK_SECRET = 'shhh';
    const app = await buildApp();
    const r = await request(app).post('/support/email-bounce').send({});
    expect(r.status).toBe(401);
  });

  it('rejects with 401 when the provided secret does not match', async () => {
    process.env.NODE_ENV = 'production';
    process.env.SUPPORT_BOUNCE_WEBHOOK_SECRET = 'shhh';
    const app = await buildApp();
    const r = await request(app)
      .post('/support/email-bounce')
      .set('X-Webhook-Secret', 'wrong')
      .send({});
    expect(r.status).toBe(401);
  });

  it('allows the request past the auth gate when the header secret matches', async () => {
    process.env.NODE_ENV = 'production';
    process.env.SUPPORT_BOUNCE_WEBHOOK_SECRET = 'shhh';
    const app = await buildApp();
    const r = await request(app)
      .post('/support/email-bounce')
      .set('X-Webhook-Secret', 'shhh')
      .send({});
    // Past auth: empty body has no parsable bounces ⇒ 202 accepted.
    expect(r.status).not.toBe(401);
  });

  it('allows the request past the auth gate when the query secret matches', async () => {
    process.env.NODE_ENV = 'production';
    process.env.SUPPORT_BOUNCE_WEBHOOK_SECRET = 'shhh';
    const app = await buildApp();
    const r = await request(app).post('/support/email-bounce?secret=shhh').send({});
    expect(r.status).not.toBe(401);
  });

  it('does not require the secret in development when env var is unset', async () => {
    process.env.NODE_ENV = 'development';
    delete process.env.SUPPORT_BOUNCE_WEBHOOK_SECRET;
    const app = await buildApp();
    const r = await request(app).post('/support/email-bounce').send({});
    expect(r.status).not.toBe(401);
  });
});

// ---- Parser contract --------------------------------------------------------

describe('parseBounceWebhookPayload — provider coverage', () => {
  it('exports the parser entrypoint', () => {
    expect(parserFile).toMatch(/export function parseBounceWebhookPayload/);
  });

  it('returns an empty list for unknown / blank payloads (no provider redelivery storm)', () => {
    expect(parseBounceWebhookPayload(null)).toEqual([]);
    expect(parseBounceWebhookPayload(undefined)).toEqual([]);
    expect(parseBounceWebhookPayload({})).toEqual([]);
    expect(parseBounceWebhookPayload({ random: 'shape' })).toEqual([]);
  });

  it('lowercases SES recipient addresses so the dedup key matches the helper', () => {
    const events = parseBounceWebhookPayload({
      notificationType: 'Bounce',
      bounce: {
        bounceType: 'Permanent',
        bounceSubType: 'General',
        bouncedRecipients: [
          { emailAddress: 'CustOmer@Example.COM', diagnosticCode: '550 mailbox not found' },
        ],
      },
      mail: { messageId: '<msg-1@email.amazonses.com>' },
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      recipientEmail: 'customer@example.com',
      messageId: '<msg-1@email.amazonses.com>',
      error: '550 mailbox not found',
      provider: 'ses',
    });
  });

  it('unwraps SES SNS Notification envelope before parsing', () => {
    const events = parseBounceWebhookPayload({
      Type: 'Notification',
      Message: JSON.stringify({
        notificationType: 'Bounce',
        bounce: {
          bounceType: 'Permanent',
          bouncedRecipients: [{ emailAddress: 'a@b.com' }],
        },
        mail: { messageId: 'msg-2' },
      }),
    });
    expect(events).toHaveLength(1);
    expect(events[0].recipientEmail).toBe('a@b.com');
    expect(events[0].messageId).toBe('msg-2');
  });

  it('drops SES transient bounces (soft) — only Permanent surfaces', () => {
    const events = parseBounceWebhookPayload({
      notificationType: 'Bounce',
      bounce: {
        bounceType: 'Transient',
        bouncedRecipients: [{ emailAddress: 'a@b.com' }],
      },
      mail: { messageId: 'msg-3' },
    });
    expect(events).toEqual([]);
  });

  it('emits a Postmark HardBounce event with the description as the error', () => {
    const events = parseBounceWebhookPayload({
      RecordType: 'Bounce',
      Type: 'HardBounce',
      Email: 'recipient@example.com',
      MessageID: 'pm-msg-1',
      Description: 'The server was unable to deliver your message.',
    });
    expect(events).toEqual([
      {
        recipientEmail: 'recipient@example.com',
        messageId: 'pm-msg-1',
        error: 'The server was unable to deliver your message.',
        provider: 'postmark',
      },
    ]);
  });

  it('drops Postmark soft-bounce types (e.g. Transient)', () => {
    expect(
      parseBounceWebhookPayload({
        RecordType: 'Bounce',
        Type: 'Transient',
        Email: 'a@b.com',
        MessageID: 'x',
      }),
    ).toEqual([]);
  });

  it('emits a SendGrid bounce event from the events array', () => {
    const events = parseBounceWebhookPayload([
      {
        event: 'bounce',
        type: 'bounce',
        email: 'sg@example.com',
        sg_message_id: 'sg-1',
        reason: '550 5.1.1 user unknown',
      },
      // Non-permanent / unrelated events that must be dropped.
      { event: 'bounce', type: 'blocked', email: 'soft@example.com' },
      { event: 'delivered', email: 'ok@example.com' },
      // Sender-side drop reasons (credit limit, malformed SMTPAPI header)
      // must NOT be classified as permanent recipient failures — flagging
      // them creates false suppressions and pages ops on our own bugs.
      { event: 'dropped', email: 'soft2@example.com', reason: 'credit limit reached' },
      { event: 'dropped', email: 'sender@example.com', reason: 'Invalid SMTPAPI header' },
      // Documented recipient-attributable drop reason: keep.
      { event: 'dropped', email: 'badaddr@example.com', reason: 'Invalid email address' },
      // SendGrid `blocked` event is also a permanent rejection.
      {
        event: 'blocked',
        email: 'blocked@example.com',
        sg_message_id: 'sg-2',
        reason: '550 blocked',
      },
    ]);
    const emails = events.map((e) => e.recipientEmail).sort();
    expect(emails).toEqual(['badaddr@example.com', 'blocked@example.com', 'sg@example.com']);
  });

  it('emits a Mailgun event-data permanent-failure event', () => {
    const events = parseBounceWebhookPayload({
      'event-data': {
        event: 'failed',
        severity: 'permanent',
        recipient: 'mg@example.com',
        reason: '550 mailbox not found',
        message: { headers: { 'message-id': 'mg-1' } },
      },
    });
    expect(events).toEqual([
      {
        recipientEmail: 'mg@example.com',
        messageId: 'mg-1',
        error: '550 mailbox not found',
        provider: 'mailgun',
      },
    ]);
  });

  it('drops Mailgun temporary-severity failures (soft)', () => {
    expect(
      parseBounceWebhookPayload({
        'event-data': {
          event: 'failed',
          severity: 'temporary',
          recipient: 'mg@example.com',
          reason: '4xx try again',
        },
      }),
    ).toEqual([]);
  });
});

// ---- End-to-end behavior: webhook → suppression + alert --------------------

// Single shared query mock so the test bodies can program per-scenario
// responses and assert on the executed SQL. The factory captures the mock
// in a module-scoped binding so we can read it back via typed
// `vi.mocked(...)` calls below — no `any` casts required.
const queryMock = vi.fn();

vi.mock('../../platform/db', () => ({
  getPlatformPool: () => ({ query: queryMock }),
}));

vi.mock('../../platform/core/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock('../../platform/core/observability', () => ({
  logError: vi.fn().mockResolvedValue(undefined),
}));

// Typed handle on the mocked logError export. `vi.mocked` preserves the
// original module's types, so calls to `.mockReset()` /
// `.mock.calls[i][n]` are checked against the real `logError` signature.
const observabilityModule = await import('../../platform/core/observability');
const logErrorMock = vi.mocked(observabilityModule.logError);

describe('POST /support/email-bounce — end-to-end behavior', () => {
  const ORIGINAL_NODE_ENV = process.env.NODE_ENV;
  const ORIGINAL_SECRET = process.env.SUPPORT_BOUNCE_WEBHOOK_SECRET;

  beforeEach(() => {
    queryMock.mockReset();
    logErrorMock.mockReset();
    process.env.NODE_ENV = 'development';
    delete process.env.SUPPORT_BOUNCE_WEBHOOK_SECRET;
  });

  afterEach(() => {
    if (ORIGINAL_NODE_ENV === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = ORIGINAL_NODE_ENV;
    if (ORIGINAL_SECRET === undefined) delete process.env.SUPPORT_BOUNCE_WEBHOOK_SECRET;
    else process.env.SUPPORT_BOUNCE_WEBHOOK_SECRET = ORIGINAL_SECRET;
  });

  async function buildApp() {
    const router = (await import('../../server/admin-api/routes/support')).default;
    const app = express();
    // Mirror the production admin-api setup: app-level express.json() handles
    // application/json bodies; the route attaches its own express.text() for
    // the SNS text/plain shape, so we don't add it here.
    app.use(express.json());
    app.use(router);
    return app;
  }

  it('returns 202 with processed=0 when the payload contains no permanent failures', async () => {
    const app = await buildApp();
    const r = await request(app)
      .post('/support/email-bounce')
      .send({ random: 'shape' });
    expect(r.status).toBe(202);
    expect(r.body).toEqual({ processed: 0 });
    // Critically: no DB work for unparseable / soft-only payloads.
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('processes a Postmark HardBounce: stamps the reply, suppresses the address, and pages ops', async () => {
    const TENANT_ID = '00000000-0000-0000-0000-000000000099';
    queryMock
      // 1. reply lookup by message_id
      .mockResolvedValueOnce({
        rowCount: 1,
        rows: [
          {
            id: 42,
            ticket_id: 'tkt_abc',
            tenant_id: TENANT_ID,
            retry_skipped_reason: null,
          },
        ],
      })
      // 2. stamp the reply with the bounce
      .mockResolvedValueOnce({ rowCount: 1, rows: [] })
      // 3. addSupportEmailSuppression INSERT ON CONFLICT
      .mockResolvedValueOnce({ rowCount: 1, rows: [] })
      // 4. raiseRecipientFirstBounceAlert claim INSERT
      .mockResolvedValueOnce({
        rowCount: 1,
        rows: [{ email_lower: 'recipient@example.com' }],
      })
      // 5. operations_alerts INSERT inside the helper
      .mockResolvedValueOnce({ rowCount: 1, rows: [] });

    const app = await buildApp();
    const r = await request(app)
      .post('/support/email-bounce')
      .send({
        RecordType: 'Bounce',
        Type: 'HardBounce',
        Email: 'Recipient@Example.com',
        MessageID: 'pm-msg-1',
        Description: '550 mailbox not found',
      });

    expect(r.status).toBe(200);
    expect(r.body).toEqual({ processed: 1, alerted: 1 });

    // 1. reply lookup keyed on the provider-reported message id.
    const lookupCall = queryMock.mock.calls[0];
    expect(lookupCall[0]).toMatch(/SELECT r\.id, r\.ticket_id, t\.tenant_id, r\.retry_skipped_reason/);
    expect(lookupCall[0]).toMatch(/email_message_id = \$1/);
    expect(lookupCall[1]).toEqual(['pm-msg-1']);

    // 2. reply stamp uses COALESCE so existing skip reasons are preserved.
    const stampCall = queryMock.mock.calls[1];
    expect(stampCall[0]).toMatch(/UPDATE support_ticket_replies/);
    expect(stampCall[0]).toMatch(/COALESCE\(retry_skipped_reason, 'permanent_smtp_failure'\)/);
    expect(stampCall[1]).toEqual([42, '550 mailbox not found']);

    // 3. suppression INSERT records the lowercased address + provider source.
    const supCall = queryMock.mock.calls[2];
    expect(supCall[0]).toMatch(/INSERT INTO support_email_suppressions/);
    expect(supCall[1][0]).toBe('recipient@example.com');
    expect(supCall[1][1]).toBe('permanent_smtp_failure');
    expect(supCall[1][2]).toBe('bounce_webhook_postmark');
    expect(supCall[1][3]).toBe('550 mailbox not found');

    // 4. recipient first-bounce alert claim.
    const alertCall = queryMock.mock.calls[3];
    expect(alertCall[0]).toMatch(/INSERT INTO support_recipient_bounce_alerts/);
    expect(alertCall[0]).toMatch(/ON CONFLICT \(email_lower\) DO NOTHING/);
    expect(alertCall[1][0]).toBe('recipient@example.com');
    expect(alertCall[1][1]).toBe(42);
    expect(alertCall[1][2]).toBe('tkt_abc');
    expect(alertCall[1][3]).toBe(TENANT_ID);

    // 5. critical error_log written via the shared helper.
    expect(logErrorMock).toHaveBeenCalledTimes(1);
    expect(logErrorMock.mock.calls[0][0]).toBe(TENANT_ID);
    expect(logErrorMock.mock.calls[0][1]).toBe('critical');
    expect(logErrorMock.mock.calls[0][3].errorCode).toBe('support_recipient_first_bounce');
  });

  it('falls back to recipient-only attribution when no reply matches the message id', async () => {
    queryMock
      // 1. reply lookup by message_id — no match
      .mockResolvedValueOnce({ rowCount: 0, rows: [] })
      // 2. fallback lookup by recipient — also no match (e.g. the address
      //    was never on a ticket; ops still wants to know about the bounce)
      .mockResolvedValueOnce({ rowCount: 0, rows: [] })
      // 3. addSupportEmailSuppression
      .mockResolvedValueOnce({ rowCount: 1, rows: [] })
      // 4. recipient alert claim — succeeds with null reply/ticket/tenant
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ email_lower: 'orphan@example.com' }] });
      // No operations_alerts call: tenantId is null (anonymous bounce)

    const app = await buildApp();
    const r = await request(app)
      .post('/support/email-bounce')
      .send({
        RecordType: 'Bounce',
        Type: 'HardBounce',
        Email: 'orphan@example.com',
        MessageID: 'unknown-id',
        Description: '550 user unknown',
      });

    expect(r.status).toBe(200);
    expect(r.body).toEqual({ processed: 1, alerted: 1 });

    // The fallback lookup keys on the lowercased recipient address.
    const fallbackLookup = queryMock.mock.calls[1];
    expect(fallbackLookup[0]).toMatch(/LOWER\(t\.user_email\) = \$1/);
    expect(fallbackLookup[1]).toEqual(['orphan@example.com']);

    // Suppression still records the address even without a matched reply.
    const supCall = queryMock.mock.calls[2];
    expect(supCall[0]).toMatch(/INSERT INTO support_email_suppressions/);
    expect(supCall[1][0]).toBe('orphan@example.com');

    // Alert claim used null tenant (anonymous), reply_id=0, ticket_id='webhook'
    // so it can still record the dedup row + critical error_log.
    const alertCall = queryMock.mock.calls[3];
    expect(alertCall[1][0]).toBe('orphan@example.com');
    expect(alertCall[1][1]).toBe(0);
    expect(alertCall[1][2]).toBe('webhook');
    expect(alertCall[1][3]).toBeNull();

    // Critical error_log was still written (helper writes it on a successful claim).
    expect(logErrorMock).toHaveBeenCalledTimes(1);
    expect(logErrorMock.mock.calls[0][0]).toBeNull();
  });

  it('parses SES bounces sent as SNS text/plain JSON and runs the full alert path', async () => {
    // SNS notifications arrive with `Content-Type: text/plain; charset=UTF-8`
    // and a stringified Message envelope. The route must JSON-parse the
    // outer body and then JSON-parse the inner Message — without this the
    // entire SES path silently no-ops in production.
    const TENANT_ID = '00000000-0000-0000-0000-0000000000aa';
    queryMock
      .mockResolvedValueOnce({
        rowCount: 1,
        rows: [{ id: 11, ticket_id: 'tkt_ses', tenant_id: TENANT_ID, retry_skipped_reason: null }],
      })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ email_lower: 'bounce@example.com' }] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] });

    const innerMessage = JSON.stringify({
      notificationType: 'Bounce',
      mail: { messageId: 'ses-msg-1' },
      bounce: {
        bounceType: 'Permanent',
        bounceSubType: 'General',
        bouncedRecipients: [
          { emailAddress: 'bounce@example.com', diagnosticCode: '550 user unknown' },
        ],
      },
    });
    const snsEnvelope = JSON.stringify({
      Type: 'Notification',
      MessageId: 'sns-1',
      TopicArn: 'arn:aws:sns:us-east-1:123:bounces',
      Message: innerMessage,
    });

    const app = await buildApp();
    const r = await request(app)
      .post('/support/email-bounce')
      .set('Content-Type', 'text/plain; charset=UTF-8')
      .send(snsEnvelope);

    expect(r.status).toBe(200);
    expect(r.body).toEqual({ processed: 1, alerted: 1 });

    // Confirms the route looked up the reply by the inner SES message id,
    // not by the outer SNS envelope.
    expect(queryMock.mock.calls[0][1]).toEqual(['ses-msg-1']);
    // And the suppression source carries the SES provider tag.
    expect(queryMock.mock.calls[2][1][2]).toBe('bounce_webhook_ses');
    expect(logErrorMock).toHaveBeenCalledTimes(1);
  });

  it('handles the SNS SubscriptionConfirmation handshake without touching the bounce pipeline', async () => {
    // A 4xx/5xx response here would prevent SES from ever activating the
    // subscription, so the route must return 2xx and leave the alert path
    // alone. The host check guards against SSRF abuse — non-AWS hosts must
    // be refused.
    const app = await buildApp();
    const confirmation = JSON.stringify({
      Type: 'SubscriptionConfirmation',
      MessageId: 'sub-1',
      Token: 'ttt',
      TopicArn: 'arn:aws:sns:us-east-1:123:bounces',
      // Use a host that fails the AWS-only check so the test never makes a
      // real network request — the route should still 200 and skip parsing.
      SubscribeURL: 'https://attacker.example.com/subscribe?Token=ttt',
    });

    const r = await request(app)
      .post('/support/email-bounce')
      .set('Content-Type', 'text/plain; charset=UTF-8')
      .send(confirmation);

    expect(r.status).toBe(200);
    expect(r.body).toEqual({ confirmed: true });
    // No DB work and no alert pipeline invocation for the handshake.
    expect(queryMock).not.toHaveBeenCalled();
    expect(logErrorMock).not.toHaveBeenCalled();
  });

  it('dedups against the in-process retry loop: if the helper claim returns rowCount=0, alerted=0', async () => {
    queryMock
      // 1. reply lookup hit
      .mockResolvedValueOnce({
        rowCount: 1,
        rows: [{ id: 7, ticket_id: 'tkt_zzz', tenant_id: 'tnt-1', retry_skipped_reason: null }],
      })
      // 2. stamp the reply
      .mockResolvedValueOnce({ rowCount: 1, rows: [] })
      // 3. suppression INSERT
      .mockResolvedValueOnce({ rowCount: 1, rows: [] })
      // 4. claim — already alerted by the retry loop ⇒ rowCount: 0
      .mockResolvedValueOnce({ rowCount: 0, rows: [] });
      // No further calls — the helper short-circuits before operations_alerts.

    const app = await buildApp();
    const r = await request(app)
      .post('/support/email-bounce')
      .send({
        RecordType: 'Bounce',
        Type: 'HardBounce',
        Email: 'dup@example.com',
        MessageID: 'pm-msg-9',
        Description: '550 already alerted',
      });

    expect(r.status).toBe(200);
    expect(r.body).toEqual({ processed: 1, alerted: 0 });
    // No critical error_log: helper short-circuited on dedup.
    expect(logErrorMock).not.toHaveBeenCalled();
  });
});
