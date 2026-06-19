import { describe, it, expect, vi, beforeEach } from 'vitest';

const a = vi.hoisted(() => ({ poolQueryMock: vi.fn(), clientQueryMock: vi.fn(), releaseMock: vi.fn() }));

vi.mock('../../../platform/db', () => ({
  getPlatformPool: () => ({ query: a.poolQueryMock, connect: async () => ({ query: a.clientQueryMock, release: a.releaseMock }) }),
  withTenantContext: async (_c: unknown, _t: string, cb: () => Promise<void>) => cb(),
}));
vi.mock('../../../platform/core/logger', () => ({ createLogger: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn() }) }));

import { lookupByPhoneNumber, getAgentConfig, getAgentToolOverrides } from './numberLookup';

beforeEach(() => {
  a.poolQueryMock.mockReset().mockResolvedValue({ rows: [] });
  a.clientQueryMock.mockReset().mockResolvedValue({ rows: [] });
  a.releaseMock.mockReset();
});

describe('lookupByPhoneNumber', () => {
  it('normalizes a 10-digit number to +1 E.164 and maps the routing row', async () => {
    a.poolQueryMock.mockResolvedValue({ rows: [{
      tenant_id: 't1', agent_id: 'ag1', agent_type: 'receptionist', agent_name: 'Ava', agent_metadata: { x: 1 },
      tenant_name: 'Acme', phone_number_id: 'pn1', routing_id: 'r1', conditions: null,
    }] });
    const res = await lookupByPhoneNumber('(212) 555-0123');
    expect(res).toMatchObject({ tenantId: 't1', agentId: 'ag1', agentName: 'Ava', phoneNumberId: 'pn1' });
    // Query was called with the normalized E.164.
    expect(a.poolQueryMock.mock.calls[0][1]).toEqual(['+12125550123']);
  });
  it('prefixes a non-10-digit number with + only', async () => {
    a.poolQueryMock.mockResolvedValue({ rows: [] });
    await lookupByPhoneNumber('447911123456');
    expect(a.poolQueryMock.mock.calls[0][1]).toEqual(['+447911123456']);
  });
  it('returns null when no routing matches', async () => {
    a.poolQueryMock.mockResolvedValue({ rows: [] });
    expect(await lookupByPhoneNumber('2125550123')).toBeNull();
  });
});

describe('getAgentConfig', () => {
  it('returns the agent row', async () => {
    a.clientQueryMock.mockImplementation(async (sql: string) => sql.includes('FROM agents') ? { rows: [{ id: 'ag1', name: 'Ava' }] } : { rows: [] });
    expect(await getAgentConfig('t1', 'ag1')).toMatchObject({ id: 'ag1' });
  });
  it('returns null when the agent is missing', async () => {
    a.clientQueryMock.mockResolvedValue({ rows: [] });
    expect(await getAgentConfig('t1', 'ag1')).toBeNull();
  });
  it('rolls back and rethrows on error', async () => {
    a.clientQueryMock.mockImplementation(async (sql: string) => { if (sql.includes('FROM agents')) throw new Error('boom'); return { rows: [] }; });
    await expect(getAgentConfig('t1', 'ag1')).rejects.toThrow('boom');
    expect(a.clientQueryMock).toHaveBeenCalledWith('ROLLBACK');
  });
});

describe('getAgentToolOverrides', () => {
  it('maps tool rows to overrides', async () => {
    a.clientQueryMock.mockImplementation(async (sql: string) => sql.includes('FROM agent_tools') ? { rows: [{ tool_name: 'lookup_customer', is_enabled: false }] } : { rows: [] });
    expect(await getAgentToolOverrides('t1', 'ag1')).toEqual([{ toolName: 'lookup_customer', enabled: false }]);
  });
  it('returns [] (swallowing) on error', async () => {
    a.clientQueryMock.mockImplementation(async (sql: string) => { if (sql.includes('FROM agent_tools')) throw new Error('boom'); return { rows: [] }; });
    expect(await getAgentToolOverrides('t1', 'ag1')).toEqual([]);
  });
});
