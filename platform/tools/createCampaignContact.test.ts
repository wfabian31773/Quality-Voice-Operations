import { describe, it, expect, vi, beforeEach } from 'vitest';

const { getCampaignMock, addContactsMock, listCampaignsMock } = vi.hoisted(() => ({
  getCampaignMock: vi.fn(),
  addContactsMock: vi.fn(),
  listCampaignsMock: vi.fn(),
}));

vi.mock('../campaigns/CampaignService', () => ({
  getCampaign: getCampaignMock,
  addContacts: addContactsMock,
  listCampaigns: listCampaignsMock,
}));

import { createCampaignContactTool } from './createCampaignContact';

const ctx = { tenantId: 'tenant-1' };

beforeEach(() => {
  getCampaignMock.mockReset();
  addContactsMock.mockReset();
  listCampaignsMock.mockReset();
});

describe('create_campaign tool', () => {
  it('requires a phone number', async () => {
    const r = (await createCampaignContactTool.handler({}, ctx)) as { success: boolean; message: string };
    expect(r.success).toBe(false);
    expect(r.message).toContain('phoneNumber is required');
  });

  it('requires a campaign id or name', async () => {
    const r = (await createCampaignContactTool.handler({ phoneNumber: '+15551234567' }, ctx)) as {
      success: boolean;
      message: string;
    };
    expect(r.success).toBe(false);
    expect(r.message).toContain('campaignId or campaignName');
  });

  it('resolves a campaign by name and adds the contact', async () => {
    listCampaignsMock.mockResolvedValue({ campaigns: [{ id: 'camp-1', name: 'Spring Outreach' }] });
    getCampaignMock.mockResolvedValue({ id: 'camp-1', name: 'Spring Outreach', status: 'active' });
    addContactsMock.mockResolvedValue(1);
    const r = (await createCampaignContactTool.handler(
      { phoneNumber: '+15551234567', campaignName: 'spring outreach', contactName: 'Ada' },
      ctx,
    )) as { success: boolean; added: boolean; campaignId: string };
    expect(r.success).toBe(true);
    expect(r.added).toBe(true);
    expect(r.campaignId).toBe('camp-1');
  });

  it('fails when no campaign matches the provided name', async () => {
    listCampaignsMock.mockResolvedValue({ campaigns: [{ id: 'camp-1', name: 'Other' }] });
    const r = (await createCampaignContactTool.handler(
      { phoneNumber: '+15551234567', campaignName: 'Missing' },
      ctx,
    )) as { success: boolean; message: string };
    expect(r.success).toBe(false);
    expect(r.message).toContain('No campaign found');
    expect(addContactsMock).not.toHaveBeenCalled();
  });

  it('fails when the campaign id does not exist', async () => {
    getCampaignMock.mockResolvedValue(null);
    const r = (await createCampaignContactTool.handler(
      { phoneNumber: '+15551234567', campaignId: 'ghost' },
      ctx,
    )) as { success: boolean; message: string };
    expect(r.success).toBe(false);
    expect(r.message).toContain('not found');
  });

  it('refuses to add to a completed campaign', async () => {
    getCampaignMock.mockResolvedValue({ id: 'camp-1', name: 'Done', status: 'completed' });
    const r = (await createCampaignContactTool.handler(
      { phoneNumber: '+15551234567', campaignId: 'camp-1' },
      ctx,
    )) as { success: boolean; message: string };
    expect(r.success).toBe(false);
    expect(r.message).toContain('completed');
  });

  it('reports when the contact already existed in the campaign', async () => {
    getCampaignMock.mockResolvedValue({ id: 'camp-1', name: 'Spring', status: 'active' });
    addContactsMock.mockResolvedValue(0);
    const r = (await createCampaignContactTool.handler(
      { phoneNumber: '+15551234567', campaignId: 'camp-1' },
      ctx,
    )) as { success: boolean; added: boolean; message: string };
    expect(r.success).toBe(true);
    expect(r.added).toBe(false);
    expect(r.message).toContain('already in campaign');
  });

  it('returns a safe error when the service throws', async () => {
    getCampaignMock.mockRejectedValue(new Error('service down'));
    const r = (await createCampaignContactTool.handler(
      { phoneNumber: '+15551234567', campaignId: 'camp-1' },
      ctx,
    )) as { success: boolean; message: string };
    expect(r.success).toBe(false);
    expect(r.message).toContain('Failed to add contact');
  });
});
