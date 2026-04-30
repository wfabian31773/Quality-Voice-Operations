import { describe, it, expect, beforeEach, vi } from 'vitest';
import express, {
  type Request,
  type Response,
  type NextFunction,
} from 'express';
import request from 'supertest';

import {
  parseEmailDeliveryWebhookPayload,
  normaliseMessageId,
} from '../../platform/email/deliveryWebhookParser';

const queryMock = vi.fn();

vi.mock('../../platform/db', () => ({
  getPlatformPool: () => ({ query: queryMock }),
  withPrivilegedClient: vi.fn(),
}));

vi.mock('../../platform/integrations/connectors', () => ({
  listConnectorConfigs: vi.fn(),
  upsertConnector: vi.fn(),
  deleteConnector: vi.fn(),
  getConnectorById: vi.fn(),
  getConnectorConfig: vi.fn(),
  connectorService: {},
}));
vi.mock('../../platform/integrations/connectors/adapters/salesforce', () => ({
  fetchSalesforceTaskPicklists: vi.fn(),
}));
vi.mock('../../platform/integrations/connectors/adapters/hubspot', () => ({
  fetchHubSpotDealPipelines: vi.fn(),
}));
vi.mock('../../platform/integrations/connectors/adapters/pipedrive', () => ({
  fetchPipedrivePipelinesAndStages: vi.fn(),
}));
vi.mock('../../platform/integrations/connectors/adapters/google-calendar', () => ({
  fetchGoogleCalendarList: vi.fn(),
}));
vi.mock('../../platform/integrations/connectors/adapters/outlook-calendar', () => ({
  fetchOutlookCalendarList: vi.fn(),
}));
vi.mock('../../platform/integrations/connectors/zohoRegion', () => ({
  resolveZohoApiDomain: vi.fn(),
  resolveZohoAccountsServer: vi.fn(),
}));
vi.mock('../../platform/audit/AuditService', () => ({
  writeAuditLog: vi.fn(),
  extractIp: () => '127.0.0.1',
}));
vi.mock('../../server/admin-api/middleware/rbac', () => ({
  requireRole: () =>
    (_req: Request, _res: Response, next: NextFunction) => next(),
}));
vi.mock('../../server/admin-api/middleware/auth', () => ({
  requireAuth: (_req: Request, _res: Response, next: NextFunction) => next(),
}));

beforeEach(() => {
  queryMock.mockReset();
  delete process.env.CONNECTOR_EMAIL_WEBHOOK_SECRET;
  delete process.env.APP_ENV;
  process.env.NODE_ENV = 'test';
  // The route file captures CONNECTOR_EMAIL_WEBHOOK_SECRET into a const
  // at module load — reset the module registry so each test gets a
  // fresh import that reads the env var we just set.
  vi.resetModules();
});

async function buildApp(): Promise<express.Express> {
  const app = express();
  app.use(express.json());
  const router = (await import('../../server/admin-api/routes/connectors')).default;
  app.use(router);
  return app;
}

// Replays the route's atomic-UPDATE flow against an in-memory store
// keyed by Message-ID. The route now does a single conditional UPDATE
// (precedence is in the WHERE clause to avoid SELECT/UPDATE races),
// then a probe SELECT only when rowCount=0 to disambiguate
// "unmatched" vs "skipped by precedence". The mock evaluates the same
// precedence rules and reports rowCount + delivery_error semantics so
// tests assert end-to-end behaviour, not SQL strings.
const ADVERSE = new Set(['bounced', 'spam', 'dropped']);
function installRecipientStore(
  initial: Record<
    string,
    {
      id: number;
      email_provider_event: string | null;
      delivery_status: string;
      delivery_error?: string | null;
    }
  >,
): {
  rows: typeof initial;
  updates: Array<{ id: number; sql: string; params: unknown[] }>;
} {
  const rows = { ...initial };
  const updates: Array<{ id: number; sql: string; params: unknown[] }> = [];
  queryMock.mockImplementation(async (sql: string, params: unknown[]) => {
    const text = String(sql);
    if (text.startsWith('UPDATE connector_alert_recipients')) {
      const messageId = String(params[0]);
      const newStatus = params[1] as string;
      const newDeliveryStatus = params[2] as string | null;
      const newError = params[3] as string | null;
      const row = rows[messageId];
      if (!row) return { rowCount: 0, rows: [] };
      const current = row.email_provider_event;
      const allowed =
        current === null ||
        current === 'deferred' ||
        (current === 'delivered' && ADVERSE.has(newStatus));
      if (!allowed) return { rowCount: 0, rows: [] };
      updates.push({ id: row.id, sql: text, params });
      const nextDeliveryError = ADVERSE.has(newStatus)
        ? (row.delivery_error ?? newError ?? null)
        : (row.delivery_error ?? null);
      rows[messageId] = {
        ...row,
        email_provider_event: newStatus,
        delivery_status: newDeliveryStatus ?? row.delivery_status,
        delivery_error: nextDeliveryError,
      };
      return { rowCount: 1, rows: [] };
    }
    if (text.includes('SELECT id') && text.includes('connector_alert_recipients')) {
      const messageId = String(params[0]);
      const row = rows[messageId];
      return { rows: row ? [{ id: row.id }] : [] };
    }
    return { rows: [] };
  });
  return { rows, updates };
}

describe('POST /connectors/email-status — auth and validation', () => {
  it('rejects when APP_ENV=production and CONNECTOR_EMAIL_WEBHOOK_SECRET is unset', async () => {
    // Auth must key off APP_ENV via isProductionLike(), not NODE_ENV —
    // a deployment with APP_ENV=production but NODE_ENV unset must still
    // fail closed when no shared secret is configured.
    process.env.APP_ENV = 'production';
    delete process.env.NODE_ENV;
    const app = await buildApp();
    const res = await request(app)
      .post('/connectors/email-status')
      .send({ Type: 'Notification' });
    expect(res.status).toBe(401);
  });

  it('rejects when APP_ENV=staging and CONNECTOR_EMAIL_WEBHOOK_SECRET is unset', async () => {
    process.env.APP_ENV = 'staging';
    delete process.env.NODE_ENV;
    const app = await buildApp();
    const res = await request(app)
      .post('/connectors/email-status')
      .send({ Type: 'Notification' });
    expect(res.status).toBe(401);
  });

  it('rejects when the secret is configured but a wrong one is supplied', async () => {
    process.env.CONNECTOR_EMAIL_WEBHOOK_SECRET = 'right';
    const app = await buildApp();
    const res = await request(app)
      .post('/connectors/email-status')
      .set('X-Webhook-Secret', 'wrong')
      .send([{ event: 'delivered', email: 'a@x.test', 'smtp-id': 'm-1' }]);
    expect(res.status).toBe(401);
  });

  it('accepts the secret via header', async () => {
    process.env.CONNECTOR_EMAIL_WEBHOOK_SECRET = 'right';
    installRecipientStore({});
    const app = await buildApp();
    const res = await request(app)
      .post('/connectors/email-status')
      .set('X-Webhook-Secret', 'right')
      .send([{ event: 'delivered', email: 'a@x.test', 'smtp-id': 'm-1' }]);
    expect(res.status).toBe(200);
  });

  it('accepts the secret via ?secret= query', async () => {
    process.env.CONNECTOR_EMAIL_WEBHOOK_SECRET = 'right';
    installRecipientStore({});
    const app = await buildApp();
    const res = await request(app)
      .post('/connectors/email-status?secret=right')
      .send([{ event: 'delivered', email: 'a@x.test', 'smtp-id': 'm-1' }]);
    expect(res.status).toBe(200);
  });

  it('accepts an SNS text/plain Notification body and parses it via express.text()', async () => {
    const store = installRecipientStore({
      'sns-1': { id: 42, email_provider_event: null, delivery_status: 'sent' },
    });
    const sns = {
      Type: 'Notification',
      Message: JSON.stringify({
        notificationType: 'Delivery',
        mail: { messageId: 'sns-1', destination: ['ada@acme.test'] },
        delivery: { recipients: ['ada@acme.test'] },
      }),
    };
    const app = await buildApp();
    const res = await request(app)
      .post('/connectors/email-status')
      .set('Content-Type', 'text/plain')
      .send(JSON.stringify(sns));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ processed: 1 });
    expect(store.rows['sns-1'].email_provider_event).toBe('delivered');
  });

  it('200s the SNS subscription handshake without writing anything', async () => {
    installRecipientStore({});
    const app = await buildApp();
    const res = await request(app)
      .post('/connectors/email-status')
      .set('Content-Type', 'text/plain')
      .send(
        JSON.stringify({
          Type: 'SubscriptionConfirmation',
          SubscribeURL: 'https://evil.example/abuse',
          TopicArn: 'arn:aws:sns:us-east-1:123:topic',
        }),
      );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ confirmed: true });
    expect(queryMock).not.toHaveBeenCalled();
  });
});

describe('POST /connectors/email-status — recipient row updates', () => {
  it('updates the matching recipient row to delivered (SendGrid event)', async () => {
    const store = installRecipientStore({
      'sg-1@acme.test': {
        id: 100,
        email_provider_event: null,
        delivery_status: 'sent',
      },
    });
    const app = await buildApp();
    const res = await request(app)
      .post('/connectors/email-status')
      .send([
        { event: 'delivered', email: 'ada@acme.test', 'smtp-id': '<sg-1@acme.test>' },
      ]);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ processed: 1, unmatched: 0 });
    expect(store.rows['sg-1@acme.test']).toMatchObject({
      email_provider_event: 'delivered',
      delivery_status: 'sent',
    });
  });

  it('flips delivery_status to failed and records delivery_error on a Postmark hard bounce', async () => {
    const store = installRecipientStore({
      'pm-1': { id: 101, email_provider_event: null, delivery_status: 'sent' },
    });
    const app = await buildApp();
    const res = await request(app)
      .post('/connectors/email-status')
      .send({
        RecordType: 'Bounce',
        Email: 'ada@acme.test',
        MessageID: 'pm-1',
        Type: 'HardBounce',
        Description: '550 mailbox does not exist',
      });
    expect(res.status).toBe(200);
    expect(res.body.processed).toBe(1);
    expect(store.rows['pm-1']).toMatchObject({
      email_provider_event: 'bounced',
      delivery_status: 'failed',
    });
    // The 4-arg UPDATE form (with delivery_error) was used.
    expect(store.updates[0].params).toContain('550 mailbox does not exist');
  });

  it('records spam complaint as failed (SES Complaint)', async () => {
    const store = installRecipientStore({
      'ses-spam': { id: 102, email_provider_event: null, delivery_status: 'sent' },
    });
    const app = await buildApp();
    const res = await request(app)
      .post('/connectors/email-status')
      .send({
        notificationType: 'Complaint',
        mail: { messageId: 'ses-spam' },
        complaint: {
          complainedRecipients: [{ emailAddress: 'angry@acme.test' }],
          complaintFeedbackType: 'abuse',
        },
      });
    expect(res.status).toBe(200);
    expect(store.rows['ses-spam']).toMatchObject({
      email_provider_event: 'spam',
      delivery_status: 'failed',
    });
  });

  it('skips events that do not carry a Message-ID (no recipient-email fallback)', async () => {
    const store = installRecipientStore({
      'never-touched': { id: 103, email_provider_event: null, delivery_status: 'sent' },
    });
    const app = await buildApp();
    const res = await request(app)
      .post('/connectors/email-status')
      .send([{ event: 'delivered', email: 'ada@acme.test' }]);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ processed: 0, unmatched: 1 });
    expect(store.updates).toHaveLength(0);
    expect(store.rows['never-touched'].email_provider_event).toBeNull();
  });

  it('reports unmatched (not 500) when the Message-ID is unknown', async () => {
    installRecipientStore({});
    const app = await buildApp();
    const res = await request(app)
      .post('/connectors/email-status')
      .send([{ event: 'delivered', email: 'ada@acme.test', 'smtp-id': 'mystery-id' }]);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ processed: 0, unmatched: 1 });
  });

  it('202s with processed=0 for unrecognised payload shapes', async () => {
    installRecipientStore({});
    const app = await buildApp();
    const res = await request(app)
      .post('/connectors/email-status')
      .send({ totally: 'foreign' });
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ processed: 0 });
  });
});

describe('POST /connectors/email-status — event precedence', () => {
  it('escalates a delivered row to spam when a complaint arrives later', async () => {
    const store = installRecipientStore({
      'esc-spam': {
        id: 200,
        email_provider_event: 'delivered',
        delivery_status: 'sent',
      },
    });
    const app = await buildApp();
    const res = await request(app)
      .post('/connectors/email-status')
      .send({
        RecordType: 'SpamComplaint',
        Email: 'ada@acme.test',
        MessageID: 'esc-spam',
      });
    expect(res.status).toBe(200);
    expect(res.body.processed).toBe(1);
    expect(store.rows['esc-spam']).toMatchObject({
      email_provider_event: 'spam',
      delivery_status: 'failed',
    });
  });

  it('escalates a delivered row to bounced when a late hard bounce arrives', async () => {
    const store = installRecipientStore({
      'esc-bounce': {
        id: 201,
        email_provider_event: 'delivered',
        delivery_status: 'sent',
      },
    });
    const app = await buildApp();
    const res = await request(app)
      .post('/connectors/email-status')
      .send({
        notificationType: 'Bounce',
        mail: { messageId: 'esc-bounce' },
        bounce: {
          bounceType: 'Permanent',
          bouncedRecipients: [
            { emailAddress: 'ada@acme.test', diagnosticCode: '550 nope' },
          ],
        },
      });
    expect(res.status).toBe(200);
    expect(store.rows['esc-bounce'].email_provider_event).toBe('bounced');
  });

  it('refuses to overwrite an adverse terminal with a later delivered (preserves the bad outcome)', async () => {
    const store = installRecipientStore({
      'locked-bounce': {
        id: 202,
        email_provider_event: 'bounced',
        delivery_status: 'failed',
      },
    });
    const app = await buildApp();
    const res = await request(app)
      .post('/connectors/email-status')
      .send([
        {
          event: 'delivered',
          email: 'ada@acme.test',
          'smtp-id': 'locked-bounce',
        },
      ]);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ processed: 0, skippedTerminal: 1 });
    expect(store.rows['locked-bounce']).toMatchObject({
      email_provider_event: 'bounced',
      delivery_status: 'failed',
    });
  });

  it('refuses to overwrite an adverse terminal with another adverse terminal (first hard failure wins)', async () => {
    const store = installRecipientStore({
      'locked-spam': {
        id: 203,
        email_provider_event: 'spam',
        delivery_status: 'failed',
      },
    });
    const app = await buildApp();
    const res = await request(app)
      .post('/connectors/email-status')
      .send({
        notificationType: 'Bounce',
        mail: { messageId: 'locked-spam' },
        bounce: {
          bounceType: 'Permanent',
          bouncedRecipients: [{ emailAddress: 'ada@acme.test' }],
        },
      });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ skippedTerminal: 1 });
    expect(store.rows['locked-spam'].email_provider_event).toBe('spam');
  });

  it('drops a deferred event when the row already has any terminal state', async () => {
    const store = installRecipientStore({
      'def-drop': {
        id: 204,
        email_provider_event: 'delivered',
        delivery_status: 'sent',
      },
    });
    const app = await buildApp();
    const res = await request(app)
      .post('/connectors/email-status')
      .send([
        { event: 'deferred', email: 'ada@acme.test', 'smtp-id': 'def-drop' },
      ]);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ skippedTerminal: 1 });
    expect(store.rows['def-drop'].email_provider_event).toBe('delivered');
  });
});

describe('parseEmailDeliveryWebhookPayload', () => {
  it('returns [] for unknown shapes', () => {
    expect(parseEmailDeliveryWebhookPayload(null)).toEqual([]);
    expect(parseEmailDeliveryWebhookPayload('hi')).toEqual([]);
    expect(parseEmailDeliveryWebhookPayload({ random: 'shape' })).toEqual([]);
  });

  it('parses an SES Delivery notification (SNS-wrapped)', () => {
    const inner = {
      notificationType: 'Delivery',
      mail: {
        messageId: '<abc-123@email.amazonses.com>',
        destination: ['ada@acme.test'],
      },
      delivery: { recipients: ['Ada@Acme.test'] },
    };
    const sns = { Type: 'Notification', Message: JSON.stringify(inner) };
    const events = parseEmailDeliveryWebhookPayload(sns);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      provider: 'ses',
      status: 'delivered',
      recipientEmail: 'ada@acme.test',
      messageId: 'abc-123@email.amazonses.com',
    });
  });

  it('parses an SES permanent Bounce as bounced and skips transient ones', () => {
    const permanent = parseEmailDeliveryWebhookPayload({
      notificationType: 'Bounce',
      mail: { messageId: 'm1' },
      bounce: {
        bounceType: 'Permanent',
        bouncedRecipients: [{ emailAddress: 'who@nowhere.test', diagnosticCode: '550 nope' }],
      },
    });
    expect(permanent).toHaveLength(1);
    expect(permanent[0]).toMatchObject({
      status: 'bounced',
      recipientEmail: 'who@nowhere.test',
      error: '550 nope',
    });

    const transient = parseEmailDeliveryWebhookPayload({
      notificationType: 'Bounce',
      mail: { messageId: 'm2' },
      bounce: {
        bounceType: 'Transient',
        bouncedRecipients: [{ emailAddress: 'who@nowhere.test' }],
      },
    });
    expect(transient).toEqual([]);
  });

  it('parses SES Complaint as spam', () => {
    const events = parseEmailDeliveryWebhookPayload({
      notificationType: 'Complaint',
      mail: { messageId: 'm3' },
      complaint: {
        complainedRecipients: [{ emailAddress: 'angry@acme.test' }],
        complaintFeedbackType: 'abuse',
      },
    });
    expect(events).toEqual([
      expect.objectContaining({
        provider: 'ses',
        status: 'spam',
        recipientEmail: 'angry@acme.test',
        error: 'abuse',
      }),
    ]);
  });

  it('parses Postmark Delivery / hard Bounce / SpamComplaint and ignores soft bounces', () => {
    expect(
      parseEmailDeliveryWebhookPayload({
        RecordType: 'Delivery',
        Email: 'ada@acme.test',
        MessageID: 'pm-1',
      }),
    ).toEqual([
      expect.objectContaining({ provider: 'postmark', status: 'delivered', messageId: 'pm-1' }),
    ]);

    expect(
      parseEmailDeliveryWebhookPayload({
        RecordType: 'Bounce',
        Email: 'ada@acme.test',
        MessageID: 'pm-2',
        Type: 'HardBounce',
        Description: 'mailbox does not exist',
      }),
    ).toEqual([
      expect.objectContaining({
        provider: 'postmark',
        status: 'bounced',
        error: 'mailbox does not exist',
      }),
    ]);

    expect(
      parseEmailDeliveryWebhookPayload({
        RecordType: 'Bounce',
        Email: 'ada@acme.test',
        Type: 'SoftBounce',
      }),
    ).toEqual([]);

    expect(
      parseEmailDeliveryWebhookPayload({
        RecordType: 'SpamComplaint',
        Email: 'ada@acme.test',
        MessageID: 'pm-3',
      }),
    ).toEqual([
      expect.objectContaining({ provider: 'postmark', status: 'spam' }),
    ]);
  });

  it('parses a SendGrid event-array', () => {
    const events = parseEmailDeliveryWebhookPayload([
      { event: 'delivered', email: 'a@x.test', 'smtp-id': '<sg-1@acme.test>' },
      { event: 'bounce', type: 'bounce', email: 'b@x.test', reason: '550' },
      { event: 'spamreport', email: 'c@x.test' },
      { event: 'deferred', email: 'd@x.test', response: 'try later' },
      { event: 'dropped', email: 'e@x.test', reason: 'Bounced Address' },
      // Sender-side reason — must not flip the recipient row to dropped.
      { event: 'dropped', email: 'f@x.test', reason: 'Recipient List over Package Quota' },
    ]);
    expect(events.map((e) => [e.recipientEmail, e.status])).toEqual([
      ['a@x.test', 'delivered'],
      ['b@x.test', 'bounced'],
      ['c@x.test', 'spam'],
      ['d@x.test', 'deferred'],
      ['e@x.test', 'dropped'],
    ]);
    expect(events[0].messageId).toBe('sg-1@acme.test');
  });

  it('parses Mailgun event-data (delivered / failed permanent / failed temporary / complained)', () => {
    const delivered = parseEmailDeliveryWebhookPayload({
      'event-data': {
        event: 'delivered',
        recipient: 'ada@acme.test',
        message: { headers: { 'message-id': '<mg-1@acme.test>' } },
      },
    });
    expect(delivered[0]).toMatchObject({
      provider: 'mailgun',
      status: 'delivered',
      recipientEmail: 'ada@acme.test',
      messageId: 'mg-1@acme.test',
    });

    const bounced = parseEmailDeliveryWebhookPayload({
      'event-data': {
        event: 'failed',
        severity: 'permanent',
        recipient: 'ada@acme.test',
        reason: '550 no such user',
      },
    });
    expect(bounced[0]).toMatchObject({ status: 'bounced', error: '550 no such user' });

    const deferred = parseEmailDeliveryWebhookPayload({
      'event-data': {
        event: 'failed',
        severity: 'temporary',
        recipient: 'ada@acme.test',
        reason: 'mailbox full',
      },
    });
    expect(deferred[0]).toMatchObject({ status: 'deferred' });

    const complained = parseEmailDeliveryWebhookPayload({
      'event-data': { event: 'complained', recipient: 'ada@acme.test' },
    });
    expect(complained[0]).toMatchObject({ status: 'spam' });
  });
});

describe('normaliseMessageId — bracketed-id round trip', () => {
  it('produces the same canonical form for bracketed and bare ids', () => {
    expect(normaliseMessageId('<abc-123@host.test>')).toBe('abc-123@host.test');
    expect(normaliseMessageId('abc-123@host.test')).toBe('abc-123@host.test');
    expect(normaliseMessageId('  <abc-123@host.test>  ')).toBe('abc-123@host.test');
  });

  it('returns null for empty or non-string inputs', () => {
    expect(normaliseMessageId(null)).toBeNull();
    expect(normaliseMessageId(undefined)).toBeNull();
    expect(normaliseMessageId('')).toBeNull();
    expect(normaliseMessageId('   ')).toBeNull();
    expect(normaliseMessageId(42)).toBeNull();
  });

  it('a stored bracketed nodemailer id matches a webhook-reported bracketed id', () => {
    // SyncErrorAlerter stores normaliseMessageId(result.messageId), so a
    // nodemailer `<x@y>` becomes `x@y` on disk. The webhook parser also
    // strips brackets, so the two values agree.
    const stored = normaliseMessageId('<abc-123@host.test>');
    const events = parseEmailDeliveryWebhookPayload([
      {
        event: 'delivered',
        email: 'ada@acme.test',
        'smtp-id': '<abc-123@host.test>',
      },
    ]);
    expect(stored).not.toBeNull();
    expect(events[0]?.messageId).toBe(stored);
  });

  it('a stored bracketed nodemailer id matches an SES-reported bracketless id', () => {
    const stored = normaliseMessageId('<abc-123@email.amazonses.com>');
    const events = parseEmailDeliveryWebhookPayload({
      Type: 'Notification',
      Message: JSON.stringify({
        notificationType: 'Delivery',
        mail: {
          messageId: 'abc-123@email.amazonses.com',
          destination: ['ada@acme.test'],
        },
        delivery: { recipients: ['ada@acme.test'] },
      }),
    });
    expect(events[0]?.messageId).toBe(stored);
  });

  it('end-to-end: store bracketed id, post bracketed webhook event, row updates', async () => {
    // Full round trip: simulate an alerter that stored the canonical
    // form of `<bracketed@id>` and verify the webhook actually matches
    // when the provider reports the same id with brackets.
    const stored = normaliseMessageId('<round-trip@nodemailer.test>') as string;
    const store = installRecipientStore({
      [stored]: {
        id: 999,
        email_provider_event: null,
        delivery_status: 'sent',
      },
    });
    const app = await buildApp();
    const res = await request(app)
      .post('/connectors/email-status')
      .send([
        {
          event: 'delivered',
          email: 'ada@acme.test',
          'smtp-id': '<round-trip@nodemailer.test>',
        },
      ]);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ processed: 1, unmatched: 0 });
    expect(store.rows[stored].email_provider_event).toBe('delivered');
  });
});
