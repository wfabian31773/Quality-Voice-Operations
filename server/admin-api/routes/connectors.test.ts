import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const a = vi.hoisted(() => ({
  user: { userId: 'u1', tenantId: 't1', email: 'e@x.com', role: 'operations_manager', isPlatformAdmin: false },
  listConnectorConfigsMock: vi.fn(),
  upsertConnectorMock: vi.fn(),
  deleteConnectorMock: vi.fn(),
  getConnectorByIdMock: vi.fn(),
  getConnectorConfigMock: vi.fn(),
  writeAuditLogMock: vi.fn(),
  fetchSalesforceTaskPicklistsMock: vi.fn(),
  fetchHubSpotDealPipelinesMock: vi.fn(),
  fetchPipedrivePipelinesAndStagesMock: vi.fn(),
  fetchGoogleCalendarListMock: vi.fn(),
  fetchOutlookCalendarListMock: vi.fn(),
  recordActivationEventMock: vi.fn(),
}));

vi.mock('../middleware/auth', () => ({
  requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    req.user = a.user as never;
    next();
  },
}));
vi.mock('../../../platform/integrations/connectors', () => ({
  listConnectorConfigs: a.listConnectorConfigsMock,
  upsertConnector: a.upsertConnectorMock,
  deleteConnector: a.deleteConnectorMock,
  getConnectorById: a.getConnectorByIdMock,
  getConnectorConfig: a.getConnectorConfigMock,
  connectorService: {},
}));
vi.mock('../middleware/security', () => ({ isProductionLike: () => false }));
vi.mock('../../../platform/audit/AuditService', () => ({ writeAuditLog: a.writeAuditLogMock, extractIp: () => '127.0.0.1' }));
vi.mock('../../../platform/integrations/connectors/adapters/salesforce', () => ({ fetchSalesforceTaskPicklists: a.fetchSalesforceTaskPicklistsMock }));
vi.mock('../../../platform/integrations/connectors/adapters/hubspot', () => ({ fetchHubSpotDealPipelines: a.fetchHubSpotDealPipelinesMock }));
vi.mock('../../../platform/integrations/connectors/adapters/pipedrive', () => ({ fetchPipedrivePipelinesAndStages: a.fetchPipedrivePipelinesAndStagesMock }));
vi.mock('../../../platform/integrations/connectors/adapters/google-calendar', () => ({ fetchGoogleCalendarList: a.fetchGoogleCalendarListMock }));
vi.mock('../../../platform/integrations/connectors/adapters/outlook-calendar', () => ({ fetchOutlookCalendarList: a.fetchOutlookCalendarListMock }));
vi.mock('../../../platform/integrations/connectors/zohoRegion', () => ({
  resolveZohoApiDomain: (v: string) => (v === 'bad' ? null : 'https://www.zohoapis.com'),
  resolveZohoAccountsServer: () => 'https://accounts.zoho.com',
}));
vi.mock('../../../platform/activation/ActivationService', () => ({ recordActivationEvent: a.recordActivationEventMock }));

import router from './connectors';

function app() {
  const app = express();
  app.use(express.json());
  app.use(router);
  return app;
}

beforeEach(() => {
  a.user.role = 'operations_manager';
  a.listConnectorConfigsMock.mockReset().mockResolvedValue([]);
  a.upsertConnectorMock.mockReset().mockResolvedValue('int-1');
  a.deleteConnectorMock.mockReset().mockResolvedValue(undefined);
  a.getConnectorByIdMock.mockReset();
  a.getConnectorConfigMock.mockReset().mockResolvedValue({ credentials: {} });
  a.writeAuditLogMock.mockReset();
  a.fetchSalesforceTaskPicklistsMock.mockReset();
  a.fetchHubSpotDealPipelinesMock.mockReset();
  a.fetchPipedrivePipelinesAndStagesMock.mockReset();
  a.fetchGoogleCalendarListMock.mockReset();
  a.fetchOutlookCalendarListMock.mockReset();
  a.recordActivationEventMock.mockReset().mockResolvedValue(undefined);
});

describe('GET /connectors', () => {
  it('lists + paginates', async () => {
    a.listConnectorConfigsMock.mockResolvedValue([{ id: 'c1' }, { id: 'c2' }]);
    const res = await request(app()).get('/connectors?limit=1');
    expect(res.body).toMatchObject({ total: 2, limit: 1 });
    expect(res.body.connectors).toHaveLength(1);
  });
  it('500 on failure', async () => {
    a.listConnectorConfigsMock.mockRejectedValue(new Error('boom'));
    expect((await request(app()).get('/connectors')).status).toBe(500);
  });
});

describe('POST /connectors', () => {
  it('requires the core fields', async () => {
    expect((await request(app()).post('/connectors').send({ provider: 'twilio' })).status).toBe(400);
  });
  it('rejects an invalid connectorType', async () => {
    const res = await request(app()).post('/connectors').send({ connectorType: 'bogus', provider: 'p', name: 'n', credentials: {} });
    expect(res.status).toBe(400);
  });
  it('rejects bad zoho api_domain credentials', async () => {
    const res = await request(app()).post('/connectors').send({ connectorType: 'crm', provider: 'zoho', name: 'n', credentials: { api_domain: 'bad' } });
    expect(res.status).toBe(400);
  });
  it('rejects a viewer via rbac', async () => {
    a.user.role = 'support_reviewer';
    expect((await request(app()).post('/connectors').send({ connectorType: 'crm', provider: 'p', name: 'n', credentials: {} })).status).toBe(403);
  });
  it('creates a connector + audit', async () => {
    const res = await request(app()).post('/connectors').send({ connectorType: 'crm', provider: 'hubspot', name: 'HS', credentials: { token: 'x' } });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ integrationId: 'int-1' });
    expect(a.writeAuditLogMock).toHaveBeenCalledWith(expect.objectContaining({ action: 'connector.created' }));
  });
});

describe('PATCH /connectors/:id', () => {
  it('404 when the connector is missing', async () => {
    a.getConnectorByIdMock.mockResolvedValue(null);
    expect((await request(app()).patch('/connectors/int-1').send({ name: 'New' })).status).toBe(404);
  });
  it('updates an existing connector', async () => {
    a.getConnectorByIdMock.mockResolvedValue({ connectorType: 'crm', provider: 'hubspot', name: 'HS', isEnabled: true });
    const res = await request(app()).patch('/connectors/int-1').send({ name: 'New', isEnabled: false });
    expect(res.body).toEqual({ updated: true });
    expect(a.upsertConnectorMock).toHaveBeenCalled();
  });
});

describe('GET /connectors/:id/settings', () => {
  it('404 when missing', async () => {
    a.getConnectorByIdMock.mockResolvedValue(null);
    expect((await request(app()).get('/connectors/int-1/settings')).status).toBe(404);
  });
  it('parses salesforce disposition/lead maps (incl. invalid JSON)', async () => {
    a.getConnectorByIdMock.mockResolvedValue({ connectorType: 'crm', provider: 'salesforce' });
    a.getConnectorConfigMock.mockResolvedValue({ credentials: { disposition_map: '{"a":1}', lead_status_map: 'not-json' } });
    const res = await request(app()).get('/connectors/int-1/settings');
    expect(res.body.settings.dispositionMap).toEqual({ a: 1 });
    expect(res.body.settings.leadStatusMapError).toBeTruthy();
  });
  it('resolves hubspot pipeline labels', async () => {
    a.getConnectorByIdMock.mockResolvedValue({ connectorType: 'crm', provider: 'hubspot' });
    a.getConnectorConfigMock.mockResolvedValue({ credentials: { appointment_pipeline_id: 'p1', appointment_stage_id: 's1' } });
    a.fetchHubSpotDealPipelinesMock.mockResolvedValue([{ id: 'p1', label: 'Sales', stages: [{ id: 's1', label: 'Booked' }] }]);
    const res = await request(app()).get('/connectors/int-1/settings');
    expect(res.body.settings).toMatchObject({ appointmentPipelineLabel: 'Sales', appointmentStageLabel: 'Booked' });
  });
});

describe('provider wrapper routes', () => {
  it('salesforce picklists (success)', async () => {
    a.getConnectorByIdMock.mockResolvedValue({ connectorType: 'crm', provider: 'salesforce' });
    a.fetchSalesforceTaskPicklistsMock.mockResolvedValue({ status: ['Open'] });
    expect((await request(app()).get('/connectors/int-1/salesforce/picklists')).body).toEqual({ status: ['Open'] });
  });
  it('salesforce picklists rejects wrong provider', async () => {
    a.getConnectorByIdMock.mockResolvedValue({ connectorType: 'crm', provider: 'hubspot' });
    expect((await request(app()).get('/connectors/int-1/salesforce/picklists')).status).toBe(400);
  });
  it('hubspot pipelines (502 on adapter error)', async () => {
    a.getConnectorByIdMock.mockResolvedValue({ connectorType: 'crm', provider: 'hubspot' });
    a.fetchHubSpotDealPipelinesMock.mockRejectedValue(new Error('api down'));
    expect((await request(app()).get('/connectors/int-1/hubspot/pipelines')).status).toBe(502);
  });
  it('pipedrive pipelines (success)', async () => {
    a.getConnectorByIdMock.mockResolvedValue({ connectorType: 'crm', provider: 'pipedrive' });
    a.fetchPipedrivePipelinesAndStagesMock.mockResolvedValue([{ id: 1, name: 'P' }]);
    expect((await request(app()).get('/connectors/int-1/pipedrive/pipelines')).body.pipelines).toHaveLength(1);
  });
  it('google calendars (sorted, primary first)', async () => {
    a.getConnectorByIdMock.mockResolvedValue({ connectorType: 'scheduling', provider: 'google-calendar' });
    a.fetchGoogleCalendarListMock.mockResolvedValue([{ id: 'b', name: 'B', primary: false }, { id: 'a', name: 'A', primary: true }]);
    const res = await request(app()).get('/connectors/int-1/google-calendar/calendars');
    expect(res.body.calendars[0].id).toBe('a');
  });
  it('outlook calendars 404 when connector missing', async () => {
    a.getConnectorByIdMock.mockResolvedValue(null);
    expect((await request(app()).get('/connectors/int-1/outlook-calendar/calendars')).status).toBe(404);
  });
});

describe('DELETE /connectors/:id', () => {
  it('deletes + audit', async () => {
    const res = await request(app()).delete('/connectors/int-1');
    expect(res.body).toEqual({ deleted: true });
    expect(a.writeAuditLogMock).toHaveBeenCalledWith(expect.objectContaining({ action: 'connector.deleted' }));
  });
  it('500 on failure', async () => {
    a.deleteConnectorMock.mockRejectedValue(new Error('boom'));
    expect((await request(app()).delete('/connectors/int-1')).status).toBe(500);
  });
});
