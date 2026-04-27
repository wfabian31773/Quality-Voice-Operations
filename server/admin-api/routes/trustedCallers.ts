import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { requireRole } from '../middleware/rbac';
import { createLogger } from '../../../platform/core/logger';
import { writeAuditLog, extractIp } from '../../../platform/audit/AuditService';
import {
  registerCallerId,
  listCallerIds,
  getCallerId,
  deleteCallerId,
  rotateCallerId,
  confirmCallerIdVerified,
  syncCallerIdStatus,
  attachTrustHubRegistration,
  readTrustHubSnapshot,
  isE164,
  type AttestationLevel,
} from '../../../platform/telephony/TrustedCallerService';
import {
  submitTrustHubRegistration,
  fetchTrustHubStatus,
  TrustHubApiError,
  type BrandRegistrationInput,
  type BrandType,
  type BusinessIndustry,
  type BusinessRegistrationIdType,
  type BusinessIdentityType,
  type TrustHubBusinessProfile,
} from '../../../platform/telephony/TrustHubService';

const router = Router();
const logger = createLogger('ADMIN_TRUSTED_CALLERS');

const MAX_FRIENDLY_NAME = 120;
const MAX_NOTES = 1000;
const ATTESTATION_VALUES: AttestationLevel[] = ['A', 'B', 'C'];

function badInput(field: string, hint: string) {
  return { error: `${field} ${hint}` };
}

function validateOptionalString(value: unknown, max: number): true | string {
  if (value === undefined || value === null) return true;
  if (typeof value !== 'string') return 'must be a string';
  if (value.length > max) return `must be ≤ ${max} characters`;
  return true;
}

function validateOptionalSid(value: unknown, prefix: string): true | string {
  if (value === undefined || value === null || value === '') return true;
  if (typeof value !== 'string') return 'must be a string';
  if (!new RegExp(`^${prefix}[A-Za-z0-9]{32}$`).test(value)) {
    return `must be a Twilio SID starting with ${prefix} (34 chars total)`;
  }
  return true;
}

router.get('/trusted-callers', requireAuth, async (req, res) => {
  const { tenantId } = req.user!;
  const includeRotated = String(req.query.includeRotated ?? '') === 'true';
  try {
    const callers = await listCallerIds(tenantId, { includeRotated });
    return res.json({ callers });
  } catch (err) {
    logger.error('Failed to list trusted callers', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to list trusted callers' });
  }
});

router.get('/trusted-callers/:id', requireAuth, async (req, res) => {
  const { tenantId } = req.user!;
  try {
    const caller = await getCallerId(tenantId, req.params.id);
    if (!caller) return res.status(404).json({ error: 'Trusted caller not found' });
    return res.json({ caller });
  } catch (err) {
    logger.error('Failed to fetch trusted caller', { tenantId, id: req.params.id, error: String(err) });
    return res.status(500).json({ error: 'Failed to fetch trusted caller' });
  }
});

router.post('/trusted-callers', requireAuth, requireRole('manager'), async (req, res) => {
  const { tenantId } = req.user!;
  const body = req.body as Record<string, unknown>;
  const phoneNumber = typeof body.phoneNumber === 'string' ? body.phoneNumber.trim() : '';
  const friendlyName = typeof body.friendlyName === 'string' ? body.friendlyName.trim() : undefined;

  if (!phoneNumber) return res.status(400).json(badInput('phoneNumber', 'is required'));
  if (!isE164(phoneNumber)) return res.status(400).json(badInput('phoneNumber', 'must be in E.164 format (e.g. +12125550123)'));

  const friendlyCheck = validateOptionalString(friendlyName, MAX_FRIENDLY_NAME);
  if (friendlyCheck !== true) return res.status(400).json(badInput('friendlyName', friendlyCheck));

  const notesCheck = validateOptionalString(body.notes, MAX_NOTES);
  if (notesCheck !== true) return res.status(400).json(badInput('notes', notesCheck));

  for (const [field, prefix] of [
    ['trustHubProfileSid', 'BU'],
    ['trustProductSid', 'BU'],
    ['brandSid', 'BN'],
  ] as const) {
    const check = validateOptionalSid(body[field], prefix);
    if (check !== true) return res.status(400).json(badInput(field, check));
  }

  try {
    const caller = await registerCallerId({
      tenantId,
      phoneNumber,
      friendlyName,
      registeredByUserId: req.user!.userId,
      notes: typeof body.notes === 'string' ? body.notes : undefined,
      trustHubProfileSid: typeof body.trustHubProfileSid === 'string' ? body.trustHubProfileSid : undefined,
      trustProductSid: typeof body.trustProductSid === 'string' ? body.trustProductSid : undefined,
      brandSid: typeof body.brandSid === 'string' ? body.brandSid : undefined,
    });

    await writeAuditLog({
      tenantId,
      actorUserId: req.user!.userId,
      actorRole: req.user!.role,
      action: 'trusted_caller.registered',
      resourceType: 'trusted_caller',
      resourceId: caller.id,
      afterState: { phoneNumber, friendlyName: friendlyName ?? null },
      ipAddress: extractIp(req),
      userAgent: req.headers['user-agent'],
    });

    return res.status(201).json({
      caller,
      validationCode: caller.validationCode,
      message: caller.validationCode
        ? 'Twilio is calling the number now. Answer and enter the validation code on the keypad to complete verification.'
        : 'Caller ID recorded as pending. Configure Twilio credentials to start the verification call.',
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error('Failed to register trusted caller', { tenantId, phoneNumber, error: message });
    return res.status(message.includes('Twilio') ? 502 : 500).json({ error: message });
  }
});

router.post('/trusted-callers/:id/verify', requireAuth, requireRole('manager'), async (req, res) => {
  const { tenantId } = req.user!;
  const body = (req.body ?? {}) as Record<string, unknown>;

  if (body.attestationLevel !== undefined && !ATTESTATION_VALUES.includes(body.attestationLevel as AttestationLevel)) {
    return res.status(400).json(badInput('attestationLevel', `must be one of: ${ATTESTATION_VALUES.join(', ')}`));
  }

  for (const [field, prefix] of [
    ['trustHubProfileSid', 'BU'],
    ['trustProductSid', 'BU'],
    ['brandSid', 'BN'],
  ] as const) {
    const check = validateOptionalSid(body[field], prefix);
    if (check !== true) return res.status(400).json(badInput(field, check));
  }

  // Manual override is reserved for owners running without Twilio creds (e.g.
  // self-hosted dev environments). The service still records the reason in
  // the audit log, but we restrict the route entry point to owners so a
  // manager cannot bypass STIR/SHAKEN trust in production.
  const manualOverride = body.manualOverride === true;
  const manualOverrideReason =
    typeof body.manualOverrideReason === 'string' ? body.manualOverrideReason.trim() : '';
  if (manualOverride) {
    if (req.user!.role !== 'tenant_owner' && req.user!.role !== 'platform_admin') {
      return res.status(403).json({ error: 'Only owners can manually verify a caller ID without Twilio confirmation.' });
    }
    if (!manualOverrideReason) {
      return res.status(400).json(badInput('manualOverrideReason', 'is required when manualOverride is true'));
    }
  }

  try {
    const caller = await confirmCallerIdVerified(tenantId, req.params.id, {
      attestationLevel: (body.attestationLevel as AttestationLevel) ?? undefined,
      trustHubProfileSid: typeof body.trustHubProfileSid === 'string' ? body.trustHubProfileSid : undefined,
      trustProductSid: typeof body.trustProductSid === 'string' ? body.trustProductSid : undefined,
      brandSid: typeof body.brandSid === 'string' ? body.brandSid : undefined,
      manualOverride,
      manualOverrideReason: manualOverrideReason || undefined,
    });

    await writeAuditLog({
      tenantId,
      actorUserId: req.user!.userId,
      actorRole: req.user!.role,
      action: manualOverride ? 'trusted_caller.verified_manual_override' : 'trusted_caller.verified',
      resourceType: 'trusted_caller',
      resourceId: caller.id,
      afterState: {
        attestationLevel: caller.attestationLevel,
        manualOverride: manualOverride || undefined,
        reason: manualOverride ? manualOverrideReason : undefined,
      },
      severity: manualOverride ? 'warning' : 'info',
      ipAddress: extractIp(req),
      userAgent: req.headers['user-agent'],
    });

    return res.json({ caller });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn('Trusted caller verify failed', { tenantId, id: req.params.id, error: message });
    return res.status(message.includes('not yet') ? 409 : 400).json({ error: message });
  }
});

router.post('/trusted-callers/:id/sync', requireAuth, async (req, res) => {
  const { tenantId } = req.user!;
  try {
    const caller = await syncCallerIdStatus(tenantId, req.params.id);
    return res.json({ caller });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return res.status(404).json({ error: message });
  }
});

router.post('/trusted-callers/:id/rotate', requireAuth, requireRole('manager'), async (req, res) => {
  const { tenantId } = req.user!;
  const body = (req.body ?? {}) as Record<string, unknown>;
  const phoneNumber = typeof body.phoneNumber === 'string' ? body.phoneNumber.trim() : '';
  const friendlyName = typeof body.friendlyName === 'string' ? body.friendlyName.trim() : undefined;

  if (!phoneNumber) return res.status(400).json(badInput('phoneNumber', 'is required'));
  if (!isE164(phoneNumber)) return res.status(400).json(badInput('phoneNumber', 'must be in E.164 format'));

  const friendlyCheck = validateOptionalString(friendlyName, MAX_FRIENDLY_NAME);
  if (friendlyCheck !== true) return res.status(400).json(badInput('friendlyName', friendlyCheck));

  try {
    const result = await rotateCallerId(tenantId, req.params.id, {
      tenantId,
      phoneNumber,
      friendlyName,
      registeredByUserId: req.user!.userId,
      notes: typeof body.notes === 'string' ? body.notes : undefined,
    });

    await writeAuditLog({
      tenantId,
      actorUserId: req.user!.userId,
      actorRole: req.user!.role,
      action: 'trusted_caller.rotated',
      resourceType: 'trusted_caller',
      resourceId: result.replacement.id,
      changes: { fromId: result.retired.id, fromPhone: result.retired.phoneNumber, toPhone: result.replacement.phoneNumber },
      ipAddress: extractIp(req),
      userAgent: req.headers['user-agent'],
    });

    return res.status(201).json({
      retired: result.retired,
      replacement: result.replacement,
      validationCode: result.replacement.validationCode,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error('Failed to rotate trusted caller', { tenantId, id: req.params.id, error: message });
    return res.status(message === 'Caller ID not found' ? 404 : 500).json({ error: message });
  }
});

// ----------------------------------------------------------------------------
// Trust Hub registration
// ----------------------------------------------------------------------------

const VALID_REGISTRATION_ID_TYPES: BusinessRegistrationIdType[] = [
  'EIN', 'DUNS', 'CCN', 'CBN', 'VAT', 'Other',
];

const VALID_BRAND_TYPES: BrandType[] = ['STANDARD', 'STARTER', 'SOLE_PROPRIETOR'];

const VALID_IDENTITY_TYPES: BusinessIdentityType[] = ['direct_customer', 'isv_reseller_or_partner'];

const VALID_INDUSTRIES: BusinessIndustry[] = [
  'AUTOMOTIVE', 'AGRICULTURE', 'BANKING', 'CONSTRUCTION', 'CONSUMER',
  'EDUCATION', 'ENGINEERING', 'ENERGY', 'OIL_AND_GAS',
  'FAST_MOVING_CONSUMER_GOODS', 'FINANCIAL', 'FINTECH', 'FOOD_AND_BEVERAGE',
  'GOVERNMENT', 'HEALTHCARE', 'HOSPITALITY', 'INSURANCE', 'LEGAL',
  'MANUFACTURING', 'MEDIA', 'ONLINE', 'PROFESSIONAL_SERVICES', 'RAW_MATERIALS',
  'REAL_ESTATE', 'RELIGION', 'RETAIL', 'JEWELRY', 'TECHNOLOGY',
  'TELECOMMUNICATIONS', 'TRANSPORTATION', 'TRAVEL', 'ELECTRONICS',
  'NOT_FOR_PROFIT',
];

function isNonEmptyString(value: unknown, max = 200): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max;
}

function isValidEmail(value: unknown): value is string {
  return typeof value === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function isValidUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    const u = new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

function parseTrustHubProfile(body: Record<string, unknown>):
  | { ok: true; profile: TrustHubBusinessProfile }
  | { ok: false; field: string; message: string } {
  const profile = body.profile as Record<string, unknown> | undefined;
  if (!profile || typeof profile !== 'object') {
    return { ok: false, field: 'profile', message: 'is required' };
  }
  if (!isNonEmptyString(profile.legalName)) return { ok: false, field: 'profile.legalName', message: 'is required' };
  if (!isValidUrl(profile.websiteUrl)) return { ok: false, field: 'profile.websiteUrl', message: 'must be a valid http(s) URL' };
  if (!isNonEmptyString(profile.businessRegistrationNumber, 64)) return { ok: false, field: 'profile.businessRegistrationNumber', message: 'is required' };
  if (!VALID_REGISTRATION_ID_TYPES.includes(profile.businessRegistrationIdType as BusinessRegistrationIdType)) {
    return { ok: false, field: 'profile.businessRegistrationIdType', message: `must be one of: ${VALID_REGISTRATION_ID_TYPES.join(', ')}` };
  }
  if (!VALID_INDUSTRIES.includes(profile.businessIndustry as BusinessIndustry)) {
    return { ok: false, field: 'profile.businessIndustry', message: 'must be a Twilio-supported industry' };
  }
  if (!VALID_IDENTITY_TYPES.includes(profile.businessIdentityType as BusinessIdentityType)) {
    return { ok: false, field: 'profile.businessIdentityType', message: 'must be direct_customer or isv_reseller_or_partner' };
  }
  if (!isValidEmail(profile.notificationEmail)) return { ok: false, field: 'profile.notificationEmail', message: 'must be a valid email' };

  const address = profile.address as Record<string, unknown> | undefined;
  if (!address || typeof address !== 'object') return { ok: false, field: 'profile.address', message: 'is required' };
  if (!isNonEmptyString(address.street)) return { ok: false, field: 'profile.address.street', message: 'is required' };
  if (!isNonEmptyString(address.city)) return { ok: false, field: 'profile.address.city', message: 'is required' };
  if (!isNonEmptyString(address.region)) return { ok: false, field: 'profile.address.region', message: 'is required' };
  if (!isNonEmptyString(address.postalCode)) return { ok: false, field: 'profile.address.postalCode', message: 'is required' };
  if (!isNonEmptyString(address.isoCountry) || (address.isoCountry as string).length !== 2) {
    return { ok: false, field: 'profile.address.isoCountry', message: 'must be a 2-letter ISO country code' };
  }

  const contact = profile.contact as Record<string, unknown> | undefined;
  if (!contact || typeof contact !== 'object') return { ok: false, field: 'profile.contact', message: 'is required' };
  if (!isNonEmptyString(contact.firstName)) return { ok: false, field: 'profile.contact.firstName', message: 'is required' };
  if (!isNonEmptyString(contact.lastName)) return { ok: false, field: 'profile.contact.lastName', message: 'is required' };
  if (!isValidEmail(contact.email)) return { ok: false, field: 'profile.contact.email', message: 'must be a valid email' };
  if (!isNonEmptyString(contact.phoneNumber) || !isE164(contact.phoneNumber as string)) {
    return { ok: false, field: 'profile.contact.phoneNumber', message: 'must be in E.164 format' };
  }
  if (!isNonEmptyString(contact.jobTitle)) return { ok: false, field: 'profile.contact.jobTitle', message: 'is required' };

  return {
    ok: true,
    profile: {
      legalName: (profile.legalName as string).trim(),
      websiteUrl: (profile.websiteUrl as string).trim(),
      businessRegistrationNumber: (profile.businessRegistrationNumber as string).trim(),
      businessRegistrationIdType: profile.businessRegistrationIdType as BusinessRegistrationIdType,
      businessIndustry: profile.businessIndustry as BusinessIndustry,
      businessIdentityType: profile.businessIdentityType as BusinessIdentityType,
      notificationEmail: (profile.notificationEmail as string).trim(),
      address: {
        street: (address.street as string).trim(),
        street2: typeof address.street2 === 'string' ? address.street2.trim() : undefined,
        city: (address.city as string).trim(),
        region: (address.region as string).trim(),
        postalCode: (address.postalCode as string).trim(),
        isoCountry: (address.isoCountry as string).trim().toUpperCase(),
      },
      contact: {
        firstName: (contact.firstName as string).trim(),
        lastName: (contact.lastName as string).trim(),
        email: (contact.email as string).trim(),
        phoneNumber: (contact.phoneNumber as string).trim(),
        jobTitle: (contact.jobTitle as string).trim(),
        businessTitle: typeof contact.businessTitle === 'string' ? contact.businessTitle.trim() : undefined,
      },
    },
  };
}

function parseBrand(body: Record<string, unknown>):
  | { ok: true; brand: BrandRegistrationInput }
  | { ok: false; field: string; message: string } {
  const raw = (body.brand as Record<string, unknown> | undefined) ?? {};
  const enabled = raw.enabled === true;
  if (!enabled) return { ok: true, brand: { enabled: false, brandType: 'STANDARD' } };
  if (!VALID_BRAND_TYPES.includes(raw.brandType as BrandType)) {
    return { ok: false, field: 'brand.brandType', message: `must be one of: ${VALID_BRAND_TYPES.join(', ')}` };
  }
  return {
    ok: true,
    brand: {
      enabled: true,
      brandType: raw.brandType as BrandType,
      mock: raw.mock === true,
    },
  };
}

router.post(
  '/trusted-callers/:id/trust-hub',
  requireAuth,
  requireRole('manager'),
  async (req, res) => {
    const { tenantId } = req.user!;
    const body = (req.body ?? {}) as Record<string, unknown>;

    const caller = await getCallerId(tenantId, req.params.id).catch(() => null);
    if (!caller) return res.status(404).json({ error: 'Trusted caller not found' });

    const profileResult = parseTrustHubProfile(body);
    if (!profileResult.ok) return res.status(400).json({ error: `${profileResult.field} ${profileResult.message}` });

    const brandResult = parseBrand(body);
    if (!brandResult.ok) return res.status(400).json({ error: `${brandResult.field} ${brandResult.message}` });

    // Reuse SIDs from any prior partial run so we don't double-register
    // (Twilio bills per Customer Profile / Brand registration).
    const previous = readTrustHubSnapshot(caller);
    let existing;
    if (previous) {
      existing = {
        customerProfileSid: previous.customerProfile.sid,
        businessInfoEndUserSid: previous.businessInfoEndUserSid,
        addressEndUserSid: previous.addressEndUserSid,
        representativeEndUserSid: previous.representativeEndUserSid,
        trustProductSid: previous.trustProduct.sid,
        brandSid: previous.brand?.sid ?? null,
      };
    } else if (caller.trustHubProfileSid || caller.trustProductSid || caller.brandSid) {
      existing = {
        customerProfileSid: caller.trustHubProfileSid ?? null,
        businessInfoEndUserSid: null,
        addressEndUserSid: null,
        representativeEndUserSid: null,
        trustProductSid: caller.trustProductSid ?? null,
        brandSid: caller.brandSid ?? null,
      };
    }

    try {
      const result = await submitTrustHubRegistration({
        profile: profileResult.profile,
        brand: brandResult.brand,
        existing,
      });

      const updated = await attachTrustHubRegistration(tenantId, caller.id, result.snapshot);

      await writeAuditLog({
        tenantId,
        actorUserId: req.user!.userId,
        actorRole: req.user!.role,
        action: 'trusted_caller.trust_hub_submitted',
        resourceType: 'trusted_caller',
        resourceId: caller.id,
        afterState: {
          customerProfileSid: result.snapshot.customerProfile.sid,
          trustProductSid: result.snapshot.trustProduct.sid,
          brandSid: result.snapshot.brand?.sid ?? null,
        },
        ipAddress: extractIp(req),
        userAgent: req.headers['user-agent'],
      });

      return res.status(201).json({
        caller: updated,
        trustHub: result.snapshot,
        message: 'Trust Hub bundles submitted to Twilio for review.',
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error('Trust Hub submission failed', { tenantId, callerId: caller.id, error: message });
      const httpStatus = err instanceof TrustHubApiError ? 502 : 500;
      return res.status(httpStatus).json({ error: message });
    }
  },
);

router.get('/trusted-callers/:id/trust-hub', requireAuth, async (req, res) => {
  const { tenantId } = req.user!;
  try {
    const caller = await getCallerId(tenantId, req.params.id);
    if (!caller) return res.status(404).json({ error: 'Trusted caller not found' });

    const stored = readTrustHubSnapshot(caller);
    if (!stored) {
      return res.json({ stored: null, live: null, effective: null, caller });
    }

    let live: typeof stored | null = null;
    try {
      live = await fetchTrustHubStatus({
        customerProfileSid: stored.customerProfile.sid,
        trustProductSid: stored.trustProduct.sid,
        brandSid: stored.brand?.sid ?? null,
        businessInfoEndUserSid: stored.businessInfoEndUserSid,
        addressEndUserSid: stored.addressEndUserSid,
        representativeEndUserSid: stored.representativeEndUserSid,
      });
    } catch (err) {
      logger.warn('Trust Hub live status fetch failed', {
        tenantId,
        callerId: caller.id,
        error: String(err),
      });
    }

    let updatedCaller = caller;
    if (
      live
      && (live.customerProfile.status !== stored.customerProfile.status
        || live.trustProduct.status !== stored.trustProduct.status
        || (live.brand?.status ?? null) !== (stored.brand?.status ?? null))
    ) {
      updatedCaller = await attachTrustHubRegistration(tenantId, caller.id, live, { source: 'sync' });
    }

    return res.json({ stored, live, effective: live ?? stored, caller: updatedCaller });
  } catch (err) {
    logger.error('Failed to fetch trust hub status', { tenantId, id: req.params.id, error: String(err) });
    return res.status(500).json({ error: 'Failed to fetch trust hub status' });
  }
});

router.delete('/trusted-callers/:id', requireAuth, requireRole('manager'), async (req, res) => {
  const { tenantId } = req.user!;
  try {
    const deleted = await deleteCallerId(tenantId, req.params.id);
    if (!deleted) return res.status(404).json({ error: 'Trusted caller not found' });

    await writeAuditLog({
      tenantId,
      actorUserId: req.user!.userId,
      actorRole: req.user!.role,
      action: 'trusted_caller.deleted',
      resourceType: 'trusted_caller',
      resourceId: req.params.id,
      severity: 'warning',
      ipAddress: extractIp(req),
      userAgent: req.headers['user-agent'],
    });

    return res.json({ deleted: true });
  } catch (err) {
    logger.error('Failed to delete trusted caller', { tenantId, id: req.params.id, error: String(err) });
    return res.status(500).json({ error: 'Failed to delete trusted caller' });
  }
});

export default router;
