/** Tests for the Trust Hub orchestrator: HTTP call order, SID reuse, error mapping. */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import {
  submitTrustHubRegistration,
  fetchTrustHubStatus,
  simplifyStatus,
  TrustHubApiError,
  SHAKEN_CUSTOMER_PROFILE_POLICY_SID,
  SHAKEN_TRUST_PRODUCT_POLICY_SID,
  type TrustHubBusinessProfile,
  type BrandRegistrationInput,
} from '../../platform/telephony/TrustHubService';

const fetchMock = vi.fn();
const ORIGINAL_FETCH = globalThis.fetch;

beforeEach(() => {
  fetchMock.mockReset();
  globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
  process.env.TWILIO_ACCOUNT_SID = 'ACtest';
  process.env.TWILIO_AUTH_TOKEN = 'tokentest';
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  delete process.env.TWILIO_ACCOUNT_SID;
  delete process.env.TWILIO_AUTH_TOKEN;
});

function jsonOk(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function jsonErr(status: number, body: unknown): Response {
  return {
    ok: false,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

const baseProfile: TrustHubBusinessProfile = {
  legalName: 'Acme Robotics, Inc.',
  websiteUrl: 'https://acme.example',
  businessRegistrationNumber: '12-3456789',
  businessRegistrationIdType: 'EIN',
  businessIndustry: 'TECHNOLOGY',
  businessIdentityType: 'direct_customer',
  notificationEmail: 'compliance@acme.example',
  address: {
    street: '500 Market Street',
    city: 'San Francisco',
    region: 'CA',
    postalCode: '94110',
    isoCountry: 'US',
  },
  contact: {
    firstName: 'Jane',
    lastName: 'Doe',
    email: 'jane@acme.example',
    phoneNumber: '+14155550100',
    jobTitle: 'COO',
  },
};

const brandOff: BrandRegistrationInput = { enabled: false, brandType: 'STANDARD' };
const brandOn: BrandRegistrationInput = { enabled: true, brandType: 'STANDARD', mock: true };

describe('submitTrustHubRegistration', () => {
  it('throws when Twilio credentials are missing', async () => {
    delete process.env.TWILIO_ACCOUNT_SID;
    delete process.env.TWILIO_AUTH_TOKEN;
    await expect(
      submitTrustHubRegistration({ profile: baseProfile, brand: brandOff }),
    ).rejects.toThrow(/TWILIO_ACCOUNT_SID/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('drives Twilio in the carrier-required order: profile → endusers → submit → trust product → submit', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonOk({ sid: 'BU-cp', status: 'draft' })) // create CP
      .mockResolvedValueOnce(jsonOk({ sid: 'IT-biz' })) // business info enduser
      .mockResolvedValueOnce(jsonOk({})) // attach biz info
      .mockResolvedValueOnce(jsonOk({ sid: 'IT-addr' })) // address enduser
      .mockResolvedValueOnce(jsonOk({})) // attach addr
      .mockResolvedValueOnce(jsonOk({ sid: 'IT-rep' })) // rep enduser
      .mockResolvedValueOnce(jsonOk({})) // attach rep
      .mockResolvedValueOnce(jsonOk({ sid: 'BU-cp', status: 'pending-review' })) // PATCH submit CP
      .mockResolvedValueOnce(jsonOk({ sid: 'BU-tp', status: 'draft' })) // create TP
      .mockResolvedValueOnce(jsonOk({})) // attach CP -> TP
      .mockResolvedValueOnce(jsonOk({ sid: 'BU-tp', status: 'pending-review' })); // PATCH submit TP

    const result = await submitTrustHubRegistration({
      profile: baseProfile,
      brand: brandOff,
    });

    expect(result.submitted).toBe(true);
    expect(result.snapshot.customerProfile.sid).toBe('BU-cp');
    expect(result.snapshot.customerProfile.status).toBe('pending-review');
    expect(result.snapshot.trustProduct.sid).toBe('BU-tp');
    expect(result.snapshot.trustProduct.status).toBe('pending-review');
    expect(result.snapshot.brand).toBeNull();
    expect(result.snapshot.businessInfoEndUserSid).toBe('IT-biz');
    expect(result.snapshot.addressEndUserSid).toBe('IT-addr');
    expect(result.snapshot.representativeEndUserSid).toBe('IT-rep');

    // Walk the call sequence and assert the URLs (the carrier-mandated order).
    const calls = fetchMock.mock.calls.map(([url, init]) => ({
      url: url as string,
      method: (init as RequestInit).method,
      body: (init as RequestInit).body as string | undefined,
    }));
    expect(calls[0].url).toContain('/v1/CustomerProfiles');
    expect(calls[0].method).toBe('POST');
    expect(calls[0].body).toContain(`PolicySid=${encodeURIComponent(SHAKEN_CUSTOMER_PROFILE_POLICY_SID)}`);

    expect(calls[1].url).toContain('/v1/EndUsers');
    expect(calls[2].url).toContain('/v1/CustomerProfiles/BU-cp/EntityAssignments');
    expect(calls[3].url).toContain('/v1/EndUsers');
    expect(calls[4].url).toContain('/v1/CustomerProfiles/BU-cp/EntityAssignments');
    expect(calls[5].url).toContain('/v1/EndUsers');
    expect(calls[6].url).toContain('/v1/CustomerProfiles/BU-cp/EntityAssignments');

    expect(calls[7].url).toContain('/v1/CustomerProfiles/BU-cp');
    expect(calls[7].method).toBe('PATCH');
    expect(calls[7].body).toContain('Status=pending-review');

    expect(calls[8].url).toContain('/v1/TrustProducts');
    expect(calls[8].method).toBe('POST');
    expect(calls[8].body).toContain(`PolicySid=${encodeURIComponent(SHAKEN_TRUST_PRODUCT_POLICY_SID)}`);

    expect(calls[9].url).toContain('/v1/TrustProducts/BU-tp/EntityAssignments');
    expect(calls[10].method).toBe('PATCH');
    expect(calls[10].url).toContain('/v1/TrustProducts/BU-tp');
  });

  it('passes Basic auth header derived from Twilio credentials', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonOk({ sid: 'BU-cp', status: 'pending-review' }))
      .mockResolvedValueOnce(jsonOk({ sid: 'IT-biz' }))
      .mockResolvedValueOnce(jsonOk({}))
      .mockResolvedValueOnce(jsonOk({ sid: 'IT-addr' }))
      .mockResolvedValueOnce(jsonOk({}))
      .mockResolvedValueOnce(jsonOk({ sid: 'IT-rep' }))
      .mockResolvedValueOnce(jsonOk({}))
      .mockResolvedValueOnce(jsonOk({ sid: 'BU-tp', status: 'pending-review' }))
      .mockResolvedValueOnce(jsonOk({}));
    await submitTrustHubRegistration({ profile: baseProfile, brand: brandOff });
    const headers = (fetchMock.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
    const expected = `Basic ${Buffer.from('ACtest:tokentest').toString('base64')}`;
    expect(headers.Authorization).toBe(expected);
  });

  it('reuses SIDs from a prior partial run instead of re-creating bundles', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonOk({ sid: 'BU-existing-cp', status: 'pending-review' })) // GET CP
      .mockResolvedValueOnce(jsonOk({})) // attach existing biz info
      .mockResolvedValueOnce(jsonOk({})) // attach existing address
      .mockResolvedValueOnce(jsonOk({})) // attach existing rep
      // CP already pending-review so submitCustomerProfile is skipped.
      .mockResolvedValueOnce(jsonOk({ sid: 'BU-existing-tp', status: 'pending-review' })) // GET TP
      .mockResolvedValueOnce(jsonOk({})); // attach CP -> TP. TP already pending-review, no PATCH.

    const result = await submitTrustHubRegistration({
      profile: baseProfile,
      brand: brandOff,
      existing: {
        customerProfileSid: 'BU-existing-cp',
        businessInfoEndUserSid: 'IT-biz-existing',
        addressEndUserSid: 'IT-addr-existing',
        representativeEndUserSid: 'IT-rep-existing',
        trustProductSid: 'BU-existing-tp',
      },
    });

    expect(result.snapshot.customerProfile.sid).toBe('BU-existing-cp');
    expect(result.snapshot.trustProduct.sid).toBe('BU-existing-tp');
    expect(result.snapshot.businessInfoEndUserSid).toBe('IT-biz-existing');

    // Only 6 fetches: 2 GETs and 4 attaches. No POST /EndUsers, no PATCH submits.
    expect(fetchMock).toHaveBeenCalledTimes(6);
    const allUrls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(allUrls.some((u) => u.endsWith('/v1/EndUsers'))).toBe(false);
  });

  it('swallows 409 "already attached" responses on EntityAssignment so retries converge', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonOk({ sid: 'BU-cp', status: 'draft' })) // CP create
      .mockResolvedValueOnce(jsonOk({ sid: 'IT-biz' }))
      .mockResolvedValueOnce(jsonErr(409, { code: 22000, message: 'already attached' })) // attach biz - 409
      .mockResolvedValueOnce(jsonOk({ sid: 'IT-addr' }))
      .mockResolvedValueOnce(jsonOk({})) // attach addr
      .mockResolvedValueOnce(jsonOk({ sid: 'IT-rep' }))
      .mockResolvedValueOnce(jsonOk({})) // attach rep
      .mockResolvedValueOnce(jsonOk({ sid: 'BU-cp', status: 'pending-review' })) // submit CP
      .mockResolvedValueOnce(jsonOk({ sid: 'BU-tp', status: 'draft' })) // TP create
      .mockResolvedValueOnce(jsonErr(409, { code: 22000, message: 'already attached' })) // attach CP->TP 409
      .mockResolvedValueOnce(jsonOk({ sid: 'BU-tp', status: 'pending-review' })); // submit TP

    const result = await submitTrustHubRegistration({ profile: baseProfile, brand: brandOff });
    expect(result.submitted).toBe(true);
    expect(result.snapshot.customerProfile.status).toBe('pending-review');
    expect(result.snapshot.trustProduct.status).toBe('pending-review');
  });

  it('surfaces non-409 HTTP failures as TrustHubApiError', async () => {
    fetchMock.mockResolvedValueOnce(jsonErr(422, { code: 21610, message: 'Invalid policy' }));
    await expect(
      submitTrustHubRegistration({ profile: baseProfile, brand: brandOff }),
    ).rejects.toBeInstanceOf(TrustHubApiError);
  });

  it('discards a previously rejected brand registration and creates a fresh one on resubmit', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonOk({ sid: 'BU-cp', status: 'twilio-approved' })) // fetch CP
      .mockResolvedValueOnce(jsonOk({})) // attach business info
      .mockResolvedValueOnce(jsonOk({})) // attach address
      .mockResolvedValueOnce(jsonOk({})) // attach rep
      .mockResolvedValueOnce(jsonOk({ sid: 'BU-tp', status: 'twilio-approved' })) // fetch TP
      .mockResolvedValueOnce(jsonOk({})) // attach CP to TP
      .mockResolvedValueOnce(jsonOk({ sid: 'BN-old', status: 'FAILED' })) // fetch existing brand
      .mockResolvedValueOnce(jsonOk({ sid: 'BN-new', status: 'PENDING' })); // create new brand

    const result = await submitTrustHubRegistration({
      profile: baseProfile,
      brand: brandOn,
      existing: {
        customerProfileSid: 'BU-cp',
        trustProductSid: 'BU-tp',
        brandSid: 'BN-old',
        businessInfoEndUserSid: 'IT-biz',
        addressEndUserSid: 'IT-addr',
        representativeEndUserSid: 'IT-rep',
      },
    });

    expect(result.snapshot.brand?.sid).toBe('BN-new');
    expect(result.snapshot.brand?.status).toBe('PENDING');
    const lastCall = fetchMock.mock.calls[fetchMock.mock.calls.length - 1];
    expect(String(lastCall[0])).toContain('messaging.twilio.com/v1/a2p/BrandRegistrations');
    expect((lastCall[1] as RequestInit).method).toBe('POST');
  });

  it('creates a brand registration on the messaging base when brand.enabled', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonOk({ sid: 'BU-cp', status: 'draft' }))
      .mockResolvedValueOnce(jsonOk({ sid: 'IT-biz' }))
      .mockResolvedValueOnce(jsonOk({}))
      .mockResolvedValueOnce(jsonOk({ sid: 'IT-addr' }))
      .mockResolvedValueOnce(jsonOk({}))
      .mockResolvedValueOnce(jsonOk({ sid: 'IT-rep' }))
      .mockResolvedValueOnce(jsonOk({}))
      .mockResolvedValueOnce(jsonOk({ sid: 'BU-cp', status: 'pending-review' }))
      .mockResolvedValueOnce(jsonOk({ sid: 'BU-tp', status: 'draft' }))
      .mockResolvedValueOnce(jsonOk({}))
      .mockResolvedValueOnce(jsonOk({ sid: 'BU-tp', status: 'pending-review' }))
      .mockResolvedValueOnce(jsonOk({ sid: 'BN-brand', status: 'PENDING' })); // brand create

    const result = await submitTrustHubRegistration({
      profile: baseProfile,
      brand: brandOn,
    });

    expect(result.snapshot.brand?.sid).toBe('BN-brand');
    expect(result.snapshot.brand?.status).toBe('PENDING');
    const brandCall = fetchMock.mock.calls[fetchMock.mock.calls.length - 1];
    expect(String(brandCall[0])).toContain('messaging.twilio.com/v1/a2p/BrandRegistrations');
    const brandBody = String((brandCall[1] as RequestInit).body);
    expect(brandBody).toContain('CustomerProfileBundleSid=BU-cp');
    expect(brandBody).toContain('A2PProfileBundleSid=BU-tp');
    expect(brandBody).toContain('BrandType=STANDARD');
    expect(brandBody).toContain('Mock=true');
  });
});

describe('fetchTrustHubStatus', () => {
  it('returns null when Twilio credentials are missing', async () => {
    delete process.env.TWILIO_ACCOUNT_SID;
    const result = await fetchTrustHubStatus({ customerProfileSid: 'BU-x' });
    expect(result).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('parallel-fetches the three resources and consolidates the snapshot', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonOk({ sid: 'BU-cp', status: 'twilio-approved', valid_until: '2026-12-31' }))
      .mockResolvedValueOnce(jsonOk({ sid: 'BU-tp', status: 'twilio-approved' }))
      .mockResolvedValueOnce(jsonOk({ sid: 'BN-brand', status: 'APPROVED' }));

    const snap = await fetchTrustHubStatus({
      customerProfileSid: 'BU-cp',
      trustProductSid: 'BU-tp',
      brandSid: 'BN-brand',
    });
    expect(snap?.customerProfile.status).toBe('twilio-approved');
    expect(snap?.customerProfile.validUntil).toBe('2026-12-31');
    expect(snap?.trustProduct.sid).toBe('BU-tp');
    expect(snap?.brand?.status).toBe('APPROVED');
  });

  it('treats Twilio 404s as "deleted in console" and falls back to the stored SID with null status', async () => {
    // CP returns 404, TP returns 200 — the snapshot should still come back
    // populated, with the missing CP carrying the stored SID and a null status.
    fetchMock
      .mockResolvedValueOnce(jsonErr(404, { code: 20404, message: 'Not Found' }))
      .mockResolvedValueOnce(jsonOk({ sid: 'BU-tp', status: 'twilio-approved' }));
    const snap = await fetchTrustHubStatus({
      customerProfileSid: 'BU-gone',
      trustProductSid: 'BU-tp',
    });
    expect(snap).not.toBeNull();
    expect(snap?.customerProfile.sid).toBe('BU-gone');
    expect(snap?.customerProfile.status).toBeNull();
    expect(snap?.trustProduct.status).toBe('twilio-approved');
  });

  it('returns null when every requested resource is missing in Twilio', async () => {
    fetchMock.mockResolvedValueOnce(jsonErr(404, { message: 'Not Found' }));
    const snap = await fetchTrustHubStatus({ customerProfileSid: 'BU-gone' });
    expect(snap).toBeNull();
  });
});

describe('simplifyStatus', () => {
  it('maps Twilio lifecycle strings to the simplified vocabulary the UI renders', () => {
    expect(simplifyStatus('twilio-approved')).toBe('approved');
    expect(simplifyStatus('approved')).toBe('approved');
    expect(simplifyStatus('twilio-rejected')).toBe('rejected');
    expect(simplifyStatus('failed')).toBe('rejected');
    expect(simplifyStatus('in-review')).toBe('in-review');
    expect(simplifyStatus('pending-review')).toBe('pending-review');
    expect(simplifyStatus('draft')).toBe('draft');
    expect(simplifyStatus(null)).toBe('draft');
    expect(simplifyStatus('something-weird')).toBe('draft');
  });
});
