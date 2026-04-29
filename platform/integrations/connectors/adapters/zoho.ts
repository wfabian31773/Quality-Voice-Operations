import { createLogger } from '../../../core/logger';
import { ensureFreshOAuthToken } from '../tokenRefresh';
import { parseDispositionMap, mapDisposition } from '../dispositionMap';
import { resolveZohoApiDomain } from '../zohoRegion';
import type { ConnectorAdapter, ConnectorConfig, ConnectorPayload, ConnectorResult } from '../types';
import type { TenantId } from '../../../core/types';

const logger = createLogger('ZOHO_CONNECTOR');
const REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_API_DOMAIN = 'https://www.zohoapis.com';

interface ZohoAuth {
  accessToken: string;
  apiBase: string;
}

interface DealRefs {
  contactId?: string;
  accountId?: string;
  dealId?: string;
}

type ResolveAuthOutcome =
  | { ok: true; auth: ZohoAuth }
  | { ok: false; error: string };

function resolveAuth(config: ConnectorConfig): ResolveAuthOutcome {
  const accessToken = config.credentials.access_token ?? '';
  if (!accessToken) {
    return { ok: false, error: 'Zoho connector not configured: missing access_token' };
  }
  // Validate `api_domain` against Zoho's published API host allowlist before
  // using it as a fetch base — every CRM call carries an
  // `Authorization: Zoho-oauthtoken …` header, so a tampered or
  // tenant-edited domain pointing at an attacker-controlled or internal
  // host would be a direct SSRF + token-exfiltration primitive.
  const storedApiDomain = config.credentials.api_domain;
  const validatedApiDomain = resolveZohoApiDomain(storedApiDomain);
  if (storedApiDomain && !validatedApiDomain) {
    return {
      ok: false,
      error: `Zoho connector refusing to dispatch: stored api_domain "${storedApiDomain}" is not a recognized Zoho API host. Reconnect via OAuth.`,
    };
  }
  const apiDomain = validatedApiDomain ?? DEFAULT_API_DOMAIN;
  return { ok: true, auth: { accessToken, apiBase: `${apiDomain}/crm/v2` } };
}

function authHeaders(auth: ZohoAuth): Record<string, string> {
  return {
    Authorization: `Zoho-oauthtoken ${auth.accessToken}`,
    'Content-Type': 'application/json',
  };
}

interface ZohoFetchResult<T> {
  ok: boolean;
  status: number;
  data?: T;
  error?: string;
}

/**
 * Zoho error codes that mean the targeted record (Contact, Account, Deal)
 * genuinely no longer exists in the upstream CRM.
 *
 * - `RESOURCE_NOT_FOUND` / `RECORD_NOT_FOUND` / `ID_NOT_FOUND`: returned
 *   directly when a path-targeted resource is gone (commonly with HTTP 404).
 * - `INVALID_DATA`: returned in per-record bulk-write responses when a
 *   referenced related ID (e.g. a `Who_Id`/`What_Id`/`Parent_Id`/`Account_Name`
 *   pointing at a deleted record) can't be resolved. Zoho's body wording is
 *   "the id given seems to be invalid" / "the related id given seems to be
 *   invalid" — we gate on that to avoid clearing the cache on unrelated
 *   validation errors (bad field type, missing required field, etc.).
 *
 * Anything outside this set (rate limit, auth error, generic validation) is
 * NOT a stale signal and must NOT clear the caller-identity cache.
 */
const ZOHO_STALE_DIRECT_ERROR_CODES = new Set([
  'RESOURCE_NOT_FOUND',
  'RECORD_NOT_FOUND',
  'ID_NOT_FOUND',
]);

const ZOHO_STALE_INVALID_DATA_PATTERN =
  /(?:related\s*id|id\s*given).*?(?:invalid|not\s*found|deleted)|does\s*not\s*exist|already\s*deleted/i;

function isZohoStaleErrorCode(code: string | undefined, message: string | undefined): boolean {
  if (!code) return false;
  if (ZOHO_STALE_DIRECT_ERROR_CODES.has(code)) return true;
  if (code === 'INVALID_DATA' && message && ZOHO_STALE_INVALID_DATA_PATTERN.test(message)) return true;
  return false;
}

/**
 * Inspect a Zoho HTTP-level error envelope (raw `error` string from
 * `zohoFetch`, which is `Zoho {status}: {body}`) and decide whether it
 * should be treated as a stale-record signal. Path-targeted 404s are the
 * canonical "the URL-named record is gone" response, but if the body
 * carries a recognised non-stale error code (e.g. `OAUTH_SCOPE_MISMATCH`
 * on a misrouted call) we honour that instead so we don't over-clear the
 * cache. Mirrors the HubSpot/Salesforce extractors.
 */
function extractZohoHttpStaleErrorCode(status: number, error: string | undefined): string | undefined {
  let parsedCode: string | undefined;
  let parsedMessage: string | undefined;
  if (error) {
    const codeMatch = error.match(/"code"\s*:\s*"([A-Z0-9_]+)"/);
    if (codeMatch) parsedCode = codeMatch[1];
    const msgMatch = error.match(/"message"\s*:\s*"([^"]*)"/);
    if (msgMatch) parsedMessage = msgMatch[1];
  }
  if (parsedCode) {
    if (isZohoStaleErrorCode(parsedCode, parsedMessage)) return parsedCode;
    // Recognised non-stale code — let the failure surface but don't clear
    // the cache, even if status is 404 (e.g. a typo'd module URL).
    return undefined;
  }
  if (status === 404) return 'NOT_FOUND';
  return undefined;
}

interface ZohoStaleIds {
  contactId?: string;
  accountId?: string;
  dealId?: string;
}

/**
 * Thrown by Zoho write/lookup helpers when the upstream returns a stale-
 * record signal (HTTP 404, `RESOURCE_NOT_FOUND`, or `INVALID_DATA` with a
 * "related id" message) for a request that referenced a cached/hinted
 * record ID. Carries the IDs the failing call referenced (keyed by Zoho-
 * native field names: `contactId`, `accountId`, `dealId`) so the handlers
 * can surface them via `result.meta.staleIds`, and the dispatch layer can
 * scrub them from the caller-identity cache. Mirrors `HubSpotStaleRecordError`
 * and `PipedriveStaleRecordError`.
 */
class ZohoStaleRecordError extends Error {
  staleIds: ZohoStaleIds;
  errorCode?: string;
  constructor(message: string, staleIds: ZohoStaleIds, errorCode?: string) {
    super(message);
    this.name = 'ZohoStaleRecordError';
    this.staleIds = staleIds;
    this.errorCode = errorCode;
  }
}

/**
 * Build a `ZohoStaleIds` object containing only the entries actually
 * populated on `candidates`. Helpers pass in the IDs that the failing
 * request body referenced; this keeps the surfaced `staleIds` narrow so
 * the dispatch layer's value-match scrub doesn't accidentally clear an
 * unrelated cached slot.
 */
function pruneStaleIds(candidates: ZohoStaleIds): ZohoStaleIds {
  const out: ZohoStaleIds = {};
  if (candidates.contactId) out.contactId = candidates.contactId;
  if (candidates.accountId) out.accountId = candidates.accountId;
  if (candidates.dealId) out.dealId = candidates.dealId;
  return out;
}

/**
 * Inspect a Zoho write/PUT response (body-level per-record entry OR
 * HTTP-level error envelope) and throw `ZohoStaleRecordError` when the
 * failure is unambiguously a stale-record signal. The bulk write API
 * returns 200/207 with a per-record `{ status: 'error', code, message }`
 * envelope — the per-record body check covers that path. Path-targeted
 * 404s are covered by the HTTP-level check.
 */
function maybeThrowZohoStale(
  res: ZohoFetchResult<ZohoWriteResponse>,
  candidates: ZohoStaleIds,
  context: string,
): void {
  const staleIds = pruneStaleIds(candidates);
  if (Object.keys(staleIds).length === 0) return;

  if (res.ok && res.data?.data?.length) {
    const entry = res.data.data[0];
    if (entry.status === 'error' && isZohoStaleErrorCode(entry.code, entry.message)) {
      const code = entry.code ?? 'INVALID_DATA';
      const message = entry.message ?? '';
      throw new ZohoStaleRecordError(
        `${context} (${code}): ${message}`.slice(0, 240),
        staleIds,
        code,
      );
    }
    return;
  }

  if (!res.ok) {
    const httpStaleCode = extractZohoHttpStaleErrorCode(res.status, res.error);
    if (httpStaleCode) {
      throw new ZohoStaleRecordError(
        `${context} (${res.status}, ${httpStaleCode}): ${res.error ?? ''}`.slice(0, 240),
        staleIds,
        httpStaleCode,
      );
    }
  }
}

async function zohoFetch<T = unknown>(
  auth: ZohoAuth,
  path: string,
  init?: { method?: string; body?: unknown },
): Promise<ZohoFetchResult<T>> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const url = `${auth.apiBase}${path}`;
    const res = await fetch(url, {
      method: init?.method ?? 'GET',
      headers: authHeaders(auth),
      body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
      signal: controller.signal,
    });
    // Zoho returns 204 (no records) for empty searches; treat as ok with empty data.
    if (res.status === 204) {
      return { ok: true, status: 204, data: { data: [] } as unknown as T };
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return { ok: false, status: res.status, error: `Zoho ${res.status}: ${text.slice(0, 200)}` };
    }
    const data = (await res.json()) as T;
    return { ok: true, status: res.status, data };
  } catch (err) {
    return { ok: false, status: 0, error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timeoutId);
  }
}

interface ZohoSearchResponse {
  data?: Array<{ id: string }>;
}

interface ZohoWriteResponse {
  data?: Array<{
    code?: string;
    status?: string;
    message?: string;
    details?: { id?: string };
  }>;
}

function extractWrittenId(res: ZohoFetchResult<ZohoWriteResponse>): string | undefined {
  if (!res.ok || !res.data?.data?.length) return undefined;
  const entry = res.data.data[0];
  if (entry.status && entry.status !== 'success') return undefined;
  return entry.details?.id;
}

function escapeCriteria(value: string): string {
  // Zoho's search criteria DSL needs parentheses and commas escaped; backslashes
  // are the standard escape character.
  return value.replace(/[\\()]/g, (m) => `\\${m}`);
}

export class ZohoConnectorAdapter implements ConnectorAdapter {
  async execute(
    tenantId: TenantId,
    config: ConnectorConfig,
    payload: ConnectorPayload,
  ): Promise<ConnectorResult> {
    let activeConfig = config;
    try {
      activeConfig = await ensureFreshOAuthToken(config);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      logger.error('Zoho token refresh failed', { tenantId, error });
      return { success: false, error: `Zoho token refresh failed: ${error}` };
    }
    const authResult = resolveAuth(activeConfig);
    if (!authResult.ok) {
      logger.error(authResult.error, { tenantId });
      return { success: false, error: authResult.error };
    }
    const auth = authResult.auth;

    switch (payload.type) {
      case 'call.completed':
        return this.handleCallCompleted(tenantId, auth, payload, activeConfig);
      case 'appointment.booked':
        return this.handleAppointmentBooked(tenantId, auth, payload, activeConfig);
      default:
        return { success: false, error: `Zoho adapter does not handle event: ${payload.type}` };
    }
  }

  private async handleCallCompleted(
    tenantId: TenantId,
    auth: ZohoAuth,
    payload: ConnectorPayload,
    config: ConnectorConfig,
  ): Promise<ConnectorResult> {
    const callerPhone = payload.callerPhone as string | undefined;
    const callerCompany = payload.callerCompany as string | undefined;
    const summary = (payload.summary as string | undefined) ?? 'AI voice call completed';
    const duration = (payload.durationSeconds as number | undefined) ?? 0;
    const callSid = payload.callSid as string | undefined;
    const disposition = payload.disposition as string | undefined;

    try {
      const customMap = parseDispositionMap(config.credentials, 'zoho');
      const dispositionFields = mapDisposition('zoho', disposition, customMap);

      const refs: DealRefs = {
        contactId: payload.contactId as string | undefined,
        accountId: payload.accountId as string | undefined,
        dealId: (payload.dealId as string | undefined)
          ?? (payload.opportunityId as string | undefined),
      };

      if (!refs.accountId && callerCompany) {
        refs.accountId = await this.findOrCreateAccount(auth, callerCompany);
      }

      if (!refs.contactId && callerPhone) {
        refs.contactId = await this.findOrCreateContact(auth, callerPhone, payload, refs.accountId);
      }

      const callBody: Record<string, unknown> = {
        Subject: dispositionFields.callDisposition || 'AI Voice Call',
        Call_Type: 'Inbound',
        Call_Start_Time: new Date().toISOString(),
        Call_Duration: this.formatDuration(duration),
        Call_Duration_in_seconds: Math.max(0, Math.round(duration)),
        Call_Status: dispositionFields.status || 'Completed',
        Description: summary + (callSid ? `\n\nCall SID: ${callSid}` : ''),
      };
      if (dispositionFields.callDisposition) {
        callBody.Call_Purpose = dispositionFields.callDisposition;
      }
      if (callerPhone) callBody.Caller_ID = callerPhone;
      if (refs.contactId) {
        callBody.Who_Id = { id: refs.contactId };
        callBody.$se_module = 'Contacts';
      }
      if (refs.dealId) {
        callBody.What_Id = { id: refs.dealId };
        callBody.$se_module = 'Deals';
      } else if (refs.accountId) {
        callBody.What_Id = { id: refs.accountId };
        callBody.$se_module = 'Accounts';
      }

      const callRes = await zohoFetch<ZohoWriteResponse>(auth, '/Calls', {
        method: 'POST',
        body: { data: [callBody] },
      });
      // The Call POST body references contactId via Who_Id and either
      // dealId (preferred) or accountId via What_Id. A stale signal here
      // is ambiguous — flag every ID the body referenced and let the
      // dispatch layer's value-match scrub clear only the truly stale one(s).
      maybeThrowZohoStale(callRes, refs, 'Zoho Call create failed');
      const callId = extractWrittenId(callRes);
      if (!callId) {
        throw new Error(callRes.error ?? 'Zoho Call create failed');
      }

      logger.info('Zoho call logged', {
        tenantId,
        contactId: refs.contactId,
        accountId: refs.accountId,
        dealId: refs.dealId,
        callId,
      });
      return {
        success: true,
        externalId: callId,
        meta: {
          contactId: refs.contactId,
          accountId: refs.accountId,
          dealId: refs.dealId,
          ...this.canonicalAliases(refs),
          callId,
          activityId: callId,
          provider: 'zoho',
        },
      };
    } catch (err) {
      if (err instanceof ZohoStaleRecordError) {
        logger.warn('Zoho call logging hit stale cached record', {
          tenantId, errorCode: err.errorCode, staleIds: err.staleIds,
        });
        return this.staleRecordResult(err, payload);
      }
      const error = err instanceof Error ? err.message : String(err);
      logger.error('Zoho call logging failed', { tenantId, error });
      return { success: false, error };
    }
  }

  /**
   * Build a `ConnectorResult` for a stale-record failure. Only IDs that
   * actually appeared on the inbound payload (matched against either the
   * Zoho-native key OR the canonical Salesforce-style alias) are surfaced
   * as `meta.staleIds` — the dispatch layer's value-match scrub then clears
   * only those slots from `crm_caller_identities`. Mirrors the helpers on
   * the HubSpot/Pipedrive/Salesforce adapters.
   */
  private staleRecordResult(
    err: ZohoStaleRecordError,
    payload: ConnectorPayload,
  ): ConnectorResult {
    const filtered: Record<string, string> = {};
    const payloadContactId = payload.contactId as string | undefined;
    const payloadAccountId = payload.accountId as string | undefined;
    const payloadDealId = (payload.dealId as string | undefined)
      ?? (payload.opportunityId as string | undefined);
    if (err.staleIds.contactId && err.staleIds.contactId === payloadContactId) {
      filtered.contactId = err.staleIds.contactId;
    }
    if (err.staleIds.accountId && err.staleIds.accountId === payloadAccountId) {
      filtered.accountId = err.staleIds.accountId;
    }
    if (err.staleIds.dealId && err.staleIds.dealId === payloadDealId) {
      filtered.dealId = err.staleIds.dealId;
    }
    return {
      success: false,
      error: err.message,
      meta: {
        provider: 'zoho',
        staleRecord: true,
        ...(err.errorCode ? { staleErrorCode: err.errorCode } : {}),
        ...(Object.keys(filtered).length > 0 ? { staleIds: filtered } : {}),
      },
    };
  }

  private async handleAppointmentBooked(
    tenantId: TenantId,
    auth: ZohoAuth,
    payload: ConnectorPayload,
    config: ConnectorConfig,
  ): Promise<ConnectorResult> {
    const callerPhone = payload.callerPhone as string | undefined;
    const callerCompany = payload.callerCompany as string | undefined;
    const summary = payload.summary as string | undefined;
    const dateStr = payload.appointmentDate as string | undefined;
    const timeStr = payload.appointmentTime as string | undefined;
    const appointmentStageName = (payload.appointmentStageId as string | undefined)
      ?? config.credentials.appointment_stage_id
      ?? undefined;
    const pipelineLayoutId = (payload.pipelineId as string | undefined)
      ?? config.credentials.appointment_pipeline_id
      ?? undefined;

    try {
      // Validate disposition map up-front so a bad config surfaces in the
      // connector activity log even when this code path doesn't read call
      // disposition fields.
      parseDispositionMap(config.credentials, 'zoho');

      const refs: DealRefs = {
        contactId: payload.contactId as string | undefined,
        accountId: payload.accountId as string | undefined,
        dealId: (payload.dealId as string | undefined)
          ?? (payload.opportunityId as string | undefined),
      };

      // Resolve account first so the new Contact can be linked at create time.
      if (!refs.accountId && callerCompany) {
        refs.accountId = await this.findOrCreateAccount(auth, callerCompany);
      }

      if (!refs.contactId && callerPhone) {
        refs.contactId = await this.findOrCreateContact(auth, callerPhone, payload, refs.accountId);
      }

      // Auto-promote: ensure a Deal exists tied to the Contact (and Account
      // when present) so the booked appointment is reflected in pipeline
      // reporting end-to-end.
      let dealMoved = false;
      if (refs.contactId) {
        if (!refs.dealId) {
          refs.dealId = await this.findOpenDealForContact(auth, refs.contactId);
        }
        if (!refs.dealId) {
          refs.dealId = await this.createDealForContact(
            auth,
            refs.contactId,
            payload,
            refs.accountId,
            appointmentStageName,
            pipelineLayoutId,
          );
        } else if (appointmentStageName) {
          dealMoved = await this.moveDealStage(
            auth,
            refs.dealId,
            appointmentStageName,
            refs.accountId,
            pipelineLayoutId,
          );
        } else if (refs.accountId) {
          await this.ensureDealAccount(auth, refs.dealId, refs.accountId);
        }
      }

      const noteBody = [
        'Appointment booked via AI voice agent',
        summary ? `Details: ${summary}` : '',
        dateStr ? `Date: ${dateStr}` : '',
        timeStr ? `Time: ${timeStr}` : '',
        refs.dealId ? `Deal ID: ${refs.dealId}` : '',
      ].filter(Boolean).join('\n');

      const noteParent = refs.dealId
        ? { id: refs.dealId, module: 'Deals' as const }
        : refs.contactId
          ? { id: refs.contactId, module: 'Contacts' as const }
          : refs.accountId
            ? { id: refs.accountId, module: 'Accounts' as const }
            : null;

      let noteId: string | undefined;
      if (noteParent) {
        const noteRes = await zohoFetch<ZohoWriteResponse>(auth, '/Notes', {
          method: 'POST',
          body: {
            data: [{
              Note_Title: 'Appointment Booked',
              Note_Content: noteBody,
              Parent_Id: { id: noteParent.id },
              se_module: noteParent.module,
            }],
          },
        });
        // The Note POST body's Parent_Id is unambiguously the noteParent ID
        // — flag only that ID so a stale signal here clears the matching
        // cache slot without touching unrelated ones.
        const noteParentStale: ZohoStaleIds = {};
        if (noteParent.module === 'Contacts') noteParentStale.contactId = noteParent.id;
        else if (noteParent.module === 'Accounts') noteParentStale.accountId = noteParent.id;
        else if (noteParent.module === 'Deals') noteParentStale.dealId = noteParent.id;
        maybeThrowZohoStale(noteRes, noteParentStale, 'Zoho Note create failed');
        noteId = extractWrittenId(noteRes);
        if (!noteId) {
          throw new Error(noteRes.error ?? 'Zoho Note create failed');
        }
      } else {
        // No record to attach the note to — log the booking as a stand-alone
        // Task instead so the activity is still discoverable in Zoho.
        const taskRes = await zohoFetch<ZohoWriteResponse>(auth, '/Tasks', {
          method: 'POST',
          body: {
            data: [{
              Subject: 'Appointment Booked',
              Status: 'Completed',
              Description: noteBody,
              ...(dateStr ? { Due_Date: dateStr } : {}),
            }],
          },
        });
        noteId = extractWrittenId(taskRes);
        if (!noteId) {
          throw new Error(taskRes.error ?? 'Zoho Task create failed');
        }
      }

      logger.info('Zoho appointment processed', {
        tenantId,
        contactId: refs.contactId,
        accountId: refs.accountId,
        dealId: refs.dealId,
        noteId,
        appointmentStageName,
        pipelineLayoutId,
        dealMoved,
      });
      return {
        success: true,
        externalId: noteId,
        meta: {
          contactId: refs.contactId,
          accountId: refs.accountId,
          dealId: refs.dealId,
          ...this.canonicalAliases(refs),
          noteId,
          activityId: noteId,
          provider: 'zoho',
          ...(pipelineLayoutId ? { pipelineId: pipelineLayoutId } : {}),
          ...(appointmentStageName ? { stageId: appointmentStageName } : {}),
          ...(dealMoved ? { dealStageMoved: true } : {}),
        },
      };
    } catch (err) {
      if (err instanceof ZohoStaleRecordError) {
        logger.warn('Zoho appointment logging hit stale cached record', {
          tenantId, errorCode: err.errorCode, staleIds: err.staleIds,
        });
        return this.staleRecordResult(err, payload);
      }
      const error = err instanceof Error ? err.message : String(err);
      logger.error('Zoho appointment logging failed', { tenantId, error });
      return { success: false, error };
    }
  }

  /**
   * Canonical Salesforce-style aliases (`contactId`/`accountId`/`opportunityId`)
   * derived from Zoho's native IDs. `contactId` and `accountId` already match
   * the canonical names so they pass through verbatim; `opportunityId` is
   * emitted alongside the existing `dealId` field. Mirrors the helper added
   * to `hubspot.ts` and `pipedrive.ts` so the cross-provider caller-identity
   * cache can store both shapes verbatim, and a future event for this caller
   * can re-inject either shape as a payload hint — the adapter accepts both
   * (see `handleCallCompleted` / `handleAppointmentBooked` where canonical
   * names are tried as a fallback to native ones).
   */
  private canonicalAliases(refs: DealRefs): Record<string, string> {
    const out: Record<string, string> = {};
    if (refs.contactId !== undefined) out.contactId = refs.contactId;
    if (refs.accountId !== undefined) out.accountId = refs.accountId;
    if (refs.dealId !== undefined) out.opportunityId = refs.dealId;
    return out;
  }

  private async findOrCreateContact(
    auth: ZohoAuth,
    phone: string,
    payload: ConnectorPayload,
    accountId?: string,
  ): Promise<string | undefined> {
    const search = await zohoFetch<ZohoSearchResponse>(
      auth,
      `/Contacts/search?phone=${encodeURIComponent(phone)}`,
    );
    if (search.ok && search.data?.data?.length) {
      return search.data.data[0].id;
    }

    const firstName = (payload.callerFirstName as string) ?? '';
    const lastName = (payload.callerLastName as string) ?? '';
    const email = (payload.callerEmail as string) ?? '';
    const last = lastName.trim() || firstName.trim() || `Caller ${phone}`;

    const body: Record<string, unknown> = {
      Last_Name: last,
      Phone: phone,
    };
    if (firstName && lastName) body.First_Name = firstName;
    if (email) body.Email = email;
    if (accountId) body.Account_Name = { id: accountId };

    const create = await zohoFetch<ZohoWriteResponse>(auth, '/Contacts', {
      method: 'POST',
      body: { data: [body] },
    });
    const id = extractWrittenId(create);
    if (!id) {
      logger.warn('Zoho contact create failed', { error: create.error });
      return undefined;
    }
    return id;
  }

  private async findOrCreateAccount(
    auth: ZohoAuth,
    name: string,
  ): Promise<string | undefined> {
    const trimmed = name.trim();
    if (!trimmed || trimmed.toLowerCase() === 'unknown') return undefined;

    const criteria = `(Account_Name:equals:${escapeCriteria(trimmed)})`;
    const search = await zohoFetch<ZohoSearchResponse>(
      auth,
      `/Accounts/search?criteria=${encodeURIComponent(criteria)}`,
    );
    if (search.ok && search.data?.data?.length) {
      return search.data.data[0].id;
    }

    const create = await zohoFetch<ZohoWriteResponse>(auth, '/Accounts', {
      method: 'POST',
      body: { data: [{ Account_Name: trimmed }] },
    });
    const id = extractWrittenId(create);
    if (!id) {
      logger.warn('Zoho account create failed', { error: create.error });
      return undefined;
    }
    return id;
  }

  private async findOpenDealForContact(
    auth: ZohoAuth,
    contactId: string,
  ): Promise<string | undefined> {
    const res = await zohoFetch<{
      data?: Array<{ id: string; Stage?: string }>;
    }>(auth, `/Contacts/${encodeURIComponent(contactId)}/Deals?per_page=10`);
    if (!res.ok) {
      // The contactId is in the URL path, so a stale signal here
      // unambiguously identifies the contactId as the deleted record.
      const httpStaleCode = extractZohoHttpStaleErrorCode(res.status, res.error);
      if (httpStaleCode) {
        throw new ZohoStaleRecordError(
          `Zoho contact deals lookup failed (${res.status}, ${httpStaleCode}): ${res.error ?? ''}`.slice(0, 240),
          { contactId },
          httpStaleCode,
        );
      }
      return undefined;
    }
    if (!res.data?.data?.length) return undefined;
    const open = res.data.data.find((d) => {
      const stage = (d.Stage ?? '').toLowerCase();
      return stage !== 'closed won' && stage !== 'closed lost';
    });
    return (open ?? res.data.data[0]).id;
  }

  private async createDealForContact(
    auth: ZohoAuth,
    contactId: string,
    payload: ConnectorPayload,
    accountId?: string,
    stageName?: string,
    layoutId?: string,
  ): Promise<string | undefined> {
    const summary = (payload.summary as string | undefined) ?? '';
    const company = (payload.callerCompany as string | undefined) ?? '';
    const titleSeed = company || summary.slice(0, 60) || 'Inbound Lead';
    const dealName = payload.type === 'appointment.booked'
      ? `${titleSeed} - QVO Appointment`
      : `AI Voice Call: ${titleSeed}`;
    const closingDate = (payload.appointmentDate as string | undefined)
      ?? new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

    const body: Record<string, unknown> = {
      Deal_Name: dealName.slice(0, 250),
      Stage: stageName || 'Qualification',
      Closing_Date: closingDate,
      Contact_Name: { id: contactId },
    };
    if (accountId) body.Account_Name = { id: accountId };
    if (layoutId) body.Layout = { id: layoutId };

    const create = await zohoFetch<ZohoWriteResponse>(auth, '/Deals', {
      method: 'POST',
      body: { data: [body] },
    });
    // The Deal POST body references contactId via Contact_Name and (when
    // present) accountId via Account_Name. A stale signal is ambiguous —
    // flag both candidates so the dispatch layer's value-match scrub can
    // clear the truly stale one without touching the still-valid one.
    maybeThrowZohoStale(
      create,
      { contactId, ...(accountId ? { accountId } : {}) },
      'Zoho deal create failed',
    );
    const id = extractWrittenId(create);
    if (!id) {
      logger.warn('Zoho deal create failed', { contactId, error: create.error });
      return undefined;
    }
    return id;
  }

  private async moveDealStage(
    auth: ZohoAuth,
    dealId: string,
    stageName: string,
    accountId?: string,
    layoutId?: string,
  ): Promise<boolean> {
    const body: Record<string, unknown> = {
      id: dealId,
      Stage: stageName,
    };
    if (accountId) body.Account_Name = { id: accountId };
    if (layoutId) body.Layout = { id: layoutId };

    const update = await zohoFetch<ZohoWriteResponse>(auth, '/Deals', {
      method: 'PUT',
      body: { data: [body] },
    });
    // The PUT body references the dealId (always) and accountId (when set).
    // A stale signal could implicate either — flag both and rely on the
    // dispatch layer's value-match scrub. When accountId is absent, only
    // dealId is flagged so the scrub can target it precisely.
    maybeThrowZohoStale(
      update,
      { dealId, ...(accountId ? { accountId } : {}) },
      'Zoho deal stage move failed',
    );
    if (!update.ok || !update.data?.data?.length || update.data.data[0].status !== 'success') {
      logger.warn('Zoho deal stage move failed', { dealId, stageName, error: update.error });
      return false;
    }
    return true;
  }

  private async ensureDealAccount(
    auth: ZohoAuth,
    dealId: string,
    accountId: string,
  ): Promise<void> {
    const update = await zohoFetch<ZohoWriteResponse>(auth, '/Deals', {
      method: 'PUT',
      body: {
        data: [{
          id: dealId,
          Account_Name: { id: accountId },
        }],
      },
    });
    // The PUT body references dealId and accountId — flag both as
    // potential stale candidates, value-match scrub does the rest.
    maybeThrowZohoStale(update, { dealId, accountId }, 'Zoho deal account link failed');
    if (!update.ok || !update.data?.data?.length || update.data.data[0].status !== 'success') {
      logger.warn('Zoho deal account link failed', { dealId, accountId, error: update.error });
    }
  }

  private formatDuration(seconds: number): string {
    const total = Math.max(0, Math.round(seconds));
    const mm = Math.floor(total / 60).toString().padStart(2, '0');
    const ss = (total % 60).toString().padStart(2, '0');
    return `${mm}:${ss}`;
  }
}

/**
 * Periodic re-validation entry point for the
 * `CrmCallerIdentityRevalidationScheduler`. Probes each cached Zoho record
 * ID with a cheap path-targeted GET (`/Contacts/{id}`, `/Accounts/{id}`,
 * `/Deals/{id}`) and returns the IDs that came back stale (HTTP 404 /
 * `RESOURCE_NOT_FOUND` / `RECORD_NOT_FOUND`) keyed by Zoho-native field
 * names (`contactId`, `accountId`, `dealId`).
 *
 * Network errors / non-stale failures are deliberately ignored; only
 * confirmed-gone records are returned for scrubbing.
 */
export async function validateZohoCachedIdentity(
  tenantId: TenantId,
  config: ConnectorConfig,
  identity: {
    contactId?: string;
    accountId?: string;
    opportunityId?: string;
    extras?: Record<string, string>;
  },
): Promise<{ stale: { contactId?: string; accountId?: string; dealId?: string } }> {
  const stale: { contactId?: string; accountId?: string; dealId?: string } = {};

  const probes: Array<{ module: 'Contacts' | 'Accounts' | 'Deals'; id: string; key: 'contactId' | 'accountId' | 'dealId' }> = [];
  const seen = new Set<string>();
  const enqueue = (module: 'Contacts' | 'Accounts' | 'Deals', id: string | undefined, key: 'contactId' | 'accountId' | 'dealId') => {
    if (!id) return;
    const dedupeKey = `${module}:${id}`;
    if (seen.has(dedupeKey)) return;
    seen.add(dedupeKey);
    probes.push({ module, id, key });
  };
  enqueue('Contacts', identity.contactId, 'contactId');
  enqueue('Accounts', identity.accountId, 'accountId');
  enqueue('Deals', identity.opportunityId, 'dealId');
  if (probes.length === 0) return { stale };

  let activeConfig: ConnectorConfig;
  try {
    activeConfig = await ensureFreshOAuthToken(config);
  } catch (err) {
    logger.warn('Zoho validate identity skipped: token refresh failed', {
      tenantId, error: err instanceof Error ? err.message : String(err),
    });
    return { stale };
  }
  const authResult = resolveAuth(activeConfig);
  if (!authResult.ok) {
    logger.warn('Zoho validate identity skipped: auth resolve failed', { tenantId, error: authResult.error });
    return { stale };
  }
  const auth = authResult.auth;

  for (const probe of probes) {
    try {
      const res = await zohoFetch(auth, `/${probe.module}/${encodeURIComponent(probe.id)}`, { method: 'GET' });
      if (res.ok) continue;
      const staleCode = extractZohoHttpStaleErrorCode(res.status, res.error);
      if (staleCode) {
        stale[probe.key] = probe.id;
      }
    } catch (err) {
      logger.debug('Zoho validate probe errored', {
        tenantId, module: probe.module, id: probe.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return { stale };
}
