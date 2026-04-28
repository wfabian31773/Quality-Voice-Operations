import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { requireRole } from '../middleware/rbac';
import { createLogger } from '../../../platform/core/logger';
import { writeAuditLog, extractIp } from '../../../platform/audit/AuditService';
import {
  createCampaign,
  getCampaign,
  listCampaigns,
  updateCampaign,
  deleteCampaign,
  getCampaignMetrics,
  getTypeSpecificMetrics,
  updateContactTypeDisposition,
  addContacts,
  listContacts,
  addToDnc,
  listDnc,
  removeFromDnc,
  getAllCampaignTypes,
  getValidCampaignTypes,
  isValidDisposition,
  checkCampaignCompliance,
  findDncMatchingContactIds,
  bulkMarkOptedOut,
} from '../../../platform/campaigns';
import type { CampaignStatus, CampaignConfig } from '../../../platform/campaigns';
import { getVerifiedCallerById } from '../../../platform/telephony/TrustedCallerService';

function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') {
        current += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        current += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      fields.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  fields.push(current);
  return fields;
}

const router = Router();
const logger = createLogger('ADMIN_CAMPAIGNS');

function getValidTimezones(): string[] {
  try {
    return (Intl as unknown as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf?.('timeZone') ?? [];
  } catch {
    return [];
  }
}
const VALID_TIMEZONES = getValidTimezones();

function validateScheduleConfig(config?: unknown): string | null {
  if (config === undefined || config === null) return null;
  // The payload comes from `req.body`, so even though the route hands us
  // something it claims is a `CampaignConfig`, we treat it as `unknown` and
  // narrow with explicit guards. Anything we accept here flows back out as a
  // typed `CampaignConfig` for the rest of the route.
  if (typeof config !== 'object' || Array.isArray(config)) {
    return 'config must be an object';
  }
  const raw = config as Record<string, unknown>;
  const {
    timezone, callWindowStart, callWindowEnd, daysOfWeek,
    maxConcurrentCalls, maxAttempts, retryDelayMinutes,
    respectContactTimezone, areaCodeTimezones, verifiedCallerId,
  } = raw;

  if (verifiedCallerId !== undefined && verifiedCallerId !== null && typeof verifiedCallerId !== 'string') {
    return 'config.verifiedCallerId must be a string id or null';
  }

  if (timezone !== undefined) {
    if (typeof timezone !== 'string') return 'config.timezone must be a string';
    if (VALID_TIMEZONES.length > 0 && !VALID_TIMEZONES.includes(timezone)) {
      return `config.timezone "${timezone}" is not a recognized timezone`;
    }
  }

  const timeRe = /^([01]\d|2[0-3]):[0-5]\d$/;
  if (callWindowStart !== undefined && (typeof callWindowStart !== 'string' || !timeRe.test(callWindowStart))) {
    return 'config.callWindowStart must be HH:MM format (00:00-23:59)';
  }
  if (callWindowEnd !== undefined && (typeof callWindowEnd !== 'string' || !timeRe.test(callWindowEnd))) {
    return 'config.callWindowEnd must be HH:MM format (00:00-23:59)';
  }
  if (typeof callWindowStart === 'string' && typeof callWindowEnd === 'string' && callWindowStart >= callWindowEnd) {
    return 'config.callWindowStart must be before config.callWindowEnd';
  }

  if (daysOfWeek !== undefined) {
    if (!Array.isArray(daysOfWeek) || daysOfWeek.some((d) => typeof d !== 'number' || d < 0 || d > 6)) {
      return 'config.daysOfWeek must be an array of day numbers 0-6';
    }
  }

  if (maxConcurrentCalls !== undefined && (typeof maxConcurrentCalls !== 'number' || maxConcurrentCalls < 1 || maxConcurrentCalls > 50)) {
    return 'config.maxConcurrentCalls must be a number between 1 and 50';
  }
  if (maxAttempts !== undefined && (typeof maxAttempts !== 'number' || maxAttempts < 1 || maxAttempts > 10)) {
    return 'config.maxAttempts must be a number between 1 and 10';
  }
  if (retryDelayMinutes !== undefined && (typeof retryDelayMinutes !== 'number' || retryDelayMinutes < 1)) {
    return 'config.retryDelayMinutes must be a positive number';
  }
  if (respectContactTimezone !== undefined && typeof respectContactTimezone !== 'boolean') {
    return 'config.respectContactTimezone must be a boolean';
  }
  if (areaCodeTimezones !== undefined) {
    if (typeof areaCodeTimezones !== 'object' || areaCodeTimezones === null || Array.isArray(areaCodeTimezones)) {
      return 'config.areaCodeTimezones must be an object mapping area codes to timezones';
    }
    for (const [area, tz] of Object.entries(areaCodeTimezones)) {
      if (!/^\d{3}$/.test(area)) return `config.areaCodeTimezones key "${area}" must be a 3-digit area code`;
      if (typeof tz !== 'string') return `config.areaCodeTimezones["${area}"] must be a string`;
      if (VALID_TIMEZONES.length > 0 && !VALID_TIMEZONES.includes(tz)) {
        return `config.areaCodeTimezones["${area}"] is not a recognized timezone`;
      }
    }
  }

  return null;
}

function paginate(req: { query: Record<string, unknown> }): { limit: number; offset: number } {
  const limit = Math.min(parseInt(String(req.query.limit ?? '20'), 10), 100);
  const page = Math.max(parseInt(String(req.query.page ?? '1'), 10), 1);
  return { limit, offset: (page - 1) * limit };
}

function parseE164(phone: string): string | null {
  const cleaned = phone.replace(/\D/g, '');
  if (cleaned.length === 10) return `+1${cleaned}`;
  if (cleaned.length === 11 && cleaned.startsWith('1')) return `+${cleaned}`;
  if (cleaned.length > 7 && phone.startsWith('+')) return phone;
  return null;
}

export const listCampaignsHandler: import('express').RequestHandler = async (req, res) => {
  const { tenantId } = req.user!;
  const { limit, offset } = paginate(req);
  const { status } = req.query as Record<string, string>;

  try {
    const result = await listCampaigns(tenantId, { limit, offset, status: status as CampaignStatus });
    return res.json(result);
  } catch (err) {
    logger.error('Failed to list campaigns', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to list campaigns' });
  }
};

router.get('/campaigns', requireAuth, listCampaignsHandler);

router.get('/campaigns/types', requireAuth, (_req, res) => {
  const types = getAllCampaignTypes();
  return res.json({ types });
});

router.post('/campaigns', requireAuth, requireRole('manager'), async (req, res) => {
  const { tenantId } = req.user!;
  const { agentId, name, type, config, scheduledAt } = req.body as {
    agentId?: string;
    name?: string;
    type?: string;
    config?: CampaignConfig;
    scheduledAt?: string;
  };

  if (!agentId || !name) {
    return res.status(400).json({ error: 'agentId and name are required' });
  }

  const validTypes = getValidCampaignTypes();
  if (type && !validTypes.includes(type)) {
    return res.status(400).json({ error: `type must be one of: ${validTypes.join(', ')}` });
  }

  const configErrors = validateScheduleConfig(config);
  if (configErrors) {
    return res.status(400).json({ error: configErrors });
  }

  try {
    const campaign = await createCampaign({
      tenantId,
      agentId,
      name,
      type: type || 'outbound_call',
      config,
      scheduledAt: scheduledAt ? new Date(scheduledAt) : undefined,
    });
    logger.info('Campaign created via API', { tenantId, campaignId: campaign.id });
    await writeAuditLog({
      tenantId,
      actorUserId: req.user!.userId,
      actorRole: req.user!.role,
      action: 'campaign.created',
      resourceType: 'campaign',
      resourceId: campaign.id,
      afterState: { name, type: type || 'outbound_call', agentId },
      ipAddress: extractIp(req),
      userAgent: req.headers['user-agent'],
    });
    return res.status(201).json({ campaign });
  } catch (err) {
    logger.error('Failed to create campaign', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to create campaign' });
  }
});

router.get('/campaigns/dnc', requireAuth, requireRole('manager'), async (req, res) => {
  const { tenantId } = req.user!;
  const limit = Math.min(parseInt(String(req.query.limit ?? '50'), 10), 200);
  const page = Math.max(parseInt(String(req.query.page ?? '1'), 10), 1);
  const offset = (page - 1) * limit;

  try {
    const result = await listDnc(tenantId, { limit, offset });
    return res.json(result);
  } catch (err) {
    logger.error('Failed to list DNC entries', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to list DNC entries' });
  }
});

router.post('/campaigns/dnc', requireAuth, requireRole('manager'), async (req, res) => {
  const { tenantId } = req.user!;
  const { phone, reason } = req.body as { phone?: string; reason?: string };

  if (!phone || typeof phone !== 'string') {
    return res.status(400).json({ error: 'phone is required' });
  }

  const e164 = parseE164(phone);
  if (!e164) {
    return res.status(400).json({ error: 'Invalid phone number format' });
  }

  try {
    const added = await addToDnc(tenantId, e164, 'manual', reason);
    return res.status(added ? 201 : 200).json({ added, phoneNumber: e164 });
  } catch (err) {
    logger.error('Failed to add to DNC', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to add to DNC list' });
  }
});

router.delete('/campaigns/dnc', requireAuth, requireRole('manager'), async (req, res) => {
  const { tenantId } = req.user!;
  const { phone } = req.body as { phone?: string };

  if (!phone || typeof phone !== 'string') {
    return res.status(400).json({ error: 'phone is required' });
  }

  const e164 = parseE164(phone);
  if (!e164) {
    return res.status(400).json({ error: 'Invalid phone number format' });
  }

  try {
    const removed = await removeFromDnc(tenantId, e164);
    return res.json({ removed });
  } catch (err) {
    logger.error('Failed to remove from DNC', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to remove from DNC list' });
  }
});

router.get('/campaigns/:id', requireAuth, async (req, res) => {
  const { tenantId } = req.user!;
  const { id } = req.params;

  try {
    const campaign = await getCampaign(tenantId, id);
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
    return res.json({ campaign });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to retrieve campaign' });
  }
});

router.patch('/campaigns/:id', requireAuth, requireRole('manager'), async (req, res) => {
  const { tenantId } = req.user!;
  const { id } = req.params;
  const { name, status, config, scheduledAt } = req.body as {
    name?: string;
    status?: string;
    config?: CampaignConfig;
    scheduledAt?: string;
  };

  const allowedStatuses: CampaignStatus[] = ['draft', 'scheduled', 'running', 'paused', 'cancelled'];
  if (status && !allowedStatuses.includes(status as CampaignStatus)) {
    return res.status(400).json({ error: `status must be one of: ${allowedStatuses.join(', ')}` });
  }

  if (status === 'running' || status === 'scheduled') {
    const userId = req.user!.userId;
    const pool = (await import('../../../platform/db')).getPlatformPool();
    const { rows: userRows } = await pool.query(
      `SELECT phone_verified FROM users WHERE id = $1`,
      [userId],
    );
    if (userRows.length > 0 && !(userRows[0].phone_verified as boolean)) {
      return res.status(403).json({
        error: 'Phone verification required before activating outbound campaigns. Verify your phone number in Settings.',
      });
    }

    const existingCampaign = await getCampaign(tenantId, id);
    const mergedConfig: CampaignConfig = {
      ...(existingCampaign?.config ?? {}),
      ...(config ?? {}),
    };
    const verifiedCallerIdCfg = mergedConfig.verifiedCallerId;
    if (typeof verifiedCallerIdCfg === 'string' && verifiedCallerIdCfg.length > 0) {
      const verified = await getVerifiedCallerById(tenantId, verifiedCallerIdCfg);
      if (!verified) {
        return res.status(400).json({
          error: 'The selected verified caller ID is missing or has not finished verification. Confirm verification from Trusted Callers.',
        });
      }
    }
  }

  const configErrors = validateScheduleConfig(config);
  if (configErrors) {
    return res.status(400).json({ error: configErrors });
  }

  // TCPA compliance pre-flight: block any transition that would put the
  // campaign into the dialer queue while DNC-listed numbers are still in the
  // contact list. We pull the existing campaign so the merged config (current
  // + incoming patch) reflects whatever quiet-hours settings the caller is
  // saving in this same request.
  if (status === 'running' || status === 'scheduled') {
    const existing = await getCampaign(tenantId, id);
    if (!existing) return res.status(404).json({ error: 'Campaign not found' });
    const mergedConfig = { ...existing.config, ...(config ?? {}) };
    const compliance = await checkCampaignCompliance(tenantId, id, { config: mergedConfig });
    if (!compliance.ok) {
      logger.warn('Campaign launch blocked by compliance check', {
        tenantId,
        campaignId: id,
        dncMatches: compliance.dncMatchCount,
        tenantDncMatches: compliance.tenantDncMatchCount,
        federalDncMatches: compliance.federalDncMatchCount,
        federalDncRegistryVersion: compliance.federalDncRegistryVersion,
        score: compliance.complianceScore,
      });
      await writeAuditLog({
        tenantId,
        actorUserId: req.user!.userId,
        actorRole: req.user!.role,
        action: 'campaign.launch_blocked',
        resourceType: 'campaign',
        resourceId: id,
        severity: 'warning',
        afterState: {
          dncMatchCount: compliance.dncMatchCount,
          tenantDncMatchCount: compliance.tenantDncMatchCount,
          federalDncMatchCount: compliance.federalDncMatchCount,
          federalDncRegistryVersion: compliance.federalDncRegistryVersion,
          complianceScore: compliance.complianceScore,
        },
        ipAddress: extractIp(req),
        userAgent: req.headers['user-agent'],
      });
      // Build a launch-blocked message that distinguishes tenant vs federal
      // matches so the operator immediately knows whether they need to
      // remove from their own DNC list, or scrub against the FTC registry.
      let launchBlockedMessage: string;
      if (compliance.dncMatchCount > 0) {
        const fragments: string[] = [];
        if (compliance.tenantDncMatchCount > 0) {
          fragments.push(`${compliance.tenantDncMatchCount} on tenant DNC`);
        }
        if (compliance.federalDncMatchCount > 0) {
          fragments.push(`${compliance.federalDncMatchCount} on federal DNC registry`);
        }
        launchBlockedMessage = `Cannot launch — ${compliance.dncMatchCount} contact${compliance.dncMatchCount === 1 ? '' : 's'} on do-not-call lists (${fragments.join(', ')}). Remove the listed numbers and try again.`;
      } else {
        launchBlockedMessage = 'Cannot launch — campaign has no contacts to dial.';
      }
      return res.status(409).json({
        error: launchBlockedMessage,
        compliance,
      });
    }
  }

  try {
    const campaign = await updateCampaign(tenantId, id, {
      name,
      status: status as CampaignStatus | undefined,
      config,
      scheduledAt: scheduledAt ? new Date(scheduledAt) : undefined,
    });
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
    logger.info('Campaign updated via API', { tenantId, campaignId: id, status });
    return res.json({ campaign });
  } catch (err) {
    logger.error('Failed to update campaign', { tenantId, campaignId: id, error: String(err) });
    return res.status(500).json({ error: 'Failed to update campaign' });
  }
});

router.delete('/campaigns/:id', requireAuth, requireRole('manager'), async (req, res) => {
  const { tenantId } = req.user!;
  const { id } = req.params;

  try {
    const deleted = await deleteCampaign(tenantId, id);
    if (!deleted) {
      return res.status(400).json({ error: 'Campaign not found or cannot be deleted (must be draft or cancelled)' });
    }
    logger.info('Campaign deleted', { tenantId, campaignId: id });
    await writeAuditLog({
      tenantId,
      actorUserId: req.user!.userId,
      actorRole: req.user!.role,
      action: 'campaign.deleted',
      resourceType: 'campaign',
      resourceId: id,
      severity: 'warning',
      ipAddress: extractIp(req),
      userAgent: req.headers['user-agent'],
    });
    return res.json({ deleted: true });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to delete campaign' });
  }
});

export const getCampaignMetricsHandler: import('express').RequestHandler = async (req, res) => {
  const { tenantId } = req.user!;
  const { id } = req.params;

  try {
    const metrics = await getCampaignMetrics(tenantId, id);
    return res.json({ campaignId: id, metrics });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to retrieve campaign metrics' });
  }
};

router.get('/campaigns/:id/metrics', requireAuth, getCampaignMetricsHandler);

router.get('/campaigns/:id/compliance', requireAuth, async (req, res) => {
  const { tenantId } = req.user!;
  const { id } = req.params;

  try {
    const campaign = await getCampaign(tenantId, id);
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
    const compliance = await checkCampaignCompliance(tenantId, id, { config: campaign.config });
    return res.json({ campaignId: id, compliance });
  } catch (err) {
    logger.error('Failed to compute campaign compliance', { tenantId, campaignId: id, error: String(err) });
    return res.status(500).json({ error: 'Failed to compute compliance report' });
  }
});

/**
 * Auto-scrub DNC matches and (optionally) retry the launch in one step.
 *
 * Flow:
 *   1. Re-scan the campaign roster for DNC matches (uses the same paginated
 *      decrypt-and-compare logic as the pre-flight, so we catch every match
 *      up to the pre-flight ceiling — not just the first 25 the panel shows).
 *   2. Flip those contacts to `opted_out` with `metadata.optOutReason='dnc_match'`.
 *   3. Write an audit log entry recording the scrub.
 *   4. Re-run the compliance check so the response carries the fresh report.
 *   5. If the caller requested `retryStatus` ('running' | 'scheduled') AND the
 *      fresh compliance check is `ok`, flip the campaign to that status and
 *      audit the relaunch. Phone-verification gating mirrors PATCH /campaigns/:id.
 *
 * Response: `{ scrubbed, preflightTruncated, compliance, campaign?, retryError? }`.
 */
router.post('/campaigns/:id/scrub-dnc', requireAuth, requireRole('manager'), async (req, res) => {
  const { tenantId } = req.user!;
  const { id } = req.params;
  const { retryStatus } = req.body as { retryStatus?: string };

  const allowedRetry: CampaignStatus[] = ['running', 'scheduled'];
  if (retryStatus !== undefined && !allowedRetry.includes(retryStatus as CampaignStatus)) {
    return res.status(400).json({
      error: `retryStatus must be one of: ${allowedRetry.join(', ')}`,
    });
  }

  try {
    const campaign = await getCampaign(tenantId, id);
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });

    // Pre-launch gating mirrors PATCH /campaigns/:id so Scrub & Launch can't
    // be used as a side door around the same checks: phone verification on
    // the actor and a valid verified caller ID on the campaign config.
    if (retryStatus === 'running' || retryStatus === 'scheduled') {
      const userId = req.user!.userId;
      const pool = (await import('../../../platform/db')).getPlatformPool();
      const { rows: userRows } = await pool.query(
        `SELECT phone_verified FROM users WHERE id = $1`,
        [userId],
      );
      if (userRows.length > 0 && !(userRows[0].phone_verified as boolean)) {
        return res.status(403).json({
          error: 'Phone verification required before activating outbound campaigns. Verify your phone number in Settings.',
        });
      }

      const verifiedCallerIdCfg = campaign.config.verifiedCallerId;
      if (typeof verifiedCallerIdCfg === 'string' && verifiedCallerIdCfg.length > 0) {
        const verified = await getVerifiedCallerById(tenantId, verifiedCallerIdCfg);
        if (!verified) {
          return res.status(400).json({
            error: 'The selected verified caller ID is missing or has not finished verification. Confirm verification from Trusted Callers.',
          });
        }
      }
    }

    const { contactIds, truncated } = await findDncMatchingContactIds(tenantId, id);
    const scrubbed = await bulkMarkOptedOut(tenantId, id, contactIds, 'dnc_match');

    if (scrubbed > 0) {
      logger.info('DNC scrub completed', { tenantId, campaignId: id, scrubbed, truncated });
      await writeAuditLog({
        tenantId,
        actorUserId: req.user!.userId,
        actorRole: req.user!.role,
        action: 'campaign.dnc_scrubbed',
        resourceType: 'campaign',
        resourceId: id,
        severity: 'warning',
        afterState: {
          scrubbedCount: scrubbed,
          // Cap the recorded id list so a 100k-contact scrub doesn't blow up
          // the audit row payload. The full count is still captured above.
          contactIds: contactIds.slice(0, 200),
          reason: 'dnc_match',
          preflightTruncated: truncated,
        },
        ipAddress: extractIp(req),
        userAgent: req.headers['user-agent'],
      });
    }

    const compliance = await checkCampaignCompliance(tenantId, id, { config: campaign.config });

    let updatedCampaign: Awaited<ReturnType<typeof updateCampaign>> = null;
    let retryError: string | null = null;

    if (retryStatus && compliance.ok) {
      updatedCampaign = await updateCampaign(tenantId, id, {
        status: retryStatus as CampaignStatus,
      });
      if (updatedCampaign) {
        logger.info('Campaign relaunched after DNC scrub', {
          tenantId,
          campaignId: id,
          status: retryStatus,
          scrubbed,
        });
        await writeAuditLog({
          tenantId,
          actorUserId: req.user!.userId,
          actorRole: req.user!.role,
          action: 'campaign.relaunched_after_scrub',
          resourceType: 'campaign',
          resourceId: id,
          afterState: { status: retryStatus, scrubbed },
          ipAddress: extractIp(req),
          userAgent: req.headers['user-agent'],
        });
      }
    } else if (retryStatus && !compliance.ok) {
      retryError = compliance.dncMatchCount > 0
        ? `Scrubbed ${scrubbed} contact${scrubbed === 1 ? '' : 's'}, but ${compliance.dncMatchCount} DNC match${compliance.dncMatchCount === 1 ? '' : 'es'} remain (pre-flight scan ceiling reached). Split the campaign or scrub again.`
        : compliance.preflightTruncated
          ? `Scrubbed ${scrubbed} contact${scrubbed === 1 ? '' : 's'}, but the campaign exceeds the pre-flight scan ceiling. Split the campaign before launching.`
          : `Scrubbed ${scrubbed} contact${scrubbed === 1 ? '' : 's'}, but the campaign still has compliance blockers.`;
    }

    return res.json({
      scrubbed,
      preflightTruncated: truncated,
      compliance,
      campaign: updatedCampaign,
      retryError,
    });
  } catch (err) {
    logger.error('Failed to scrub DNC matches', { tenantId, campaignId: id, error: String(err) });
    return res.status(500).json({ error: 'Failed to scrub DNC matches' });
  }
});

export const addContactsHandler: import('express').RequestHandler = async (req, res) => {
  const { tenantId } = req.user!;
  const { id } = req.params;
  const body = req.body as { contacts?: unknown; csv?: string };

  let rawContacts: Array<{ phone_number?: string; phoneNumber?: string; name?: string; metadata?: Record<string, unknown> }> = [];

  if (body.csv && typeof body.csv === 'string') {
    const lines = body.csv.trim().split('\n');
    const headerRaw = parseCsvLine(lines[0]).map((h) => h.trim());
    const headerLower = headerRaw.map((h) => h.toLowerCase());
    const phoneIdx = headerLower.findIndex((h) => h === 'phone' || h === 'phone_number' || h === 'phonenumber');
    const nameIdx = headerLower.indexOf('name');

    if (phoneIdx === -1) {
      return res.status(400).json({ error: 'CSV must have a phone, phone_number, or phoneNumber column' });
    }

    for (let i = 1; i < lines.length; i++) {
      const cols = parseCsvLine(lines[i]);
      if (!cols[phoneIdx]) continue;
      const metadata: Record<string, unknown> = {};
      for (let ci = 0; ci < headerRaw.length; ci++) {
        if (ci === phoneIdx || ci === nameIdx) continue;
        const val = cols[ci]?.trim();
        if (val) metadata[headerRaw[ci]] = val;
      }
      rawContacts.push({
        phoneNumber: cols[phoneIdx].trim(),
        name: nameIdx !== -1 ? cols[nameIdx]?.trim() : undefined,
        metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
      });
    }
  } else if (Array.isArray(body.contacts)) {
    rawContacts = body.contacts as typeof rawContacts;
  } else {
    return res.status(400).json({ error: 'Provide contacts array or csv string' });
  }

  const contacts: Array<{ phoneNumber: string; name?: string; metadata?: Record<string, unknown> }> = [];
  const invalid: string[] = [];

  for (const c of rawContacts) {
    const raw = c.phone_number ?? c.phoneNumber ?? '';
    const e164 = parseE164(raw);
    if (!e164) { invalid.push(raw); continue; }
    contacts.push({ phoneNumber: e164, name: c.name, metadata: c.metadata });
  }

  if (contacts.length === 0) {
    return res.status(400).json({ error: 'No valid contacts found', invalid });
  }

  try {
    const inserted = await addContacts(tenantId, id, contacts);
    logger.info('Contacts added to campaign', { tenantId, campaignId: id, inserted, skippedInvalid: invalid.length });
    return res.status(201).json({ inserted, skippedInvalid: invalid.length, invalid: invalid.slice(0, 10) });
  } catch (err) {
    logger.error('Failed to add contacts', { tenantId, campaignId: id, error: String(err) });
    return res.status(500).json({ error: 'Failed to add contacts' });
  }
};

router.post('/campaigns/:id/contacts', requireAuth, requireRole('manager'), addContactsHandler);

router.get('/campaigns/:id/contacts', requireAuth, requireRole('manager'), async (req, res) => {
  const { tenantId } = req.user!;
  const { id } = req.params;
  const { limit, offset } = paginate(req);
  const { status } = req.query as Record<string, string>;

  try {
    const result = await listContacts(tenantId, id, { limit, offset, status: status as import('../../../platform/campaigns').ContactStatus });
    return res.json(result);
  } catch (err) {
    logger.error('Failed to list contacts', { tenantId, campaignId: id, error: String(err) });
    return res.status(500).json({ error: 'Failed to list contacts' });
  }
});

router.get('/campaigns/:id/type-metrics', requireAuth, async (req, res) => {
  const { tenantId } = req.user!;
  const { id } = req.params;

  try {
    const typeMetrics = await getTypeSpecificMetrics(tenantId, id);
    return res.json({ campaignId: id, typeMetrics });
  } catch (err) {
    logger.error('Failed to get type-specific metrics', { tenantId, campaignId: id, error: String(err) });
    return res.status(500).json({ error: 'Failed to retrieve type-specific metrics' });
  }
});

router.patch('/campaigns/:id/contacts/:contactId/disposition', requireAuth, requireRole('manager'), async (req, res) => {
  const { tenantId } = req.user!;
  const { id: campaignId, contactId } = req.params;
  const { disposition } = req.body as { disposition?: string };

  if (!disposition || typeof disposition !== 'string') {
    return res.status(400).json({ error: 'disposition is required' });
  }

  try {
    const campaign = await getCampaign(tenantId, campaignId);
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });

    if (!isValidDisposition(campaign.type, disposition)) {
      return res.status(400).json({ error: `Invalid disposition "${disposition}" for campaign type "${campaign.type}"` });
    }

    const updated = await updateContactTypeDisposition(tenantId, campaignId, contactId, disposition);
    if (!updated) {
      return res.status(404).json({ error: 'Contact not found in this campaign' });
    }
    return res.json({ updated: true });
  } catch (err) {
    logger.error('Failed to update contact disposition', { tenantId, campaignId, contactId, error: String(err) });
    return res.status(500).json({ error: 'Failed to update disposition' });
  }
});

export default router;
