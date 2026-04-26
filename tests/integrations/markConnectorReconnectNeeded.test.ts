import { describe, it, expect, beforeEach, vi } from 'vitest';

const queryMock = vi.fn();
const dispatchMock = vi.fn(async () => ({ status: 'sent', emailedRecipients: 1 }));

const fakePool = {
  query: queryMock,
  connect: vi.fn(async () => ({
    query: queryMock,
    release: vi.fn(),
  })),
};

vi.mock('../../platform/db', () => ({
  getPlatformPool: () => fakePool,
  withTenantContext: vi.fn(
    async (_client: unknown, _tenantId: string, fn: () => Promise<unknown>) => fn(),
  ),
}));

beforeEach(() => {
  queryMock.mockReset();
  dispatchMock.mockReset();
  dispatchMock.mockResolvedValue({ status: 'sent', emailedRecipients: 1 });
  fakePool.connect.mockClear();
  fakePool.connect.mockImplementation(async () => ({
    query: queryMock,
    release: vi.fn(),
  }));
  vi.resetModules();
});

async function flushAsync(): Promise<void> {
  // The dynamic import inside db.ts can take several ms to resolve in vitest.
  // Wait long enough for the IIFE's `await import(...)` + dispatch to complete.
  await new Promise((r) => setTimeout(r, 100));
  for (let i = 0; i < 10; i += 1) {
    await new Promise((r) => setImmediate(r));
  }
}

describe('markConnectorReconnectNeeded', () => {
  it('updates the integration row and dispatches an immediate alert with provider context', async () => {
    queryMock.mockResolvedValue({ rows: [], rowCount: 1 });

    // doMock applies before the next dynamic import (which db.ts performs internally).
    vi.doMock(
      '../../platform/integrations/connectors/ConnectorAuthAlertScheduler',
      () => ({
        dispatchConnectorAuthAlert: dispatchMock,
      }),
    );

    const { markConnectorReconnectNeeded } = await import(
      '../../platform/integrations/connectors/db'
    );

    await markConnectorReconnectNeeded(
      'tenant-1' as unknown as string,
      'int-1',
      {
        errorMessage: 'invalid_grant',
        provider: 'hubspot',
        connectorType: 'crm',
      },
    );
    await flushAsync();

    expect(dispatchMock).toHaveBeenCalledTimes(1);
    expect(dispatchMock).toHaveBeenCalledWith({
      tenantId: 'tenant-1',
      integrationId: 'int-1',
      provider: 'hubspot',
      connectorType: 'crm',
      errorMessage: 'invalid_grant',
      reason: 'needs_reconnect',
    });

    const updateCall = queryMock.mock.calls.find((c) =>
      String(c[0]).includes(`SET last_sync_status = 'needs_reconnect'`),
    );
    expect(updateCall).toBeDefined();
    expect(updateCall![1]).toEqual(['tenant-1', 'int-1', 'invalid_grant']);
  });

  it('does not dispatch when notify=false', async () => {
    queryMock.mockResolvedValue({ rows: [], rowCount: 1 });
    vi.doMock(
      '../../platform/integrations/connectors/ConnectorAuthAlertScheduler',
      () => ({
        dispatchConnectorAuthAlert: dispatchMock,
      }),
    );

    const { markConnectorReconnectNeeded } = await import(
      '../../platform/integrations/connectors/db'
    );

    await markConnectorReconnectNeeded('tenant-1' as unknown as string, 'int-1', {
      provider: 'hubspot',
      connectorType: 'crm',
      notify: false,
    });
    await flushAsync();

    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it('skips alert dispatch when the UPDATE matches zero rows', async () => {
    queryMock.mockResolvedValue({ rows: [], rowCount: 0 });
    vi.doMock(
      '../../platform/integrations/connectors/ConnectorAuthAlertScheduler',
      () => ({
        dispatchConnectorAuthAlert: dispatchMock,
      }),
    );

    const { markConnectorReconnectNeeded } = await import(
      '../../platform/integrations/connectors/db'
    );

    await markConnectorReconnectNeeded('tenant-1' as unknown as string, 'int-missing', {
      provider: 'hubspot',
      connectorType: 'crm',
      errorMessage: 'invalid_grant',
    });
    await flushAsync();

    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it('skips alert dispatch when the status update itself fails', async () => {
    fakePool.connect.mockImplementationOnce(async () => ({
      query: vi.fn(async () => {
        throw new Error('db down');
      }),
      release: vi.fn(),
    }));
    vi.doMock(
      '../../platform/integrations/connectors/ConnectorAuthAlertScheduler',
      () => ({
        dispatchConnectorAuthAlert: dispatchMock,
      }),
    );

    const { markConnectorReconnectNeeded } = await import(
      '../../platform/integrations/connectors/db'
    );

    await markConnectorReconnectNeeded('tenant-1' as unknown as string, 'int-1', {
      provider: 'hubspot',
      connectorType: 'crm',
      errorMessage: 'invalid_grant',
    });
    await flushAsync();

    expect(dispatchMock).not.toHaveBeenCalled();
  });
});
