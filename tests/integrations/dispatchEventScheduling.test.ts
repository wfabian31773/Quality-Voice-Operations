import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { listEnabledMock, getPreferredMock } = vi.hoisted(() => ({
  listEnabledMock: vi.fn(),
  getPreferredMock: vi.fn(),
}));

vi.mock('../../platform/integrations/connectors/db', () => ({
  listEnabledConnectorConfigs: listEnabledMock,
  getPreferredSchedulingProvider: getPreferredMock,
  getConnectorConfig: vi.fn(),
  updateConnectorSyncStatus: vi.fn(),
}));

vi.mock('../../platform/integrations/connectors/SyncErrorAlerter', () => ({
  notifyConnectorSyncError: vi.fn(),
  notifySustainedConnectorFailure: vi.fn(),
  isRevenueCriticalProvider: () => false,
}));

vi.mock('../../platform/core/observability/traceLogger', () => ({
  recordIntegrationEvent: vi.fn(),
  recordConnectorDispatchEvent: vi.fn(),
}));

vi.mock('../../platform/db', () => ({
  withPrivilegedClient: vi.fn(async (fn: (c: unknown) => unknown) => fn({ query: vi.fn() })),
}));

import { connectorService } from '../../platform/integrations/connectors/ConnectorService';

const tenantId = 'tenant-test' as unknown as Parameters<typeof connectorService.dispatchEvent>[0];

const googleConfig = {
  tenantId,
  integrationId: 'int-google',
  connectorType: 'scheduling',
  provider: 'google-calendar',
  isEnabled: true,
  config: {},
  credentials: {},
};

const outlookConfig = {
  tenantId,
  integrationId: 'int-outlook',
  connectorType: 'scheduling',
  provider: 'outlook-calendar',
  isEnabled: true,
  config: {},
  credentials: {},
};

describe('ConnectorService.dispatchEvent scheduling provider routing', () => {
  let executeSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    listEnabledMock.mockReset();
    getPreferredMock.mockReset();
    executeSpy = vi
      .spyOn(connectorService as unknown as { executeWithConfig: (...args: unknown[]) => Promise<unknown> }, 'executeWithConfig')
      .mockImplementation(async () => ({ success: true }));
  });

  afterEach(() => {
    executeSpy.mockRestore();
  });

  it('dispatches only to the explicit scheduling provider passed in options', async () => {
    listEnabledMock.mockResolvedValue([googleConfig, outlookConfig]);

    const result = await connectorService.dispatchEvent(
      tenantId,
      'appointment.booked',
      { type: 'appointment.booked' } as never,
      { schedulingProvider: 'outlook-calendar' },
    );

    expect(getPreferredMock).not.toHaveBeenCalled();
    expect(executeSpy).toHaveBeenCalledTimes(1);
    expect(executeSpy.mock.calls[0]?.[1]).toMatchObject({ provider: 'outlook-calendar' });
    expect(result.dispatched).toBe(1);
    expect(result.results[0]).toMatchObject({ provider: 'outlook-calendar', success: true });
  });

  it('auto-resolves the provider from agentId/phoneNumberId when not provided', async () => {
    listEnabledMock.mockResolvedValue([googleConfig, outlookConfig]);
    getPreferredMock.mockResolvedValue('google-calendar');

    const result = await connectorService.dispatchEvent(
      tenantId,
      'appointment.booked',
      {
        type: 'appointment.booked',
        agentId: 'agent-1',
        phoneNumberId: 'phone-1',
      } as never,
    );

    expect(getPreferredMock).toHaveBeenCalledWith(tenantId, {
      agentId: 'agent-1',
      phoneNumberId: 'phone-1',
    });
    expect(executeSpy).toHaveBeenCalledTimes(1);
    expect(executeSpy.mock.calls[0]?.[1]).toMatchObject({ provider: 'google-calendar' });
    expect(result.dispatched).toBe(1);
  });

  it('falls back to dispatching all enabled scheduling providers when no preference exists', async () => {
    listEnabledMock.mockResolvedValue([googleConfig, outlookConfig]);
    getPreferredMock.mockResolvedValue(null);

    const result = await connectorService.dispatchEvent(
      tenantId,
      'appointment.booked',
      { type: 'appointment.booked', agentId: 'agent-no-pref' } as never,
    );

    expect(executeSpy).toHaveBeenCalledTimes(2);
    expect(result.dispatched).toBe(2);
    const dispatchedProviders = result.results.map((r) => r.provider).sort();
    expect(dispatchedProviders).toEqual(['google-calendar', 'outlook-calendar']);
  });

  it('does not look up preferred provider when payload has no agent or phone identifiers', async () => {
    listEnabledMock.mockResolvedValue([googleConfig, outlookConfig]);

    const result = await connectorService.dispatchEvent(
      tenantId,
      'appointment.booked',
      { type: 'appointment.booked' } as never,
    );

    expect(getPreferredMock).not.toHaveBeenCalled();
    expect(executeSpy).toHaveBeenCalledTimes(2);
    expect(result.dispatched).toBe(2);
  });

  it('does not affect non-scheduling connectors when scheduling provider is set', async () => {
    const crmConfig = {
      tenantId,
      integrationId: 'int-crm',
      connectorType: 'crm',
      provider: 'hubspot',
      isEnabled: true,
      config: {},
      credentials: {},
    };
    listEnabledMock.mockResolvedValue([crmConfig]);

    const result = await connectorService.dispatchEvent(
      tenantId,
      'call.completed',
      { type: 'call.completed' } as never,
      { schedulingProvider: 'outlook-calendar' },
    );

    expect(executeSpy).toHaveBeenCalledTimes(1);
    expect(executeSpy.mock.calls[0]?.[1]).toMatchObject({ provider: 'hubspot' });
    expect(result.dispatched).toBe(1);
  });
});
