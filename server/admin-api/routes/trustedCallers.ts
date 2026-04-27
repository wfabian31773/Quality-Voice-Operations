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
  isE164,
  type AttestationLevel,
} from '../../../platform/telephony/TrustedCallerService';

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
