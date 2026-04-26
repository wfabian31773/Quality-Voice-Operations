import { createLogger } from '../../../core/logger';
import { ensureFreshOAuthToken } from '../tokenRefresh';
import { parseDispositionMap, mapDisposition } from '../dispositionMap';
import type { ConnectorAdapter, ConnectorConfig, ConnectorPayload, ConnectorResult } from '../types';
import type { TenantId } from '../../../core/types';

const logger = createLogger('PIPEDRIVE_CONNECTOR');
const REQUEST_TIMEOUT_MS = 15_000;

interface PipedriveAuth {
  apiToken?: string;
  accessToken?: string;
  apiBase: string;
}

interface DealRefs {
  personId?: number;
  orgId?: number;
  dealId?: number;
}

function resolveAuth(config: ConnectorConfig): PipedriveAuth | null {
  const accessToken = config.credentials.access_token ?? '';
  const apiToken = config.credentials.api_token ?? '';
  const companyDomain = config.credentials.company_domain ?? '';

  if (accessToken) {
    const apiBase = companyDomain
      ? `https://${companyDomain}.pipedrive.com/api/v1`
      : 'https://api.pipedrive.com/v1';
    return { accessToken, apiBase };
  }
  if (apiToken) {
    const apiBase = companyDomain
      ? `https://${companyDomain}.pipedrive.com/api/v1`
      : 'https://api.pipedrive.com/v1';
    return { apiToken, apiBase };
  }
  return null;
}

function authHeaders(auth: PipedriveAuth): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (auth.accessToken) {
    headers.Authorization = `Bearer ${auth.accessToken}`;
  }
  return headers;
}

async function pdFetch<T = unknown>(
  auth: PipedriveAuth,
  path: string,
  init?: { method?: string; body?: unknown },
): Promise<{ ok: boolean; status: number; data?: T; error?: string }> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const sep = path.includes('?') ? '&' : '?';
    const tokenSep = auth.apiToken ? `${sep}api_token=${encodeURIComponent(auth.apiToken)}` : '';
    const url = `${auth.apiBase}${path}${tokenSep}`;
    const res = await fetch(url, {
      method: init?.method ?? 'GET',
      headers: authHeaders(auth),
      body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return { ok: false, status: res.status, error: `Pipedrive ${res.status}: ${text.slice(0, 200)}` };
    }
    const data = (await res.json()) as T;
    return { ok: true, status: res.status, data };
  } catch (err) {
    return { ok: false, status: 0, error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timeoutId);
  }
}

interface PdPersonCreate {
  success: boolean;
  data: { id: number };
}

interface PdDealsResponse {
  success: boolean;
  data: Array<{ id: number; status: string; title: string; stage_id?: number }> | null;
}

function toNumericId(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

/**
 * Thrown by Pipedrive write/lookup helpers when the upstream returns a 404
 * (or a body indicating the targeted Person/Organization/Deal no longer
 * exists). Carries the IDs the failing call referenced so the handlers can
 * surface them via `result.meta.staleIds`, and the dispatch layer can scrub
 * them from the caller-identity cache.
 */
class PipedriveStaleRecordError extends Error {
  staleIds: { personId?: string; orgId?: string; dealId?: string };
  errorCode?: string;
  constructor(
    message: string,
    staleIds: { personId?: string; orgId?: string; dealId?: string },
    errorCode?: string,
  ) {
    super(message);
    this.name = 'PipedriveStaleRecordError';
    this.staleIds = staleIds;
    this.errorCode = errorCode;
  }
}

/**
 * Decide whether a Pipedrive non-OK response should be treated as a
 * stale-record signal. Pipedrive returns a JSON envelope on failure shaped
 * like `{ success: false, error: "Person not found", error_info: "..." }`.
 *
 * - HTTP 404 / 410 on path-targeted resources is the canonical "object is
 *   gone" response. Treated as stale unless the body explicitly says
 *   otherwise (Pipedrive is consistent here, unlike Salesforce/HubSpot).
 * - For other non-OK statuses (commonly 400/410 on POST /activities when a
 *   referenced person_id / org_id / deal_id no longer exists), look for
 *   "not found" / "does not exist" / "deleted" wording in the error string.
 *
 * Returns the matching errorCode when stale, otherwise undefined.
 */
function extractPipedriveStaleErrorCode(status: number, error?: string): string | undefined {
  if (status === 404) return 'NOT_FOUND';
  if (status === 410) return 'GONE';
  if (!error) return undefined;
  if (/not\s*found|does\s*not\s*exist|has\s*been\s*deleted|is\s*deleted/i.test(error)) {
    return 'NOT_FOUND';
  }
  return undefined;
}

export interface PipedrivePipelineStage {
  id: number;
  name: string;
  orderNr: number;
}

export interface PipedrivePipelineWithStages {
  id: number;
  name: string;
  orderNr: number;
  active: boolean;
  stages: PipedrivePipelineStage[];
}

export async function fetchPipedrivePipelinesAndStages(
  tenantId: TenantId,
  config: ConnectorConfig,
): Promise<PipedrivePipelineWithStages[]> {
  let activeConfig = config;
  try {
    activeConfig = await ensureFreshOAuthToken(config);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    throw new Error(`Pipedrive token refresh failed: ${error}`);
  }
  const auth = resolveAuth(activeConfig);
  if (!auth) {
    throw new Error('Pipedrive connector not configured: missing access_token or api_token');
  }

  const [pipelinesRes, stagesRes] = await Promise.all([
    pdFetch<{
      success: boolean;
      data: Array<{
        id: number;
        name: string;
        order_nr?: number;
        active?: boolean;
      }> | null;
    }>(auth, '/pipelines'),
    pdFetch<{
      success: boolean;
      data: Array<{
        id: number;
        name: string;
        order_nr?: number;
        pipeline_id: number;
        active_flag?: boolean;
      }> | null;
    }>(auth, '/stages'),
  ]);

  if (!pipelinesRes.ok || !pipelinesRes.data?.success) {
    throw new Error(pipelinesRes.error ?? 'Pipedrive pipelines fetch failed');
  }
  if (!stagesRes.ok || !stagesRes.data?.success) {
    throw new Error(stagesRes.error ?? 'Pipedrive stages fetch failed');
  }

  const stagesByPipeline = new Map<number, PipedrivePipelineStage[]>();
  for (const stage of stagesRes.data.data ?? []) {
    if (stage.active_flag === false) continue;
    const list = stagesByPipeline.get(stage.pipeline_id) ?? [];
    list.push({
      id: stage.id,
      name: stage.name,
      orderNr: typeof stage.order_nr === 'number' ? stage.order_nr : 0,
    });
    stagesByPipeline.set(stage.pipeline_id, list);
  }
  for (const list of stagesByPipeline.values()) {
    list.sort((a, b) => a.orderNr - b.orderNr);
  }

  const pipelines = (pipelinesRes.data.data ?? []).map((p) => ({
    id: p.id,
    name: p.name,
    orderNr: typeof p.order_nr === 'number' ? p.order_nr : 0,
    active: p.active !== false,
    stages: stagesByPipeline.get(p.id) ?? [],
  }));
  pipelines.sort((a, b) => a.orderNr - b.orderNr);

  logger.info('Pipedrive pipelines fetched', { tenantId, pipelineCount: pipelines.length });
  return pipelines;
}

export class PipedriveConnectorAdapter implements ConnectorAdapter {
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
      logger.error('Pipedrive token refresh failed', { tenantId, error });
      return { success: false, error: `Pipedrive token refresh failed: ${error}` };
    }
    const auth = resolveAuth(activeConfig);
    if (!auth) {
      logger.error('Missing Pipedrive credentials', { tenantId });
      return { success: false, error: 'Pipedrive connector not configured: missing access_token or api_token' };
    }

    switch (payload.type) {
      case 'call.completed':
        return this.handleCallCompleted(tenantId, auth, payload, activeConfig);
      case 'appointment.booked':
        return this.handleAppointmentBooked(tenantId, auth, payload, activeConfig);
      default:
        return { success: false, error: `Pipedrive adapter does not handle event: ${payload.type}` };
    }
  }

  private async handleCallCompleted(
    tenantId: TenantId,
    auth: PipedriveAuth,
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
      const customMap = parseDispositionMap(config.credentials, 'pipedrive');
      const dispositionFields = mapDisposition('pipedrive', disposition, customMap);

      const refs: DealRefs = {
        personId: toNumericId(payload.personId) ?? toNumericId(payload.contactId),
        orgId: toNumericId(payload.orgId) ?? toNumericId(payload.accountId),
        dealId: toNumericId(payload.dealId) ?? toNumericId(payload.opportunityId),
      };

      if (!refs.orgId && callerCompany) {
        refs.orgId = await this.findOrCreateOrganization(auth, callerCompany);
      }

      if (!refs.personId && callerPhone) {
        refs.personId = await this.findOrCreatePerson(auth, callerPhone, payload, refs.orgId);
      }

      if (refs.personId && !refs.dealId) {
        refs.dealId = await this.findOpenDealForPerson(auth, refs.personId);
        if (!refs.dealId) {
          refs.dealId = await this.createDealForPerson(auth, refs.personId, payload, refs.orgId, config);
        }
      }

      const activityRes = await pdFetch<{ success: boolean; data: { id: number } }>(auth, '/activities', {
        method: 'POST',
        body: {
          subject: dispositionFields.callDisposition || 'AI Voice Call',
          type: dispositionFields.status || 'call',
          done: 1,
          duration: this.formatDuration(duration),
          note: summary + (callSid ? `\n\nCall SID: ${callSid}` : ''),
          ...(refs.personId ? { person_id: refs.personId } : {}),
          ...(refs.orgId ? { org_id: refs.orgId } : {}),
          ...(refs.dealId ? { deal_id: refs.dealId } : {}),
        },
      });

      if (!activityRes.ok || !activityRes.data?.success) {
        this.maybeThrowActivityStale(activityRes, refs);
        throw new Error(activityRes.error ?? 'Pipedrive activity create failed');
      }

      const activityId = String(activityRes.data.data.id);
      logger.info('Pipedrive call activity logged', {
        tenantId,
        personId: refs.personId,
        orgId: refs.orgId,
        dealId: refs.dealId,
        activityId,
      });
      return {
        success: true,
        externalId: activityId,
        meta: {
          personId: refs.personId,
          orgId: refs.orgId,
          dealId: refs.dealId,
          ...this.canonicalAliases(refs),
          activityId,
          provider: 'pipedrive',
        },
      };
    } catch (err) {
      if (err instanceof PipedriveStaleRecordError) {
        logger.warn('Pipedrive call logging hit stale cached record', {
          tenantId, errorCode: err.errorCode, staleIds: err.staleIds,
        });
        return this.staleRecordResult(err, payload);
      }
      const error = err instanceof Error ? err.message : String(err);
      logger.error('Pipedrive call logging failed', { tenantId, error });
      return { success: false, error };
    }
  }

  private async handleAppointmentBooked(
    tenantId: TenantId,
    auth: PipedriveAuth,
    payload: ConnectorPayload,
    config: ConnectorConfig,
  ): Promise<ConnectorResult> {
    const callerPhone = payload.callerPhone as string | undefined;
    const callerCompany = payload.callerCompany as string | undefined;
    const summary = payload.summary as string | undefined;
    const dateStr = payload.appointmentDate as string | undefined;
    const timeStr = payload.appointmentTime as string | undefined;
    const appointmentStageId = toNumericId(payload.appointmentStageId)
      ?? toNumericId(config.credentials.appointment_stage_id);

    try {
      const customMap = parseDispositionMap(config.credentials, 'pipedrive');
      const dispositionFields = mapDisposition('pipedrive', 'booked', customMap);

      const refs: DealRefs = {
        personId: toNumericId(payload.personId) ?? toNumericId(payload.contactId),
        orgId: toNumericId(payload.orgId) ?? toNumericId(payload.accountId),
        dealId: toNumericId(payload.dealId) ?? toNumericId(payload.opportunityId),
      };

      // Resolve org first so the new Person can be linked at create time.
      if (!refs.orgId && callerCompany) {
        refs.orgId = await this.findOrCreateOrganization(auth, callerCompany);
      }

      if (!refs.personId && callerPhone) {
        refs.personId = await this.findOrCreatePerson(auth, callerPhone, payload, refs.orgId);
      }

      // Auto-promote: ensure a Deal exists tied to the Person (and Org when present)
      // so the booked appointment is reflected in pipeline reporting.
      let dealMoved = false;
      if (refs.personId) {
        if (!refs.dealId) {
          refs.dealId = await this.findOpenDealForPerson(auth, refs.personId);
        }
        if (!refs.dealId) {
          refs.dealId = await this.createDealForPerson(
            auth,
            refs.personId,
            payload,
            refs.orgId,
            config,
            appointmentStageId,
          );
        } else if (appointmentStageId) {
          dealMoved = await this.moveDealStage(auth, refs.dealId, appointmentStageId, refs.orgId);
        } else if (refs.orgId) {
          // Backfill org link on a pre-existing deal.
          await this.ensureDealOrg(auth, refs.dealId, refs.orgId);
        }
      }

      const noteBody = [
        'Appointment booked via AI voice agent',
        summary ? `Details: ${summary}` : '',
        dateStr ? `Date: ${dateStr}` : '',
        timeStr ? `Time: ${timeStr}` : '',
        refs.dealId ? `Deal ID: ${refs.dealId}` : '',
      ].filter(Boolean).join('\n');

      const activityRes = await pdFetch<{ success: boolean; data: { id: number } }>(auth, '/activities', {
        method: 'POST',
        body: {
          subject: dispositionFields.callDisposition || 'Appointment Booked',
          type: dispositionFields.status || 'meeting',
          done: 0,
          note: noteBody,
          ...(dateStr ? { due_date: dateStr } : {}),
          ...(timeStr ? { due_time: timeStr } : {}),
          ...(refs.personId ? { person_id: refs.personId } : {}),
          ...(refs.orgId ? { org_id: refs.orgId } : {}),
          ...(refs.dealId ? { deal_id: refs.dealId } : {}),
        },
      });

      if (!activityRes.ok || !activityRes.data?.success) {
        this.maybeThrowActivityStale(activityRes, refs);
        throw new Error(activityRes.error ?? 'Pipedrive activity create failed');
      }

      const activityId = String(activityRes.data.data.id);
      logger.info('Pipedrive appointment processed', {
        tenantId,
        personId: refs.personId,
        orgId: refs.orgId,
        dealId: refs.dealId,
        activityId,
        appointmentStageId,
        dealMoved,
      });
      return {
        success: true,
        externalId: activityId,
        meta: {
          personId: refs.personId,
          orgId: refs.orgId,
          dealId: refs.dealId,
          ...this.canonicalAliases(refs),
          activityId,
          provider: 'pipedrive',
          ...(appointmentStageId ? { stageId: appointmentStageId } : {}),
          ...(dealMoved ? { dealStageMoved: true } : {}),
        },
      };
    } catch (err) {
      if (err instanceof PipedriveStaleRecordError) {
        logger.warn('Pipedrive appointment logging hit stale cached record', {
          tenantId, errorCode: err.errorCode, staleIds: err.staleIds,
        });
        return this.staleRecordResult(err, payload);
      }
      const error = err instanceof Error ? err.message : String(err);
      logger.error('Pipedrive appointment logging failed', { tenantId, error });
      return { success: false, error };
    }
  }

  /**
   * For activity creation (`POST /activities`), the IDs are in the request
   * body — not the URL — so a stale signal could implicate person_id, org_id,
   * or deal_id. Flag all three candidates and let the dispatch layer's
   * value-match scrub clear only the truly stale one(s).
   */
  private maybeThrowActivityStale(
    res: { ok: boolean; status: number; error?: string },
    refs: DealRefs,
  ): void {
    if (res.ok) return;
    const staleCode = extractPipedriveStaleErrorCode(res.status, res.error);
    if (!staleCode) return;
    const staleIds: { personId?: string; orgId?: string; dealId?: string } = {};
    if (refs.personId !== undefined) staleIds.personId = String(refs.personId);
    if (refs.orgId !== undefined) staleIds.orgId = String(refs.orgId);
    if (refs.dealId !== undefined) staleIds.dealId = String(refs.dealId);
    if (Object.keys(staleIds).length === 0) return;
    throw new PipedriveStaleRecordError(
      `Pipedrive activity create failed (${res.status}, ${staleCode}): ${res.error ?? ''}`,
      staleIds,
      staleCode,
    );
  }

  /**
   * Build a `ConnectorResult` for a stale-record failure. Only IDs that
   * actually appeared on the inbound payload (matched against either the
   * native Pipedrive name OR the canonical Salesforce-style alias the
   * adapter emits in `meta`) are surfaced as `meta.staleIds`. Mirrors
   * `SalesforceConnectorAdapter.staleRecordResult` and the HubSpot one.
   */
  private staleRecordResult(
    err: PipedriveStaleRecordError,
    payload: ConnectorPayload,
  ): ConnectorResult {
    const filtered: Record<string, string> = {};
    const payloadPersonId = (payload.personId ?? payload.contactId) as string | undefined;
    const payloadOrgId = (payload.orgId ?? payload.accountId) as string | undefined;
    const payloadDealId = (payload.dealId ?? payload.opportunityId) as string | undefined;
    if (err.staleIds.personId && err.staleIds.personId === String(payloadPersonId ?? '')) {
      filtered.personId = err.staleIds.personId;
    }
    if (err.staleIds.orgId && err.staleIds.orgId === String(payloadOrgId ?? '')) {
      filtered.orgId = err.staleIds.orgId;
    }
    if (err.staleIds.dealId && err.staleIds.dealId === String(payloadDealId ?? '')) {
      filtered.dealId = err.staleIds.dealId;
    }
    return {
      success: false,
      error: err.message,
      meta: {
        provider: 'pipedrive',
        staleRecord: true,
        ...(err.errorCode ? { staleErrorCode: err.errorCode } : {}),
        ...(Object.keys(filtered).length > 0 ? { staleIds: filtered } : {}),
      },
    };
  }

  /**
   * Canonical Salesforce-style aliases (`contactId`/`accountId`/`opportunityId`)
   * derived from Pipedrive's native numeric IDs (`personId`/`orgId`/`dealId`),
   * stringified for the cross-provider cache. Emitted alongside the native
   * fields in `result.meta` so:
   *   - the caller-identity cache layer can store both shapes verbatim, and
   *   - the next event for this caller can re-inject either shape as a
   *     payload hint (the adapter accepts both — see `handleCallCompleted`
   *     and `handleAppointmentBooked` where canonical names are tried as a
   *     fallback to native ones).
   */
  private canonicalAliases(refs: DealRefs): Record<string, string> {
    const out: Record<string, string> = {};
    if (refs.personId !== undefined) out.contactId = String(refs.personId);
    if (refs.orgId !== undefined) out.accountId = String(refs.orgId);
    if (refs.dealId !== undefined) out.opportunityId = String(refs.dealId);
    return out;
  }

  private async findOrCreatePerson(
    auth: PipedriveAuth,
    phone: string,
    payload: ConnectorPayload,
    orgId?: number,
  ): Promise<number | undefined> {
    const searchPath = `/persons/search?term=${encodeURIComponent(phone)}&fields=phone&exact_match=true`;
    const search = await pdFetch<{
      success: boolean;
      data: { items: Array<{ item: { id: number } }> } | null;
    }>(auth, searchPath);

    if (search.ok && search.data?.success && search.data.data?.items?.length) {
      return search.data.data.items[0].item.id;
    }

    const firstName = (payload.callerFirstName as string) ?? '';
    const lastName = (payload.callerLastName as string) ?? '';
    const email = (payload.callerEmail as string) ?? '';
    const name = [firstName, lastName].filter(Boolean).join(' ').trim() || `Caller ${phone}`;

    const create = await pdFetch<PdPersonCreate>(auth, '/persons', {
      method: 'POST',
      body: {
        name,
        phone: [{ value: phone, primary: true, label: 'work' }],
        ...(email ? { email: [{ value: email, primary: true, label: 'work' }] } : {}),
        ...(orgId ? { org_id: orgId } : {}),
      },
    });

    if (!create.ok || !create.data?.success) {
      logger.warn('Pipedrive person create failed', { error: create.error });
      return undefined;
    }
    return create.data.data.id;
  }

  private async findOrCreateOrganization(
    auth: PipedriveAuth,
    name: string,
  ): Promise<number | undefined> {
    const trimmed = name.trim();
    if (!trimmed || trimmed.toLowerCase() === 'unknown') return undefined;

    const searchPath = `/organizations/search?term=${encodeURIComponent(trimmed)}&fields=name&exact_match=true&limit=1`;
    const search = await pdFetch<{
      success: boolean;
      data: { items: Array<{ item: { id: number } }> } | null;
    }>(auth, searchPath);
    if (search.ok && search.data?.success && search.data.data?.items?.length) {
      return search.data.data.items[0].item.id;
    }

    const create = await pdFetch<{ success: boolean; data: { id: number } }>(auth, '/organizations', {
      method: 'POST',
      body: { name: trimmed },
    });
    if (!create.ok || !create.data?.success) {
      logger.warn('Pipedrive organization create failed', { error: create.error });
      return undefined;
    }
    return create.data.data.id;
  }

  private async findOpenDealForPerson(auth: PipedriveAuth, personId: number): Promise<number | undefined> {
    const res = await pdFetch<PdDealsResponse>(auth, `/persons/${personId}/deals?status=open&limit=1`);
    if (res.ok && res.data?.success && res.data.data?.length) {
      return res.data.data[0].id;
    }
    // personId is in the URL path, so a stale signal here unambiguously
    // identifies the personId as the deleted/merged record.
    if (!res.ok) {
      const staleCode = extractPipedriveStaleErrorCode(res.status, res.error);
      if (staleCode) {
        throw new PipedriveStaleRecordError(
          `Pipedrive open deal lookup failed (${res.status}, ${staleCode}): ${res.error ?? ''}`,
          { personId: String(personId) },
          staleCode,
        );
      }
    }
    return undefined;
  }

  private async createDealForPerson(
    auth: PipedriveAuth,
    personId: number,
    payload: ConnectorPayload,
    orgId?: number,
    config?: ConnectorConfig,
    overrideStageId?: number,
  ): Promise<number | undefined> {
    const summary = (payload.summary as string | undefined) ?? '';
    const company = (payload.callerCompany as string | undefined) ?? '';
    const titleSeed = company
      || summary.slice(0, 60)
      || 'Inbound Lead';
    const title = payload.type === 'appointment.booked'
      ? `${titleSeed} - QVO Appointment`
      : `AI Voice Call: ${titleSeed}`;

    const stageId = overrideStageId
      ?? toNumericId(payload.stageId)
      ?? toNumericId(config?.credentials.default_stage_id);
    const pipelineId = toNumericId(payload.pipelineId)
      ?? toNumericId(config?.credentials.default_pipeline_id);

    const create = await pdFetch<{ success: boolean; data: { id: number } }>(auth, '/deals', {
      method: 'POST',
      body: {
        title: title.slice(0, 250),
        person_id: personId,
        status: 'open',
        ...(orgId ? { org_id: orgId } : {}),
        ...(stageId ? { stage_id: stageId } : {}),
        ...(pipelineId ? { pipeline_id: pipelineId } : {}),
      },
    });
    if (!create.ok || !create.data?.success) {
      // The deal-create body references person_id (always) and org_id (when
      // provided). If Pipedrive rejects with a stale signal, either record
      // could be the gone one — flag both candidates and let the dispatch
      // layer's value-match scrub clear only the truly stale ID.
      const staleCode = extractPipedriveStaleErrorCode(create.status, create.error);
      if (staleCode) {
        throw new PipedriveStaleRecordError(
          `Pipedrive deal create failed (${create.status}, ${staleCode}): ${create.error ?? ''}`,
          { personId: String(personId), ...(orgId !== undefined ? { orgId: String(orgId) } : {}) },
          staleCode,
        );
      }
      logger.warn('Pipedrive deal create failed', { personId, error: create.error });
      return undefined;
    }
    return create.data.data.id;
  }

  private async moveDealStage(
    auth: PipedriveAuth,
    dealId: number,
    stageId: number,
    orgId?: number,
  ): Promise<boolean> {
    const update = await pdFetch<{ success: boolean }>(auth, `/deals/${dealId}`, {
      method: 'PUT',
      body: {
        stage_id: stageId,
        ...(orgId ? { org_id: orgId } : {}),
      },
    });
    if (!update.ok || !update.data?.success) {
      // dealId is in the URL path; org_id (when provided) is in the request
      // body. A stale signal could mean either record is gone — flag both
      // candidates and let the dispatch layer's value-match scrub clear
      // only the truly stale ID(s).
      const staleCode = extractPipedriveStaleErrorCode(update.status, update.error);
      if (staleCode) {
        throw new PipedriveStaleRecordError(
          `Pipedrive deal stage move failed (${update.status}, ${staleCode}): ${update.error ?? ''}`,
          { dealId: String(dealId), ...(orgId !== undefined ? { orgId: String(orgId) } : {}) },
          staleCode,
        );
      }
      logger.warn('Pipedrive deal stage move failed', { dealId, stageId, error: update.error });
      return false;
    }
    return true;
  }

  private async ensureDealOrg(
    auth: PipedriveAuth,
    dealId: number,
    orgId: number,
  ): Promise<void> {
    const update = await pdFetch<{ success: boolean }>(auth, `/deals/${dealId}`, {
      method: 'PUT',
      body: { org_id: orgId },
    });
    if (!update.ok || !update.data?.success) {
      // dealId is in the URL path; orgId is the only field in the body. A
      // stale signal could mean either record is gone — flag both
      // candidates so the dispatch layer's value-match scrub clears the
      // truly stale ID(s) without over-scrubbing the still-valid one.
      const staleCode = extractPipedriveStaleErrorCode(update.status, update.error);
      if (staleCode) {
        throw new PipedriveStaleRecordError(
          `Pipedrive deal org link failed (${update.status}, ${staleCode}): ${update.error ?? ''}`,
          { dealId: String(dealId), orgId: String(orgId) },
          staleCode,
        );
      }
      logger.warn('Pipedrive deal org link failed', { dealId, orgId, error: update.error });
    }
  }

  private formatDuration(seconds: number): string {
    const total = Math.max(0, Math.round(seconds));
    const mm = Math.floor(total / 60).toString().padStart(2, '0');
    const ss = (total % 60).toString().padStart(2, '0');
    return `${mm}:${ss}`;
  }
}
