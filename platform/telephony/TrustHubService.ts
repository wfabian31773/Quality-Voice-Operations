/**
 * Wraps Twilio Trust Hub: creates a Customer Profile bundle, the
 * SHAKEN/STIR Trust Product, and an optional A2P Brand Registration.
 * Steps are idempotent via `existing` SIDs so retries don't duplicate
 * resources. No DB writes — persistence lives in TrustedCallerService.
 */
import { createLogger } from '../core/logger';

const logger = createLogger('TRUST_HUB');

// Twilio-published Policy SIDs for SHAKEN/STIR (Secondary Customer
// Profile of type Business + Trust Product).
export const SHAKEN_CUSTOMER_PROFILE_POLICY_SID =
  'RNdfbf3fae0e1107f8aded988d3201a2c1';
export const SHAKEN_TRUST_PRODUCT_POLICY_SID =
  'RN7a97559effdf62d00f4298208492a5ea';

const TRUST_HUB_BASE = 'https://trusthub.twilio.com/v1';
const MESSAGING_BASE = 'https://messaging.twilio.com/v1';

// ---- Domain types -----------------------------------------------------------

export type BusinessIdentityType =
  | 'direct_customer'
  | 'isv_reseller_or_partner';

export type BusinessRegistrationIdType =
  | 'EIN'
  | 'DUNS'
  | 'CCN'
  | 'CBN'
  | 'VAT'
  | 'Other';

export type BusinessIndustry =
  | 'AUTOMOTIVE'
  | 'AGRICULTURE'
  | 'BANKING'
  | 'CONSTRUCTION'
  | 'CONSUMER'
  | 'EDUCATION'
  | 'ENGINEERING'
  | 'ENERGY'
  | 'OIL_AND_GAS'
  | 'FAST_MOVING_CONSUMER_GOODS'
  | 'FINANCIAL'
  | 'FINTECH'
  | 'FOOD_AND_BEVERAGE'
  | 'GOVERNMENT'
  | 'HEALTHCARE'
  | 'HOSPITALITY'
  | 'INSURANCE'
  | 'LEGAL'
  | 'MANUFACTURING'
  | 'MEDIA'
  | 'ONLINE'
  | 'PROFESSIONAL_SERVICES'
  | 'RAW_MATERIALS'
  | 'REAL_ESTATE'
  | 'RELIGION'
  | 'RETAIL'
  | 'JEWELRY'
  | 'TECHNOLOGY'
  | 'TELECOMMUNICATIONS'
  | 'TRANSPORTATION'
  | 'TRAVEL'
  | 'ELECTRONICS'
  | 'NOT_FOR_PROFIT';

export type BrandType = 'STANDARD' | 'STARTER' | 'SOLE_PROPRIETOR';

export interface BusinessAddress {
  street: string;
  street2?: string;
  city: string;
  region: string;
  postalCode: string;
  isoCountry: string;
}

export interface AuthorizedContact {
  firstName: string;
  lastName: string;
  email: string;
  phoneNumber: string;
  jobTitle: string;
  businessTitle?: string;
}

export interface TrustHubBusinessProfile {
  legalName: string;
  websiteUrl: string;
  businessRegistrationNumber: string;
  businessRegistrationIdType: BusinessRegistrationIdType;
  businessIndustry: BusinessIndustry;
  businessIdentityType: BusinessIdentityType;
  notificationEmail: string;
  address: BusinessAddress;
  contact: AuthorizedContact;
}

export interface BrandRegistrationInput {
  /** Skip A2P brand registration when the operator only needs voice. */
  enabled: boolean;
  brandType: BrandType;
  /** When true, the brand can be used for low-volume / SHAKEN-only traffic. */
  mock?: boolean;
}

export interface ExistingTrustHubSids {
  customerProfileSid?: string | null;
  businessInfoEndUserSid?: string | null;
  addressEndUserSid?: string | null;
  representativeEndUserSid?: string | null;
  trustProductSid?: string | null;
  brandSid?: string | null;
}

export interface TrustHubResourceSnapshot {
  sid: string | null;
  status: string | null;
  failureReason?: string | null;
  validUntil?: string | null;
}

export interface TrustHubSnapshot {
  customerProfile: TrustHubResourceSnapshot;
  trustProduct: TrustHubResourceSnapshot;
  brand: TrustHubResourceSnapshot | null;
  businessInfoEndUserSid: string | null;
  addressEndUserSid: string | null;
  representativeEndUserSid: string | null;
  lastSubmittedAt?: string | null;
  lastSyncedAt?: string | null;
}

// ---- HTTP plumbing ----------------------------------------------------------

interface TwilioCreds {
  accountSid: string;
  authToken: string;
}

function getTwilioCreds(): TwilioCreds | null {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  if (!accountSid || !authToken) return null;
  return { accountSid, authToken };
}

function authHeader(creds: TwilioCreds): string {
  return `Basic ${Buffer.from(`${creds.accountSid}:${creds.authToken}`).toString('base64')}`;
}

async function trustHubFetch<T>(
  creds: TwilioCreds,
  path: string,
  init: { method: 'GET' | 'POST' | 'PATCH' | 'DELETE'; body?: URLSearchParams } = { method: 'GET' },
  baseUrl: string = TRUST_HUB_BASE,
): Promise<T> {
  const url = `${baseUrl}${path}`;
  const headers: Record<string, string> = {
    Authorization: authHeader(creds),
    Accept: 'application/json',
  };
  if (init.body) headers['Content-Type'] = 'application/x-www-form-urlencoded';
  const response = await fetch(url, {
    method: init.method,
    headers,
    body: init.body?.toString(),
  });
  if (!response.ok) {
    let body = '';
    try {
      body = (await response.text()).slice(0, 500);
    } catch {
      body = '';
    }
    throw new TrustHubApiError(response.status, init.method, path, body);
  }
  return (await response.json()) as T;
}

export class TrustHubApiError extends Error {
  constructor(
    public httpStatus: number,
    public httpMethod: string,
    public requestPath: string,
    public responseBody: string,
  ) {
    super(`Twilio Trust Hub ${httpMethod} ${requestPath} failed with ${httpStatus}: ${responseBody}`);
    this.name = 'TrustHubApiError';
  }
}

// ---- Twilio response shapes -------------------------------------------------

interface CustomerProfileResponse {
  sid: string;
  status?: string;
  friendly_name?: string;
  policy_sid?: string;
  valid_until?: string | null;
  failure_reason?: string | null;
}

interface EndUserResponse {
  sid: string;
  type?: string;
  attributes?: Record<string, unknown>;
}

interface TrustProductResponse {
  sid: string;
  status?: string;
  friendly_name?: string;
  valid_until?: string | null;
  failure_reason?: string | null;
}

interface BrandRegistrationResponse {
  sid: string;
  status?: string;
  failure_reason?: string | null;
  brand_score?: number | null;
}

// ---- Step helpers (exported for testing) ------------------------------------

export async function createCustomerProfile(
  creds: TwilioCreds,
  profile: TrustHubBusinessProfile,
): Promise<CustomerProfileResponse> {
  const body = new URLSearchParams({
    FriendlyName: `QVO ${profile.legalName} Customer Profile`,
    Email: profile.notificationEmail,
    PolicySid: SHAKEN_CUSTOMER_PROFILE_POLICY_SID,
  });
  return trustHubFetch<CustomerProfileResponse>(creds, '/CustomerProfiles', {
    method: 'POST',
    body,
  });
}

export async function createBusinessInfoEndUser(
  creds: TwilioCreds,
  profile: TrustHubBusinessProfile,
): Promise<EndUserResponse> {
  const attributes = {
    business_name: profile.legalName,
    business_type: 'Private', // sole-prop, partnership, llc, private, public
    business_registration_number: profile.businessRegistrationNumber,
    business_registration_identifier: profile.businessRegistrationIdType,
    business_identity: profile.businessIdentityType,
    business_industry: profile.businessIndustry,
    business_regions_of_operation: ['USA_AND_CANADA'],
    website_url: profile.websiteUrl,
  };
  const body = new URLSearchParams({
    FriendlyName: `QVO ${profile.legalName} Business Info`,
    Type: 'customer_profile_business_information',
    Attributes: JSON.stringify(attributes),
  });
  return trustHubFetch<EndUserResponse>(creds, '/EndUsers', { method: 'POST', body });
}

export async function createAddressEndUser(
  creds: TwilioCreds,
  profile: TrustHubBusinessProfile,
): Promise<EndUserResponse> {
  const attributes = {
    business_name: profile.legalName,
    address_street: profile.address.street,
    address_street_secondary: profile.address.street2 ?? '',
    address_city: profile.address.city,
    address_subdivision: profile.address.region,
    address_postal_code: profile.address.postalCode,
    address_iso_country: profile.address.isoCountry,
  };
  const body = new URLSearchParams({
    FriendlyName: `QVO ${profile.legalName} Address`,
    Type: 'customer_profile_address',
    Attributes: JSON.stringify(attributes),
  });
  return trustHubFetch<EndUserResponse>(creds, '/EndUsers', { method: 'POST', body });
}

export async function createAuthorizedRepresentativeEndUser(
  creds: TwilioCreds,
  profile: TrustHubBusinessProfile,
): Promise<EndUserResponse> {
  const attributes = {
    first_name: profile.contact.firstName,
    last_name: profile.contact.lastName,
    email: profile.contact.email,
    phone_number: profile.contact.phoneNumber,
    business_title: profile.contact.businessTitle ?? profile.contact.jobTitle,
    job_position: profile.contact.jobTitle,
  };
  const body = new URLSearchParams({
    FriendlyName: `QVO ${profile.contact.firstName} ${profile.contact.lastName}`,
    Type: 'authorized_representative_1',
    Attributes: JSON.stringify(attributes),
  });
  return trustHubFetch<EndUserResponse>(creds, '/EndUsers', { method: 'POST', body });
}

export async function attachEntityToCustomerProfile(
  creds: TwilioCreds,
  customerProfileSid: string,
  objectSid: string,
): Promise<void> {
  const body = new URLSearchParams({ ObjectSid: objectSid });
  try {
    await trustHubFetch(
      creds,
      `/CustomerProfiles/${encodeURIComponent(customerProfileSid)}/EntityAssignments`,
      { method: 'POST', body },
    );
  } catch (err) {
    // Twilio returns 409 when the entity is already attached. That's a
    // perfectly fine no-op for our retries — a partial run that already
    // created the assignment shouldn't fail the whole flow.
    if (err instanceof TrustHubApiError && err.httpStatus === 409) return;
    throw err;
  }
}

export async function attachEntityToTrustProduct(
  creds: TwilioCreds,
  trustProductSid: string,
  objectSid: string,
): Promise<void> {
  const body = new URLSearchParams({ ObjectSid: objectSid });
  try {
    await trustHubFetch(
      creds,
      `/TrustProducts/${encodeURIComponent(trustProductSid)}/EntityAssignments`,
      { method: 'POST', body },
    );
  } catch (err) {
    if (err instanceof TrustHubApiError && err.httpStatus === 409) return;
    throw err;
  }
}

export async function submitCustomerProfile(
  creds: TwilioCreds,
  customerProfileSid: string,
): Promise<CustomerProfileResponse> {
  const body = new URLSearchParams({ Status: 'pending-review' });
  return trustHubFetch<CustomerProfileResponse>(
    creds,
    `/CustomerProfiles/${encodeURIComponent(customerProfileSid)}`,
    { method: 'PATCH', body },
  );
}

export async function fetchCustomerProfile(
  creds: TwilioCreds,
  customerProfileSid: string,
): Promise<CustomerProfileResponse | null> {
  try {
    return await trustHubFetch<CustomerProfileResponse>(
      creds,
      `/CustomerProfiles/${encodeURIComponent(customerProfileSid)}`,
    );
  } catch (err) {
    if (err instanceof TrustHubApiError && err.httpStatus === 404) return null;
    throw err;
  }
}

export async function createTrustProduct(
  creds: TwilioCreds,
  profile: TrustHubBusinessProfile,
): Promise<TrustProductResponse> {
  const body = new URLSearchParams({
    FriendlyName: `QVO ${profile.legalName} SHAKEN/STIR`,
    Email: profile.notificationEmail,
    PolicySid: SHAKEN_TRUST_PRODUCT_POLICY_SID,
  });
  return trustHubFetch<TrustProductResponse>(creds, '/TrustProducts', {
    method: 'POST',
    body,
  });
}

export async function submitTrustProduct(
  creds: TwilioCreds,
  trustProductSid: string,
): Promise<TrustProductResponse> {
  const body = new URLSearchParams({ Status: 'pending-review' });
  return trustHubFetch<TrustProductResponse>(
    creds,
    `/TrustProducts/${encodeURIComponent(trustProductSid)}`,
    { method: 'PATCH', body },
  );
}

export async function fetchTrustProduct(
  creds: TwilioCreds,
  trustProductSid: string,
): Promise<TrustProductResponse | null> {
  try {
    return await trustHubFetch<TrustProductResponse>(
      creds,
      `/TrustProducts/${encodeURIComponent(trustProductSid)}`,
    );
  } catch (err) {
    if (err instanceof TrustHubApiError && err.httpStatus === 404) return null;
    throw err;
  }
}

export async function createBrandRegistration(
  creds: TwilioCreds,
  customerProfileSid: string,
  trustProductSid: string,
  brand: BrandRegistrationInput,
): Promise<BrandRegistrationResponse> {
  const body = new URLSearchParams({
    CustomerProfileBundleSid: customerProfileSid,
    A2PProfileBundleSid: trustProductSid,
    BrandType: brand.brandType,
  });
  if (brand.mock) body.set('Mock', 'true');
  return trustHubFetch<BrandRegistrationResponse>(
    creds,
    '/a2p/BrandRegistrations',
    { method: 'POST', body },
    MESSAGING_BASE,
  );
}

export async function fetchBrandRegistration(
  creds: TwilioCreds,
  brandSid: string,
): Promise<BrandRegistrationResponse | null> {
  try {
    return await trustHubFetch<BrandRegistrationResponse>(
      creds,
      `/a2p/BrandRegistrations/${encodeURIComponent(brandSid)}`,
      { method: 'GET' },
      MESSAGING_BASE,
    );
  } catch (err) {
    if (err instanceof TrustHubApiError && err.httpStatus === 404) return null;
    throw err;
  }
}

// ---- Orchestrator -----------------------------------------------------------

export interface SubmitTrustHubInput {
  profile: TrustHubBusinessProfile;
  brand: BrandRegistrationInput;
  /** SIDs from a previous partial run; reused to avoid duplicate creation. */
  existing?: ExistingTrustHubSids;
}

export interface SubmitTrustHubResult {
  snapshot: TrustHubSnapshot;
  submitted: boolean;
}

/** Run the full Trust Hub flow; idempotent when `existing` SIDs are supplied. */
export async function submitTrustHubRegistration(
  input: SubmitTrustHubInput,
): Promise<SubmitTrustHubResult> {
  const creds = getTwilioCreds();
  if (!creds) {
    throw new Error(
      'TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN are not configured. Trust Hub registration requires Twilio credentials.',
    );
  }

  const existing = input.existing ?? {};

  let customerProfile: CustomerProfileResponse;
  if (existing.customerProfileSid) {
    const fetched = await fetchCustomerProfile(creds, existing.customerProfileSid);
    if (!fetched) {
      throw new Error(
        `Existing Customer Profile ${existing.customerProfileSid} no longer exists at Twilio.`,
      );
    }
    customerProfile = fetched;
  } else {
    customerProfile = await createCustomerProfile(creds, input.profile);
    logger.info('Trust Hub Customer Profile created', {
      sid: customerProfile.sid,
      legalName: input.profile.legalName,
    });
  }

  const businessInfoSid = existing.businessInfoEndUserSid
    ?? (await createBusinessInfoEndUser(creds, input.profile)).sid;
  await attachEntityToCustomerProfile(creds, customerProfile.sid, businessInfoSid);

  const addressSid = existing.addressEndUserSid
    ?? (await createAddressEndUser(creds, input.profile)).sid;
  await attachEntityToCustomerProfile(creds, customerProfile.sid, addressSid);

  const representativeSid = existing.representativeEndUserSid
    ?? (await createAuthorizedRepresentativeEndUser(creds, input.profile)).sid;
  await attachEntityToCustomerProfile(creds, customerProfile.sid, representativeSid);

  // Submit Customer Profile (no-op when already pending-review/approved).
  let cpStatus = (customerProfile.status ?? '').toLowerCase();
  if (cpStatus === '' || cpStatus === 'draft' || cpStatus === 'twilio-rejected') {
    customerProfile = await submitCustomerProfile(creds, customerProfile.sid);
    cpStatus = (customerProfile.status ?? '').toLowerCase();
    logger.info('Trust Hub Customer Profile submitted', {
      sid: customerProfile.sid,
      status: customerProfile.status,
    });
  }

  let trustProduct: TrustProductResponse;
  if (existing.trustProductSid) {
    const fetched = await fetchTrustProduct(creds, existing.trustProductSid);
    if (!fetched) {
      throw new Error(
        `Existing Trust Product ${existing.trustProductSid} no longer exists at Twilio.`,
      );
    }
    trustProduct = fetched;
  } else {
    trustProduct = await createTrustProduct(creds, input.profile);
    logger.info('Trust Hub Trust Product created', { sid: trustProduct.sid });
  }
  await attachEntityToTrustProduct(creds, trustProduct.sid, customerProfile.sid);

  let tpStatus = (trustProduct.status ?? '').toLowerCase();
  if (tpStatus === '' || tpStatus === 'draft' || tpStatus === 'twilio-rejected') {
    trustProduct = await submitTrustProduct(creds, trustProduct.sid);
    tpStatus = (trustProduct.status ?? '').toLowerCase();
    logger.info('Trust Hub Trust Product submitted', {
      sid: trustProduct.sid,
      status: trustProduct.status,
    });
  }

  let brand: BrandRegistrationResponse | null = null;
  if (input.brand.enabled) {
    if (existing.brandSid) {
      brand = await fetchBrandRegistration(creds, existing.brandSid);
      const status = (brand?.status ?? '').toUpperCase();
      if (status === 'FAILED' || status === 'REJECTED') {
        logger.info('A2P Brand Registration was rejected, creating a fresh registration', {
          previousBrandSid: brand?.sid,
          status,
        });
        brand = null;
      }
    }
    if (!brand) {
      brand = await createBrandRegistration(creds, customerProfile.sid, trustProduct.sid, input.brand);
      logger.info('A2P Brand Registration created', {
        sid: brand.sid,
        brandType: input.brand.brandType,
      });
    }
  }

  return {
    submitted: true,
    snapshot: {
      customerProfile: {
        sid: customerProfile.sid,
        status: customerProfile.status ?? null,
        validUntil: customerProfile.valid_until ?? null,
        failureReason: customerProfile.failure_reason ?? null,
      },
      trustProduct: {
        sid: trustProduct.sid,
        status: trustProduct.status ?? null,
        validUntil: trustProduct.valid_until ?? null,
        failureReason: trustProduct.failure_reason ?? null,
      },
      brand: brand
        ? {
            sid: brand.sid,
            status: brand.status ?? null,
            failureReason: brand.failure_reason ?? null,
          }
        : null,
      businessInfoEndUserSid: businessInfoSid,
      addressEndUserSid: addressSid,
      representativeEndUserSid: representativeSid,
    },
  };
}

/** Refresh a Trust Hub snapshot from Twilio without mutating anything. */
export async function fetchTrustHubStatus(
  sids: ExistingTrustHubSids,
): Promise<TrustHubSnapshot | null> {
  const creds = getTwilioCreds();
  if (!creds) return null;

  const [cp, tp, brand] = await Promise.all([
    sids.customerProfileSid ? fetchCustomerProfile(creds, sids.customerProfileSid) : Promise.resolve(null),
    sids.trustProductSid ? fetchTrustProduct(creds, sids.trustProductSid) : Promise.resolve(null),
    sids.brandSid ? fetchBrandRegistration(creds, sids.brandSid) : Promise.resolve(null),
  ]);

  if (!cp && !tp && !brand) return null;

  return {
    customerProfile: {
      sid: cp?.sid ?? sids.customerProfileSid ?? null,
      status: cp?.status ?? null,
      validUntil: cp?.valid_until ?? null,
      failureReason: cp?.failure_reason ?? null,
    },
    trustProduct: {
      sid: tp?.sid ?? sids.trustProductSid ?? null,
      status: tp?.status ?? null,
      validUntil: tp?.valid_until ?? null,
      failureReason: tp?.failure_reason ?? null,
    },
    brand: sids.brandSid
      ? {
          sid: brand?.sid ?? sids.brandSid,
          status: brand?.status ?? null,
          failureReason: brand?.failure_reason ?? null,
        }
      : null,
    businessInfoEndUserSid: sids.businessInfoEndUserSid ?? null,
    addressEndUserSid: sids.addressEndUserSid ?? null,
    representativeEndUserSid: sids.representativeEndUserSid ?? null,
  };
}

/** Collapse Twilio's many lifecycle strings into the badge vocabulary the UI uses. */
export type SimpleTrustHubStatus =
  | 'draft'
  | 'pending-review'
  | 'in-review'
  | 'approved'
  | 'rejected';

export function simplifyStatus(status: string | null | undefined): SimpleTrustHubStatus {
  const value = (status ?? '').toLowerCase();
  if (value === 'twilio-approved' || value === 'approved') return 'approved';
  if (value === 'twilio-rejected' || value === 'rejected' || value === 'failed') return 'rejected';
  if (value === 'in-review') return 'in-review';
  if (value === 'pending-review') return 'pending-review';
  return 'draft';
}
