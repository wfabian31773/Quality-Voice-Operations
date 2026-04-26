import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
} from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import express from 'express';
import request from 'supertest';

// ---- Static contract tests --------------------------------------------------
// These read the source as text so the wiring constraints survive even if a
// future refactor moves runtime structures around. They guard the four
// invariants ops cares about:
//   1. The unsubscribe routes exist and live on the public side of the
//      router (no auth/RBAC middleware between mount and handler).
//   2. The handler verifies the HMAC token before touching the DB.
//   3. Every outbound support-email send site attaches the
//      List-Unsubscribe + List-Unsubscribe-Post headers and the visible
//      footer link, so manual click and one-click MUA flows both terminate
//      in the same suppression write.
//   4. The sink calls the existing addSupportEmailUnsubscribe helper
//      (which the badge in PlatformAdmin already consumes via the
//      checkSupportEmailSkip → 'recipient_unsubscribed' path) — i.e. we
//      reuse the gate, we don't grow a parallel one.

const supportFile = readFileSync(
  join(process.cwd(), 'server/admin-api/routes/support.ts'),
  'utf8',
);
const tokenHelperFile = readFileSync(
  join(process.cwd(), 'platform/email/supportUnsubscribeToken.ts'),
  'utf8',
);
const supportSchedulerFile = readFileSync(
  join(process.cwd(), 'platform/help/SupportReplyRetryScheduler.ts'),
  'utf8',
);
const docsSchedulerFile = readFileSync(
  join(process.cwd(), 'platform/help/DocsFeedbackReplyRetryScheduler.ts'),
  'utf8',
);
const supportReplyEmailFile = readFileSync(
  join(process.cwd(), 'platform/help/supportReplyEmail.ts'),
  'utf8',
);
const docsReplyEmailFile = readFileSync(
  join(process.cwd(), 'platform/help/docsFeedbackReplyEmail.ts'),
  'utf8',
);

describe('Support unsubscribe — static wiring contract', () => {
  it('mints HMAC-SHA256 tokens and verifies them in constant time', () => {
    expect(tokenHelperFile).toMatch(/createHmac\(\s*'sha256'/);
    expect(tokenHelperFile).toMatch(/timingSafeEqual/);
    // Token derived from the lowercased address — opt-out is address-
    // scoped, not per-send. If this regresses, two casings of the same
    // address would mint different tokens and the verify side would fail
    // legitimate clicks.
    expect(tokenHelperFile).toMatch(/normalizeEmail/);
  });

  it('produces RFC 8058 one-click headers (mailto + https + Post directive)', () => {
    expect(tokenHelperFile).toMatch(
      /'List-Unsubscribe':\s*`<mailto:[^`]+>,\s*<\$\{[^}]+\}>`/,
    );
    expect(tokenHelperFile).toMatch(
      /'List-Unsubscribe-Post':\s*'List-Unsubscribe=One-Click'/,
    );
  });

  it('exposes both a one-click POST and a friendly GET landing page', () => {
    expect(supportFile).toMatch(/router\.get\(\s*'\/support\/unsubscribe'/);
    expect(supportFile).toMatch(/router\.post\(\s*\n?\s*'\/support\/unsubscribe'/);
    // urlencoded body parser — providers POST `List-Unsubscribe=One-Click`
    // as application/x-www-form-urlencoded, not JSON.
    expect(supportFile).toMatch(/express\.urlencoded\(\s*\{\s*extended:\s*false/);
  });

  it('verifies the HMAC token before writing to support_email_unsubscribes', () => {
    // The gate must run before the DB write — otherwise an attacker could
    // unsubscribe arbitrary addresses by enumerating them.
    const handlerStart = supportFile.indexOf('async function handleSupportUnsubscribe');
    expect(handlerStart).toBeGreaterThan(-1);
    const handlerSlice = supportFile.slice(handlerStart, handlerStart + 4000);
    const verifyIdx = handlerSlice.indexOf('verifySupportUnsubscribeToken');
    const writeIdx = handlerSlice.indexOf('addSupportEmailUnsubscribe');
    expect(verifyIdx).toBeGreaterThan(-1);
    expect(writeIdx).toBeGreaterThan(-1);
    expect(verifyIdx).toBeLessThan(writeIdx);
  });

  it('reuses the existing checkSupportEmailSkip gate (no parallel suppression list)', () => {
    // The badge in PlatformAdmin is driven by retry_skipped_reason =
    // 'recipient_unsubscribed', which the existing send-side gate stamps
    // when checkSupportEmailSkip returns that reason. Our sink writes to
    // the same support_email_unsubscribes table the gate reads.
    expect(supportFile).toMatch(/addSupportEmailUnsubscribe/);
    expect(supportFile).toMatch(/checkSupportEmailSkip/);
    // And the gating still stamps the right reason on skipped sends:
    expect(supportFile).toMatch(/recipient_unsubscribed/);
  });

  it('attaches List-Unsubscribe headers to every outbound support email send site', () => {
    // Initial ack, manual /reply, manual /retry, deliverDocsFeedbackReply,
    // SupportReplyRetryScheduler retry, DocsFeedbackReplyRetryScheduler
    // retry — six call sites total. We assert each module imports the
    // header builder and references it at least once.
    expect(supportFile).toMatch(/buildSupportUnsubscribeEmailHeaders/);
    expect(supportSchedulerFile).toMatch(/buildSupportUnsubscribeEmailHeaders/);
    expect(docsSchedulerFile).toMatch(/buildSupportUnsubscribeEmailHeaders/);
    // At least four spread/use sites in support.ts (ack + reply + retry +
    // docs feedback). Counting prevents a regression where one path
    // silently drops the header.
    const matches = supportFile.match(/buildSupportUnsubscribeEmailHeaders/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(4);
  });

  it('passes the visible unsubscribe footer through the shared renderers', () => {
    // The renderers accept the footer as an optional input so the manual
    // and auto-retry paths produce byte-identical bodies.
    expect(supportReplyEmailFile).toMatch(/unsubscribeFooter\?:/);
    expect(docsReplyEmailFile).toMatch(/unsubscribeFooter\?:/);
    // Every send site supplies it.
    expect(supportFile).toMatch(/buildSupportUnsubscribeFooter/);
    expect(supportSchedulerFile).toMatch(/buildSupportUnsubscribeFooter/);
    expect(docsSchedulerFile).toMatch(/buildSupportUnsubscribeFooter/);
  });
});

// ---- Token helper unit tests ------------------------------------------------

describe('supportUnsubscribeToken — verify semantics', () => {
  // We re-import the helper inside each test block because the secret
  // resolution reads process.env at mint time; tests that mutate env vars
  // need a clean module each time.
  it('mints a 32-hex-char token deterministic in (email, secret)', async () => {
    process.env.SUPPORT_UNSUBSCRIBE_SECRET = 'test-secret-1';
    vi.resetModules();
    const mod = await import('../../platform/email/supportUnsubscribeToken');
    const t1 = mod.buildSupportUnsubscribeToken('Alice@Example.COM');
    const t2 = mod.buildSupportUnsubscribeToken('alice@example.com');
    expect(t1).toMatch(/^[a-f0-9]{32}$/);
    // Address-scoped: case-insensitive on the email, deterministic on the
    // secret. Two casings of the same address must produce the same token,
    // otherwise users who saved a link from a differently-cased original
    // get spurious "invalid token" errors.
    expect(t1).toBe(t2);
  });

  it('rejects mismatched and length-surprising tokens without throwing', async () => {
    process.env.SUPPORT_UNSUBSCRIBE_SECRET = 'test-secret-2';
    vi.resetModules();
    const mod = await import('../../platform/email/supportUnsubscribeToken');
    const good = mod.buildSupportUnsubscribeToken('bob@example.com');
    expect(mod.verifySupportUnsubscribeToken('bob@example.com', good)).toBe(true);
    expect(mod.verifySupportUnsubscribeToken('bob@example.com', good + 'a')).toBe(false);
    expect(mod.verifySupportUnsubscribeToken('bob@example.com', good.slice(0, -1))).toBe(false);
    // Different address, same token → must reject (otherwise an attacker
    // could replay a legitimate token against another address).
    expect(mod.verifySupportUnsubscribeToken('eve@example.com', good)).toBe(false);
    // Null / empty inputs → reject, never throw.
    expect(mod.verifySupportUnsubscribeToken(null, good)).toBe(false);
    expect(mod.verifySupportUnsubscribeToken('bob@example.com', null)).toBe(false);
    expect(mod.verifySupportUnsubscribeToken('', '')).toBe(false);
  });

  it('rotating the secret invalidates previously minted tokens', async () => {
    process.env.SUPPORT_UNSUBSCRIBE_SECRET = 'rotate-old';
    vi.resetModules();
    const oldMod = await import('../../platform/email/supportUnsubscribeToken');
    const oldToken = oldMod.buildSupportUnsubscribeToken('carol@example.com');

    process.env.SUPPORT_UNSUBSCRIBE_SECRET = 'rotate-new';
    vi.resetModules();
    const newMod = await import('../../platform/email/supportUnsubscribeToken');
    expect(newMod.verifySupportUnsubscribeToken('carol@example.com', oldToken)).toBe(false);
  });

  it('builds an https URL containing the encoded address and token', async () => {
    process.env.SUPPORT_UNSUBSCRIBE_SECRET = 'url-secret';
    process.env.SUPPORT_PUBLIC_BASE_URL = 'https://app.qvo.ai';
    vi.resetModules();
    const mod = await import('../../platform/email/supportUnsubscribeToken');
    const url = mod.buildSupportUnsubscribeUrl('Dan+filter@example.com');
    expect(url.startsWith('https://app.qvo.ai/api/admin/support/unsubscribe?')).toBe(true);
    expect(url).toContain('e=dan%2Bfilter%40example.com');
    expect(url).toMatch(/&t=[a-f0-9]{32}$/);
  });
});

// ---- Runtime endpoint tests -------------------------------------------------

vi.mock('../../platform/email/SupportEmailSuppression', () => {
  const addSupportEmailUnsubscribeMock = vi.fn().mockResolvedValue(undefined);
  return {
    __addSupportEmailUnsubscribeMock: addSupportEmailUnsubscribeMock,
    addSupportEmailUnsubscribe: addSupportEmailUnsubscribeMock,
    // The router also pulls these in for the send-side gating that
    // already exists; tests don't exercise them, so noop stubs are fine.
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

describe('POST/GET /support/unsubscribe — runtime behaviour', () => {
  const ORIGINAL_SECRET = process.env.SUPPORT_UNSUBSCRIBE_SECRET;
  const ORIGINAL_BASE = process.env.SUPPORT_PUBLIC_BASE_URL;

  // Each test imports its own freshly-evaluated router so the mocks we
  // install above bind cleanly. The token helper reads the secret on each
  // mint, so we don't need to reset its module.
  let app: express.Express;
  let addSupportEmailUnsubscribeMock: ReturnType<typeof vi.fn>;
  let mintToken: (email: string) => string;

  beforeEach(async () => {
    process.env.SUPPORT_UNSUBSCRIBE_SECRET = 'endpoint-test-secret';
    process.env.SUPPORT_PUBLIC_BASE_URL = 'https://app.qvo.ai';
    vi.resetModules();

    const router = (await import('../../server/admin-api/routes/support')).default;
    const tokenMod = await import('../../platform/email/supportUnsubscribeToken');
    mintToken = tokenMod.buildSupportUnsubscribeToken;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    addSupportEmailUnsubscribeMock = ((await import(
      '../../platform/email/SupportEmailSuppression',
    )) as any).__addSupportEmailUnsubscribeMock;
    addSupportEmailUnsubscribeMock.mockClear();

    app = express();
    app.use(express.json());
    app.use(router);
  });

  afterEach(() => {
    if (ORIGINAL_SECRET === undefined) delete process.env.SUPPORT_UNSUBSCRIBE_SECRET;
    else process.env.SUPPORT_UNSUBSCRIBE_SECRET = ORIGINAL_SECRET;
    if (ORIGINAL_BASE === undefined) delete process.env.SUPPORT_PUBLIC_BASE_URL;
    else process.env.SUPPORT_PUBLIC_BASE_URL = ORIGINAL_BASE;
  });

  it('GET with valid token records the unsubscribe and renders the landing page', async () => {
    const email = 'frank@example.com';
    const t = mintToken(email);
    const r = await request(app).get('/support/unsubscribe').query({ e: email, t });
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toMatch(/html/);
    expect(r.text).toMatch(/unsubscribed/i);
    // The address rendered into the HTML is the supplied form, but the
    // sink is called with the same value (the helper itself lowercases
    // before insert). We only assert the call happened with the address
    // — case-handling is the helper's responsibility.
    expect(addSupportEmailUnsubscribeMock).toHaveBeenCalledTimes(1);
    expect(addSupportEmailUnsubscribeMock).toHaveBeenCalledWith(
      email,
      'landing_page',
    );
  });

  it('POST with valid token (one-click) returns 200 with empty body and tags source as one_click_post', async () => {
    const email = 'gina@example.com';
    const t = mintToken(email);
    const r = await request(app)
      .post('/support/unsubscribe')
      .query({ e: email, t })
      // RFC 8058 body — providers send this as form-encoded.
      .set('content-type', 'application/x-www-form-urlencoded')
      .send('List-Unsubscribe=One-Click');
    expect(r.status).toBe(200);
    expect(r.text).toBe('');
    expect(addSupportEmailUnsubscribeMock).toHaveBeenCalledWith(
      email,
      'one_click_post',
    );
  });

  it('rejects POST with a tampered token without writing to the sink', async () => {
    const email = 'henry@example.com';
    const t = mintToken(email);
    const tampered = t.slice(0, -1) + (t.endsWith('a') ? 'b' : 'a');
    const r = await request(app)
      .post('/support/unsubscribe')
      .query({ e: email, t: tampered })
      .set('content-type', 'application/x-www-form-urlencoded')
      .send('List-Unsubscribe=One-Click');
    expect(r.status).toBe(400);
    expect(addSupportEmailUnsubscribeMock).not.toHaveBeenCalled();
  });

  it('rejects GET when the address has been swapped (token replay)', async () => {
    const realEmail = 'iris@example.com';
    const t = mintToken(realEmail);
    const r = await request(app)
      .get('/support/unsubscribe')
      .query({ e: 'attacker@example.com', t });
    expect(r.status).toBe(400);
    expect(r.text).toMatch(/invalid/i);
    expect(addSupportEmailUnsubscribeMock).not.toHaveBeenCalled();
  });

  it('rejects requests missing either the email or the token', async () => {
    const t = mintToken('jack@example.com');
    const r1 = await request(app).get('/support/unsubscribe').query({ t });
    const r2 = await request(app).get('/support/unsubscribe').query({ e: 'jack@example.com' });
    const r3 = await request(app).get('/support/unsubscribe');
    for (const r of [r1, r2, r3]) {
      expect(r.status).toBe(400);
    }
    expect(addSupportEmailUnsubscribeMock).not.toHaveBeenCalled();
  });

  it('repeat hits are idempotent — the sink may be called once per click but the helper upserts', async () => {
    // The handler always defers idempotency to the SQL upsert in
    // addSupportEmailUnsubscribe (ON CONFLICT DO UPDATE). We assert the
    // contract by hitting the endpoint twice and confirming neither call
    // surfaces an error to the client.
    const email = 'kim@example.com';
    const t = mintToken(email);
    const r1 = await request(app).get('/support/unsubscribe').query({ e: email, t });
    const r2 = await request(app).get('/support/unsubscribe').query({ e: email, t });
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(addSupportEmailUnsubscribeMock).toHaveBeenCalledTimes(2);
  });
});
