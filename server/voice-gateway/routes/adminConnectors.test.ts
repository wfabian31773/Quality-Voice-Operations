import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const h = vi.hoisted(() => ({
  listConnectorConfigsMock: vi.fn(),
  upsertConnectorMock: vi.fn(),
  deleteConnectorMock: vi.fn(),
}));

vi.mock('../../../platform/integrations/connectors', () => ({
  listConnectorConfigs: h.listConnectorConfigsMock,
  upsertConnector: h.upsertConnectorMock,
  deleteConnector: h.deleteConnectorMock,
}));

import adminConnectorsRouter from './adminConnectors';

function app() {
  const a = express();
  a.use(express.json());
  a.use(adminConnectorsRouter);
  return a;
}

const TOKEN = 'secret-token';
const auth = (r: request.Test) => r.set('x-admin-token', TOKEN).set('x-tenant-id', 'tenant-1');

beforeEach(() => {
  h.listConnectorConfigsMock.mockReset();
  h.upsertConnectorMock.mockReset();
  h.deleteConnectorMock.mockReset();
  process.env.ADMIN_INTERNAL_TOKEN = TOKEN;
});
afterEach(() => {
  delete process.env.ADMIN_INTERNAL_TOKEN;
});

describe('admin connectors auth', () => {
  it('rejects with 403 when the admin token is wrong', async () => {
    const res = await request(app()).get('/admin/connectors').set('x-admin-token', 'nope');
    expect(res.status).toBe(403);
  });

  it('rejects with 503 when no admin token is configured', async () => {
    delete process.env.ADMIN_INTERNAL_TOKEN;
    const res = await request(app()).get('/admin/connectors');
    expect(res.status).toBe(503);
  });
});

describe('GET /admin/connectors', () => {
  it('requires a tenant header', async () => {
    const res = await request(app()).get('/admin/connectors').set('x-admin-token', TOKEN);
    expect(res.status).toBe(400);
  });

  it('lists connectors for the tenant', async () => {
    h.listConnectorConfigsMock.mockResolvedValue([{ id: 'c1', provider: 'twilio' }]);
    const res = await auth(request(app()).get('/admin/connectors'));
    expect(res.status).toBe(200);
    expect(res.body.connectors).toHaveLength(1);
  });

  it('returns 500 when listing fails', async () => {
    h.listConnectorConfigsMock.mockRejectedValue(new Error('db down'));
    const res = await auth(request(app()).get('/admin/connectors'));
    expect(res.status).toBe(500);
  });
});

describe('POST /admin/connectors', () => {
  const body = { connectorType: 'sms', provider: 'twilio', name: 'Main', credentials: { sid: 'x' } };

  it('rejects missing required fields', async () => {
    const res = await auth(request(app()).post('/admin/connectors')).send({ provider: 'twilio' });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Fields required');
  });

  it('rejects an invalid connector type', async () => {
    const res = await auth(request(app()).post('/admin/connectors')).send({ ...body, connectorType: 'bogus' });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Invalid connectorType');
  });

  it('upserts a valid connector', async () => {
    h.upsertConnectorMock.mockResolvedValue('integration-9');
    const res = await auth(request(app()).post('/admin/connectors')).send(body);
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ integrationId: 'integration-9' });
  });

  it('returns 500 when the upsert fails', async () => {
    h.upsertConnectorMock.mockRejectedValue(new Error('boom'));
    const res = await auth(request(app()).post('/admin/connectors')).send(body);
    expect(res.status).toBe(500);
  });
});

describe('DELETE /admin/connectors/:id', () => {
  it('requires a tenant header', async () => {
    const res = await request(app()).delete('/admin/connectors/abc').set('x-admin-token', TOKEN);
    expect(res.status).toBe(400);
  });

  it('deletes a connector', async () => {
    h.deleteConnectorMock.mockResolvedValue(undefined);
    const res = await auth(request(app()).delete('/admin/connectors/abc'));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ deleted: true });
  });

  it('returns 500 when deletion fails', async () => {
    h.deleteConnectorMock.mockRejectedValue(new Error('boom'));
    const res = await auth(request(app()).delete('/admin/connectors/abc'));
    expect(res.status).toBe(500);
  });
});
