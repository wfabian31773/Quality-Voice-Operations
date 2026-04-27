/**
 * Unit + integration coverage for the global `auditMutation()` middleware.
 *
 * The middleware records one `audit_logs` row per non-GET tenant-scoped
 * request unless the route handler sets `req.skipAuditMutation = true`.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import express, {
  type Request,
  type Response,
  type NextFunction,
} from 'express';
import request from 'supertest';

const writeAuditLogMock = vi.fn();

vi.mock('../../platform/audit/AuditService', () => ({
  writeAuditLog: (...args: unknown[]) => writeAuditLogMock(...args),
  extractIp: () => '198.51.100.10',
}));

vi.mock('../../platform/core/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

async function buildApp(opts: {
  user?: Record<string, unknown> | null;
  attachUserBeforeMiddleware?: boolean;
} = {}): Promise<express.Express> {
  const { auditMutation } = await import('../../platform/audit/auditMutation');
  const app = express();
  app.use(express.json());

  const userFactory = (req: Request, _res: Response, next: NextFunction) => {
    if (opts.user !== undefined) {
      if (opts.user !== null) {
        req.user = opts.user as Request['user'];
      }
    } else {
      req.user = {
        userId: 'user-1',
        tenantId: 'tenant-A',
        email: 'owner@acme.test',
        role: 'tenant_owner',
        isPlatformAdmin: false,
      };
    }
    next();
  };

  if (opts.attachUserBeforeMiddleware !== false) {
    app.use(userFactory);
  }
  app.use(auditMutation());
  if (opts.attachUserBeforeMiddleware === false) {
    app.use(userFactory);
  }

  app.get('/widget/tokens', (_req, res) => {
    res.json({ tokens: [] });
  });

  app.post('/widget/tokens', (_req, res) => {
    res.status(201).json({ token: { id: 'tok-123' } });
  });

  app.delete('/widget/tokens/:id', (_req, res) => {
    res.json({ success: true });
  });

  app.post('/users/invite', (_req, res) => {
    res.status(201).json({ user: { id: 'u-1' } });
  });

  app.post('/users/skipme', (req, res) => {
    req.skipAuditMutation = true;
    res.json({ ok: true });
  });

  app.post('/v1/ingest/calls', (_req, res) => {
    res.status(422).json({ error: 'bad' });
  });

  app.post('/connectors/:id/disconnect', (_req, res) => {
    res.status(500).json({ error: 'boom' });
  });

  return app;
}

beforeEach(() => {
  writeAuditLogMock.mockReset();
});

describe('auditMutation middleware', () => {
  it('does not write an audit entry for GET requests', async () => {
    const app = await buildApp();
    await request(app).get('/widget/tokens').expect(200);
    expect(writeAuditLogMock).not.toHaveBeenCalled();
  });

  it('records an audit entry for POST /widget/tokens with sanitized body', async () => {
    const app = await buildApp();
    const res = await request(app)
      .post('/widget/tokens')
      .set('User-Agent', 'qvo-test/1.0')
      .send({ label: 'Default', token: 'super-secret-value' });

    expect(res.status).toBe(201);
    expect(writeAuditLogMock).toHaveBeenCalledTimes(1);

    const event = writeAuditLogMock.mock.calls[0][0];
    expect(event.tenantId).toBe('tenant-A');
    expect(event.actorUserId).toBe('user-1');
    expect(event.actorRole).toBe('tenant_owner');
    expect(event.action).toBe('widget_tokens.post');
    expect(event.resourceType).toBe('widget');
    expect(event.severity).toBe('info');
    expect(event.ipAddress).toBe('198.51.100.10');
    expect(event.userAgent).toBe('qvo-test/1.0');
    expect(event.changes.method).toBe('POST');
    expect(event.changes.path).toBe('/widget/tokens');
    expect(event.changes.statusCode).toBe(201);
    expect(typeof event.changes.durationMs).toBe('number');
    expect(event.changes.body).toEqual({ label: 'Default', token: '[REDACTED]' });
  });

  it('captures resource id from req.params for DELETE /widget/tokens/:id', async () => {
    const app = await buildApp();
    await request(app).delete('/widget/tokens/abc-1234-5678').expect(200);

    expect(writeAuditLogMock).toHaveBeenCalledTimes(1);
    const event = writeAuditLogMock.mock.calls[0][0];
    expect(event.action).toBe('widget_tokens.delete');
    expect(event.resourceId).toBe('abc-1234-5678');
    expect(event.changes.statusCode).toBe(200);
  });

  it('redacts sensitive fields recursively in the audit changes payload', async () => {
    const app = await buildApp();
    await request(app)
      .post('/users/invite')
      .send({
        email: 'new@acme.test',
        role: 'manager',
        nested: { password: 'p4ss', api_key: 'sk_live_xyz', value: 'fine' },
      });

    const event = writeAuditLogMock.mock.calls[0][0];
    expect(event.changes.body).toEqual({
      email: 'new@acme.test',
      role: 'manager',
      nested: { password: '[REDACTED]', api_key: '[REDACTED]', value: 'fine' },
    });
  });

  it('skips writing when the route handler sets req.skipAuditMutation = true', async () => {
    const app = await buildApp();
    await request(app).post('/users/skipme').send({ foo: 'bar' }).expect(200);
    expect(writeAuditLogMock).not.toHaveBeenCalled();
  });

  it('skips writing when there is no authenticated user / tenant context', async () => {
    const app = await buildApp({ user: null });
    await request(app).post('/widget/tokens').send({}).expect(201);
    expect(writeAuditLogMock).not.toHaveBeenCalled();
  });

  it('logs failed (4xx) mutations with severity=warning by default', async () => {
    const app = await buildApp();
    await request(app).post('/v1/ingest/calls').send({ bad: true }).expect(422);

    expect(writeAuditLogMock).toHaveBeenCalledTimes(1);
    const event = writeAuditLogMock.mock.calls[0][0];
    expect(event.severity).toBe('warning');
    expect(event.changes.statusCode).toBe(422);
  });

  it('logs failed (5xx) mutations with severity=warning', async () => {
    const app = await buildApp();
    await request(app)
      .post('/connectors/conn-1/disconnect')
      .send({ reason: 'manual' })
      .expect(500);

    const event = writeAuditLogMock.mock.calls[0][0];
    expect(event.severity).toBe('warning');
    expect(event.resourceType).toBe('connectors');
    expect(event.resourceId).toBe('conn-1');
    expect(event.changes.statusCode).toBe(500);
    expect(event.changes.path).toBe('/connectors/conn-1/disconnect');
  });

  it('uses the matched route template so dynamic ids never leak into the action name', async () => {
    // Action cardinality is the key correctness property here — without
    // route templates, action names like `connectors_conn-1_disconnect.post`
    // explode the audit_logs.action search index.
    const app = await buildApp();
    await request(app)
      .post('/connectors/conn-1/disconnect')
      .send({ reason: 'manual' })
      .expect(500);
    await request(app)
      .post('/connectors/conn-2/disconnect')
      .send({ reason: 'manual' })
      .expect(500);

    expect(writeAuditLogMock).toHaveBeenCalledTimes(2);
    const actions = writeAuditLogMock.mock.calls.map(call => call[0].action);
    expect(actions[0]).toBe(actions[1]);
    expect(actions[0]).not.toContain('conn-1');
    expect(actions[0]).not.toContain('conn-2');
    expect(actions[0]).toBe('connectors_disconnect.post');
  });

  it('truncates oversized request bodies to MAX_BODY_BYTES preview', async () => {
    const app = await buildApp();
    const big = { payload: 'x'.repeat(8_000) };
    await request(app).post('/widget/tokens').send(big).expect(201);

    const event = writeAuditLogMock.mock.calls[0][0];
    // Long string values are individually truncated with an ellipsis at 500 chars.
    expect(typeof event.changes.body.payload).toBe('string');
    expect(event.changes.body.payload.length).toBeLessThan(8_000);
    expect(event.changes.body.payload.endsWith('…')).toBe(true);
  });

  it('records query-string keys when present', async () => {
    const app = await buildApp();
    await request(app).post('/widget/tokens?source=admin&password=oops').send({}).expect(201);

    const event = writeAuditLogMock.mock.calls[0][0];
    expect(event.changes.query).toEqual({ source: 'admin', password: '[REDACTED]' });
  });
});
