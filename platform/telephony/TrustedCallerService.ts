import { getPlatformPool, withTenantContext } from '../db';
import { createLogger } from '../core/logger';

const logger = createLogger('TRUSTED_CALLER');

export type VerifiedCallerStatus = 'pending' | 'verified' | 'failed' | 'rotated';
export type AttestationLevel = 'A' | 'B' | 'C';

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
const VERIFICATION_TTL_MS = 10 * 60 * 1000; // Twilio validation codes are valid for 10 minutes.

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
