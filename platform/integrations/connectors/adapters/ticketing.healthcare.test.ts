import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConnectorConfig } from '../types';
import type { SafeFetchResponse } from '../ssrfGuard';

const mocks = vi.hoisted(() => ({ safeFetch: vi.fn() }));
vi.mock('../ssrfGuard', async () => {
  const actual = await vi.importActual<typeof import('../ssrfGuard')>('../ssrfGuard');
  return { ...actual, safeFetch: mocks.safeFetch };
});

import { normalizeTicketPayload, TicketingConnectorAdapter } from './ticketing';

const config: ConnectorConfig = {
  integrationId: 'ticketing-1',
  tenantId: 'tenant-1' as never,
  connectorType: 'ticketing',
  provider: 'qvo-ticketing',
  isEnabled: true,
  credentials: { base_url: 'https://tickets.example.com', api_key: 'test-key' },
};

function response(status: number, body: Record<string, unknown>): SafeFetchResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: '',
    headers: {},
    text: async () => JSON.stringify(body),
    json: async () => body,
  };
}

beforeEach(() => mocks.safeFetch.mockReset());

describe('ticketing adapter healthcare caller normalization', () => {
  it('uses the professional caller identity without inventing a patient identity', () => {
    expect(normalizeTicketPayload({
      type: 'answering_service_ticket',
      callerFirstName: 'Morgan',
      callerLastName: 'Lee',
      callerPhone: '+15555550120',
      callbackNumber: '+15555550120',
      callerType: 'pharmacy',
      organizationName: 'Central Pharmacy',
      reasonForCall: 'Refill clarification requested by the pharmacy',
    })).toMatchObject({
      patientFullName: 'Morgan Lee',
      patientPhone: '+15555550120',
      reasonForCalling: 'Refill clarification requested by the pharmacy',
    });
  });

  it('keeps a distinct patient reference when a caregiver supplies one', () => {
    expect(normalizeTicketPayload({
      type: 'answering_service_ticket',
      callerFirstName: 'Morgan',
      callerLastName: 'Lee',
      callerPhone: '+15555550120',
      patientFirstName: 'Pat',
      patientLastName: 'Lee',
      patientPhone: '+15555550121',
      callerType: 'caregiver',
      reasonForCall: 'Appointment request',
    })).toMatchObject({
      patientFullName: 'Pat Lee',
      patientPhone: '+15555550121',
    });
  });

  it('preserves canonical tickets and normalizes after-hours tickets', () => {
    const canonical = {
      type: 'create_ticket' as const,
      patientFullName: 'Pat Lee', patientDob: '', reasonForCalling: 'Question',
      preferredContactMethod: 'phone' as const,
    };
    expect(normalizeTicketPayload(canonical)).toBe(canonical);
    expect(normalizeTicketPayload({
      type: 'after_hours_triage_ticket', patientFirstName: 'Pat', patientLastName: 'Lee',
      callbackNumber: '+15555550121', symptomDescription: 'Caller-reported concern',
      triageOutcome: 'urgent_transfer',
    })).toMatchObject({
      patientFullName: 'Pat Lee', patientPhone: '+15555550121',
      reasonForCalling: 'Caller-reported concern [Triage: urgent_transfer]',
    });
  });

  it('submits the professional caller identity to the configured ticketing endpoint', async () => {
    mocks.safeFetch.mockResolvedValue(response(200, { success: true, ticketNumber: 'T-100', ticketId: 'ext-1' }));
    const result = await new TicketingConnectorAdapter().execute('tenant-1' as never, config, {
      type: 'answering_service_ticket', callerFirstName: 'Morgan', callerLastName: 'Lee',
      callerPhone: '+15555550120', reasonForCall: 'Refill clarification', preferredContactMethod: 'phone',
    });
    expect(result).toMatchObject({ success: true, ticketNumber: 'T-100', externalId: 'ext-1' });
    const body = JSON.parse(String(mocks.safeFetch.mock.calls[0]?.[1]?.body));
    expect(body).toMatchObject({
      patientFullName: 'Morgan Lee', patientPhone: '+15555550120',
      reasonForCalling: 'Refill clarification', originalPayloadType: 'answering_service_ticket',
    });
  });

  it('fails closed for unsupported payloads, missing credentials, HTTP errors, and provider errors', async () => {
    const adapter = new TicketingConnectorAdapter();
    await expect(adapter.execute('tenant-1' as never, config, { type: 'unknown' })).resolves.toMatchObject({ success: false });
    await expect(adapter.execute('tenant-1' as never, { ...config, credentials: {} }, { type: 'answering_service_ticket' })).resolves.toMatchObject({ success: false });
    expect(mocks.safeFetch).not.toHaveBeenCalled();

    mocks.safeFetch.mockResolvedValueOnce(response(503, { error: 'down' }));
    await expect(adapter.execute('tenant-1' as never, config, { type: 'answering_service_ticket' })).resolves.toMatchObject({
      success: false,
      error: expect.stringContaining('HTTP 503'),
    });

    mocks.safeFetch.mockResolvedValueOnce(response(200, { success: false, error: 'rejected' }));
    await expect(adapter.execute('tenant-1' as never, config, { type: 'answering_service_ticket' })).resolves.toEqual({
      success: false,
      error: 'rejected',
    });
  });

});
