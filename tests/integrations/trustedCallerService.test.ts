/**
 * Unit coverage for the TrustedCallerService — focuses on the two areas
 * that govern STIR/SHAKEN trust integrity:
 *
 *   1. Twilio's `POST .../OutgoingCallerIds.json` response parsing.
 *      Real-world Twilio returns the validation payload at the root of
 *      the JSON body. An older nested `{ validation_request: {...} }`
 *      shape also has to be tolerated. Either way, the validation code
 *      must be surfaced — silently storing `null` would strand the
 *      operator with no way to verify the number.
 *
 *   2. `confirmCallerIdVerified` policy. The service must never mark a
 *      caller as 'verified' unless Twilio confirms the registration
 *      (when creds exist) or an explicit, audited manual override is
 *      supplied (when no creds are present). Any softer policy would
 *      let the campaign activation guard pass on numbers we don't
 *      actually own.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const queryMock = vi.fn();
const releaseMock = vi.fn();
const connectMock = vi.fn(async () => ({
  query: queryMock,
  release: releaseMock,
}));

vi.mock('../../platform/db', () => ({
  getPlatformPool: () => ({ connect: connectMock }),
  withTenantContext: vi.fn(async (_client: unknown, _tenantId: string, fn: () => Promise<void>) => fn()),
  withPrivilegedClient: vi.fn(),
}));

const fetchMock = vi.fn();
const ORIGINAL_FETCH = globalThis.fetch;

beforeEach(() => {
  queryMock.mockReset();
  releaseMock.mockReset();
  fetchMock.mockReset();
  connectMock.mockClear();
  globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
  process.env.TWILIO_ACCOUNT_SID = 'ACtest';
  process.env.TWILIO_AUTH_TOKEN = 'tokentest';
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  delete process.env.TWILIO_ACCOUNT_SID;
  delete process.env.TWILIO_AUTH_TOKEN;
});

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function trackInsert(returning: Record<string, unknown>): void {
  // Two queries fire inside withTenant: BEGIN, then the INSERT, then COMMIT.
  // The test uses a sequential dispatcher.
  queryMock.mockImplementation(async (sql: string) => {
    const text = String(sql);
    if (text.startsWith('BEGIN') || text.startsWith('COMMIT') || text.startsWith('ROLLBACK')) {
      return { rows: [], rowCount: 0 };
    }
    if (text.includes('INSERT INTO verified_caller_ids')) {
      return { rows: [returning], rowCount: 1 };
    }
    if (text.includes('SELECT * FROM verified_caller_ids')) {
      return { rows: [returning], rowCount: 1 };
    }
    if (text.includes('UPDATE verified_caller_ids')) {
      return { rows: [{ ...returning, status: 'verified', verified_at: new Date().toISOString() }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  });
}

const STORED_ROW = {
  id: 'vc-1',
  tenant_id: 'tenant-A',
  phone_number: '+12125550123',
  friendly_name: 'Sales',
  status: 'pending',
  attestation_level: null,
  twilio_validation_sid: 'CA123',
  twilio_caller_sid: null,
  trust_hub_profile_sid: null,
  trust_product_sid: null,
  brand_sid: null,
  verification_code: '482931',
  verification_expires_at: new Date(Date.now() + 60_000).toISOString(),
  verified_at: null,
  rotated_at: null,
  rotated_to_id: null,
  registered_by_user_id: 'user-1',
  notes: null,
  metadata: {},
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
};

describe('startTwilioValidation response parsing', () => {
  it('reads the validation code from the Twilio root-level response', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(201, {
        account_sid: 'ACtest',
        sid: 'PNxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
        call_sid: 'CA123',
        phone_number: '+12125550123',
        friendly_name: 'Sales',
        validation_code: '482931',
      }),
    );
    trackInsert(STORED_ROW);

    const { registerCallerId } = await import('../../platform/telephony/TrustedCallerService');
    const result = await registerCallerId({
      tenantId: 'tenant-A',
      phoneNumber: '+12125550123',
      friendlyName: 'Sales',
      registeredByUserId: 'user-1',
    });

    expect(result.validationCode).toBe('482931');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('falls back to the nested validation_request shape if Twilio returns it', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(201, {
        validation_request: {
          account_sid: 'ACtest',
          call_sid: 'CA999',
          phone_number: '+12125550123',
          friendly_name: 'Sales',
          validation_code: '102030',
        },
      }),
    );
    trackInsert({ ...STORED_ROW, verification_code: '102030', twilio_validation_sid: 'CA999' });

    const { registerCallerId } = await import('../../platform/telephony/TrustedCallerService');
    const result = await registerCallerId({
      tenantId: 'tenant-A',
      phoneNumber: '+12125550123',
      friendlyName: 'Sales',
    });

    expect(result.validationCode).toBe('102030');
  });

  it('throws a clear error when Twilio responds without a validation code', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(201, { account_sid: 'ACtest', call_sid: 'CA000' }));

    const { registerCallerId } = await import('../../platform/telephony/TrustedCallerService');
    await expect(
      registerCallerId({
        tenantId: 'tenant-A',
        phoneNumber: '+12125550123',
      }),
    ).rejects.toThrow(/validation code/i);
  });

  it('surfaces Twilio HTTP errors back to the caller', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(400, { code: 21450, message: 'Invalid phone number' }));

    const { registerCallerId } = await import('../../platform/telephony/TrustedCallerService');
    await expect(
      registerCallerId({
        tenantId: 'tenant-A',
        phoneNumber: '+12125550123',
      }),
    ).rejects.toThrow(/Twilio rejected the verification request/);
  });
});

describe('confirmCallerIdVerified policy', () => {
  it('refuses to mark verified when Twilio has not registered the number', async () => {
    trackInsert(STORED_ROW);
    // First fetch is for OutgoingCallerIds GET — return an empty list.
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { outgoing_caller_ids: [] }));

    const { confirmCallerIdVerified } = await import('../../platform/telephony/TrustedCallerService');
    await expect(confirmCallerIdVerified('tenant-A', 'vc-1', { attestationLevel: 'A' })).rejects.toThrow(
      /Twilio has not yet recorded/i,
    );
  });

  it('does not let an admin-supplied attestation bypass the Twilio check', async () => {
    trackInsert(STORED_ROW);
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { outgoing_caller_ids: [] }));

    const { confirmCallerIdVerified } = await import('../../platform/telephony/TrustedCallerService');
    await expect(
      confirmCallerIdVerified('tenant-A', 'vc-1', {
        attestationLevel: 'A',
        trustProductSid: 'BU' + 'a'.repeat(32),
      }),
    ).rejects.toThrow(/Twilio has not yet recorded/i);
    // We hit Twilio exactly once — no DB UPDATE took place.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('refuses verification when no Twilio creds and no manual override is provided', async () => {
    delete process.env.TWILIO_ACCOUNT_SID;
    delete process.env.TWILIO_AUTH_TOKEN;
    trackInsert(STORED_ROW);

    const { confirmCallerIdVerified } = await import('../../platform/telephony/TrustedCallerService');
    await expect(confirmCallerIdVerified('tenant-A', 'vc-1', { attestationLevel: 'A' })).rejects.toThrow(
      /Twilio credentials are not configured/i,
    );
    // No Twilio call should have been made.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('requires a non-empty manualOverrideReason when bypassing Twilio', async () => {
    delete process.env.TWILIO_ACCOUNT_SID;
    delete process.env.TWILIO_AUTH_TOKEN;
    trackInsert(STORED_ROW);

    const { confirmCallerIdVerified } = await import('../../platform/telephony/TrustedCallerService');
    await expect(
      confirmCallerIdVerified('tenant-A', 'vc-1', { manualOverride: true, manualOverrideReason: '   ' }),
    ).rejects.toThrow(/manualOverride/i);
  });

  it('promotes to verified once Twilio confirms the OutgoingCallerIds row', async () => {
    trackInsert(STORED_ROW);
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        outgoing_caller_ids: [
          { sid: 'PN' + 'a'.repeat(32), phone_number: '+12125550123', friendly_name: 'Sales' },
        ],
      }),
    );

    const { confirmCallerIdVerified } = await import('../../platform/telephony/TrustedCallerService');
    const verified = await confirmCallerIdVerified('tenant-A', 'vc-1', { attestationLevel: 'A' });
    expect(verified.status).toBe('verified');
  });
});
