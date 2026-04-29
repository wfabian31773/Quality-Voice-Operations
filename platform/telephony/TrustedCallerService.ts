import { getPlatformPool, withTenantContext, withPrivilegedClient } from '../db';
import { createLogger } from '../core/logger';
import type { TrustHubSnapshot } from './TrustHubService';

const logger = createLogger('TRUSTED_CALLER');

export type VerifiedCallerStatus = 'pending' | 'verified' | 'failed' | 'rotated';
export type AttestationLevel = 'A' | 'B' | 'C';

/**
 * Health states reported by `checkCallerHealth` and persisted on the
 * `verified_caller_ids` row by the weekly scheduler.
 *
 *   - `healthy`        — Twilio confirms the OutgoingCallerIds row exists
 *                        and any Trust Hub product / brand attached is
 *                        approved with a `valid_until` more than
 *                        `EXPIRING_SOON_THRESHOLD_DAYS` away.
 *   - `expiring_soon`  — `valid_until` is within the threshold window.
 *                        Carriers will keep attesting A until the date
 *                        passes; we just nudge owners ahead of time.
 *   - `expired`        — `valid_until` has passed but Twilio hasn't yet
 *                        revoked the row. Treated as a hard error so the
 *                        UI flips the badge to red.
 *   - `revoked`        — Twilio no longer reports the row at all (the
 *                        OutgoingCallerIds entry was deleted, the Trust
 *                        Hub product is `twilio-rejected`, the brand
 *                        registration is `FAILED`, etc.). The scheduler
 *                        also demotes the row's stored attestation level
 *                        so it can't be re-used by the campaign guard.
 *   - `unknown`        — health check couldn't run (no Twilio creds,
 *                        network error). We never alert on `unknown` to
 *                        avoid noisy false positives during transient
 *                        Twilio outages.
 */
export type CallerHealthStatus =
  | 'healthy'
  | 'expiring_soon'
  | 'expired'
  | 'revoked'
  | 'unknown';

export interface VerifiedCallerId {
  id: string;
  tenantId: string;
  phoneNumber: string;
  friendlyName: string | null;
  status: VerifiedCallerStatus;
  attestationLevel: AttestationLevel | null;
  twilioValidationSid: string | null;
  twilioCallerSid: string | null;
  trustHubProfileSid: string | null;
  trustProductSid: string | null;
  brandSid: string | null;
  verificationCode: string | null;
  verificationExpiresAt: Date | null;
  verifiedAt: Date | null;
  rotatedAt: Date | null;
  rotatedToId: string | null;
  registeredByUserId: string | null;
  notes: string | null;
  metadata: Record<string, unknown>;
  expiresAt: Date | null;
  lastHealthCheckAt: Date | null;
  lastHealthStatus: CallerHealthStatus | null;
  lastHealthMessage: string | null;
  expiryAlertSentAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface RegisterCallerIdParams {
  tenantId: string;
  phoneNumber: string;
  friendlyName?: string;
  registeredByUserId?: string;
  notes?: string;
  trustHubProfileSid?: string;
  trustProductSid?: string;
  brandSid?: string;
}

export interface VerifiedCallerSyncResult {
  status: VerifiedCallerStatus;
  attestationLevel: AttestationLevel | null;
  twilioCallerSid: string | null;
}

const E164_REGEX = /^\+[1-9]\d{7,14}$/;
/**
 * Twilio validation codes are valid for 10 minutes. After this window the
 * background `VerifiedCallerSyncScheduler` will flip the row to `failed`
 * automatically so admins don't see callers stranded in `pending` forever.
 */
export const VERIFICATION_TTL_MS = 10 * 60 * 1000;

interface DbClient {
  query: (sql: string, values?: unknown[]) => Promise<{ rows: Record<string, unknown>[]; rowCount?: number | null }>;
}

async function withTenant<T>(tenantId: string, fn: (client: DbClient) => Promise<T>): Promise<T> {
  const pool = getPlatformPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await withTenantContext(client, tenantId, async () => {});
    const result = await fn(client as unknown as DbClient);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

function rowToCaller(r: Record<string, unknown>): VerifiedCallerId {
  return {
    id: r.id as string,
    tenantId: r.tenant_id as string,
    phoneNumber: r.phone_number as string,
    friendlyName: (r.friendly_name as string) ?? null,
    status: r.status as VerifiedCallerStatus,
    attestationLevel: ((r.attestation_level as string) ?? null) as AttestationLevel | null,
    twilioValidationSid: (r.twilio_validation_sid as string) ?? null,
    twilioCallerSid: (r.twilio_caller_sid as string) ?? null,
    trustHubProfileSid: (r.trust_hub_profile_sid as string) ?? null,
    trustProductSid: (r.trust_product_sid as string) ?? null,
    brandSid: (r.brand_sid as string) ?? null,
    verificationCode: (r.verification_code as string) ?? null,
    verificationExpiresAt: r.verification_expires_at ? new Date(r.verification_expires_at as string) : null,
    verifiedAt: r.verified_at ? new Date(r.verified_at as string) : null,
    rotatedAt: r.rotated_at ? new Date(r.rotated_at as string) : null,
    rotatedToId: (r.rotated_to_id as string) ?? null,
    registeredByUserId: (r.registered_by_user_id as string) ?? null,
    notes: (r.notes as string) ?? null,
    metadata: (typeof r.metadata === 'object' && r.metadata !== null ? r.metadata : {}) as Record<string, unknown>,
    expiresAt: r.expires_at ? new Date(r.expires_at as string) : null,
    lastHealthCheckAt: r.last_health_check_at ? new Date(r.last_health_check_at as string) : null,
    lastHealthStatus: ((r.last_health_status as string) ?? null) as CallerHealthStatus | null,
    lastHealthMessage: (r.last_health_message as string) ?? null,
    expiryAlertSentAt: r.expiry_alert_sent_at ? new Date(r.expiry_alert_sent_at as string) : null,
    createdAt: new Date(r.created_at as string),
    updatedAt: new Date(r.updated_at as string),
  };
}

export function isE164(value: string): boolean {
  return E164_REGEX.test(value);
}

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

interface TwilioValidationResponse {
  account_sid?: string;
  call_sid?: string;
  friendly_name?: string;
  phone_number?: string;
  validation_code?: string;
  sid?: string;
}

interface TwilioOutgoingCallerIdResponse {
  sid?: string;
  phone_number?: string;
  friendly_name?: string;
  date_created?: string;
}

interface TwilioListResponse<T> {
  outgoing_caller_ids?: T[];
}

async function twilioRequest(
  creds: TwilioCreds,
  pathSuffix: string,
  init: { method: 'GET' | 'POST' | 'DELETE'; body?: URLSearchParams } = { method: 'GET' },
): Promise<Response> {
  const url = `https://api.twilio.com/2010-04-01/Accounts/${creds.accountSid}/${pathSuffix}`;
  const headers: Record<string, string> = {
    Authorization: `Basic ${Buffer.from(`${creds.accountSid}:${creds.authToken}`).toString('base64')}`,
  };
  if (init.body) headers['Content-Type'] = 'application/x-www-form-urlencoded';
  return fetch(url, { method: init.method, headers, body: init.body?.toString() });
}

/**
 * Initiate the Twilio outbound caller ID validation flow. Twilio will call
 * the supplied number; the user must answer and enter the returned
 * `validationCode` on the keypad. The call SID lets us poll for completion.
 *
 * Returns `null` for the validationCode in test/dev environments where Twilio
 * credentials are not configured (the row is still recorded so the admin UI
 * can show pending state and the rotation flow can be exercised).
 */
async function startTwilioValidation(
  creds: TwilioCreds,
  phoneNumber: string,
  friendlyName: string,
): Promise<{ validationSid: string; validationCode: string | null } | { error: string }> {
  const body = new URLSearchParams({
    PhoneNumber: phoneNumber,
    FriendlyName: friendlyName,
  });

  const response = await twilioRequest(creds, 'OutgoingCallerIds.json', { method: 'POST', body });

  if (!response.ok) {
    const errorText = await response.text();
    return { error: `Twilio ${response.status}: ${errorText}` };
  }

  // Twilio's `POST .../OutgoingCallerIds.json` returns the validation request
  // resource directly at the top level: `{ account_sid, phone_number,
  // friendly_name, validation_code, call_sid }`. Older library versions used
  // to nest it under `validation_request` so we accept either shape
  // defensively to avoid silently losing the validation code (which would
  // strand operators with no way to verify the number).
  const raw = (await response.json()) as
    | TwilioValidationResponse
    | { validation_request?: TwilioValidationResponse };
  const v: TwilioValidationResponse =
    raw && typeof raw === 'object' && 'validation_request' in raw && raw.validation_request
      ? raw.validation_request
      : (raw as TwilioValidationResponse);

  const validationSid = (v.call_sid ?? v.sid ?? '').toString();
  const validationCode =
    typeof v.validation_code === 'string' && v.validation_code.length > 0 ? v.validation_code : null;

  if (!validationCode) {
    return { error: 'Twilio response did not include a validation code — verification cannot proceed.' };
  }

  return { validationSid, validationCode };
}

async function fetchTwilioVerifiedCaller(
  creds: TwilioCreds,
  phoneNumber: string,
): Promise<TwilioOutgoingCallerIdResponse | null> {
  const response = await twilioRequest(creds, `OutgoingCallerIds.json?PhoneNumber=${encodeURIComponent(phoneNumber)}`);
  if (!response.ok) return null;
  const data = (await response.json()) as TwilioListResponse<TwilioOutgoingCallerIdResponse>;
  return data.outgoing_caller_ids?.[0] ?? null;
}

export async function registerCallerId(
  params: RegisterCallerIdParams,
): Promise<VerifiedCallerId & { validationCode: string | null }> {
  if (!isE164(params.phoneNumber)) {
    throw new Error('phoneNumber must be in E.164 format (e.g. +12125550123)');
  }

  const creds = getTwilioCreds();
  let validationSid: string | null = null;
  let validationCode: string | null = null;

  if (creds) {
    const result = await startTwilioValidation(
      creds,
      params.phoneNumber,
      params.friendlyName ?? `QVO-${params.tenantId}`,
    );
    if ('error' in result) {
      logger.error('Twilio validation failed to start', { tenantId: params.tenantId, error: result.error });
      throw new Error(`Twilio rejected the verification request: ${result.error}`);
    }
    validationSid = result.validationSid;
    validationCode = result.validationCode;
  } else {
    logger.warn('Twilio credentials not configured — recording pending caller ID without validation call', {
      tenantId: params.tenantId,
    });
  }

  return withTenant(params.tenantId, async (client) => {
    const expiresAt = new Date(Date.now() + VERIFICATION_TTL_MS);
    const { rows } = await client.query(
      `INSERT INTO verified_caller_ids (
         tenant_id, phone_number, friendly_name, status,
         twilio_validation_sid, verification_code, verification_expires_at,
         trust_hub_profile_sid, trust_product_sid, brand_sid,
         registered_by_user_id, notes
       )
       VALUES ($1, $2, $3, 'pending', $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (tenant_id, phone_number) DO UPDATE SET
         friendly_name = EXCLUDED.friendly_name,
         status = 'pending',
         twilio_validation_sid = EXCLUDED.twilio_validation_sid,
         verification_code = EXCLUDED.verification_code,
         verification_expires_at = EXCLUDED.verification_expires_at,
         trust_hub_profile_sid = COALESCE(EXCLUDED.trust_hub_profile_sid, verified_caller_ids.trust_hub_profile_sid),
         trust_product_sid = COALESCE(EXCLUDED.trust_product_sid, verified_caller_ids.trust_product_sid),
         brand_sid = COALESCE(EXCLUDED.brand_sid, verified_caller_ids.brand_sid),
         registered_by_user_id = COALESCE(EXCLUDED.registered_by_user_id, verified_caller_ids.registered_by_user_id),
         notes = COALESCE(EXCLUDED.notes, verified_caller_ids.notes),
         rotated_at = NULL,
         rotated_to_id = NULL,
         updated_at = NOW()
       RETURNING *`,
      [
        params.tenantId,
        params.phoneNumber,
        params.friendlyName ?? null,
        validationSid,
        validationCode,
        validationCode ? expiresAt : null,
        params.trustHubProfileSid ?? null,
        params.trustProductSid ?? null,
        params.brandSid ?? null,
        params.registeredByUserId ?? null,
        params.notes ?? null,
      ],
    );

    logger.info('Verified caller ID registered (pending verification)', {
      tenantId: params.tenantId,
      phoneNumber: params.phoneNumber,
      hasTwilioCreds: Boolean(creds),
    });

    return { ...rowToCaller(rows[0]), validationCode };
  });
}

export async function listCallerIds(
  tenantId: string,
  opts: { includeRotated?: boolean } = {},
): Promise<VerifiedCallerId[]> {
  return withTenant(tenantId, async (client) => {
    const conditions = ['tenant_id = $1'];
    if (!opts.includeRotated) conditions.push(`status <> 'rotated'`);
    const { rows } = await client.query(
      `SELECT * FROM verified_caller_ids WHERE ${conditions.join(' AND ')} ORDER BY
         CASE status WHEN 'verified' THEN 0 WHEN 'pending' THEN 1 WHEN 'failed' THEN 2 ELSE 3 END,
         created_at DESC`,
      [tenantId],
    );
    return rows.map(rowToCaller);
  });
}

export async function getCallerId(tenantId: string, id: string): Promise<VerifiedCallerId | null> {
  return withTenant(tenantId, async (client) => {
    const { rows } = await client.query(
      `SELECT * FROM verified_caller_ids WHERE id = $1 AND tenant_id = $2 LIMIT 1`,
      [id, tenantId],
    );
    return rows.length > 0 ? rowToCaller(rows[0]) : null;
  });
}

export async function getVerifiedCallerById(
  tenantId: string,
  id: string,
): Promise<VerifiedCallerId | null> {
  const caller = await getCallerId(tenantId, id);
  if (!caller || caller.status !== 'verified') return null;
  return caller;
}

export async function deleteCallerId(tenantId: string, id: string): Promise<boolean> {
  const caller = await getCallerId(tenantId, id);
  if (!caller) return false;

  const creds = getTwilioCreds();
  if (creds && caller.twilioCallerSid) {
    try {
      await twilioRequest(creds, `OutgoingCallerIds/${caller.twilioCallerSid}.json`, { method: 'DELETE' });
    } catch (err) {
      logger.warn('Failed to remove Twilio outgoing caller ID', {
        tenantId,
        sid: caller.twilioCallerSid,
        error: String(err),
      });
    }
  }

  return withTenant(tenantId, async (client) => {
    const { rowCount } = await client.query(
      `DELETE FROM verified_caller_ids WHERE id = $1 AND tenant_id = $2`,
      [id, tenantId],
    );
    return (rowCount ?? 0) > 0;
  });
}

export interface RotateCallerIdResult {
  retired: VerifiedCallerId;
  replacement: VerifiedCallerId & { validationCode: string | null };
}

export async function rotateCallerId(
  tenantId: string,
  id: string,
  replacement: RegisterCallerIdParams,
): Promise<RotateCallerIdResult> {
  const existing = await getCallerId(tenantId, id);
  if (!existing) throw new Error('Caller ID not found');

  const newCaller = await registerCallerId({
    ...replacement,
    tenantId,
    notes: replacement.notes ?? `Rotated from ${existing.phoneNumber}`,
  });

  const retired = await withTenant(tenantId, async (client) => {
    const { rows } = await client.query(
      `UPDATE verified_caller_ids
         SET status = 'rotated', rotated_at = NOW(), rotated_to_id = $3, updated_at = NOW()
       WHERE id = $1 AND tenant_id = $2
       RETURNING *`,
      [id, tenantId, newCaller.id],
    );
    return rowToCaller(rows[0]);
  });

  logger.info('Verified caller ID rotated', {
    tenantId,
    fromId: id,
    fromPhone: existing.phoneNumber,
    toId: newCaller.id,
    toPhone: newCaller.phoneNumber,
  });

  return { retired, replacement: newCaller };
}

/**
 * Confirm a caller ID has been verified.
 *
 * Policy (deliberately strict because STIR/SHAKEN trust depends on it):
 *
 *   - When Twilio credentials are configured we ALWAYS poll Twilio's
 *     OutgoingCallerIds resource for this number. The caller is only
 *     promoted to 'verified' when Twilio confirms the number is
 *     registered. Admin-supplied attestation/Trust Hub SIDs cannot
 *     bypass this check — they only annotate the row after Twilio
 *     confirms ownership.
 *   - When Twilio credentials are NOT configured (test/dev or
 *     self-hosted setups without Twilio) verification is refused
 *     unless the caller passes an explicit `manualOverride` flag with
 *     a non-empty `manualOverrideReason`. This forces a deliberate,
 *     auditable decision instead of silently trusting any number.
 */
export interface ConfirmCallerIdOptions {
  attestationLevel?: AttestationLevel;
  trustHubProfileSid?: string;
  trustProductSid?: string;
  brandSid?: string;
  manualOverride?: boolean;
  manualOverrideReason?: string;
}

export async function confirmCallerIdVerified(
  tenantId: string,
  id: string,
  override: ConfirmCallerIdOptions = {},
): Promise<VerifiedCallerId> {
  const caller = await getCallerId(tenantId, id);
  if (!caller) throw new Error('Caller ID not found');
  if (caller.status === 'verified') return caller;

  const creds = getTwilioCreds();
  let twilioCallerSid: string | null = caller.twilioCallerSid;

  if (creds) {
    const remote = await fetchTwilioVerifiedCaller(creds, caller.phoneNumber);
    if (!remote) {
      throw new Error(
        'Twilio has not yet recorded this number as a verified outgoing caller ID. Complete the validation call and retry.',
      );
    }
    twilioCallerSid = remote.sid ?? twilioCallerSid;
  } else {
    if (!override.manualOverride || !override.manualOverrideReason || !override.manualOverrideReason.trim()) {
      throw new Error(
        'Twilio credentials are not configured, so this caller ID cannot be verified automatically. Pass an explicit manualOverride with a reason if you are running without Twilio.',
      );
    }
    logger.warn('Verified caller ID promoted via manual override (no Twilio confirmation)', {
      tenantId,
      callerId: id,
      reason: override.manualOverrideReason,
    });
  }

  return withTenant(tenantId, async (client) => {
    const { rows } = await client.query(
      `UPDATE verified_caller_ids
         SET status = 'verified',
             attestation_level = COALESCE($3, attestation_level),
             trust_hub_profile_sid = COALESCE($4, trust_hub_profile_sid),
             trust_product_sid = COALESCE($5, trust_product_sid),
             brand_sid = COALESCE($6, brand_sid),
             twilio_caller_sid = COALESCE($7, twilio_caller_sid),
             verification_code = NULL,
             verification_expires_at = NULL,
             verified_at = NOW(),
             updated_at = NOW()
       WHERE id = $1 AND tenant_id = $2
       RETURNING *`,
      [
        id,
        tenantId,
        override.attestationLevel ?? null,
        override.trustHubProfileSid ?? null,
        override.trustProductSid ?? null,
        override.brandSid ?? null,
        twilioCallerSid,
      ],
    );
    logger.info('Verified caller ID confirmed verified', {
      tenantId,
      callerId: id,
      attestation: override.attestationLevel ?? null,
    });
    return rowToCaller(rows[0]);
  });
}

/**
 * Refresh the status of a pending caller ID by querying Twilio. Returns the
 * latest record. Marks rows whose verification window expired as `failed`.
 */
export async function syncCallerIdStatus(
  tenantId: string,
  id: string,
): Promise<VerifiedCallerId> {
  const caller = await getCallerId(tenantId, id);
  if (!caller) throw new Error('Caller ID not found');
  if (caller.status !== 'pending') return caller;

  if (caller.verificationExpiresAt && caller.verificationExpiresAt.getTime() < Date.now()) {
    return withTenant(tenantId, async (client) => {
      const { rows } = await client.query(
        `UPDATE verified_caller_ids
           SET status = 'failed', updated_at = NOW()
         WHERE id = $1 AND tenant_id = $2
         RETURNING *`,
        [id, tenantId],
      );
      return rowToCaller(rows[0]);
    });
  }

  const creds = getTwilioCreds();
  if (!creds) return caller;

  const remote = await fetchTwilioVerifiedCaller(creds, caller.phoneNumber);
  if (!remote) return caller;

  return confirmCallerIdVerified(tenantId, id, {});
}

/**
 * Returns the verified caller ID linked to a campaign by config key
 * `verifiedCallerId` — used by the OutboundDialer to pick the `From` number.
 */
export async function resolveCampaignCallerId(
  tenantId: string,
  verifiedCallerId: string | null | undefined,
): Promise<VerifiedCallerId | null> {
  if (!verifiedCallerId) return null;
  return getVerifiedCallerById(tenantId, verifiedCallerId);
}

// ============================================================================
// Trust Hub registration persistence
// ============================================================================

/**
 * Persist the SIDs returned by the Twilio Trust Hub orchestrator onto an
 * existing verified caller row, including a per-resource lifecycle
 * snapshot under `metadata.trustHub` for the wizard badge.
 */
export async function attachTrustHubRegistration(
  tenantId: string,
  callerId: string,
  snapshot: TrustHubSnapshot,
  opts: { source?: 'submit' | 'sync' } = { source: 'submit' },
): Promise<VerifiedCallerId> {
  return withTenant(tenantId, async (client) => {
    const existingRow = await client.query(
      `SELECT * FROM verified_caller_ids WHERE id = $1 AND tenant_id = $2`,
      [callerId, tenantId],
    );
    const prior = existingRow.rows[0] ? rowToCaller(existingRow.rows[0]) : null;
    const priorSnapshot = prior ? readTrustHubSnapshot(prior) : null;
    // The persisted blob carries `lastSubmittedAt` / `lastSyncedAt` even
    // though `TrustHubSnapshot` does not type them — pull them off the
    // raw metadata so we can preserve `lastSubmittedAt` across syncs.
    const priorRawTrustHub = (prior?.metadata?.trustHub ?? null) as
      | { lastSubmittedAt?: string | null }
      | null;

    let brand = snapshot.brand
      ?? (prior?.brandSid && priorSnapshot?.brand ? priorSnapshot.brand : null);
    if (!brand && prior?.brandSid) {
      brand = { sid: prior.brandSid, status: 'unknown', validUntil: null, failureReason: null };
    }

    const now = new Date().toISOString();
    const trustHubMetadata = {
      customerProfile: snapshot.customerProfile,
      trustProduct: snapshot.trustProduct,
      brand,
      businessInfoEndUserSid: snapshot.businessInfoEndUserSid,
      addressEndUserSid: snapshot.addressEndUserSid,
      representativeEndUserSid: snapshot.representativeEndUserSid,
      lastSubmittedAt: opts.source === 'sync'
        ? priorRawTrustHub?.lastSubmittedAt ?? now
        : now,
      lastSyncedAt: now,
    };

    const { rows } = await client.query(
      `UPDATE verified_caller_ids
          SET trust_hub_profile_sid = $3,
              trust_product_sid = $4,
              brand_sid = COALESCE($5, brand_sid),
              metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('trustHub', $6::jsonb),
              updated_at = NOW()
        WHERE id = $1 AND tenant_id = $2
        RETURNING *`,
      [
        callerId,
        tenantId,
        snapshot.customerProfile.sid,
        snapshot.trustProduct.sid,
        snapshot.brand?.sid ?? null,
        JSON.stringify(trustHubMetadata),
      ],
    );

    if (rows.length === 0) {
      throw new Error('Caller ID not found');
    }

    logger.info('Trust Hub registration attached to caller', {
      tenantId,
      callerId,
      customerProfileSid: snapshot.customerProfile.sid,
      trustProductSid: snapshot.trustProduct.sid,
      brandSid: snapshot.brand?.sid ?? null,
    });

    return rowToCaller(rows[0]);
  });
}

/**
 * Read the persisted Trust Hub snapshot back from the row. Returns null
 * when no Trust Hub registration has been attached yet.
 */
export function readTrustHubSnapshot(caller: VerifiedCallerId): TrustHubSnapshot | null {
  const meta = (caller.metadata?.trustHub ?? null) as TrustHubSnapshot | null;
  if (!meta) return null;
  if (!meta.customerProfile || !meta.trustProduct) return null;
  return meta;
}

// ============================================================================
// Weekly health check — see VerifiedCallerHealthScheduler
// ============================================================================

/**
 * Days of advance warning for an upcoming `valid_until`. Once a caller's
 * Trust Hub product / brand registration is within this window we flip the
 * UI badge to "expires in N days" and dispatch a one-shot weekly nudge so
 * owners can re-register before carriers downgrade attestation.
 */
export const EXPIRING_SOON_THRESHOLD_DAYS = 14;

const TRUST_HUB_REVOKED_STATUSES = new Set([
  'twilio-rejected',
  'rejected',
  'draft', // a previously approved product reverted to draft, attestation invalid
]);

const BRAND_REVOKED_STATUSES = new Set([
  'FAILED',
  'SUSPENDED',
]);

export interface CallerHealthResult {
  status: CallerHealthStatus;
  expiresAt: Date | null;
  message: string | null;
  /** Set when the result implies we should demote attestation (revoked). */
  demoteAttestation: boolean;
}

interface TwilioTrustProductResponse {
  sid?: string;
  status?: string;
  valid_until?: string | null;
  date_updated?: string | null;
}

interface TwilioBrandResponse {
  sid?: string;
  status?: string;
  brand_score?: number | null;
}

async function fetchTrustProductStatus(
  creds: TwilioCreds,
  sid: string,
): Promise<TwilioTrustProductResponse | { httpStatus: number; error: string }> {
  const url = `https://trusthub.twilio.com/v1/TrustProducts/${encodeURIComponent(sid)}`;
  const headers: Record<string, string> = {
    Authorization: `Basic ${Buffer.from(`${creds.accountSid}:${creds.authToken}`).toString('base64')}`,
  };
  const response = await fetch(url, { method: 'GET', headers });
  if (!response.ok) {
    return { httpStatus: response.status, error: await response.text() };
  }
  return (await response.json()) as TwilioTrustProductResponse;
}

async function fetchBrandStatus(
  creds: TwilioCreds,
  sid: string,
): Promise<TwilioBrandResponse | { httpStatus: number; error: string }> {
  const url = `https://messaging.twilio.com/v1/a2p/BrandRegistrations/${encodeURIComponent(sid)}`;
  const headers: Record<string, string> = {
    Authorization: `Basic ${Buffer.from(`${creds.accountSid}:${creds.authToken}`).toString('base64')}`,
  };
  const response = await fetch(url, { method: 'GET', headers });
  if (!response.ok) {
    return { httpStatus: response.status, error: await response.text() };
  }
  return (await response.json()) as TwilioBrandResponse;
}

/**
 * Inspect Twilio for the current health of a verified caller. Combines:
 *
 *   1. OutgoingCallerIds presence — if Twilio doesn't return our number
 *      anymore, the caller verification was deleted and we can no longer
 *      attest at the entry level. Result: `revoked`.
 *   2. Trust Hub product (when configured) — query the trust product SID
 *      and use its `status` + `valid_until`. `twilio-rejected` /
 *      reverted-to-draft mean the product is no longer carrying
 *      attestation.
 *   3. Brand registration (when configured) — query the brand SID and
 *      treat `FAILED` / `SUSPENDED` as revoked.
 *
 * The most severe state across all three checks wins. When Twilio
 * credentials aren't configured we return `unknown` so the scheduler skips
 * alerting (alerting on `unknown` would spam tenants every time the
 * environment lost its Twilio creds).
 */
export async function checkCallerHealth(
  caller: Pick<
    VerifiedCallerId,
    'phoneNumber' | 'trustProductSid' | 'brandSid'
  >,
  options: { now?: Date; expiringSoonDays?: number } = {},
): Promise<CallerHealthResult> {
  const creds = getTwilioCreds();
  if (!creds) {
    return {
      status: 'unknown',
      expiresAt: null,
      message: 'Twilio credentials not configured; health check skipped.',
      demoteAttestation: false,
    };
  }

  const now = options.now ?? new Date();
  const thresholdMs =
    (options.expiringSoonDays ?? EXPIRING_SOON_THRESHOLD_DAYS) * 24 * 60 * 60 * 1000;

  // 1. OutgoingCallerIds presence — the floor of every verification.
  //
  // We deliberately do NOT use `fetchTwilioVerifiedCaller` here. That helper
  // collapses every non-2xx response to `null`, which is fine for the
  // existing "is the caller verified yet?" callers but catastrophic for
  // health checks: a transient 5xx, a 429 rate-limit, or a 401 from a
  // misconfigured-but-present credential set would all silently look like
  // "Twilio doesn't know about this number" and trigger a false `revoked`
  // alert + attestation demotion across every tenant in the cycle.
  //
  // Instead, distinguish:
  //   - 200 + empty list  → genuinely missing → revoked
  //   - 200 + match       → present → keep going
  //   - 404               → genuinely missing → revoked
  //   - 401 / 403 / 429 / 5xx → transient or auth-misconfig → unknown
  //   - network throw     → unknown (caught below)
  let outgoingResponse: Response;
  try {
    outgoingResponse = await twilioRequest(
      creds,
      `OutgoingCallerIds.json?PhoneNumber=${encodeURIComponent(caller.phoneNumber)}`,
    );
  } catch (err) {
    return {
      status: 'unknown',
      expiresAt: null,
      message: `Twilio OutgoingCallerIds lookup failed: ${String(err).slice(0, 200)}`,
      demoteAttestation: false,
    };
  }

  if (outgoingResponse.status === 404) {
    return {
      status: 'revoked',
      expiresAt: null,
      message: 'Twilio no longer reports this number under OutgoingCallerIds. Re-verify to restore attestation.',
      demoteAttestation: true,
    };
  }
  if (!outgoingResponse.ok) {
    // Auth (401/403), rate limit (429), and 5xx all flow here. Treat them
    // as unknown so the scheduler does NOT alert and does NOT demote
    // attestation — the row will simply be retried on the next weekly tick.
    let errorBody = '';
    try {
      errorBody = (await outgoingResponse.text()).slice(0, 200);
    } catch {
      errorBody = '';
    }
    return {
      status: 'unknown',
      expiresAt: null,
      message: `Twilio OutgoingCallerIds lookup returned ${outgoingResponse.status}: ${errorBody}`,
      demoteAttestation: false,
    };
  }

  let outgoingPayload: TwilioListResponse<TwilioOutgoingCallerIdResponse>;
  try {
    outgoingPayload = (await outgoingResponse.json()) as TwilioListResponse<TwilioOutgoingCallerIdResponse>;
  } catch (err) {
    // Twilio returned a 2xx with non-JSON / truncated body. Treat as
    // unknown rather than risking a false revocation.
    return {
      status: 'unknown',
      expiresAt: null,
      message: `Twilio OutgoingCallerIds returned malformed JSON: ${String(err).slice(0, 200)}`,
      demoteAttestation: false,
    };
  }

  if (!outgoingPayload.outgoing_caller_ids?.length) {
    return {
      status: 'revoked',
      expiresAt: null,
      message: 'Twilio no longer reports this number under OutgoingCallerIds. Re-verify to restore attestation.',
      demoteAttestation: true,
    };
  }

  // 2. Trust Hub product (optional).
  let expiresAt: Date | null = null;
  let trustHubMessage: string | null = null;
  if (caller.trustProductSid) {
    const result = await fetchTrustProductStatus(creds, caller.trustProductSid);
    if ('httpStatus' in result) {
      // 404 means the product was deleted → revoked. Other HTTP errors
      // are transient and shouldn't downgrade health.
      if (result.httpStatus === 404) {
        return {
          status: 'revoked',
          expiresAt: null,
          message: `Trust Hub product ${caller.trustProductSid} no longer exists.`,
          demoteAttestation: true,
        };
      }
      return {
        status: 'unknown',
        expiresAt: null,
        message: `Trust Hub lookup failed (${result.httpStatus}): ${result.error.slice(0, 200)}`,
        demoteAttestation: false,
      };
    }
    const status = (result.status ?? '').toLowerCase();
    if (TRUST_HUB_REVOKED_STATUSES.has(status)) {
      return {
        status: 'revoked',
        expiresAt: null,
        message: `Trust Hub product status is "${result.status ?? 'unknown'}" — re-register to keep A-attestation.`,
        demoteAttestation: true,
      };
    }
    if (typeof result.valid_until === 'string' && result.valid_until.length > 0) {
      const parsed = new Date(result.valid_until);
      if (Number.isFinite(parsed.getTime())) {
        expiresAt = parsed;
        trustHubMessage = `Trust Hub product expires ${parsed.toUTCString()}.`;
      }
    }
  }

  // 3. Brand registration (optional).
  if (caller.brandSid) {
    const result = await fetchBrandStatus(creds, caller.brandSid);
    if ('httpStatus' in result) {
      if (result.httpStatus === 404) {
        return {
          status: 'revoked',
          expiresAt,
          message: `Brand registration ${caller.brandSid} no longer exists.`,
          demoteAttestation: true,
        };
      }
      return {
        status: 'unknown',
        expiresAt,
        message: `Brand registration lookup failed (${result.httpStatus}): ${result.error.slice(0, 200)}`,
        demoteAttestation: false,
      };
    }
    const status = (result.status ?? '').toUpperCase();
    if (BRAND_REVOKED_STATUSES.has(status)) {
      return {
        status: 'revoked',
        expiresAt,
        message: `Brand registration status is "${result.status ?? 'unknown'}" — re-register to keep A-attestation.`,
        demoteAttestation: true,
      };
    }
  }

  // 4. Compute expiring_soon / expired against the resolved expiresAt.
  if (expiresAt) {
    const msRemaining = expiresAt.getTime() - now.getTime();
    if (msRemaining <= 0) {
      return {
        status: 'expired',
        expiresAt,
        message: `Trust Hub product expired ${expiresAt.toUTCString()}. Re-register to restore attestation.`,
        demoteAttestation: false,
      };
    }
    if (msRemaining <= thresholdMs) {
      return {
        status: 'expiring_soon',
        expiresAt,
        message: trustHubMessage ?? `Expires ${expiresAt.toUTCString()}.`,
        demoteAttestation: false,
      };
    }
  }

  return {
    status: 'healthy',
    expiresAt,
    message: trustHubMessage,
    demoteAttestation: false,
  };
}

/**
 * Cross-tenant list of callers still awaiting Twilio confirmation. The
 * `VerifiedCallerSyncScheduler` calls this each tick to find rows it
 * should poll. Includes both rows whose 10-minute validation window is
 * still open AND rows that have already passed it — the scheduler
 * relies on `syncCallerIdStatus` to flip the latter to `failed` (so we
 * deliberately do NOT filter them out here).
 *
 * Uses `withPrivilegedClient` because the table has RLS enabled and the
 * scheduler needs to read across every tenant. The actual updates are
 * still scoped to the owning tenant via `syncCallerIdStatus` →
 * `withTenant`, so RLS still protects writes.
 */
export async function listPendingCallersToSync(
  limit: number = 100,
): Promise<VerifiedCallerId[]> {
  return withPrivilegedClient(async (client) => {
    const { rows } = await client.query(
      `SELECT * FROM verified_caller_ids
        WHERE status = 'pending'
        ORDER BY created_at ASC
        LIMIT $1`,
      [limit],
    );
    return rows.map(rowToCaller);
  });
}

/**
 * Cross-tenant lookup of verified callers due for a health check. The
 * scheduler calls this at the top of each cycle to find rows that have
 * either never been health-checked, or whose last check was more than
 * `staleAfterMs` ago.
 *
 * Uses `withPrivilegedClient` so the platform pool can read across all
 * tenants (the verified_caller_ids table has RLS enabled and is otherwise
 * locked to a single `app.tenant_id` setting).
 */
export async function listCallersDueForHealthCheck(
  staleAfterMs: number,
  limit: number = 500,
): Promise<VerifiedCallerId[]> {
  return withPrivilegedClient(async (client) => {
    const { rows } = await client.query(
      `SELECT * FROM verified_caller_ids
        WHERE status = 'verified'
          AND (
            last_health_check_at IS NULL
            OR last_health_check_at < NOW() - ($1 || ' milliseconds')::interval
          )
        ORDER BY last_health_check_at NULLS FIRST, verified_at NULLS FIRST
        LIMIT $2`,
      [String(staleAfterMs), limit],
    );
    return rows.map(rowToCaller);
  });
}

/**
 * Persist the outcome of a health check on the row. Always stamps
 * `last_health_check_at`. When the result is `revoked` and
 * `demoteAttestation` is set, drops the stored attestation level so
 * subsequent campaign activations through `getVerifiedCallerById` will not
 * silently keep claiming A-attestation.
 *
 * Runs through `withPrivilegedClient` so the scheduler doesn't need to
 * thread tenant context for cross-tenant updates.
 */
export async function recordCallerHealth(
  callerId: string,
  tenantId: string,
  result: CallerHealthResult,
): Promise<void> {
  await withPrivilegedClient(async (client) => {
    await client.query(
      `UPDATE verified_caller_ids
          SET expires_at = $3,
              last_health_check_at = NOW(),
              last_health_status = $4,
              last_health_message = $5,
              attestation_level = CASE
                WHEN $6::boolean THEN NULL
                ELSE attestation_level
              END,
              updated_at = NOW()
        WHERE id = $1 AND tenant_id = $2`,
      [
        callerId,
        tenantId,
        result.expiresAt ? result.expiresAt.toISOString() : null,
        result.status,
        result.message,
        result.demoteAttestation,
      ],
    );
  });
}

/**
 * Atomic claim of the one-shot success-notification slot for a caller
 * that has just transitioned `pending → verified`. Returns true when we
 * won the claim (so the caller should fan out the toast), false when
 * another scheduler instance already sent the notification.
 *
 * Unlike `claimExpiryAlertSlot` this is a true one-shot — successful
 * verification only happens once per caller row, so we guard on
 * `verified_notification_sent_at IS NULL` rather than a sliding window.
 */
export async function claimVerifiedNotificationSlot(
  callerId: string,
  tenantId: string,
): Promise<boolean> {
  return withPrivilegedClient(async (client) => {
    const result = await client.query(
      `UPDATE verified_caller_ids
          SET verified_notification_sent_at = NOW(), updated_at = NOW()
        WHERE id = $1
          AND tenant_id = $2
          AND verified_notification_sent_at IS NULL`,
      [callerId, tenantId],
    );
    return (result.rowCount ?? 0) === 1;
  });
}

/**
 * Cross-tenant lookup of verified callers whose Trust Hub bundle is still
 * waiting on Twilio approval. Used by the daily Trust Hub status poll to
 * decide which rows need a fresh `fetchTrustHubStatus` call.
 *
 * A caller is considered "pending" when its `metadata.trustHub` snapshot
 * has at least one resource (Customer Profile, Trust Product, or A2P
 * brand registration) that is NOT yet in a terminal state. Terminal
 * states for the Trust Hub products are `twilio-approved` and
 * `twilio-rejected`; for brand registrations they are `APPROVED`,
 * `FAILED`, `REJECTED`, and `SUSPENDED`. A caller with all resources in
 * terminal states drops out of this query so the daily poll doesn't keep
 * burning Twilio API calls on bundles that will never change again.
 *
 * Uses `withPrivilegedClient` so the platform pool can read across all
 * tenants. The actual snapshot writes still go through
 * `attachTrustHubRegistration` (which is tenant-scoped via `withTenant`),
 * so RLS still protects writes.
 */
export async function listCallersWithPendingTrustHub(
  limit: number = 200,
): Promise<VerifiedCallerId[]> {
  return withPrivilegedClient(async (client) => {
    const { rows } = await client.query(
      `SELECT * FROM verified_caller_ids
        WHERE status = 'verified'
          AND metadata ? 'trustHub'
          AND metadata #>> '{trustHub,customerProfile,sid}' IS NOT NULL
          AND (
            LOWER(COALESCE(metadata #>> '{trustHub,customerProfile,status}', ''))
              NOT IN ('twilio-approved', 'twilio-rejected')
            OR LOWER(COALESCE(metadata #>> '{trustHub,trustProduct,status}', ''))
              NOT IN ('twilio-approved', 'twilio-rejected')
            OR (
              jsonb_typeof(metadata #> '{trustHub,brand}') = 'object'
              AND UPPER(COALESCE(metadata #>> '{trustHub,brand,status}', ''))
                NOT IN ('APPROVED', 'FAILED', 'REJECTED', 'SUSPENDED')
            )
          )
        ORDER BY (metadata #>> '{trustHub,lastSyncedAt}') NULLS FIRST, updated_at ASC
        LIMIT $1`,
      [limit],
    );
    return rows.map(rowToCaller);
  });
}

/**
 * Promote a verified caller's stored attestation level. SHAKEN/STIR
 * approval flips the Trust Hub product to `twilio-approved`, at which
 * point the carrier will attest at level A — so we promote the row's
 * attestation only when the new level is strictly higher than the
 * current one. Level ordering: A > B > C > none. Returns `true` when
 * the row was actually updated (so the caller can fan out a notice or
 * audit entry), `false` when the existing level was already at or above
 * the requested level.
 */
const ATTESTATION_RANK: Record<AttestationLevel | 'none', number> = {
  none: 0,
  C: 1,
  B: 2,
  A: 3,
};

export async function promoteCallerAttestation(
  tenantId: string,
  callerId: string,
  level: AttestationLevel,
): Promise<boolean> {
  return withPrivilegedClient(async (client) => {
    const result = await client.query(
      `UPDATE verified_caller_ids
          SET attestation_level = $3, updated_at = NOW()
        WHERE id = $1
          AND tenant_id = $2
          AND COALESCE(
            CASE attestation_level
              WHEN 'A' THEN 3
              WHEN 'B' THEN 2
              WHEN 'C' THEN 1
              ELSE 0
            END,
            0
          ) < $4`,
      [callerId, tenantId, level, ATTESTATION_RANK[level]],
    );
    return (result.rowCount ?? 0) === 1;
  });
}

/**
 * Atomic claim of the weekly alert slot for one caller. Returns true when
 * we won the claim (so the caller should send the alert), false when
 * another scheduler tick already sent one within `throttleMs`.
 *
 * Mirrors the pattern used by `ConnectorAuthAlertScheduler.claimAuthAlertSlot`
 * — the throttle stamp is set inside the same UPDATE so two scheduler
 * instances racing for the same row can't both alert.
 */
export async function claimExpiryAlertSlot(
  callerId: string,
  tenantId: string,
  throttleMs: number,
): Promise<boolean> {
  return withPrivilegedClient(async (client) => {
    const result = await client.query(
      `UPDATE verified_caller_ids
          SET expiry_alert_sent_at = NOW(), updated_at = NOW()
        WHERE id = $1
          AND tenant_id = $2
          AND (
            expiry_alert_sent_at IS NULL
            OR expiry_alert_sent_at < NOW() - ($3 || ' milliseconds')::interval
          )`,
      [callerId, tenantId, String(throttleMs)],
    );
    return (result.rowCount ?? 0) === 1;
  });
}

/**
 * Unconditional throttle stamp used by the operator-triggered re-issue
 * path on the Platform Admin verified-caller health panel. Skips the
 * throttle predicate so the slot is reset to NOW() even when an alert
 * was sent inside the current weekly window. Subsequent automated
 * cycles still respect the freshly-stamped window.
 */
export async function stampExpiryAlertSlot(
  callerId: string,
  tenantId: string,
): Promise<void> {
  await withPrivilegedClient(async (client) => {
    await client.query(
      `UPDATE verified_caller_ids
          SET expiry_alert_sent_at = NOW(), updated_at = NOW()
        WHERE id = $1 AND tenant_id = $2`,
      [callerId, tenantId],
    );
  });
}

/**
 * One row in the cross-tenant unhealthy-verified-callers view that backs
 * the Platform Admin health panel. Joins the row with its owning tenant
 * so the UI can render `tenantName` without an extra round-trip per row.
 */
export interface UnhealthyVerifiedCallerRow {
  caller: VerifiedCallerId;
  tenantName: string | null;
  tenantSlug: string | null;
}

/**
 * Cross-tenant view of verified callers whose last health check came back
 * as `expiring_soon`, `expired`, or `revoked`. Backs the Platform Admin
 * "Verified caller health" panel so support can proactively reach out
 * before outbound deliverability degrades.
 *
 * Sorted by computed days-remaining ascending so the most urgent rows
 * surface first. `revoked` rows are treated as the most urgent
 * (effectively -infinity days remaining) since carrier attestation is
 * already gone and the `expires_at` column is typically NULL for them.
 * Within the rest, the row with the soonest (or most-overdue) `expires_at`
 * sorts first — a row already 5 days expired ranks ahead of one expiring
 * tomorrow.
 *
 * Uses `withPrivilegedClient` because the table has RLS enabled and is
 * otherwise locked to a single `app.tenant_id` setting.
 */
export async function listUnhealthyVerifiedCallers(
  limit: number = 200,
): Promise<UnhealthyVerifiedCallerRow[]> {
  return withPrivilegedClient(async (client) => {
    const { rows } = await client.query(
      `SELECT v.*, t.name AS __tenant_name, t.slug AS __tenant_slug
         FROM verified_caller_ids v
         LEFT JOIN tenants t ON t.id = v.tenant_id
        WHERE v.status = 'verified'
          AND v.last_health_status IN ('expiring_soon', 'expired', 'revoked')
        ORDER BY
          -- "Days remaining" sort key. Revoked rows sort first
          -- unconditionally (carrier no longer attests), then expired,
          -- then expiring_soon — within each bucket the soonest /
          -- most-overdue expires_at wins.
          CASE
            WHEN v.last_health_status = 'revoked' THEN -2147483648
            WHEN v.expires_at IS NULL THEN -2147483647
            ELSE EXTRACT(EPOCH FROM (v.expires_at - NOW()))::bigint / 86400
          END ASC,
          v.last_health_check_at DESC NULLS LAST
        LIMIT $1`,
      [limit],
    );
    return rows.map((r) => ({
      caller: rowToCaller(r),
      tenantName: (r.__tenant_name as string) ?? null,
      tenantSlug: (r.__tenant_slug as string) ?? null,
    }));
  });
}
