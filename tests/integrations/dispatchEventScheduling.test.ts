import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const {
  listEnabledMock,
  getPreferredMock,
  recordAppointmentMock,
  getRecordedAppointmentMock,
  writeAuditMock,
} = vi.hoisted(() => ({
  listEnabledMock: vi.fn(),
  getPreferredMock: vi.fn(),
  recordAppointmentMock: vi.fn(),
  getRecordedAppointmentMock: vi.fn(),
  writeAuditMock: vi.fn(),
}));

vi.mock('../../platform/integrations/connectors/db', () => ({
  listEnabledConnectorConfigs: listEnabledMock,
  getPreferredSchedulingProvider: getPreferredMock,
  recordAppointmentSchedulingDispatch: recordAppointmentMock,
  getAppointmentSchedulingProvider: getRecordedAppointmentMock,
  getConnectorConfig: vi.fn(),
  updateConnectorSyncStatus: vi.fn(),
}));

vi.mock('../../platform/audit/AuditService', () => ({
  writeAuditLog: writeAuditMock,
}));

vi.mock('../../platform/integrations/connectors/SyncErrorAlerter', () => ({
  notifyConnectorSyncError: vi.fn(),
  notifySustainedConnectorFailure: vi.fn(),
  notifyConnectorRecovery: vi.fn(),
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
    recordAppointmentMock.mockReset();
    recordAppointmentMock.mockResolvedValue(undefined);
    getRecordedAppointmentMock.mockReset();
    getRecordedAppointmentMock.mockResolvedValue(null);
    writeAuditMock.mockReset();
    writeAuditMock.mockResolvedValue(undefined);
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

  it('writes an audit log entry when the chosen scheduling provider has no enabled connector', async () => {
    listEnabledMock.mockResolvedValue([googleConfig]);

    const result = await connectorService.dispatchEvent(
      tenantId,
      'appointment.booked',
      {
        type: 'appointment.booked',
        agentId: `agent-drift-${Date.now()}`,
        phoneNumberId: `phone-drift-${Date.now()}`,
      } as never,
      { schedulingProvider: 'outlook-calendar' },
    );

    expect(executeSpy).not.toHaveBeenCalled();
    expect(result.dispatched).toBe(0);
    expect(writeAuditMock).toHaveBeenCalledTimes(1);
    expect(writeAuditMock.mock.calls[0]?.[0]).toMatchObject({
      action: 'connector.scheduling_provider_drift',
      severity: 'warning',
      changes: expect.objectContaining({
        schedulingProvider: 'outlook-calendar',
        reason: 'no_enabled_scheduling_connector_matches',
      }),
    });
  });

  it('dedupes the drift audit log entry within the TTL window', async () => {
    listEnabledMock.mockResolvedValue([googleConfig]);
    const agentId = `agent-dedupe-${Date.now()}`;

    await connectorService.dispatchEvent(
      tenantId,
      'appointment.booked',
      { type: 'appointment.booked', agentId } as never,
      { schedulingProvider: 'outlook-calendar' },
    );
    await connectorService.dispatchEvent(
      tenantId,
      'appointment.booked',
      { type: 'appointment.booked', agentId } as never,
      { schedulingProvider: 'outlook-calendar' },
    );

    expect(writeAuditMock).toHaveBeenCalledTimes(1);
  });

  it('does not write a drift audit when an enabled scheduling provider matches', async () => {
    listEnabledMock.mockResolvedValue([googleConfig, outlookConfig]);

    await connectorService.dispatchEvent(
      tenantId,
      'appointment.booked',
      { type: 'appointment.booked' } as never,
      { schedulingProvider: 'google-calendar' },
    );

    expect(writeAuditMock).not.toHaveBeenCalled();
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

  it('records every derivable key after a successful appointment.booked dispatch', async () => {
    listEnabledMock.mockResolvedValue([googleConfig, outlookConfig]);
    getPreferredMock.mockResolvedValue('google-calendar');
    executeSpy.mockImplementation(async (_tenantId, config) => {
      const cfg = config as { connectorType: string };
      return cfg.connectorType === 'scheduling'
        ? { success: true, externalId: 'gcal-event-1' }
        : { success: true };
    });

    await connectorService.dispatchEvent(
      tenantId,
      'appointment.booked',
      {
        type: 'appointment.booked',
        agentId: 'agent-1',
        appointmentId: 'appt-99',
        callSid: 'CA-booked-1',
        callerPhone: '+15551234567',
        appointmentDate: '2026-05-01',
        appointmentTime: '14:00',
      } as never,
    );

    // Every derivable key is recorded so later lifecycle events with a
    // different subset of identifying fields can still route back to the
    // original calendar.
    expect(recordAppointmentMock).toHaveBeenCalledWith(
      tenantId,
      'appt:appt-99',
      'google-calendar',
      'gcal-event-1',
    );
    expect(recordAppointmentMock).toHaveBeenCalledWith(
      tenantId,
      'sid:CA-booked-1',
      'google-calendar',
      'gcal-event-1',
    );
    expect(recordAppointmentMock).toHaveBeenCalledWith(
      tenantId,
      'phone:+15551234567:2026-05-01T14:00',
      'google-calendar',
      'gcal-event-1',
    );
    expect(recordAppointmentMock).toHaveBeenCalledTimes(3);
  });

  it('does not record a ledger entry when the appointment.booked scheduling dispatch fails', async () => {
    listEnabledMock.mockResolvedValue([googleConfig, outlookConfig]);
    getPreferredMock.mockResolvedValue('google-calendar');
    executeSpy.mockImplementation(async () => ({ success: false, error: 'gcal exploded' }));

    await connectorService.dispatchEvent(
      tenantId,
      'appointment.booked',
      {
        type: 'appointment.booked',
        agentId: 'agent-1',
        callSid: 'CA-booked-2',
      } as never,
    );

    expect(recordAppointmentMock).not.toHaveBeenCalled();
  });
});

describe('ConnectorService.dispatchEvent appointment lifecycle routing', () => {
  let executeSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    listEnabledMock.mockReset();
    getPreferredMock.mockReset();
    getPreferredMock.mockResolvedValue(null);
    recordAppointmentMock.mockReset();
    recordAppointmentMock.mockResolvedValue(undefined);
    getRecordedAppointmentMock.mockReset();
    getRecordedAppointmentMock.mockResolvedValue(null);
    executeSpy = vi
      .spyOn(connectorService as unknown as { executeWithConfig: (...args: unknown[]) => Promise<unknown> }, 'executeWithConfig')
      .mockImplementation(async () => ({ success: true }));
  });

  afterEach(() => {
    executeSpy.mockRestore();
  });

  it('routes appointment.rescheduled to the same calendar that originally received the booking', async () => {
    listEnabledMock.mockResolvedValue([googleConfig, outlookConfig]);
    getRecordedAppointmentMock.mockResolvedValue('outlook-calendar');

    const result = await connectorService.dispatchEvent(
      tenantId,
      'appointment.rescheduled',
      {
        type: 'appointment.rescheduled',
        callSid: 'CA-original-booking',
      } as never,
    );

    expect(getRecordedAppointmentMock).toHaveBeenCalledWith(tenantId, 'sid:CA-original-booking');
    expect(executeSpy).toHaveBeenCalledTimes(1);
    expect(executeSpy.mock.calls[0]?.[1]).toMatchObject({ provider: 'outlook-calendar' });
    expect(result.dispatched).toBe(1);
    expect(result.results[0]).toMatchObject({ provider: 'outlook-calendar', success: true });
    // Lifecycle events must not overwrite the ledger entry — only the
    // original appointment.booked event writes to it.
    expect(recordAppointmentMock).not.toHaveBeenCalled();
  });

  it('routes appointment.cancelled to the same calendar that originally received the booking', async () => {
    listEnabledMock.mockResolvedValue([googleConfig, outlookConfig]);
    getRecordedAppointmentMock.mockResolvedValue('google-calendar');

    const result = await connectorService.dispatchEvent(
      tenantId,
      'appointment.cancelled',
      {
        type: 'appointment.cancelled',
        appointmentId: 'appt-42',
      } as never,
    );

    expect(getRecordedAppointmentMock).toHaveBeenCalledWith(tenantId, 'appt:appt-42');
    expect(executeSpy).toHaveBeenCalledTimes(1);
    expect(executeSpy.mock.calls[0]?.[1]).toMatchObject({ provider: 'google-calendar' });
    expect(result.dispatched).toBe(1);
    expect(result.results[0]).toMatchObject({ provider: 'google-calendar', success: true });
  });

  it('falls back to broadcasting reschedule events when no ledger entry and no agent/phone identifiers exist', async () => {
    listEnabledMock.mockResolvedValue([googleConfig, outlookConfig]);
    getRecordedAppointmentMock.mockResolvedValue(null);

    const result = await connectorService.dispatchEvent(
      tenantId,
      'appointment.rescheduled',
      {
        type: 'appointment.rescheduled',
        callSid: 'CA-no-record',
      } as never,
    );

    expect(getRecordedAppointmentMock).toHaveBeenCalledWith(tenantId, 'sid:CA-no-record');
    expect(executeSpy).toHaveBeenCalledTimes(2);
    expect(result.dispatched).toBe(2);
  });

  it('prefers an explicit options.schedulingProvider over the ledger lookup for cancel events', async () => {
    listEnabledMock.mockResolvedValue([googleConfig, outlookConfig]);
    getRecordedAppointmentMock.mockResolvedValue('google-calendar');

    const result = await connectorService.dispatchEvent(
      tenantId,
      'appointment.cancelled',
      {
        type: 'appointment.cancelled',
        appointmentId: 'appt-42',
      } as never,
      { schedulingProvider: 'outlook-calendar' },
    );

    expect(getRecordedAppointmentMock).not.toHaveBeenCalled();
    expect(executeSpy).toHaveBeenCalledTimes(1);
    expect(executeSpy.mock.calls[0]?.[1]).toMatchObject({ provider: 'outlook-calendar' });
    expect(result.dispatched).toBe(1);
  });

  it('lets the ledger override the current agent/phone preference for reschedule events', async () => {
    listEnabledMock.mockResolvedValue([googleConfig, outlookConfig]);
    // The tenant has *since* changed their default scheduling provider for
    // this agent to Outlook, but the original booking actually landed in
    // Google Calendar. We must route the reschedule back to Google so the
    // existing event is updated — not duplicated into Outlook.
    getPreferredMock.mockResolvedValue('outlook-calendar');
    getRecordedAppointmentMock.mockResolvedValue('google-calendar');

    const result = await connectorService.dispatchEvent(
      tenantId,
      'appointment.rescheduled',
      {
        type: 'appointment.rescheduled',
        agentId: 'agent-1',
        callSid: 'CA-original-booking',
      } as never,
    );

    expect(getRecordedAppointmentMock).toHaveBeenCalledWith(tenantId, 'sid:CA-original-booking');
    // The agent preference lookup is short-circuited once the ledger
    // returns a hit.
    expect(getPreferredMock).not.toHaveBeenCalled();
    expect(executeSpy).toHaveBeenCalledTimes(1);
    expect(executeSpy.mock.calls[0]?.[1]).toMatchObject({ provider: 'google-calendar' });
    expect(result.dispatched).toBe(1);
  });

  it('falls back to agent/phone preference when the ledger has no entry for a lifecycle event', async () => {
    listEnabledMock.mockResolvedValue([googleConfig, outlookConfig]);
    getRecordedAppointmentMock.mockResolvedValue(null);
    getPreferredMock.mockResolvedValue('outlook-calendar');

    const result = await connectorService.dispatchEvent(
      tenantId,
      'appointment.rescheduled',
      {
        type: 'appointment.rescheduled',
        agentId: 'agent-1',
        callSid: 'CA-no-ledger',
      } as never,
    );

    expect(getRecordedAppointmentMock).toHaveBeenCalledWith(tenantId, 'sid:CA-no-ledger');
    expect(getPreferredMock).toHaveBeenCalled();
    expect(executeSpy).toHaveBeenCalledTimes(1);
    expect(executeSpy.mock.calls[0]?.[1]).toMatchObject({ provider: 'outlook-calendar' });
    expect(result.dispatched).toBe(1);
  });

  it('tries every derivable key and uses the first ledger hit for cancel events', async () => {
    listEnabledMock.mockResolvedValue([googleConfig, outlookConfig]);
    // The cancel event carries no appointmentId or callSid, only the
    // caller phone + appointment time. The ledger entry was recorded
    // under that key at booking time, so the lookup still succeeds.
    getRecordedAppointmentMock.mockImplementation(async (_tenantId: string, key: string) => {
      if (key === 'phone:+15551234567:2026-05-01T14:00') return 'outlook-calendar';
      return null;
    });

    const result = await connectorService.dispatchEvent(
      tenantId,
      'appointment.cancelled',
      {
        type: 'appointment.cancelled',
        callerPhone: '+15551234567',
        appointmentDate: '2026-05-01',
        appointmentTime: '14:00',
      } as never,
    );

    expect(getRecordedAppointmentMock).toHaveBeenCalledWith(
      tenantId,
      'phone:+15551234567:2026-05-01T14:00',
    );
    expect(executeSpy).toHaveBeenCalledTimes(1);
    expect(executeSpy.mock.calls[0]?.[1]).toMatchObject({ provider: 'outlook-calendar' });
    expect(result.dispatched).toBe(1);
  });

  it('walks the keys in preference order and stops at the first hit for cancel events', async () => {
    listEnabledMock.mockResolvedValue([googleConfig, outlookConfig]);
    getRecordedAppointmentMock.mockImplementation(async (_tenantId: string, key: string) => {
      // Only the callSid key has a recorded provider — the appointmentId
      // key returns null, simulating a partial backfill / mismatched
      // identifier between the booked and cancel events.
      if (key === 'sid:CA-booked-1') return 'google-calendar';
      return null;
    });

    const result = await connectorService.dispatchEvent(
      tenantId,
      'appointment.cancelled',
      {
        type: 'appointment.cancelled',
        appointmentId: 'appt-not-recorded',
        callSid: 'CA-booked-1',
      } as never,
    );

    expect(getRecordedAppointmentMock).toHaveBeenNthCalledWith(1, tenantId, 'appt:appt-not-recorded');
    expect(getRecordedAppointmentMock).toHaveBeenNthCalledWith(2, tenantId, 'sid:CA-booked-1');
    expect(getRecordedAppointmentMock).toHaveBeenCalledTimes(2);
    expect(executeSpy).toHaveBeenCalledTimes(1);
    expect(executeSpy.mock.calls[0]?.[1]).toMatchObject({ provider: 'google-calendar' });
    expect(result.dispatched).toBe(1);
  });

  it('uses callerPhone + appointment time as a fallback lookup key when no callSid or appointmentId is present', async () => {
    listEnabledMock.mockResolvedValue([googleConfig, outlookConfig]);
    getRecordedAppointmentMock.mockResolvedValue('outlook-calendar');

    const result = await connectorService.dispatchEvent(
      tenantId,
      'appointment.no_show',
      {
        type: 'appointment.no_show',
        callerPhone: '+15551234567',
        appointmentDate: '2026-05-01',
        appointmentTime: '14:00',
      } as never,
    );

    expect(getRecordedAppointmentMock).toHaveBeenCalledWith(
      tenantId,
      'phone:+15551234567:2026-05-01T14:00',
    );
    expect(executeSpy).toHaveBeenCalledTimes(1);
    expect(executeSpy.mock.calls[0]?.[1]).toMatchObject({ provider: 'outlook-calendar' });
    expect(result.dispatched).toBe(1);
  });
});
