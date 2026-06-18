import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const names = [
  'createCampaign', 'getCampaign', 'listCampaigns', 'updateCampaign', 'deleteCampaign',
  'getCampaignMetrics', 'getTypeSpecificMetrics', 'updateContactTypeDisposition', 'addContacts',
  'listContacts', 'addToDnc', 'listDnc', 'removeFromDnc', 'getAllCampaignTypes',
  'getValidCampaignTypes', 'isValidDisposition', 'checkCampaignCompliance',
  'findDncMatchingContactIds', 'bulkMarkOptedOut',
] as const;

const a = vi.hoisted(() => ({
  user: { userId: 'u1', tenantId: 't1', email: 'e@x.com', role: 'operations_manager', isPlatformAdmin: false },
  mocks: Object.fromEntries(['createCampaign', 'getCampaign', 'listCampaigns', 'updateCampaign', 'deleteCampaign', 'getCampaignMetrics', 'getTypeSpecificMetrics', 'updateContactTypeDisposition', 'addContacts', 'listContacts', 'addToDnc', 'listDnc', 'removeFromDnc', 'getAllCampaignTypes', 'getValidCampaignTypes', 'isValidDisposition', 'checkCampaignCompliance', 'findDncMatchingContactIds', 'bulkMarkOptedOut'].map((n) => [n, vi.fn()])) as Record<string, ReturnType<typeof vi.fn>>,
  writeAuditLogMock: vi.fn(),
  getVerifiedCallerByIdMock: vi.fn(),
}));

vi.mock('../middleware/auth', () => ({
  requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    req.user = a.user as never;
    next();
  },
}));
vi.mock('../../../platform/campaigns', () => a.mocks);
vi.mock('../../../platform/audit/AuditService', () => ({ writeAuditLog: a.writeAuditLogMock, extractIp: () => '127.0.0.1' }));
vi.mock('../../../platform/telephony/TrustedCallerService', () => ({ getVerifiedCallerById: a.getVerifiedCallerByIdMock }));

import router from './campaigns';

function app() {
  const app = express();
  app.use(express.json());
  app.use(router);
  return app;
}

beforeEach(() => {
  a.user.role = 'operations_manager';
  for (const n of names) a.mocks[n].mockReset();
  a.mocks.listCampaigns.mockResolvedValue({ campaigns: [], total: 0 });
  a.mocks.getAllCampaignTypes.mockReturnValue([{ key: 'outbound_call' }]);
  a.mocks.getValidCampaignTypes.mockReturnValue(['outbound_call', 'reminder']);
  a.mocks.isValidDisposition.mockReturnValue(true);
  a.mocks.createCampaign.mockResolvedValue({ id: 'camp1' });
  a.mocks.listDnc.mockResolvedValue({ entries: [], total: 0 });
  a.mocks.addToDnc.mockResolvedValue(true);
  a.mocks.removeFromDnc.mockResolvedValue(true);
  a.writeAuditLogMock.mockReset().mockResolvedValue(undefined);
});

describe('GET /campaigns + /campaigns/types', () => {
  it('lists campaigns', async () => {
    a.mocks.listCampaigns.mockResolvedValue({ campaigns: [{ id: 'c1' }], total: 1 });
    expect((await request(app()).get('/campaigns')).body.total).toBe(1);
  });
  it('returns campaign types', async () => {
    expect((await request(app()).get('/campaigns/types')).body.types).toHaveLength(1);
  });
  it('500 on list failure', async () => {
    a.mocks.listCampaigns.mockRejectedValue(new Error('boom'));
    expect((await request(app()).get('/campaigns')).status).toBe(500);
  });
});

describe('POST /campaigns', () => {
  it('requires agentId and name', async () => {
    expect((await request(app()).post('/campaigns').send({ name: 'C' })).status).toBe(400);
  });
  it('rejects an invalid type', async () => {
    expect((await request(app()).post('/campaigns').send({ agentId: 'a1', name: 'C', type: 'bogus' })).status).toBe(400);
  });
  it('rejects a bad schedule config', async () => {
    const res = await request(app()).post('/campaigns').send({ agentId: 'a1', name: 'C', config: { callWindowStart: '25:00' } });
    expect(res.status).toBe(400);
  });
  it('creates a campaign + audit', async () => {
    const res = await request(app()).post('/campaigns').send({ agentId: 'a1', name: 'C', type: 'outbound_call' });
    expect(res.status).toBe(201);
    expect(a.writeAuditLogMock).toHaveBeenCalledWith(expect.objectContaining({ action: 'campaign.created' }));
  });
  it('rejects a viewer via rbac', async () => {
    a.user.role = 'support_reviewer';
    expect((await request(app()).post('/campaigns').send({ agentId: 'a1', name: 'C' })).status).toBe(403);
  });
});

describe('DNC list', () => {
  it('lists DNC entries', async () => {
    a.mocks.listDnc.mockResolvedValue({ entries: [{ phone: '+1' }], total: 1 });
    expect((await request(app()).get('/campaigns/dnc')).body.total).toBe(1);
  });
  it('add requires a phone', async () => {
    expect((await request(app()).post('/campaigns/dnc').send({})).status).toBe(400);
  });
  it('add rejects an invalid phone', async () => {
    expect((await request(app()).post('/campaigns/dnc').send({ phone: '123' })).status).toBe(400);
  });
  it('adds to DNC (normalizes E.164)', async () => {
    const res = await request(app()).post('/campaigns/dnc').send({ phone: '2125550123', reason: 'opt-out' });
    expect(res.status).toBe(201);
    expect(a.mocks.addToDnc).toHaveBeenCalledWith('t1', '+12125550123', 'manual', 'opt-out');
  });
  it('removes from DNC', async () => {
    expect((await request(app()).delete('/campaigns/dnc').send({ phone: '2125550123' })).body).toEqual({ removed: true });
  });
});

describe('GET/DELETE /campaigns/:id', () => {
  it('404 when missing', async () => {
    a.mocks.getCampaign.mockResolvedValue(null);
    expect((await request(app()).get('/campaigns/c1')).status).toBe(404);
  });
  it('returns a campaign', async () => {
    a.mocks.getCampaign.mockResolvedValue({ id: 'c1' });
    expect((await request(app()).get('/campaigns/c1')).body.campaign).toMatchObject({ id: 'c1' });
  });
  it('deletes a campaign', async () => {
    a.mocks.deleteCampaign.mockResolvedValue(true);
    a.mocks.getCampaign.mockResolvedValue({ id: 'c1' });
    expect((await request(app()).delete('/campaigns/c1')).status).toBe(200);
  });
});

describe('metrics + contacts', () => {
  it('returns campaign metrics', async () => {
    a.mocks.getCampaignMetrics.mockResolvedValue({ calls: 5 });
    const res = await request(app()).get('/campaigns/c1/metrics');
    expect(res.status).toBe(200);
    expect(res.body.campaignId).toBe('c1');
    expect(a.mocks.getCampaignMetrics).toHaveBeenCalledWith('t1', 'c1');
  });
  it('returns type-specific metrics', async () => {
    a.mocks.getTypeSpecificMetrics.mockResolvedValue({ booked: 2 });
    expect((await request(app()).get('/campaigns/c1/type-metrics')).body.typeMetrics).toMatchObject({ booked: 2 });
  });
  it('add contacts requires contacts or csv', async () => {
    expect((await request(app()).post('/campaigns/c1/contacts').send({})).status).toBe(400);
  });
  it('add contacts rejects when all are invalid', async () => {
    const res = await request(app()).post('/campaigns/c1/contacts').send({ contacts: [{ phoneNumber: 'xx' }] });
    expect(res.status).toBe(400);
  });
  it('adds valid contacts', async () => {
    a.mocks.addContacts.mockResolvedValue(2);
    const res = await request(app()).post('/campaigns/c1/contacts').send({ contacts: [{ phoneNumber: '2125550123' }, { phoneNumber: '2125550124' }] });
    expect(res.status).toBe(201);
    expect(res.body.inserted).toBe(2);
  });
  it('adds contacts from a CSV', async () => {
    a.mocks.addContacts.mockResolvedValue(1);
    const csv = 'phone,name\n2125550123,Ada';
    const res = await request(app()).post('/campaigns/c1/contacts').send({ csv });
    expect(res.status).toBe(201);
  });
  it('lists contacts', async () => {
    a.mocks.listContacts.mockResolvedValue({ contacts: [], total: 0 });
    expect((await request(app()).get('/campaigns/c1/contacts')).status).toBe(200);
  });
});

describe('PATCH disposition', () => {
  it('requires a disposition', async () => {
    expect((await request(app()).patch('/campaigns/c1/contacts/k1/disposition').send({})).status).toBe(400);
  });
  it('404 when the campaign is missing', async () => {
    a.mocks.getCampaign.mockResolvedValue(null);
    expect((await request(app()).patch('/campaigns/c1/contacts/k1/disposition').send({ disposition: 'contacted' })).status).toBe(404);
  });
  it('rejects an invalid disposition for the campaign type', async () => {
    a.mocks.getCampaign.mockResolvedValue({ id: 'c1', type: 'outbound_call' });
    a.mocks.isValidDisposition.mockReturnValue(false);
    expect((await request(app()).patch('/campaigns/c1/contacts/k1/disposition').send({ disposition: 'weird' })).status).toBe(400);
  });
  it('updates a valid disposition', async () => {
    a.mocks.getCampaign.mockResolvedValue({ id: 'c1', type: 'outbound_call' });
    a.mocks.isValidDisposition.mockReturnValue(true);
    a.mocks.updateContactTypeDisposition.mockResolvedValue(true);
    expect((await request(app()).patch('/campaigns/c1/contacts/k1/disposition').send({ disposition: 'contacted' })).body).toEqual({ updated: true });
  });
});
