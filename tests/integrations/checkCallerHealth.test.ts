import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// `checkCallerHealth` reads TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN at call
// time (via the module-private `getTwilioCreds`). We toggle them per-suite
// to also exercise the "no creds" branch.
const ORIGINAL_SID = process.env.TWILIO_ACCOUNT_SID;
const ORIGINAL_TOKEN = process.env.TWILIO_AUTH_TOKEN;

const fetchMock = vi.fn();

beforeEach(() => {
  process.env.TWILIO_ACCOUNT_SID = 'ACtestsidtestsidtestsidtestsidtest';
  process.env.TWILIO_AUTH_TOKEN = 'testtoken';
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  if (ORIGINAL_SID === undefined) delete process.env.TWILIO_ACCOUNT_SID;
  else process.env.TWILIO_ACCOUNT_SID = ORIGINAL_SID;
  if (ORIGINAL_TOKEN === undefined) delete process.env.TWILIO_AUTH_TOKEN;
  else process.env.TWILIO_AUTH_TOKEN = ORIGINAL_TOKEN;
  vi.unstubAllGlobals();
});

import { checkCallerHealth } from '../../platform/telephony/TrustedCallerService';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const phoneNumber = '+12125550123';

describe('checkCallerHealth', () => {
  it('returns unknown when Twilio creds are missing (no alerts on misconfig)', async () => {
    delete process.env.TWILIO_ACCOUNT_SID;
    delete process.env.TWILIO_AUTH_TOKEN;
    const result = await checkCallerHealth({
      phoneNumber,
      trustProductSid: null,
      brandSid: null,
    });
    expect(result.status).toBe('unknown');
    expect(result.demoteAttestation).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns revoked when Twilio no longer reports the OutgoingCallerIds row', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ outgoing_caller_ids: [] }));

    const result = await checkCallerHealth({
      phoneNumber,
      trustProductSid: null,
      brandSid: null,
    });

    expect(result.status).toBe('revoked');
    expect(result.demoteAttestation).toBe(true);
    expect(result.message).toContain('OutgoingCallerIds');
  });

  it('returns healthy when OutgoingCallerIds present and no Trust Hub linkage', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        outgoing_caller_ids: [{ phone_number: phoneNumber, sid: 'PNxxxx' }],
      }),
    );

    const result = await checkCallerHealth({
      phoneNumber,
      trustProductSid: null,
      brandSid: null,
    });
    expect(result.status).toBe('healthy');
    expect(result.expiresAt).toBeNull();
  });

  it('returns expiring_soon when Trust Hub product valid_until is within threshold', async () => {
    const validUntil = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          outgoing_caller_ids: [{ phone_number: phoneNumber, sid: 'PNxxxx' }],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          sid: 'BUprod',
          status: 'twilio-approved',
          valid_until: validUntil,
        }),
      );

    const result = await checkCallerHealth({
      phoneNumber,
      trustProductSid: 'BUprod',
      brandSid: null,
    });

    expect(result.status).toBe('expiring_soon');
    expect(result.expiresAt?.toISOString()).toBe(validUntil);
    expect(result.demoteAttestation).toBe(false);
  });

  it('returns expired when Trust Hub valid_until has passed', async () => {
    const validUntil = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          outgoing_caller_ids: [{ phone_number: phoneNumber, sid: 'PNxxxx' }],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          sid: 'BUprod',
          status: 'twilio-approved',
          valid_until: validUntil,
        }),
      );

    const result = await checkCallerHealth({
      phoneNumber,
      trustProductSid: 'BUprod',
      brandSid: null,
    });

    expect(result.status).toBe('expired');
    expect(result.demoteAttestation).toBe(false);
  });

  it('returns revoked when Trust Hub product is twilio-rejected', async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          outgoing_caller_ids: [{ phone_number: phoneNumber, sid: 'PNxxxx' }],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          sid: 'BUprod',
          status: 'twilio-rejected',
          valid_until: null,
        }),
      );

    const result = await checkCallerHealth({
      phoneNumber,
      trustProductSid: 'BUprod',
      brandSid: null,
    });

    expect(result.status).toBe('revoked');
    expect(result.demoteAttestation).toBe(true);
  });

  it('returns revoked when Trust Hub product 404s (deleted on Twilio side)', async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          outgoing_caller_ids: [{ phone_number: phoneNumber, sid: 'PNxxxx' }],
        }),
      )
      .mockResolvedValueOnce(new Response('not found', { status: 404 }));

    const result = await checkCallerHealth({
      phoneNumber,
      trustProductSid: 'BUprod',
      brandSid: null,
    });

    expect(result.status).toBe('revoked');
    expect(result.demoteAttestation).toBe(true);
  });

  it('returns unknown when Trust Hub returns a transient 5xx (no spurious alerts)', async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          outgoing_caller_ids: [{ phone_number: phoneNumber, sid: 'PNxxxx' }],
        }),
      )
      .mockResolvedValueOnce(new Response('upstream', { status: 502 }));

    const result = await checkCallerHealth({
      phoneNumber,
      trustProductSid: 'BUprod',
      brandSid: null,
    });

    expect(result.status).toBe('unknown');
    expect(result.demoteAttestation).toBe(false);
  });

  it('returns revoked when brand registration is FAILED', async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          outgoing_caller_ids: [{ phone_number: phoneNumber, sid: 'PNxxxx' }],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          sid: 'BNbrand',
          status: 'FAILED',
        }),
      );

    const result = await checkCallerHealth({
      phoneNumber,
      trustProductSid: null,
      brandSid: 'BNbrand',
    });

    expect(result.status).toBe('revoked');
    expect(result.demoteAttestation).toBe(true);
  });

  it('returns unknown when OutgoingCallerIds lookup throws (network error)', async () => {
    fetchMock.mockRejectedValueOnce(new Error('ECONNRESET'));

    const result = await checkCallerHealth({
      phoneNumber,
      trustProductSid: null,
      brandSid: null,
    });

    expect(result.status).toBe('unknown');
    expect(result.demoteAttestation).toBe(false);
    expect(result.message).toContain('OutgoingCallerIds');
  });

  it('returns unknown — NOT revoked — on a transient OutgoingCallerIds 500 (no false demotion)', async () => {
    fetchMock.mockResolvedValueOnce(new Response('upstream boom', { status: 500 }));

    const result = await checkCallerHealth({
      phoneNumber,
      trustProductSid: null,
      brandSid: null,
    });

    expect(result.status).toBe('unknown');
    expect(result.demoteAttestation).toBe(false);
    expect(result.message).toContain('500');
  });

  it('returns unknown — NOT revoked — on an OutgoingCallerIds 429 rate-limit', async () => {
    fetchMock.mockResolvedValueOnce(new Response('rate limited', { status: 429 }));

    const result = await checkCallerHealth({
      phoneNumber,
      trustProductSid: null,
      brandSid: null,
    });

    expect(result.status).toBe('unknown');
    expect(result.demoteAttestation).toBe(false);
    expect(result.message).toContain('429');
  });

  it('returns unknown — NOT revoked — on an OutgoingCallerIds 401 (auth misconfig)', async () => {
    fetchMock.mockResolvedValueOnce(new Response('unauthorized', { status: 401 }));

    const result = await checkCallerHealth({
      phoneNumber,
      trustProductSid: null,
      brandSid: null,
    });

    expect(result.status).toBe('unknown');
    expect(result.demoteAttestation).toBe(false);
    expect(result.message).toContain('401');
  });

  it('treats an OutgoingCallerIds 404 as genuinely missing -> revoked', async () => {
    fetchMock.mockResolvedValueOnce(new Response('not found', { status: 404 }));

    const result = await checkCallerHealth({
      phoneNumber,
      trustProductSid: null,
      brandSid: null,
    });

    expect(result.status).toBe('revoked');
    expect(result.demoteAttestation).toBe(true);
  });
});
