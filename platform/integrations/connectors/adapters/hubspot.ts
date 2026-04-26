import { createLogger } from '../../../core/logger';
import { ensureFreshOAuthToken } from '../tokenRefresh';
import { parseDispositionMap, mapDisposition } from '../dispositionMap';
import type { ConnectorAdapter, ConnectorConfig, ConnectorPayload, ConnectorResult } from '../types';
import type { TenantId } from '../../../core/types';

const logger = createLogger('HUBSPOT_CONNECTOR');
const REQUEST_TIMEOUT_MS = 15_000;
const HUBSPOT_API = 'https://api.hubapi.com';

const ASSOCIATION = {
  CONTACT_TO_COMPANY: 1,
  DEAL_TO_CONTACT: 3,
  DEAL_TO_COMPANY: 5,
  CALL_TO_CONTACT: 194,
  NOTE_TO_CONTACT: 202,
  NOTE_TO_DEAL: 214,
} as const;

interface DealRefs {
  contactId?: string;
  companyId?: string;
  dealId?: string;
}

/**
 * HubSpot error categories that mean the targeted record (contact, company,
 * deal, note, call) genuinely no longer exists in the upstream CRM. Anything
 * else (rate limit, validation error, auth error, etc.) is NOT a stale signal
 * and must NOT clear the caller-identity cache.
 */
const HUBSPOT_STALE_ERROR_CATEGORIES = new Set([
  'OBJECT_NOT_FOUND',
]);

/**
 * Thrown by HubSpot write helpers when an HTTP 404 (or one of the
 * `HUBSPOT_STALE_ERROR_CATEGORIES`) is returned for a request that referenced
 * a cached/hinted record ID. Carries the IDs the failing call referenced so
 * `handleCallCompleted` / `handleAppointmentBooked` can surface them via
 * `result.meta.staleIds`, and the dispatch layer can scrub them from the
 * caller-identity cache.
 */
class HubSpotStaleRecordError extends Error {
  staleIds: { contactId?: string; companyId?: string; dealId?: string };
  errorCode?: string;
  constructor(
    message: string,
    staleIds: { contactId?: string; companyId?: string; dealId?: string },
    errorCode?: string,
  ) {
    super(message);
    this.name = 'HubSpotStaleRecordError';
    this.staleIds = staleIds;
    this.errorCode = errorCode;
  }
}

/**
 * Inspect a HubSpot REST error response and decide whether it should be
 * treated as a stale-record signal. HubSpot returns errors shaped like:
 *   `{ status: "error", message: "...", category: "OBJECT_NOT_FOUND", ... }`
 *
 * - When the body's `category` field is in `HUBSPOT_STALE_ERROR_CATEGORIES`,
 *   that's the most specific signal — use it.
 * - For raw 404s where the body did NOT carry a recognised non-stale category,
 *   treat the response as `NOT_FOUND` (HubSpot's canonical response when the
 *   path-targeted object truly does not exist).
 *
 * Returns the matching errorCode when stale, otherwise undefined. This mirrors
 * `extractSalesforceStaleErrorCode` so a non-stale 404 (e.g. a misrouted URL
 * with a recognised non-stale category) does not over-clear the cache.
 */
function extractHubSpotStaleErrorCode(status: number, body: string): string | undefined {
  let parsed: unknown;
  if (body) {
    try { parsed = JSON.parse(body); } catch { /* falls through */ }
  }
  let sawNonStaleCategory = false;
  if (parsed && typeof parsed === 'object') {
    const category = (parsed as { category?: unknown }).category;
    if (typeof category === 'string') {
      if (HUBSPOT_STALE_ERROR_CATEGORIES.has(category)) return category;
      sawNonStaleCategory = true;
    }
  }
  if (status === 404 && !sawNonStaleCategory) return 'NOT_FOUND';
  return undefined;
}

/**
 * Translate HubSpot object names (`contacts`, `companies`, `deals`) plus the
 * IDs that referenced them in a failing call into the `staleIds` shape carried
 * on `HubSpotStaleRecordError`. Used by helpers (`associate`, `createNote`,
 * `logCallEngagement`) that touch multiple records at once and can't tell from
 * HubSpot's response which specific one is the stale culprit — flag all
 * candidates and let the dispatch layer's value-match scrub do the rest.
 */
function mapHubSpotObjectsToStaleIds(
  refs: Array<{ object: string; id: string }>,
): { contactId?: string; companyId?: string; dealId?: string } {
  const out: { contactId?: string; companyId?: string; dealId?: string } = {};
  for (const ref of refs) {
    if (!ref.id) continue;
    if (ref.object === 'contacts') out.contactId = ref.id;
    else if (ref.object === 'companies') out.companyId = ref.id;
    else if (ref.object === 'deals') out.dealId = ref.id;
  }
  return out;
}

export interface HubSpotPipelineStage {
  id: string;
  label: string;
  displayOrder: number;
}

export interface HubSpotPipeline {
  id: string;
  label: string;
  displayOrder: number;
  stages: HubSpotPipelineStage[];
}

export async function fetchHubSpotDealPipelines(
  tenantId: TenantId,
  config: ConnectorConfig,
): Promise<HubSpotPipeline[]> {
  let activeConfig = config;
  try {
    activeConfig = await ensureFreshOAuthToken(config);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    throw new Error(`HubSpot token refresh failed: ${error}`);
  }
  const accessToken = activeConfig.credentials.access_token ?? '';
  if (!accessToken) {
    throw new Error('HubSpot connector not configured: missing access_token');
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(`${HUBSPOT_API}/crm/v3/pipelines/deals`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`HubSpot pipelines fetch failed (${res.status}): ${text.slice(0, 200)}`);
    }
    const data = await res.json() as {
      results?: Array<{
        id: string;
        label: string;
        displayOrder?: number;
        stages?: Array<{ id: string; label: string; displayOrder?: number }>;
      }>;
    };
    const pipelines = Array.isArray(data.results) ? data.results : [];
    logger.info('HubSpot pipelines fetched', { tenantId, pipelineCount: pipelines.length });
    return pipelines
      .map((p) => ({
        id: String(p.id),
        label: typeof p.label === 'string' ? p.label : String(p.id),
        displayOrder: typeof p.displayOrder === 'number' ? p.displayOrder : 0,
        stages: (Array.isArray(p.stages) ? p.stages : [])
          .map((s) => ({
            id: String(s.id),
            label: typeof s.label === 'string' ? s.label : String(s.id),
            displayOrder: typeof s.displayOrder === 'number' ? s.displayOrder : 0,
          }))
          .sort((a, b) => a.displayOrder - b.displayOrder),
      }))
      .sort((a, b) => a.displayOrder - b.displayOrder);
  } finally {
    clearTimeout(timeoutId);
  }
}

export class HubSpotConnectorAdapter implements ConnectorAdapter {
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
      logger.error('HubSpot token refresh failed', { tenantId, error });
      return { success: false, error: `HubSpot token refresh failed: ${error}` };
    }
    const accessToken = activeConfig.credentials.access_token ?? '';
    if (!accessToken) {
      logger.error('Missing HubSpot access token', { tenantId });
      return { success: false, error: 'HubSpot connector not configured: missing access_token' };
    }

    switch (payload.type) {
      case 'call.completed':
        return this.handleCallCompleted(tenantId, accessToken, payload, activeConfig);
      case 'appointment.booked':
        return this.handleAppointmentBooked(tenantId, accessToken, payload, activeConfig);
      default:
        return { success: false, error: `HubSpot adapter does not handle event: ${payload.type}` };
    }
  }

  private async handleCallCompleted(
    tenantId: TenantId,
    accessToken: string,
    payload: ConnectorPayload,
    config: ConnectorConfig,
  ): Promise<ConnectorResult> {
    const callerPhone = payload.callerPhone as string | undefined;
    const summary = payload.summary as string | undefined;
    const duration = payload.durationSeconds as number | undefined;
    const callSid = payload.callSid as string | undefined;
    const disposition = payload.disposition as string | undefined;
    const callerCompany = payload.callerCompany as string | undefined;

    try {
      const customMap = parseDispositionMap(config.credentials, 'hubspot');
      const dispositionFields = mapDisposition('hubspot', disposition, customMap);

      const refs: DealRefs = {
        contactId: (payload.contactId as string | undefined),
        companyId: (payload.companyId as string | undefined)
          ?? (payload.accountId as string | undefined),
        dealId: (payload.dealId as string | undefined)
          ?? (payload.opportunityId as string | undefined),
      };

      if (!refs.contactId && callerPhone) {
        refs.contactId = await this.findOrCreateContact(accessToken, callerPhone, payload);
      }

      if (!refs.companyId && callerCompany) {
        refs.companyId = await this.findOrCreateCompany(accessToken, callerCompany);
        if (refs.contactId && refs.companyId) {
          await this.associate(accessToken, 'contacts', refs.contactId, 'companies', refs.companyId, ASSOCIATION.CONTACT_TO_COMPANY);
        }
      }

      const engagementResult = await this.logCallEngagement(accessToken, {
        contactId: refs.contactId,
        summary: summary ?? 'AI voice call completed',
        durationMs: (duration ?? 0) * 1000,
        callSid,
        callerPhone,
        callStatus: dispositionFields.status,
        callDisposition: dispositionFields.callDisposition,
      });

      logger.info('HubSpot call logged', {
        tenantId,
        contactId: refs.contactId,
        companyId: refs.companyId,
        dealId: refs.dealId,
        engagementId: engagementResult,
      });
      return {
        success: true,
        externalId: engagementResult,
        meta: {
          contactId: refs.contactId,
          companyId: refs.companyId,
          dealId: refs.dealId,
          ...this.canonicalAliases(refs),
          engagementId: engagementResult,
          provider: 'hubspot',
          ...(config.credentials.appointment_pipeline_id
            ? { pipelineId: config.credentials.appointment_pipeline_id }
            : {}),
        },
      };
    } catch (err) {
      if (err instanceof HubSpotStaleRecordError) {
        logger.warn('HubSpot call logging hit stale cached record', {
          tenantId, errorCode: err.errorCode, staleIds: err.staleIds,
        });
        return this.staleRecordResult(err, payload);
      }
      const error = err instanceof Error ? err.message : String(err);
      logger.error('HubSpot call logging failed', { tenantId, error });
      return { success: false, error };
    }
  }

  /**
   * Build a `ConnectorResult` for a stale-record failure. Only IDs that
   * actually appeared on the inbound payload (i.e. came from the cache or
   * the explicit hint) are surfaced as `meta.staleIds` so the dispatch
   * layer can scrub the matching `crm_caller_identities` slots without
   * touching anything else. Mirrors `SalesforceConnectorAdapter.staleRecordResult`.
   */
  private staleRecordResult(
    err: HubSpotStaleRecordError,
    payload: ConnectorPayload,
  ): ConnectorResult {
    const filtered: Record<string, string> = {};
    // Accept both HubSpot-native keys and the canonical Salesforce-style
    // aliases. Inbound payloads from cache injection use native field names,
    // but explicit hints from upstream callers may use the canonical aliases.
    const payloadContactId = payload.contactId as string | undefined;
    const payloadCompanyId = (payload.companyId as string | undefined)
      ?? (payload.accountId as string | undefined);
    const payloadDealId = (payload.dealId as string | undefined)
      ?? (payload.opportunityId as string | undefined);
    if (err.staleIds.contactId && err.staleIds.contactId === payloadContactId) {
      filtered.contactId = err.staleIds.contactId;
    }
    if (err.staleIds.companyId && err.staleIds.companyId === payloadCompanyId) {
      filtered.companyId = err.staleIds.companyId;
    }
    if (err.staleIds.dealId && err.staleIds.dealId === payloadDealId) {
      filtered.dealId = err.staleIds.dealId;
    }
    return {
      success: false,
      error: err.message,
      meta: {
        provider: 'hubspot',
        staleRecord: true,
        ...(err.errorCode ? { staleErrorCode: err.errorCode } : {}),
        ...(Object.keys(filtered).length > 0 ? { staleIds: filtered } : {}),
      },
    };
  }

  private async handleAppointmentBooked(
    tenantId: TenantId,
    accessToken: string,
    payload: ConnectorPayload,
    config: ConnectorConfig,
  ): Promise<ConnectorResult> {
    const callerPhone = payload.callerPhone as string | undefined;
    const summary = payload.summary as string | undefined;
    const callerCompany = payload.callerCompany as string | undefined;
    const pipelineId = (payload.pipelineId as string | undefined)
      ?? config.credentials.appointment_pipeline_id
      ?? undefined;
    const appointmentStageId = (payload.appointmentStageId as string | undefined)
      ?? config.credentials.appointment_stage_id
      ?? undefined;

    try {
      // Validate disposition map up-front so a bad config surfaces in the
      // connector activity log even when the appointment path doesn't otherwise
      // touch call disposition fields.
      parseDispositionMap(config.credentials, 'hubspot');

      const refs: DealRefs = {
        contactId: (payload.contactId as string | undefined),
        companyId: (payload.companyId as string | undefined)
          ?? (payload.accountId as string | undefined),
        dealId: (payload.dealId as string | undefined)
          ?? (payload.opportunityId as string | undefined),
      };

      if (!refs.contactId && callerPhone) {
        refs.contactId = await this.findOrCreateContact(accessToken, callerPhone, payload);
      }

      if (!refs.companyId && callerCompany) {
        refs.companyId = await this.findOrCreateCompany(accessToken, callerCompany);
        if (refs.contactId && refs.companyId) {
          await this.associate(accessToken, 'contacts', refs.contactId, 'companies', refs.companyId, ASSOCIATION.CONTACT_TO_COMPANY);
        }
      }

      // Auto-promote: ensure a Deal is wired into the active pipeline so the
      // booked appointment is reflected in pipeline reporting end-to-end.
      let dealMoved = false;
      if (refs.contactId) {
        if (!refs.dealId) {
          refs.dealId = await this.findOpenDealForContact(accessToken, refs.contactId);
        }
        if (!refs.dealId) {
          refs.dealId = await this.createDeal(accessToken, {
            contactId: refs.contactId,
            companyId: refs.companyId,
            company: callerCompany,
            firstName: payload.callerFirstName as string | undefined,
            lastName: payload.callerLastName as string | undefined,
            pipelineId,
            stageId: appointmentStageId,
          });
        } else if (appointmentStageId) {
          dealMoved = await this.moveDealStage(accessToken, refs.dealId, appointmentStageId, pipelineId);
        }

        if (refs.dealId && refs.companyId) {
          await this.associate(accessToken, 'deals', refs.dealId, 'companies', refs.companyId, ASSOCIATION.DEAL_TO_COMPANY);
        }
      }

      const note = [
        'Appointment Booked via AI Agent',
        summary ? `Details: ${summary}` : '',
        payload.appointmentDate ? `Date: ${payload.appointmentDate}` : '',
        payload.appointmentTime ? `Time: ${payload.appointmentTime}` : '',
        refs.dealId ? `Deal ID: ${refs.dealId}` : '',
      ].filter(Boolean).join('\n');

      const engagementId = await this.createNote(accessToken, refs.contactId, refs.dealId, note);

      logger.info('HubSpot appointment processed', {
        tenantId,
        contactId: refs.contactId,
        companyId: refs.companyId,
        dealId: refs.dealId,
        engagementId,
        pipelineId,
        appointmentStageId,
        dealMoved,
      });
      return {
        success: true,
        externalId: engagementId,
        meta: {
          contactId: refs.contactId,
          companyId: refs.companyId,
          dealId: refs.dealId,
          ...this.canonicalAliases(refs),
          engagementId,
          provider: 'hubspot',
          ...(pipelineId ? { pipelineId } : {}),
          ...(appointmentStageId ? { stageId: appointmentStageId } : {}),
          ...(dealMoved ? { dealStageMoved: true } : {}),
        },
      };
    } catch (err) {
      if (err instanceof HubSpotStaleRecordError) {
        logger.warn('HubSpot appointment logging hit stale cached record', {
          tenantId, errorCode: err.errorCode, staleIds: err.staleIds,
        });
        return this.staleRecordResult(err, payload);
      }
      const error = err instanceof Error ? err.message : String(err);
      logger.error('HubSpot appointment logging failed', { tenantId, error });
      return { success: false, error };
    }
  }

  /**
   * Canonical Salesforce-style aliases (`contactId`/`accountId`/`opportunityId`)
   * derived from HubSpot's native IDs (`contactId`/`companyId`/`dealId`).
   * Emitted alongside the native fields in `result.meta` so the cross-provider
   * caller-identity cache can store both shapes verbatim, and a future event
   * can re-inject either shape as a payload hint — the adapter accepts both
   * (see `handleCallCompleted` / `handleAppointmentBooked` where canonical
   * names are tried as a fallback to native ones).
   */
  private canonicalAliases(refs: DealRefs): Record<string, string> {
    const out: Record<string, string> = {};
    if (refs.contactId !== undefined) out.contactId = refs.contactId;
    if (refs.companyId !== undefined) out.accountId = refs.companyId;
    if (refs.dealId !== undefined) out.opportunityId = refs.dealId;
    return out;
  }

  private async findOrCreateContact(
    accessToken: string,
    phone: string,
    payload: ConnectorPayload,
  ): Promise<string | undefined> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const searchRes = await fetch(`${HUBSPOT_API}/crm/v3/objects/contacts/search`, {
        method: 'POST',
        headers: this.headers(accessToken),
        body: JSON.stringify({
          filterGroups: [{
            filters: [{ propertyName: 'phone', operator: 'EQ', value: phone }],
          }],
        }),
        signal: controller.signal,
      });

      if (searchRes.ok) {
        const data = await searchRes.json() as { total: number; results: Array<{ id: string }> };
        if (data.total > 0) {
          return data.results[0].id;
        }
      }

      const firstName = (payload.callerFirstName as string) ?? '';
      const lastName = (payload.callerLastName as string) ?? '';
      const email = (payload.callerEmail as string) ?? '';

      const createRes = await fetch(`${HUBSPOT_API}/crm/v3/objects/contacts`, {
        method: 'POST',
        headers: this.headers(accessToken),
        body: JSON.stringify({
          properties: {
            phone,
            ...(firstName && { firstname: firstName }),
            ...(lastName && { lastname: lastName }),
            ...(email && { email }),
          },
        }),
        signal: controller.signal,
      });

      if (createRes.ok) {
        const data = await createRes.json() as { id: string };
        return data.id;
      }

      return undefined;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private async findOrCreateCompany(
    accessToken: string,
    name: string,
  ): Promise<string | undefined> {
    const trimmed = name.trim();
    if (!trimmed || trimmed.toLowerCase() === 'unknown') return undefined;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const searchRes = await fetch(`${HUBSPOT_API}/crm/v3/objects/companies/search`, {
        method: 'POST',
        headers: this.headers(accessToken),
        body: JSON.stringify({
          filterGroups: [{
            filters: [{ propertyName: 'name', operator: 'EQ', value: trimmed }],
          }],
          limit: 1,
        }),
        signal: controller.signal,
      });
      if (searchRes.ok) {
        const data = await searchRes.json() as { total: number; results: Array<{ id: string }> };
        if (data.total > 0 && data.results[0]?.id) return data.results[0].id;
      } else {
        const text = await searchRes.text().catch(() => '');
        logger.warn('HubSpot company search failed', { status: searchRes.status, body: text.slice(0, 200) });
      }

      const createRes = await fetch(`${HUBSPOT_API}/crm/v3/objects/companies`, {
        method: 'POST',
        headers: this.headers(accessToken),
        body: JSON.stringify({ properties: { name: trimmed } }),
        signal: controller.signal,
      });
      if (!createRes.ok) {
        const text = await createRes.text().catch(() => '');
        logger.warn('HubSpot company create failed', { status: createRes.status, body: text.slice(0, 200) });
        return undefined;
      }
      const data = await createRes.json() as { id: string };
      return data.id;
    } catch (err) {
      logger.warn('HubSpot company lookup/create threw', { error: String(err) });
      return undefined;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private async findOpenDealForContact(
    accessToken: string,
    contactId: string,
  ): Promise<string | undefined> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(`${HUBSPOT_API}/crm/v3/objects/deals/search`, {
        method: 'POST',
        headers: this.headers(accessToken),
        body: JSON.stringify({
          filterGroups: [{
            filters: [
              { propertyName: 'associations.contact', operator: 'EQ', value: contactId },
              { propertyName: 'hs_is_closed', operator: 'NEQ', value: 'true' },
            ],
          }],
          sorts: [{ propertyName: 'createdate', direction: 'DESCENDING' }],
          limit: 1,
        }),
        signal: controller.signal,
      });
      if (!res.ok) return undefined;
      const data = await res.json() as { total: number; results: Array<{ id: string }> };
      if (data.total > 0 && data.results[0]?.id) return data.results[0].id;
      return undefined;
    } catch (err) {
      logger.warn('HubSpot open deal lookup threw', { error: String(err) });
      return undefined;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private async createDeal(
    accessToken: string,
    params: {
      contactId: string;
      companyId?: string;
      company?: string;
      firstName?: string;
      lastName?: string;
      pipelineId?: string;
      stageId?: string;
    },
  ): Promise<string | undefined> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const dealName = params.company
        ? `${params.company} - QVO Appointment`
        : `${[params.firstName, params.lastName].filter(Boolean).join(' ').trim() || 'Inbound Caller'} - QVO Appointment`;

      const properties: Record<string, string> = { dealname: dealName.slice(0, 250) };
      if (params.pipelineId) properties.pipeline = params.pipelineId;
      if (params.stageId) properties.dealstage = params.stageId;

      const associations: Array<Record<string, unknown>> = [{
        to: { id: params.contactId },
        types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: ASSOCIATION.DEAL_TO_CONTACT }],
      }];
      if (params.companyId) {
        associations.push({
          to: { id: params.companyId },
          types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: ASSOCIATION.DEAL_TO_COMPANY }],
        });
      }

      const res = await fetch(`${HUBSPOT_API}/crm/v3/objects/deals`, {
        method: 'POST',
        headers: this.headers(accessToken),
        body: JSON.stringify({ properties, associations }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        // The deal create body references contactId / companyId via the
        // associations array. If HubSpot rejects with OBJECT_NOT_FOUND, one
        // of those referenced records has been deleted upstream — we don't
        // know which one, so flag both as potentially stale and let the
        // dispatch layer's value-match scrub clear only the truly stale ID.
        const staleCode = extractHubSpotStaleErrorCode(res.status, text);
        if (staleCode) {
          throw new HubSpotStaleRecordError(
            `HubSpot deal create failed (${res.status}, ${staleCode}): ${text.slice(0, 200)}`,
            { contactId: params.contactId, ...(params.companyId ? { companyId: params.companyId } : {}) },
            staleCode,
          );
        }
        logger.warn('HubSpot deal create failed', { status: res.status, body: text.slice(0, 200) });
        return undefined;
      }
      const data = await res.json() as { id: string };
      return data.id;
    } catch (err) {
      if (err instanceof HubSpotStaleRecordError) throw err;
      logger.warn('HubSpot deal create threw', { error: String(err) });
      return undefined;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private async moveDealStage(
    accessToken: string,
    dealId: string,
    stageId: string,
    pipelineId?: string,
  ): Promise<boolean> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const properties: Record<string, string> = { dealstage: stageId };
      if (pipelineId) properties.pipeline = pipelineId;
      const res = await fetch(`${HUBSPOT_API}/crm/v3/objects/deals/${dealId}`, {
        method: 'PATCH',
        headers: this.headers(accessToken),
        body: JSON.stringify({ properties }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        // dealId is in the URL path, so a stale signal here unambiguously
        // identifies the dealId as the deleted/archived record.
        const staleCode = extractHubSpotStaleErrorCode(res.status, text);
        if (staleCode) {
          throw new HubSpotStaleRecordError(
            `HubSpot deal stage move failed (${res.status}, ${staleCode}): ${text.slice(0, 200)}`,
            { dealId },
            staleCode,
          );
        }
        logger.warn('HubSpot deal stage move failed', { dealId, status: res.status, body: text.slice(0, 200) });
        return false;
      }
      return true;
    } catch (err) {
      if (err instanceof HubSpotStaleRecordError) throw err;
      logger.warn('HubSpot deal stage move threw', { dealId, error: String(err) });
      return false;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private async associate(
    accessToken: string,
    fromObject: string,
    fromId: string,
    toObject: string,
    toId: string,
    typeId: number,
  ): Promise<void> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(
        `${HUBSPOT_API}/crm/v4/objects/${fromObject}/${fromId}/associations/${toObject}/${toId}`,
        {
          method: 'PUT',
          headers: this.headers(accessToken),
          body: JSON.stringify([
            { associationCategory: 'HUBSPOT_DEFINED', associationTypeId: typeId },
          ]),
          signal: controller.signal,
        },
      );
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        // Both fromId and toId are in the URL path, so HubSpot's response
        // doesn't tell us which one is missing. Flag both as potentially
        // stale and let the dispatch layer's value-match scrub do the rest:
        // only the value that actually equals a cached ID gets cleared.
        const staleCode = extractHubSpotStaleErrorCode(res.status, text);
        if (staleCode) {
          const staleIds = mapHubSpotObjectsToStaleIds([
            { object: fromObject, id: fromId },
            { object: toObject, id: toId },
          ]);
          throw new HubSpotStaleRecordError(
            `HubSpot association failed (${res.status}, ${staleCode}): ${text.slice(0, 200)}`,
            staleIds,
            staleCode,
          );
        }
        logger.warn('HubSpot association failed', {
          fromObject, fromId, toObject, toId, status: res.status, body: text.slice(0, 200),
        });
      }
    } catch (err) {
      if (err instanceof HubSpotStaleRecordError) throw err;
      logger.warn('HubSpot association threw', {
        fromObject, fromId, toObject, toId, error: String(err),
      });
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private async logCallEngagement(
    accessToken: string,
    params: {
      contactId?: string;
      summary: string;
      durationMs: number;
      callSid?: string;
      callerPhone?: string;
      callStatus?: string;
      callDisposition?: string;
    },
  ): Promise<string> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const body: Record<string, unknown> = {
        properties: {
          hs_call_title: 'AI Voice Call',
          hs_call_body: params.summary,
          hs_call_duration: String(params.durationMs),
          hs_call_status: params.callStatus ?? 'COMPLETED',
          hs_call_direction: 'INBOUND',
          ...(params.callDisposition && { hs_call_disposition: params.callDisposition }),
          ...(params.callerPhone && { hs_call_from_number: params.callerPhone }),
          ...(params.callSid && { hs_call_external_id: params.callSid }),
        },
        ...(params.contactId && {
          associations: [{
            to: { id: params.contactId },
            types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: ASSOCIATION.CALL_TO_CONTACT }],
          }],
        }),
      };

      const res = await fetch(`${HUBSPOT_API}/crm/v3/objects/calls`, {
        method: 'POST',
        headers: this.headers(accessToken),
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        // The call engagement references contactId via the associations array.
        // If HubSpot rejects with OBJECT_NOT_FOUND, the only ID we sent that
        // could be the stale one is the contactId.
        const staleCode = extractHubSpotStaleErrorCode(res.status, text);
        if (staleCode && params.contactId) {
          throw new HubSpotStaleRecordError(
            `HubSpot call engagement create failed (${res.status}, ${staleCode}): ${text.slice(0, 200)}`,
            { contactId: params.contactId },
            staleCode,
          );
        }
        throw new Error(`HubSpot API error ${res.status}: ${text.slice(0, 200)}`);
      }

      const data = await res.json() as { id: string };
      return data.id;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private async createNote(
    accessToken: string,
    contactId: string | undefined,
    dealId: string | undefined,
    body: string,
  ): Promise<string> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const associations: Array<Record<string, unknown>> = [];
      if (contactId) {
        associations.push({
          to: { id: contactId },
          types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: ASSOCIATION.NOTE_TO_CONTACT }],
        });
      }
      if (dealId) {
        associations.push({
          to: { id: dealId },
          types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: ASSOCIATION.NOTE_TO_DEAL }],
        });
      }

      const payload: Record<string, unknown> = {
        properties: {
          hs_note_body: body,
          hs_timestamp: new Date().toISOString(),
        },
        ...(associations.length ? { associations } : {}),
      };

      const res = await fetch(`${HUBSPOT_API}/crm/v3/objects/notes`, {
        method: 'POST',
        headers: this.headers(accessToken),
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        // The note's associations array references contactId and/or dealId.
        // If HubSpot rejects with OBJECT_NOT_FOUND, one of those records is
        // gone — flag both candidates and let the dispatch layer's
        // value-match scrub clear only the truly stale ID(s).
        const staleCode = extractHubSpotStaleErrorCode(res.status, text);
        if (staleCode && (contactId || dealId)) {
          throw new HubSpotStaleRecordError(
            `HubSpot note creation failed (${res.status}, ${staleCode}): ${text.slice(0, 200)}`,
            {
              ...(contactId ? { contactId } : {}),
              ...(dealId ? { dealId } : {}),
            },
            staleCode,
          );
        }
        throw new Error(`HubSpot note creation failed ${res.status}: ${text.slice(0, 200)}`);
      }

      const data = await res.json() as { id: string };
      return data.id;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private headers(accessToken: string): Record<string, string> {
    return {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    };
  }
}
