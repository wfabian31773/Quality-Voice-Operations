import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_ANSWERING_SERVICE_CONFIG } from '../config/ticketingConfig';
import { createServiceTicket } from './createServiceTicketTool';

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  release: vi.fn(),
  isTicketingConfigured: vi.fn(() => false),
  submitTicket: vi.fn(),
}));
const query = mocks.query;

vi.mock('../../../db', () => ({
  getPlatformPool: () => ({ query, connect: async () => ({ query, release: mocks.release }) }),
  withTenantContext: vi.fn(async () => undefined),
}));
vi.mock('../../../integrations/azul-vision/ticketingClient', () => ({
  isTicketingConfigured: mocks.isTicketingConfigured,
  submitTicket: mocks.submitTicket,
}));

describe('createServiceTicket healthcare outcome', () => {
  beforeEach(() => {
    query.mockReset().mockResolvedValue({ rows: [] });
    mocks.release.mockReset();
    mocks.isTicketingConfigured.mockReset().mockReturnValue(false);
    mocks.submitTicket.mockReset();
  });

  it('persists a professional caller without inventing a patient identity', async () => {
    const writeToOutbox = vi.fn(async () => ({ outboxId: 'out-b2b', alreadyExists: false }));
    const result = await createServiceTicket({
      callerFirstName: 'Morgan',
      callerLastName: 'Lee',
      callerPhone: '+15555550120',
      callbackNumber: '+15555550120',
      callerType: 'pharmacy',
      organizationName: 'Central Pharmacy',
      reasonForCall: 'Refill clarification requested by the pharmacy',
      outcomeType: 'staff_message',
      requestedAction: 'Pharmacy callback',
      urgency: 'routine',
      callbackPreference: 'business hours',
      identityVerificationStatus: 'not_required',
      consentToContact: true,
      evidenceSource: ['caller_statement'],
    }, {
      tenantId: 'tenant-1' as never,
      callSid: 'CA-b2b',
      callLogId: 'call-b2b',
      outbox: { writeToOutbox } as never,
      config: DEFAULT_ANSWERING_SERVICE_CONFIG,
      practiceName: 'Northstar Clinic',
    });

    expect(result.success).toBe(true);
    expect(writeToOutbox).toHaveBeenCalledWith(expect.objectContaining({
      idempotencyKey: 'healthcare-receptionist:CA-b2b:staff_message',
      payload: expect.objectContaining({
        callerFirstName: 'Morgan',
        callerLastName: 'Lee',
        callerPhone: '+15555550120',
        patientFirstName: undefined,
        patientLastName: undefined,
        patientPhone: undefined,
      }),
    }));
  });

  it('requires a stable call identifier for every healthcare side effect', async () => {
    const writeToOutbox = vi.fn();
    const result = await createServiceTicket({
      callerFirstName: 'Ana', callerLastName: 'Lopez', callerPhone: '+15555550100',
      callbackNumber: '+15555550100', callerType: 'patient', reasonForCall: 'Needs a callback',
      outcomeType: 'callback_request', requestedAction: 'Return the call', urgency: 'routine',
      callbackPreference: 'afternoon', identityVerificationStatus: 'unverified',
      consentToContact: true, evidenceSource: ['caller_statement'],
    }, {
      tenantId: 'tenant-1' as never,
      outbox: { writeToOutbox } as never,
      config: DEFAULT_ANSWERING_SERVICE_CONFIG,
    });

    expect(result.success).toBe(false);
    expect(result.confirmationMessage).toMatch(/unable to verify the call|cannot submit/i);
    expect(writeToOutbox).not.toHaveBeenCalled();
  });

  it('uses the persisted call-log identifier as the idempotency scope when a carrier SID is unavailable', async () => {
    const writeToOutbox = vi.fn(async () => ({ outboxId: 'out-call-log', alreadyExists: false }));
    const result = await createServiceTicket({
      callerFirstName: 'Ana', callerLastName: 'Lopez', callerPhone: '+15555550100',
      callbackNumber: '+15555550100', callerType: 'patient', reasonForCall: 'Needs a callback',
      outcomeType: 'callback_request', requestedAction: 'Return the call', urgency: 'routine',
      callbackPreference: 'afternoon', identityVerificationStatus: 'unverified',
      consentToContact: true, evidenceSource: ['caller_statement'],
    }, {
      tenantId: 'tenant-1' as never,
      callLogId: 'call-log-only',
      outbox: { writeToOutbox } as never,
      config: DEFAULT_ANSWERING_SERVICE_CONFIG,
    });

    expect(result.success).toBe(true);
    expect(writeToOutbox).toHaveBeenCalledWith(expect.objectContaining({
      idempotencyKey: 'healthcare-receptionist:call-log-only:callback_request',
    }));
  });

  it('validates caller and patient contact fields before persistence', async () => {
    const writeToOutbox = vi.fn();
    const result = await createServiceTicket({
      callerFirstName: 'Ana', callerLastName: 'Lopez', callerPhone: 'not-a-phone',
      patientFirstName: 'Pat', patientLastName: 'Lopez', patientPhone: 'also-invalid',
      callbackNumber: '+15555550100', callerType: 'caregiver', reasonForCall: 'Needs a callback',
      outcomeType: 'callback_request', requestedAction: 'Return the call', urgency: 'routine',
      callbackPreference: 'afternoon', identityVerificationStatus: 'unverified',
      consentToContact: true, evidenceSource: ['caller_statement'],
    }, {
      tenantId: 'tenant-1' as never,
      callSid: 'CA-invalid-contacts',
      outbox: { writeToOutbox } as never,
      config: DEFAULT_ANSWERING_SERVICE_CONFIG,
    });

    expect(result.success).toBe(false);
    expect(result.confirmationMessage).toMatch(/callerPhone|patientPhone/);
    expect(writeToOutbox).not.toHaveBeenCalled();
  });

  it('persists every staff-ready outcome field with a tenant-scoped idempotency key', async () => {
    const writeToOutbox = vi.fn(async () => ({ outboxId: 'out-1', alreadyExists: false }));
    const result = await createServiceTicket({
      patientFirstName: 'Ana',
      patientLastName: 'Lopez',
      patientPhone: '+15555550100',
      callbackNumber: '+15555550101',
      reasonForCall: 'Needs an annual eye exam',
      outcomeType: 'appointment_request',
      requestedAction: 'Call back to confirm an annual eye exam time',
      urgency: 'routine',
      callbackPreference: 'weekday afternoons',
      identityVerificationStatus: 'partially_verified',
      consentToContact: true,
      evidenceSource: ['caller_statement', 'caller_id'],
      callerType: 'patient',
    }, {
      tenantId: 'tenant-1' as never,
      callSid: 'CA-123',
      callLogId: 'call-1',
      outbox: { writeToOutbox } as never,
      config: DEFAULT_ANSWERING_SERVICE_CONFIG,
      practiceName: 'Northstar Clinic',
    });

    expect(result.success).toBe(true);
    expect(result.confirmationMessage).toMatch(/submitted|follow up/i);
    expect(result.confirmationMessage).not.toMatch(/booked|confirmed appointment/i);
    expect(writeToOutbox).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: 'tenant-1',
      idempotencyKey: 'healthcare-receptionist:CA-123:appointment_request',
      payload: expect.objectContaining({
        outcomeType: 'appointment_request',
        requestedAction: 'Call back to confirm an annual eye exam time',
        urgency: 'routine',
        callbackPreference: 'weekday afternoons',
        identityVerificationStatus: 'partially_verified',
        consentToContact: true,
        evidenceSource: ['caller_statement', 'caller_id'],
        callerType: 'patient',
        summary: expect.stringMatching(/annual eye exam/i),
      }),
    }));
  });

  it('does not claim success when durable persistence fails', async () => {
    const result = await createServiceTicket({
      patientFirstName: 'Ana',
      patientLastName: 'Lopez',
      patientPhone: '+15555550100',
      callbackNumber: '+15555550100',
      reasonForCall: 'Please call me back',
      outcomeType: 'callback_request',
      requestedAction: 'Return the call',
      urgency: 'routine',
      callbackPreference: 'any time',
      identityVerificationStatus: 'unverified',
      consentToContact: true,
      evidenceSource: ['caller_statement'],
      callerType: 'patient',
    }, {
      tenantId: 'tenant-1' as never,
      callSid: 'CA-456',
      outbox: { writeToOutbox: vi.fn(async () => { throw new Error('unavailable'); }) } as never,
      config: DEFAULT_ANSWERING_SERVICE_CONFIG,
    });

    expect(result).toMatchObject({ success: false });
    expect(result.confirmationMessage).toMatch(/wasn't able to submit/i);
  });

  it('rejects an incomplete healthcare outcome before durable persistence', async () => {
    const writeToOutbox = vi.fn();
    const result = await createServiceTicket({
      patientFirstName: 'Ana',
      patientLastName: 'Lopez',
      patientPhone: '+15555550100',
      reasonForCall: 'Needs an appointment',
      outcomeType: 'appointment_request',
    }, {
      tenantId: 'tenant-1' as never,
      callSid: 'CA-incomplete',
      outbox: { writeToOutbox } as never,
      config: DEFAULT_ANSWERING_SERVICE_CONFIG,
    });

    expect(result).toMatchObject({ success: false });
    expect(result.confirmationMessage).toMatch(/missing required/i);
    expect(writeToOutbox).not.toHaveBeenCalled();
  });

  it('repairs a missing local ticket after an idempotent outbox hit without duplicating staff work', async () => {
    const writeToOutbox = vi.fn(async () => ({ outboxId: 'out-existing', alreadyExists: true }));
    query.mockImplementation(async (sql: string) => {
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql.includes('pg_advisory_xact_lock')) return { rows: [] };
      if (sql.includes('SELECT id, ticket_number FROM tickets')) return { rows: [] };
      if (sql.includes('INSERT INTO tickets')) return { rows: [{ id: 'ticket-repaired', ticket_number: 44 }] };
      if (sql.includes('SELECT * FROM ticket_sla_policies')) return { rows: [] };
      return { rows: [] };
    });
    const result = await createServiceTicket({
      patientFirstName: 'Ana',
      patientLastName: 'Lopez',
      patientPhone: '+15555550100',
      callbackNumber: '+15555550100',
      reasonForCall: 'Needs a callback',
      outcomeType: 'callback_request',
      requestedAction: 'Return the call',
      urgency: 'routine',
      callbackPreference: 'afternoon',
      identityVerificationStatus: 'unverified',
      consentToContact: true,
      evidenceSource: ['caller_statement'],
      callerType: 'patient',
    }, {
      tenantId: 'tenant-1' as never,
      callSid: 'CA-duplicate',
      callLogId: 'call-duplicate',
      outbox: { writeToOutbox } as never,
      config: DEFAULT_ANSWERING_SERVICE_CONFIG,
    });

    expect(result).toMatchObject({ success: true, outboxId: 'out-existing', ticketId: 'ticket-repaired', projectionStatus: 'created' });
    expect(query.mock.calls.filter(([sql]) => String(sql).includes('INSERT INTO tickets'))).toHaveLength(1);
  });

  it('reuses the existing local ticket on an idempotent replay', async () => {
    query.mockImplementation(async (sql: string) => {
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql.includes('pg_advisory_xact_lock')) return { rows: [] };
      if (sql.includes('SELECT id, ticket_number FROM tickets')) return { rows: [{ id: 'ticket-existing', ticket_number: 43 }] };
      return { rows: [] };
    });
    const result = await createServiceTicket({
      patientFirstName: 'Ana', patientLastName: 'Lopez', patientPhone: '+15555550100',
      callbackNumber: '+15555550100', reasonForCall: 'Needs a callback', outcomeType: 'callback_request',
      requestedAction: 'Return the call', urgency: 'routine', callbackPreference: 'afternoon',
      identityVerificationStatus: 'unverified', consentToContact: true,
      evidenceSource: ['caller_statement'], callerType: 'patient',
    }, {
      tenantId: 'tenant-1' as never, callSid: 'CA-duplicate', callLogId: 'call-duplicate',
      outbox: { writeToOutbox: vi.fn(async () => ({ outboxId: 'out-existing', alreadyExists: true })) } as never,
      config: DEFAULT_ANSWERING_SERVICE_CONFIG,
    });
    expect(result).toMatchObject({ ticketId: 'ticket-existing', projectionStatus: 'existing' });
    expect(query.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO tickets'))).toBe(false);
  });

  it('rejects oversized or unrecognized healthcare outcome input', async () => {
    const writeToOutbox = vi.fn();
    const result = await createServiceTicket({
      patientFirstName: 'Ana',
      patientLastName: 'Lopez',
      patientPhone: '+15555550100',
      callbackNumber: '+15555550100',
      reasonForCall: 'x'.repeat(2_001),
      outcomeType: 'callback_request',
      requestedAction: 'Return the call',
      urgency: 'routine',
      callbackPreference: 'afternoon',
      identityVerificationStatus: 'unverified',
      consentToContact: true,
      evidenceSource: ['invented_source' as never],
      callerType: 'patient',
    }, {
      tenantId: 'tenant-1' as never,
      callSid: 'CA-invalid',
      outbox: { writeToOutbox } as never,
      config: DEFAULT_ANSWERING_SERVICE_CONFIG,
    });

    expect(result).toMatchObject({ success: false });
    expect(result.confirmationMessage).toMatch(/invalid information/i);
    expect(writeToOutbox).not.toHaveBeenCalled();
  });

  it('creates the local ticket, activity, and SLA record after durable outbox persistence', async () => {
    query.mockImplementation(async (sql: string) => {
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql.includes('pg_advisory_xact_lock')) return { rows: [] };
      if (sql.includes('SELECT id, ticket_number FROM tickets')) return { rows: [] };
      if (sql.includes('INSERT INTO tickets')) return { rows: [{ id: 'ticket-1', ticket_number: 'T-1' }] };
      if (sql.includes('SELECT * FROM ticket_sla_policies')) return { rows: [{ id: 'sla-1', first_response_minutes: 30, resolution_minutes: 240 }] };
      return { rows: [] };
    });
    const result = await createServiceTicket({
      patientFirstName: 'Ana', patientLastName: 'Lopez', patientPhone: '+15555550100',
      callbackNumber: '+15555550100', reasonForCall: 'Urgent appointment request',
      outcomeType: 'appointment_request', requestedAction: 'Call to arrange an appointment',
      urgency: 'urgent', callbackPreference: 'morning', identityVerificationStatus: 'verified',
      consentToContact: true, evidenceSource: ['caller_statement', 'verified_record'], callerType: 'patient',
      lastProviderSeen: 'Dr. Rivera', locationOfLastVisit: 'North office', additionalNotes: 'Caller requests interpreter',
    }, {
      tenantId: 'tenant-1' as never, callSid: 'CA-local', callLogId: 'call-local',
      outbox: { writeToOutbox: vi.fn(async () => ({ outboxId: 'out-local', alreadyExists: false })) } as never,
      config: DEFAULT_ANSWERING_SERVICE_CONFIG,
    });

    expect(result.success).toBe(true);
    expect(result).toMatchObject({ ticketId: 'ticket-1', ticketNumber: 'T-1', projectionStatus: 'created' });
    const ticketInsert = query.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO tickets'));
    const slaInsert = query.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO ticket_sla_instances'));
    expect(ticketInsert?.[1]?.[3]).toContain('Requested Action: Call to arrange an appointment');
    expect(slaInsert?.[1]).toEqual(['tenant-1', 'ticket-1', 'sla-1', '30', '240']);
  });

  it('retains durable success when the optional local ticket projection fails', async () => {
    query.mockRejectedValueOnce(new Error('database unavailable'));
    const result = await createServiceTicket({
      patientFirstName: 'Ana', patientLastName: 'Lopez', patientPhone: '+15555550100',
      callbackNumber: '+15555550100', reasonForCall: 'Needs a callback', outcomeType: 'callback_request',
      requestedAction: 'Return the call', urgency: 'time_sensitive', callbackPreference: 'today',
      identityVerificationStatus: 'unverified', consentToContact: true,
      evidenceSource: ['caller_statement'], callerType: 'caregiver',
    }, {
      tenantId: 'tenant-1' as never, callSid: 'CA-db-fail',
      outbox: { writeToOutbox: vi.fn(async () => ({ outboxId: 'out-db-fail', alreadyExists: false })) } as never,
      config: DEFAULT_ANSWERING_SERVICE_CONFIG,
    });
    expect(result).toMatchObject({ success: true, outboxId: 'out-db-fail' });
  });

  it('supports an injected local projector while preserving the production validation and outbox contract', async () => {
    const localTicketProjector = vi.fn(async () => ({
      status: 'created' as const,
      ticketId: 'demo-ticket-1',
      ticketNumber: 101,
    }));
    const writeToOutbox = vi.fn(async () => ({ outboxId: 'demo-outbox-1', alreadyExists: false }));
    const result = await createServiceTicket({
      callerFirstName: 'Ana', callerLastName: 'Lopez', callerPhone: '+15555550100',
      patientFirstName: 'Ana', patientLastName: 'Lopez', patientPhone: '+15555550100',
      callbackNumber: '+15555550100', reasonForCall: 'Annual eye exam request',
      outcomeType: 'appointment_request', requestedAction: 'Call back to arrange an appointment time',
      urgency: 'routine', callbackPreference: 'weekday afternoon',
      identityVerificationStatus: 'partially_verified', consentToContact: true,
      evidenceSource: ['caller_statement', 'caller_id'], callerType: 'patient',
    }, {
      tenantId: 'demo' as never,
      callSid: 'DEMO-CA-1',
      callLogId: 'demo-call-1',
      outbox: { writeToOutbox } as never,
      config: DEFAULT_ANSWERING_SERVICE_CONFIG,
      localTicketProjector,
    });

    expect(writeToOutbox).toHaveBeenCalledOnce();
    expect(localTicketProjector).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: 'demo', callLogId: 'demo-call-1', outboxId: 'demo-outbox-1', priority: 'medium',
    }));
    expect(result).toMatchObject({
      success: true, outboxId: 'demo-outbox-1', ticketId: 'demo-ticket-1',
      ticketNumber: 101, projectionStatus: 'created',
    });
    expect(query).not.toHaveBeenCalled();
  });

  it('attempts the configured Azul connector without reversing durable success on connector failure', async () => {
    mocks.isTicketingConfigured.mockReturnValue(true);
    mocks.submitTicket.mockResolvedValue({ success: false, error: 'connector unavailable' });
    const result = await createServiceTicket({
      patientFirstName: 'Ana', patientLastName: 'Lopez', patientPhone: '+15555550100',
      callbackNumber: '+15555550100', reasonForCall: 'Cancel appointment', outcomeType: 'cancellation_request',
      requestedAction: 'Cancel the appointment', urgency: 'routine', callbackPreference: 'phone',
      identityVerificationStatus: 'verified', consentToContact: true,
      evidenceSource: ['caller_statement', 'verified_record'], callerType: 'patient', patientDob: '01/01/1980',
    }, {
      tenantId: 'tenant-1' as never, callSid: 'CA-azul', practiceName: 'Azul Vision',
      outbox: { writeToOutbox: vi.fn(async () => ({ outboxId: 'out-azul', alreadyExists: false })) } as never,
      config: DEFAULT_ANSWERING_SERVICE_CONFIG,
    });
    expect(result.success).toBe(true);
    expect(mocks.submitTicket).toHaveBeenCalledOnce();
    expect(result.confirmationMessage).not.toMatch(/cancelled|confirmed/i);
  });

  it('preserves the legacy answering-service payload when no healthcare outcome type is supplied', async () => {
    const writeToOutbox = vi.fn(async () => ({ outboxId: 'legacy', alreadyExists: false }));
    const result = await createServiceTicket({
      patientFirstName: 'Ana', patientLastName: 'Lopez', patientPhone: '+15555550100', reasonForCall: 'General message',
    }, {
      tenantId: 'tenant-1' as never,
      outbox: { writeToOutbox } as never,
      config: DEFAULT_ANSWERING_SERVICE_CONFIG,
    });
    expect(result.success).toBe(true);
    expect(writeToOutbox).toHaveBeenCalledWith(expect.objectContaining({ idempotencyKey: undefined }));
  });
});
