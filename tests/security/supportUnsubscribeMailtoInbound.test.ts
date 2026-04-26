import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
} from 'vitest';
import express from 'express';
import request from 'supertest';

// The List-Unsubscribe header advertises a `mailto:unsubscribe@<domain>`
// fallback for older MUAs that can't drive the RFC 8058 one-click HTTPS
// endpoint. This suite locks down the inbound webhook routing rule that
// turns those mailto: opt-outs into rows in `support_email_unsubscribes`,
// so the existing send-side gate (`checkSupportEmailSkip` →
// `recipient_unsubscribed`) suppresses every future send to the address.
//
// We mock the suppression module so the assertion target is the helper
// the existing landing-page sink already calls — i.e. a future refactor
// that breaks the contract by inserting a row directly will fail here.

vi.mock('../../platform/email/SupportEmailSuppression', () => {
  const addSupportEmailUnsubscribeMock = vi.fn().mockResolvedValue(undefined);
  return {
    __addSupportEmailUnsubscribeMock: addSupportEmailUnsubscribeMock,
    addSupportEmailUnsubscribe: addSupportEmailUnsubscribeMock,
    addSupportEmailSuppression: vi.fn().mockResolvedValue(undefined),
    checkSupportEmailSkip: vi.fn().mockResolvedValue({
      skip: false,
      reason: null,
      emailLower: null,
    }),
  };
});

vi.mock('../../platform/core/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

describe('isSupportUnsubscribeMailtoTarget — pure helper', () => {
  const ORIGINAL_MAILTO = process.env.SUPPORT_UNSUBSCRIBE_MAILTO;
  const ORIGINAL_FROM = process.env.EMAIL_FROM;

  afterEach(() => {
    if (ORIGINAL_MAILTO === undefined) delete process.env.SUPPORT_UNSUBSCRIBE_MAILTO;
    else process.env.SUPPORT_UNSUBSCRIBE_MAILTO = ORIGINAL_MAILTO;
    if (ORIGINAL_FROM === undefined) delete process.env.EMAIL_FROM;
    else process.env.EMAIL_FROM = ORIGINAL_FROM;
  });

  async function load() {
    vi.resetModules();
    return import('../../platform/email/supportUnsubscribeToken');
  }

  it('matches a bare address case-insensitively against the configured target', async () => {
    process.env.SUPPORT_UNSUBSCRIBE_MAILTO = 'unsubscribe@example.com';
    const mod = await load();
    expect(mod.isSupportUnsubscribeMailtoTarget('unsubscribe@example.com')).toBe(true);
    expect(mod.isSupportUnsubscribeMailtoTarget('Unsubscribe@Example.COM')).toBe(true);
    expect(mod.isSupportUnsubscribeMailtoTarget('  unsubscribe@example.com  ')).toBe(true);
  });

  it('matches an angle-bracketed address with a display name', async () => {
    process.env.SUPPORT_UNSUBSCRIBE_MAILTO = 'unsubscribe@example.com';
    const mod = await load();
    expect(
      mod.isSupportUnsubscribeMailtoTarget('"Unsubscribe" <unsubscribe@example.com>'),
    ).toBe(true);
  });

  it('matches when the target appears in a comma-separated recipient list', async () => {
    process.env.SUPPORT_UNSUBSCRIBE_MAILTO = 'unsubscribe@example.com';
    const mod = await load();
    expect(
      mod.isSupportUnsubscribeMailtoTarget(
        'Support <support@example.com>, unsubscribe@example.com',
      ),
    ).toBe(true);
  });

  it('rejects unrelated addresses, blanks, and nulls', async () => {
    process.env.SUPPORT_UNSUBSCRIBE_MAILTO = 'unsubscribe@example.com';
    const mod = await load();
    expect(mod.isSupportUnsubscribeMailtoTarget('support@example.com')).toBe(false);
    expect(mod.isSupportUnsubscribeMailtoTarget('attacker@evil.example')).toBe(false);
    expect(mod.isSupportUnsubscribeMailtoTarget('')).toBe(false);
    expect(mod.isSupportUnsubscribeMailtoTarget(null)).toBe(false);
    expect(mod.isSupportUnsubscribeMailtoTarget(undefined)).toBe(false);
  });

  it('falls back to the EMAIL_FROM domain when no explicit target is configured', async () => {
    delete process.env.SUPPORT_UNSUBSCRIBE_MAILTO;
    process.env.EMAIL_FROM = 'noreply@qualityvoiceops.com';
    const mod = await load();
    expect(mod.getSupportUnsubscribeMailtoTarget()).toBe('unsubscribe@qualityvoiceops.com');
    expect(mod.isSupportUnsubscribeMailtoTarget('unsubscribe@qualityvoiceops.com')).toBe(true);
    expect(mod.isSupportUnsubscribeMailtoTarget('unsubscribe@other.example')).toBe(false);
  });
});

describe('POST /support/inbound — unsubscribe@ routing rule', () => {
  const ORIGINAL_NODE_ENV = process.env.NODE_ENV;
  const ORIGINAL_SECRET = process.env.SUPPORT_INBOUND_SECRET;
  const ORIGINAL_MAILTO = process.env.SUPPORT_UNSUBSCRIBE_MAILTO;

  let app: express.Express;
  let addSupportEmailUnsubscribeMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    process.env.NODE_ENV = 'development';
    delete process.env.SUPPORT_INBOUND_SECRET;
    process.env.SUPPORT_UNSUBSCRIBE_MAILTO = 'unsubscribe@example.com';
    vi.resetModules();

    const router = (await import('../../server/admin-api/routes/support')).default;
    addSupportEmailUnsubscribeMock = (
      (await import(
        '../../platform/email/SupportEmailSuppression',
      )) as unknown as { __addSupportEmailUnsubscribeMock: ReturnType<typeof vi.fn> }
    ).__addSupportEmailUnsubscribeMock;
    addSupportEmailUnsubscribeMock.mockClear();

    app = express();
    app.use(express.json());
    app.use(router);
  });

  afterEach(() => {
    if (ORIGINAL_NODE_ENV === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = ORIGINAL_NODE_ENV;
    if (ORIGINAL_SECRET === undefined) delete process.env.SUPPORT_INBOUND_SECRET;
    else process.env.SUPPORT_INBOUND_SECRET = ORIGINAL_SECRET;
    if (ORIGINAL_MAILTO === undefined) delete process.env.SUPPORT_UNSUBSCRIBE_MAILTO;
    else process.env.SUPPORT_UNSUBSCRIBE_MAILTO = ORIGINAL_MAILTO;
  });

  it('writes an unsubscribe row keyed on the From address when To is the unsubscribe inbox', async () => {
    const r = await request(app)
      .post('/support/inbound')
      .send({
        from: 'Real User <real.user@customer.example>',
        to: 'unsubscribe@example.com',
        subject: 'unsubscribe',
        text: '',
      });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      matched: true,
      unsubscribed: 'real.user@customer.example',
      source: 'mailto_inbound',
    });
    expect(addSupportEmailUnsubscribeMock).toHaveBeenCalledTimes(1);
    expect(addSupportEmailUnsubscribeMock).toHaveBeenCalledWith(
      'real.user@customer.example',
      'mailto_inbound',
    );
  });

  it('accepts an empty body (Apple Mail / Gmail send no body on Unsubscribe click)', async () => {
    const r = await request(app)
      .post('/support/inbound')
      .send({
        from: 'bare@customer.example',
        to: 'unsubscribe@example.com',
        subject: '',
        text: '',
        html: '',
      });
    expect(r.status).toBe(200);
    expect(addSupportEmailUnsubscribeMock).toHaveBeenCalledWith(
      'bare@customer.example',
      'mailto_inbound',
    );
  });

  it('still routes to the ticket parser when To is not the unsubscribe inbox', async () => {
    const r = await request(app)
      .post('/support/inbound')
      .send({
        from: 'someone@customer.example',
        to: 'support@reply.qvo.ai',
        subject: 'no ticket ref here',
        text: 'hello',
      });
    // Either 202 (no ticket match) or 500 (DB unavailable in this isolated
    // app), but never the unsubscribe success shape, and the suppression
    // helper must NOT have been called.
    expect(r.status).not.toBe(200);
    expect(addSupportEmailUnsubscribeMock).not.toHaveBeenCalled();
  });

  it('rejects an unsubscribe inbound that lacks a usable From address', async () => {
    const r = await request(app)
      .post('/support/inbound')
      .send({
        from: '',
        to: 'unsubscribe@example.com',
        subject: 'unsubscribe',
      });
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ error: 'missing sender' });
    expect(addSupportEmailUnsubscribeMock).not.toHaveBeenCalled();
  });

  it('rejects an unsubscribe inbound when From is malformed', async () => {
    const r = await request(app)
      .post('/support/inbound')
      .send({
        from: 'not-an-email',
        to: 'unsubscribe@example.com',
      });
    expect(r.status).toBe(400);
    expect(addSupportEmailUnsubscribeMock).not.toHaveBeenCalled();
  });

  it('still enforces the shared-secret gate before any unsubscribe write', async () => {
    process.env.NODE_ENV = 'production';
    process.env.SUPPORT_INBOUND_SECRET = 'shhh';
    vi.resetModules();
    const router = (await import('../../server/admin-api/routes/support')).default;
    addSupportEmailUnsubscribeMock = (
      (await import(
        '../../platform/email/SupportEmailSuppression',
      )) as unknown as { __addSupportEmailUnsubscribeMock: ReturnType<typeof vi.fn> }
    ).__addSupportEmailUnsubscribeMock;
    addSupportEmailUnsubscribeMock.mockClear();
    const guarded = express();
    guarded.use(express.json());
    guarded.use(router);

    const r = await request(guarded)
      .post('/support/inbound')
      .send({
        from: 'real.user@customer.example',
        to: 'unsubscribe@example.com',
      });
    expect(r.status).toBe(401);
    expect(addSupportEmailUnsubscribeMock).not.toHaveBeenCalled();
  });
});
