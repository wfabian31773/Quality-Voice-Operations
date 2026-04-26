import { createLogger } from '../../../core/logger';
import { ensureFreshOAuthToken } from '../tokenRefresh';
import {
  parseDispositionMap as parseSharedDispositionMap,
  mapDisposition,
  normalizeDispositionKey,
  DEFAULT_SALESFORCE_DISPOSITION_MAP,
  type DispositionMap,
} from '../dispositionMap';
import type { ConnectorAdapter, ConnectorConfig, ConnectorPayload, ConnectorResult } from '../types';
import type { TenantId } from '../../../core/types';

const logger = createLogger('SALESFORCE_CONNECTOR');
const REQUEST_TIMEOUT_MS = 15_000;
const API_VERSION = 'v60.0';

// Salesforce IDs encode the sObject in the first 3 chars (the "key prefix").
// We use this to classify whatId so the call detail UI can render Account /
// Opportunity records even when the activity attached to an existing record
// (no Lead conversion happened).
function classifySalesforceId(id: string | undefined): 'Lead' | 'Contact' | 'Account' | 'Opportunity' | 'Task' | 'Event' | undefined {
  if (!id || id.length < 3) return undefined;
  switch (id.slice(0, 3)) {
    case '00Q': return 'Lead';
    case '003': return 'Contact';
    case '001': return 'Account';
    case '006': return 'Opportunity';
    case '00T': return 'Task';
    case '00U': return 'Event';
    default: return undefined;
  }
}

/**
 * Salesforce error codes that mean "the record you referenced is gone or
 * unreachable" — i.e. a cached ID is now a zombie and must be evicted from
 * `crm_caller_identities` so the next event re-runs phone/company lookup.
 *
 * - ENTITY_IS_DELETED: record was deleted (and possibly emptied from the
 *   recycle bin), or merged away.
 * - INVALID_CROSS_REFERENCE_KEY: a foreign-key field (WhoId/WhatId/AccountId/
 *   etc.) references a record that doesn't exist or isn't visible.
 * - MALFORMED_ID: the ID is not a real Salesforce ID at all.
 * - NOT_FOUND: REST 404 with this code (rare, but Salesforce uses it for some
 *   sObject endpoints).
 */
const SALESFORCE_STALE_ERROR_CODES = new Set([
  'ENTITY_IS_DELETED',
  'INVALID_CROSS_REFERENCE_KEY',
  'MALFORMED_ID',
  'NOT_FOUND',
]);

/**
 * Thrown by Salesforce write helpers when an HTTP 404 or one of the
 * `SALESFORCE_STALE_ERROR_CODES` is returned. Carries the IDs the failing
 * call referenced so `handleCallCompleted` / `handleAppointmentBooked` can
 * surface them via `result.meta.staleIds`, and the dispatch layer can scrub
 * them from the caller-identity cache.
 */
class SalesforceStaleRecordError extends Error {
  staleIds: { contactId?: string; accountId?: string; opportunityId?: string };
  errorCode?: string;
  constructor(
    message: string,
    staleIds: { contactId?: string; accountId?: string; opportunityId?: string },
    errorCode?: string,
  ) {
    super(message);
    this.name = 'SalesforceStaleRecordError';
    this.staleIds = staleIds;
    this.errorCode = errorCode;
  }
}

/**
 * Inspect a Salesforce REST error response body and decide whether it should
 * be treated as a stale-record signal. Salesforce typically returns an array
 * of `{ errorCode, message, fields? }` entries on failure.
 *
 * Returns the matching errorCode when stale, otherwise undefined.
 */
function extractSalesforceStaleErrorCode(status: number, body: string): string | undefined {
  return extractSalesforceStaleErrorDetails(status, body)?.code;
}

/**
 * Pull the stale-record errorCode AND the offending field names out of a
 * Salesforce REST error body. Salesforce returns one of:
 *   `[{ "errorCode": "ENTITY_IS_DELETED", "message": "...", "fields": ["WhoId"] }]`
 * The `fields` array, when present, lets the caller scrub only the truly
 * stale cached ID instead of all the IDs it passed in.
 */
function extractSalesforceStaleErrorDetails(
  status: number,
  body: string,
): { code: string; fields: string[] } | undefined {
  let parsed: unknown;
  if (body) {
    try { parsed = JSON.parse(body); } catch { /* falls through */ }
  }
  const list = Array.isArray(parsed) ? parsed : parsed ? [parsed] : [];
  // 1. If the body contains a Salesforce error entry with a recognised
  //    stale errorCode, that's the most specific signal -> use it.
  let sawAnyErrorCode = false;
  for (const entry of list) {
    if (entry && typeof entry === 'object') {
      const code = (entry as { errorCode?: unknown }).errorCode;
      if (typeof code === 'string') {
        sawAnyErrorCode = true;
        if (SALESFORCE_STALE_ERROR_CODES.has(code)) {
          const rawFields = (entry as { fields?: unknown }).fields;
          const fields = Array.isArray(rawFields)
            ? rawFields.filter((f): f is string => typeof f === 'string')
            : [];
          return { code, fields };
        }
      }
    }
  }
  // 2. For raw 404s, only treat as NOT_FOUND when the body did NOT carry any
  //    other Salesforce errorCode. This prevents misrouted endpoints or
  //    config-level 404s (which still come back with a non-stale errorCode
  //    like INVALID_TYPE / INVALID_FIELD) from over-clearing the identity
  //    cache. An empty body 404 is still treated as record-not-found because
  //    that's the canonical Salesforce response when the targeted sobject
  //    really has been deleted.
  if (status === 404 && !sawAnyErrorCode) return { code: 'NOT_FOUND', fields: [] };
  return undefined;
}

type PipelineMode = 'leads' | 'contacts';

interface SalesforceTokens {
  accessToken: string;
  instanceUrl: string;
}

type SfRecord = { id: string; object: 'Contact' | 'Lead' };

const SALESFORCE_REQUEST_TIMEOUT_MS = REQUEST_TIMEOUT_MS;

async function salesforceFetchWithTimeout(url: string, init: RequestInit = {}): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), SALESFORCE_REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Resolve a fresh Salesforce access token + instance URL pair, refreshing via
 * the shared `ensureFreshOAuthToken` flow when the stored token is close to
 * expiry. The shared refresher handles persistence, audit logging, and
 * `markConnectorReconnectNeeded` on failure — so callers only need to handle
 * the thrown error (or a `null` result when credentials were never stored).
 */
export async function ensureSalesforceAccessToken(
  tenantId: TenantId,
  config: ConnectorConfig,
): Promise<SalesforceTokens | null> {
  const initialAccessToken = config.credentials.access_token ?? '';
  const initialInstanceUrl = config.credentials.instance_url ?? '';

  if (!initialAccessToken || !initialInstanceUrl) {
    logger.error('Missing Salesforce credentials', { tenantId });
    return null;
  }

  const fresh = await ensureFreshOAuthToken(config);
  return {
    accessToken: fresh.credentials.access_token ?? initialAccessToken,
    instanceUrl: fresh.credentials.instance_url ?? initialInstanceUrl,
  };
}

export interface SalesforceTaskPicklists {
  status: string[];
  callDisposition: string[];
}

export async function fetchSalesforceTaskPicklists(
  tenantId: TenantId,
  config: ConnectorConfig,
): Promise<SalesforceTaskPicklists> {
  const tokens = await ensureSalesforceAccessToken(tenantId, config);
  if (!tokens) {
    throw new Error('Salesforce connector not configured: missing or invalid tokens');
  }

  const url = `${tokens.instanceUrl}/services/data/${API_VERSION}/sobjects/Task/describe`;
  const res = await salesforceFetchWithTimeout(url, {
    headers: {
      Authorization: `Bearer ${tokens.accessToken}`,
      'Content-Type': 'application/json',
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Salesforce Task describe failed (${res.status}): ${text.slice(0, 200)}`);
  }
  const data = await res.json() as {
    fields?: Array<{
      name: string;
      picklistValues?: Array<{ value: string; active?: boolean }>;
    }>;
  };

  const fields = Array.isArray(data.fields) ? data.fields : [];
  const pick = (name: string): string[] => {
    const field = fields.find((f) => f.name === name);
    if (!field || !Array.isArray(field.picklistValues)) return [];
    return field.picklistValues
      .filter((v) => v.active !== false && typeof v.value === 'string' && v.value.length > 0)
      .map((v) => v.value);
  };

  return {
    status: pick('Status'),
    callDisposition: pick('CallDisposition'),
  };
}

export class SalesforceConnectorAdapter implements ConnectorAdapter {
  async execute(
    tenantId: TenantId,
    config: ConnectorConfig,
    payload: ConnectorPayload,
  ): Promise<ConnectorResult> {
    let tokens: SalesforceTokens | null;
    try {
      tokens = await this.ensureAccessToken(tenantId, config);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      logger.error('Salesforce token refresh failed', { tenantId, error });
      return { success: false, error: `Salesforce token refresh failed: ${error}` };
    }
    if (!tokens) {
      return { success: false, error: 'Salesforce connector not configured: missing or invalid tokens' };
    }

    switch (payload.type) {
      case 'call.completed':
        return this.handleCallCompleted(tenantId, tokens, payload, config);
      case 'appointment.booked':
        return this.handleAppointmentBooked(tenantId, tokens, payload, config);
      default:
        return { success: false, error: `Salesforce adapter does not handle event: ${payload.type}` };
    }
  }

  private resolvePipelineMode(config: ConnectorConfig, payload: ConnectorPayload): PipelineMode {
    const fromPayload = (payload.pipelineMode as string | undefined)?.toLowerCase();
    if (fromPayload === 'leads' || fromPayload === 'contacts') return fromPayload;
    const fromCreds = (config.credentials.pipeline_mode ?? '').toLowerCase();
    if (fromCreds === 'contacts') return 'contacts';
    return 'leads';
  }

  private isQualified(payload: ConnectorPayload): boolean {
    if (payload.qualified === true) return true;
    if (typeof payload.qualified === 'string' && payload.qualified.toLowerCase() === 'true') return true;
    if (payload.type === 'appointment.booked') return true;
    return false;
  }

  private resolveLeadOutcome(payload: ConnectorPayload): LeadOutcome {
    const explicit = typeof payload.outcome === 'string'
      ? payload.outcome.toLowerCase().trim().replace(/[\s-]+/g, '_')
      : '';
    if (explicit === 'qualified' || explicit === 'disqualified' || explicit === 'nurture' || explicit === 'no_answer') {
      return explicit;
    }
    if (this.isQualified(payload)) return 'qualified';
    const dispoKey = normalizeDispositionKey(payload.disposition as string | undefined);
    if (dispoKey === 'no_answer') return 'no_answer';
    if (dispoKey === 'spam') return 'disqualified';
    if (payload.qualified === false) return 'disqualified';
    if (typeof payload.qualified === 'string' && payload.qualified.toLowerCase() === 'false') return 'disqualified';
    return 'nurture';
  }

  private async ensureAccessToken(
    tenantId: TenantId,
    config: ConnectorConfig,
  ): Promise<SalesforceTokens | null> {
    return ensureSalesforceAccessToken(tenantId, config);
  }

  private async handleCallCompleted(
    tenantId: TenantId,
    tokens: SalesforceTokens,
    payload: ConnectorPayload,
    config: ConnectorConfig,
  ): Promise<ConnectorResult> {
    const callerPhone = payload.callerPhone as string | undefined;
    const summary = payload.summary as string | undefined;
    const duration = payload.durationSeconds as number | undefined;
    const callSid = payload.callSid as string | undefined;
    const disposition = payload.disposition as string | undefined;
    const callerCompany = payload.callerCompany as string | undefined;
    const mode = this.resolvePipelineMode(config, payload);

    try {
      let who = callerPhone
        ? await this.findOrCreateLeadOrContact(tokens, callerPhone, payload, mode)
        : undefined;

      // If the AI agent qualified this caller and we matched/created a Lead,
      // convert it to Contact + Account + Opportunity so the activity attaches downstream.
      // Otherwise, update the Lead's Status field to reflect the QVO outcome
      // (disqualified / nurture / no_answer) so sales reps can route to the
      // right downstream playbook.
      let convertedContactId: string | undefined;
      let convertedOpportunityId: string | undefined;
      let convertedAccountId: string | undefined;
      let convertedFromLeadId: string | undefined;
      let updatedLeadStatus: string | undefined;
      let updatedLeadOutcome: LeadOutcome | undefined;
      if (who?.object === 'Lead') {
        const outcome = this.resolveLeadOutcome(payload);
        const leadStatusMap = resolveLeadStatusMap(config.credentials);
        if (outcome === 'qualified') {
          const reuseAccountId = (payload.accountId as string | undefined)
            ?? (callerCompany ? await this.findOrCreateAccount(tokens, callerCompany) : undefined);
          const opportunityName = callerCompany
            ? `${callerCompany} - QVO Inbound Call`
            : 'QVO Inbound Opportunity';
          const conversion = await this.convertLead(tokens, who.id, {
            accountId: reuseAccountId,
            opportunityName,
            convertedStatus: leadStatusMap.qualified,
          });
          if (conversion) {
            convertedFromLeadId = who.id;
            convertedContactId = conversion.contactId;
            convertedOpportunityId = conversion.opportunityId;
            convertedAccountId = conversion.accountId;
            who = { id: conversion.contactId, object: 'Contact' };
          }
        } else {
          const targetStatus = leadStatusMap[outcome];
          if (targetStatus) {
            const ok = await this.updateLeadStatus(tokens, who.id, targetStatus);
            if (ok) {
              updatedLeadStatus = targetStatus;
              updatedLeadOutcome = outcome;
            }
          }
        }
      }

      const whatId = convertedOpportunityId
        ?? convertedAccountId
        ?? await this.resolveWhatId(tokens, who, payload);
      const whatObject = classifySalesforceId(whatId);
      const derivedOpportunityId = convertedOpportunityId
        ?? (whatObject === 'Opportunity' ? whatId : undefined);
      const derivedAccountId = convertedAccountId
        ?? (whatObject === 'Account' ? whatId : undefined);
      const customMap = parseSharedDispositionMap(config.credentials, 'salesforce');
      const dispositionFields = mapDisposition('salesforce', disposition, customMap);

      const taskId = await this.createTask(tokens, {
        whoId: who?.id,
        whatId,
        subject: 'AI Voice Call',
        description: summary ?? 'AI voice call completed',
        durationSeconds: duration ?? 0,
        callSid,
        callerPhone,
        taskSubtype: 'Call',
        status: dispositionFields.status,
        callDisposition: dispositionFields.callDisposition,
      });

      const noteId = summary
        ? await this.attachSummaryNote(tokens, taskId, 'AI Call Summary', summary)
        : undefined;

      logger.info('Salesforce call task created', {
        tenantId, mode, whoObject: who?.object, whoId: who?.id, whatId, taskId, noteId,
        disposition, convertedFromLeadId, updatedLeadOutcome, updatedLeadStatus,
      });
      return {
        success: true,
        externalId: taskId,
        meta: {
          whoId: who?.id,
          whoObject: who?.object,
          whatId,
          whatObject,
          taskId,
          noteId,
          pipelineMode: mode,
          provider: 'salesforce',
          instanceUrl: tokens.instanceUrl,
          eventType: 'call.completed',
          ...(derivedOpportunityId ? { opportunityId: derivedOpportunityId } : {}),
          ...(derivedAccountId ? { accountId: derivedAccountId } : {}),
          ...(convertedContactId
            ? {
                convertedFromLead: true,
                convertedFromLeadId,
                contactId: convertedContactId,
              }
            : {}),
          ...(updatedLeadStatus
            ? {
                leadStatusUpdated: true,
                leadOutcome: updatedLeadOutcome,
                leadStatus: updatedLeadStatus,
              }
            : {}),
        },
      };
    } catch (err) {
      if (err instanceof SalesforceStaleRecordError) {
        logger.warn('Salesforce call logging hit stale cached record', {
          tenantId, errorCode: err.errorCode, staleIds: err.staleIds,
        });
        return this.staleRecordResult(err, payload);
      }
      const error = err instanceof Error ? err.message : String(err);
      logger.error('Salesforce call logging failed', { tenantId, error });
      return { success: false, error };
    }
  }

  /**
   * Build a `ConnectorResult` for a stale-record failure. Only IDs that
   * actually appeared on the inbound payload (i.e. came from the cache or
   * the explicit hint) are surfaced as `meta.staleIds` so the dispatch
   * layer can scrub the matching `crm_caller_identities` slots without
   * touching anything else.
   */
  private staleRecordResult(
    err: SalesforceStaleRecordError,
    payload: ConnectorPayload,
  ): ConnectorResult {
    const filtered: Record<string, string> = {};
    const payloadContactId = payload.contactId as string | undefined;
    const payloadAccountId = payload.accountId as string | undefined;
    const payloadOpportunityId = payload.opportunityId as string | undefined;
    if (err.staleIds.contactId && err.staleIds.contactId === payloadContactId) {
      filtered.contactId = err.staleIds.contactId;
    }
    if (err.staleIds.accountId && err.staleIds.accountId === payloadAccountId) {
      filtered.accountId = err.staleIds.accountId;
    }
    if (err.staleIds.opportunityId && err.staleIds.opportunityId === payloadOpportunityId) {
      filtered.opportunityId = err.staleIds.opportunityId;
    }
    return {
      success: false,
      error: err.message,
      meta: {
        provider: 'salesforce',
        staleRecord: true,
        ...(err.errorCode ? { staleErrorCode: err.errorCode } : {}),
        ...(Object.keys(filtered).length > 0 ? { staleIds: filtered } : {}),
      },
    };
  }

  private async handleAppointmentBooked(
    tenantId: TenantId,
    tokens: SalesforceTokens,
    payload: ConnectorPayload,
    config: ConnectorConfig,
  ): Promise<ConnectorResult> {
    const callerPhone = payload.callerPhone as string | undefined;
    const summary = payload.summary as string | undefined;
    const callerCompany = payload.callerCompany as string | undefined;
    const mode = this.resolvePipelineMode(config, payload);

    try {
      let who = callerPhone
        ? await this.findOrCreateLeadOrContact(tokens, callerPhone, payload, mode)
        : undefined;

      // Auto-convert Lead → Contact on the high-intent appointment.booked event
      // so downstream Account/Contact/Opportunity wiring fires end-to-end without
      // sales reps manually running Lead conversion.
      let convertedContactId: string | undefined;
      let convertedOpportunityId: string | undefined;
      let convertedAccountId: string | undefined;
      let convertedFromLeadId: string | undefined;
      if (who?.object === 'Lead') {
        const reuseAccountId = (payload.accountId as string | undefined)
          ?? (callerCompany ? await this.findOrCreateAccount(tokens, callerCompany) : undefined);
        const opportunityName = callerCompany
          ? `${callerCompany} - QVO Appointment`
          : 'QVO Appointment Opportunity';
        const leadStatusMap = resolveLeadStatusMap(config.credentials);
        const conversion = await this.convertLead(tokens, who.id, {
          accountId: reuseAccountId,
          opportunityName,
          convertedStatus: leadStatusMap.qualified,
        });
        if (conversion) {
          convertedFromLeadId = who.id;
          convertedContactId = conversion.contactId;
          convertedOpportunityId = conversion.opportunityId;
          convertedAccountId = conversion.accountId;
          who = { id: conversion.contactId, object: 'Contact' };
          logger.info('Salesforce Lead converted on appointment.booked', {
            tenantId,
            leadId: conversion.leadId,
            contactId: conversion.contactId,
            accountId: conversion.accountId,
            opportunityId: conversion.opportunityId,
            reusedAccount: Boolean(reuseAccountId),
          });
        }
      }

      const whatId = convertedOpportunityId
        ?? convertedAccountId
        ?? await this.resolveWhatId(tokens, who, payload);
      const whatObject = classifySalesforceId(whatId);
      const derivedOpportunityId = convertedOpportunityId
        ?? (whatObject === 'Opportunity' ? whatId : undefined);
      const derivedAccountId = convertedAccountId
        ?? (whatObject === 'Account' ? whatId : undefined);
      const customMap = parseSharedDispositionMap(config.credentials, 'salesforce');
      const dispositionFields = mapDisposition('salesforce', 'booked', customMap);

      const description = [
        'Appointment booked via QVO AI agent',
        summary ? `Details: ${summary}` : '',
        payload.appointmentDate ? `Date: ${payload.appointmentDate}` : '',
        payload.appointmentTime ? `Time: ${payload.appointmentTime}` : '',
      ].filter(Boolean).join('\n');

      const taskId = await this.createTask(tokens, {
        whoId: who?.id,
        whatId,
        subject: 'Appointment Booked',
        description,
        durationSeconds: 0,
        callerPhone,
        taskSubtype: 'Task',
        activityDate: (payload.appointmentDate as string) ?? undefined,
        status: dispositionFields.status,
        callDisposition: dispositionFields.callDisposition,
      });

      const noteId = summary
        ? await this.attachSummaryNote(tokens, taskId, 'AI Appointment Summary', summary)
        : undefined;

      logger.info('Salesforce appointment task created', {
        tenantId, mode, whoObject: who?.object, whoId: who?.id, whatId, taskId, noteId,
        convertedFromLeadId,
      });
      return {
        success: true,
        externalId: taskId,
        meta: {
          whoId: who?.id,
          whoObject: who?.object,
          whatId,
          whatObject,
          taskId,
          noteId,
          pipelineMode: mode,
          provider: 'salesforce',
          instanceUrl: tokens.instanceUrl,
          eventType: 'appointment.booked',
          ...(derivedOpportunityId ? { opportunityId: derivedOpportunityId } : {}),
          ...(derivedAccountId ? { accountId: derivedAccountId } : {}),
          ...(convertedContactId
            ? {
                convertedFromLead: true,
                convertedFromLeadId,
                contactId: convertedContactId,
              }
            : {}),
        },
      };
    } catch (err) {
      if (err instanceof SalesforceStaleRecordError) {
        logger.warn('Salesforce appointment logging hit stale cached record', {
          tenantId, errorCode: err.errorCode, staleIds: err.staleIds,
        });
        return this.staleRecordResult(err, payload);
      }
      const error = err instanceof Error ? err.message : String(err);
      logger.error('Salesforce appointment logging failed', { tenantId, error });
      return { success: false, error };
    }
  }

  private async convertLead(
    tokens: SalesforceTokens,
    leadId: string,
    options: { accountId?: string; opportunityName?: string; convertedStatus?: string },
  ): Promise<
    | {
        leadId: string;
        contactId: string;
        accountId: string;
        opportunityId?: string;
      }
    | undefined
  > {
    const requestedStatus = options.convertedStatus?.trim();
    let convertedStatus = requestedStatus || await this.getConvertedLeadStatus(tokens);
    if (!convertedStatus) {
      logger.warn('Skipping Salesforce Lead conversion: no IsConverted LeadStatus available', { leadId });
      return undefined;
    }

    const url = `${tokens.instanceUrl}/services/data/${API_VERSION}/sobjects/LeadConvert/`;
    const body: Record<string, unknown> = {
      leadId,
      convertedStatus,
      doNotCreateOpportunity: false,
    };
    if (options.accountId) body.accountId = options.accountId;
    if (options.opportunityName) body.opportunityName = options.opportunityName.slice(0, 120);

    try {
      let res = await this.fetchWithTimeout(url, {
        method: 'POST',
        headers: this.headers(tokens.accessToken),
        body: JSON.stringify(body),
      });
      // If the manager-mapped "qualified" status isn't a valid converted
      // status in this org, retry once with the auto-detected one so the
      // conversion still happens.
      if (!res.ok && requestedStatus) {
        const fallback = await this.getConvertedLeadStatus(tokens);
        if (fallback && fallback !== convertedStatus) {
          logger.warn('Salesforce Lead conversion retrying with auto-detected status', {
            leadId, attempted: convertedStatus, fallback,
          });
          convertedStatus = fallback;
          body.convertedStatus = fallback;
          res = await this.fetchWithTimeout(url, {
            method: 'POST',
            headers: this.headers(tokens.accessToken),
            body: JSON.stringify(body),
          });
        }
      }
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        // If the failure was caused by a stale `accountId` we passed in (cached
        // from a previous call but since deleted/merged), surface it so the
        // dispatch layer can scrub the cache. The leadId itself is freshly
        // resolved earlier in this call and cannot be stale.
        const staleCode = options.accountId
          ? extractSalesforceStaleErrorCode(res.status, text)
          : undefined;
        if (staleCode && options.accountId) {
          throw new SalesforceStaleRecordError(
            `Salesforce Lead conversion failed ${res.status} (${staleCode}): ${text.slice(0, 200)}`,
            { accountId: options.accountId },
            staleCode,
          );
        }
        logger.warn('Salesforce Lead conversion failed', {
          leadId, status: res.status, convertedStatus, body: text.slice(0, 300),
        });
        return undefined;
      }
      const data = await res.json() as {
        success?: boolean;
        leadId?: string;
        contactId?: string;
        accountId?: string;
        opportunityId?: string;
        errors?: unknown;
      };
      if (data.success === false || !data.contactId || !data.accountId) {
        logger.warn('Salesforce Lead conversion returned unsuccessful response', {
          leadId, response: data,
        });
        return undefined;
      }
      return {
        leadId: data.leadId ?? leadId,
        contactId: data.contactId,
        accountId: data.accountId,
        opportunityId: data.opportunityId,
      };
    } catch (err) {
      // Stale-record errors must propagate so the call/appointment handler
      // can surface them via meta.staleIds; never swallow them as "skipped
      // conversion" because that would silently leave a zombie cache row.
      if (err instanceof SalesforceStaleRecordError) throw err;
      logger.warn('Salesforce Lead conversion threw', { leadId, error: String(err) });
      return undefined;
    }
  }

  private async updateLeadStatus(
    tokens: SalesforceTokens,
    leadId: string,
    status: string,
  ): Promise<boolean> {
    const trimmed = status.trim();
    if (!trimmed) return false;
    const url = `${tokens.instanceUrl}/services/data/${API_VERSION}/sobjects/Lead/${encodeURIComponent(leadId)}`;
    try {
      const res = await this.fetchWithTimeout(url, {
        method: 'PATCH',
        headers: this.headers(tokens.accessToken),
        body: JSON.stringify({ Status: trimmed }),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        logger.warn('Salesforce Lead status update failed', {
          leadId, status: trimmed, httpStatus: res.status, body: text.slice(0, 200),
        });
        return false;
      }
      return true;
    } catch (err) {
      logger.warn('Salesforce Lead status update threw', { leadId, status: trimmed, error: String(err) });
      return false;
    }
  }

  private async getConvertedLeadStatus(
    tokens: SalesforceTokens,
  ): Promise<string | undefined> {
    const soql = `SELECT MasterLabel FROM LeadStatus WHERE IsConverted = true ORDER BY SortOrder ASC NULLS LAST LIMIT 1`;
    const url = `${tokens.instanceUrl}/services/data/${API_VERSION}/query?q=${encodeURIComponent(soql)}`;
    try {
      const res = await this.fetchWithTimeout(url, { headers: this.headers(tokens.accessToken) });
      if (!res.ok) return undefined;
      const data = await res.json() as { records: Array<{ MasterLabel: string }> };
      return data.records[0]?.MasterLabel;
    } catch {
      return undefined;
    }
  }

  private async resolveWhatId(
    tokens: SalesforceTokens,
    who: { id: string; object: 'Contact' | 'Lead' } | undefined,
    payload: ConnectorPayload,
  ): Promise<string | undefined> {
    const explicitOpportunityId = payload.opportunityId as string | undefined;
    if (explicitOpportunityId) return explicitOpportunityId;

    if (who?.object === 'Contact') {
      const oppId = await this.findOpenOpportunityForContact(tokens, who.id);
      if (oppId) return oppId;
    }

    const explicitAccountId = payload.accountId as string | undefined;
    if (explicitAccountId) return explicitAccountId;

    const callerCompany = payload.callerCompany as string | undefined;
    if (callerCompany) {
      const accountId = await this.findOrCreateAccount(tokens, callerCompany);
      if (accountId) return accountId;
    }

    if (who?.object === 'Contact') {
      const accountId = await this.findAccountForContact(tokens, who.id);
      if (accountId) return accountId;
    }

    return undefined;
  }

  private async findOrCreateLeadOrContact(
    tokens: SalesforceTokens,
    phone: string,
    payload: ConnectorPayload,
    mode: PipelineMode,
  ): Promise<SfRecord | undefined> {
    const hintedContactId = payload.contactId as string | undefined;
    if (hintedContactId) return { id: hintedContactId, object: 'Contact' };

    const existing = await this.findContactOrLeadByPhone(tokens, phone);
    if (existing) return existing;

    const firstName = (payload.callerFirstName as string) ?? '';
    const lastName = (payload.callerLastName as string) ?? 'Unknown Caller';
    const email = (payload.callerEmail as string) ?? '';
    const company = (payload.callerCompany as string) ?? '';

    if (mode === 'contacts') {
      // Pre-create Account from company name so the Contact can be linked.
      const accountId = (payload.accountId as string | undefined)
        ?? (company ? await this.findOrCreateAccount(tokens, company) : undefined);
      const contactId = await this.createContact(tokens, { firstName, lastName, email, phone, accountId });
      if (!contactId) return undefined;
      // Best-effort opportunity creation alongside the new contact.
      await this.createOpportunityForContact(tokens, contactId, {
        name: company
          ? `${company} - QVO Inbound`
          : `${(firstName || lastName || 'Inbound')} – Inbound Call`,
        accountId,
      }).catch((err) => logger.warn('Salesforce Opportunity create skipped', { error: String(err) }));
      return { id: contactId, object: 'Contact' };
    }

    const leadId = await this.createLead(tokens, { firstName, lastName, email, phone, company });
    return leadId ? { id: leadId, object: 'Lead' } : undefined;
  }

  private async findContactOrLeadByPhone(
    tokens: SalesforceTokens,
    phone: string,
  ): Promise<SfRecord | undefined> {
    const escaped = phone.replace(/'/g, "\\'");
    const queries: Array<{ object: 'Contact' | 'Lead'; soql: string }> = [
      { object: 'Contact', soql: `SELECT Id FROM Contact WHERE Phone = '${escaped}' OR MobilePhone = '${escaped}' LIMIT 1` },
      { object: 'Lead', soql: `SELECT Id FROM Lead WHERE (Phone = '${escaped}' OR MobilePhone = '${escaped}') AND IsConverted = false LIMIT 1` },
    ];

    for (const { object, soql } of queries) {
      const url = `${tokens.instanceUrl}/services/data/${API_VERSION}/query?q=${encodeURIComponent(soql)}`;
      const res = await this.fetchWithTimeout(url, { headers: this.headers(tokens.accessToken) });
      if (!res.ok) continue;
      const data = await res.json() as { totalSize: number; records: Array<{ Id: string }> };
      if (data.totalSize > 0 && data.records[0]?.Id) {
        return { id: data.records[0].Id, object };
      }
    }
    return undefined;
  }

  private async findAccountForContact(
    tokens: SalesforceTokens,
    contactId: string,
  ): Promise<string | undefined> {
    const escaped = contactId.replace(/'/g, "\\'");
    const soql = `SELECT AccountId FROM Contact WHERE Id = '${escaped}' LIMIT 1`;
    const url = `${tokens.instanceUrl}/services/data/${API_VERSION}/query?q=${encodeURIComponent(soql)}`;
    try {
      const res = await this.fetchWithTimeout(url, { headers: this.headers(tokens.accessToken) });
      if (!res.ok) return undefined;
      const data = await res.json() as { records: Array<{ AccountId?: string }> };
      return data.records[0]?.AccountId ?? undefined;
    } catch {
      return undefined;
    }
  }

  private async findOrCreateAccount(
    tokens: SalesforceTokens,
    companyName: string,
  ): Promise<string | undefined> {
    const trimmed = companyName.trim();
    if (!trimmed || trimmed.toLowerCase() === 'unknown') return undefined;

    const escaped = trimmed.replace(/'/g, "\\'");
    const soql = `SELECT Id FROM Account WHERE Name = '${escaped}' LIMIT 1`;
    const queryUrl = `${tokens.instanceUrl}/services/data/${API_VERSION}/query?q=${encodeURIComponent(soql)}`;
    try {
      const res = await this.fetchWithTimeout(queryUrl, { headers: this.headers(tokens.accessToken) });
      if (res.ok) {
        const data = await res.json() as { totalSize: number; records: Array<{ Id: string }> };
        if (data.totalSize > 0 && data.records[0]?.Id) return data.records[0].Id;
      }
    } catch (err) {
      logger.warn('Salesforce Account lookup threw', { error: String(err) });
    }

    const createUrl = `${tokens.instanceUrl}/services/data/${API_VERSION}/sobjects/Account`;
    try {
      const res = await this.fetchWithTimeout(createUrl, {
        method: 'POST',
        headers: this.headers(tokens.accessToken),
        body: JSON.stringify({ Name: trimmed }),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        logger.warn('Salesforce Account create failed', { status: res.status, body: text.slice(0, 200) });
        return undefined;
      }
      const data = await res.json() as { id: string };
      return data.id;
    } catch (err) {
      logger.warn('Salesforce Account create threw', { error: String(err) });
      return undefined;
    }
  }

  private async attachSummaryNote(
    tokens: SalesforceTokens,
    parentId: string,
    title: string,
    summary: string,
  ): Promise<string | undefined> {
    try {
      const htmlContent = `<p>${escapeHtml(summary).replace(/\n/g, '<br/>')}</p>`;
      const base64Content = Buffer.from(htmlContent, 'utf8').toString('base64');

      const noteUrl = `${tokens.instanceUrl}/services/data/${API_VERSION}/sobjects/ContentNote`;
      const noteRes = await this.fetchWithTimeout(noteUrl, {
        method: 'POST',
        headers: this.headers(tokens.accessToken),
        body: JSON.stringify({ Title: title.slice(0, 200), Content: base64Content }),
      });
      if (!noteRes.ok) {
        const text = await noteRes.text().catch(() => '');
        logger.warn('Salesforce ContentNote create failed', { status: noteRes.status, body: text.slice(0, 200) });
        return undefined;
      }
      const noteData = await noteRes.json() as { id: string };

      const linkUrl = `${tokens.instanceUrl}/services/data/${API_VERSION}/sobjects/ContentDocumentLink`;
      const linkRes = await this.fetchWithTimeout(linkUrl, {
        method: 'POST',
        headers: this.headers(tokens.accessToken),
        body: JSON.stringify({
          ContentDocumentId: noteData.id,
          LinkedEntityId: parentId,
          ShareType: 'V',
          Visibility: 'AllUsers',
        }),
      });
      if (!linkRes.ok) {
        const text = await linkRes.text().catch(() => '');
        logger.warn('Salesforce ContentDocumentLink create failed', {
          status: linkRes.status, body: text.slice(0, 200),
        });
      }
      return noteData.id;
    } catch (err) {
      logger.warn('Salesforce summary note attach threw', { error: String(err) });
      return undefined;
    }
  }

  private async findOpenOpportunityForContact(
    tokens: SalesforceTokens,
    contactId: string,
  ): Promise<string | undefined> {
    const escaped = contactId.replace(/'/g, "\\'");
    const soql = `SELECT OpportunityId FROM OpportunityContactRole WHERE ContactId = '${escaped}' AND Opportunity.IsClosed = false ORDER BY Opportunity.LastModifiedDate DESC LIMIT 1`;
    const url = `${tokens.instanceUrl}/services/data/${API_VERSION}/query?q=${encodeURIComponent(soql)}`;
    try {
      const res = await this.fetchWithTimeout(url, { headers: this.headers(tokens.accessToken) });
      if (!res.ok) {
        logger.warn('Salesforce Opportunity lookup failed', { status: res.status });
        return undefined;
      }
      const data = await res.json() as { totalSize: number; records: Array<{ OpportunityId: string }> };
      if (data.totalSize > 0 && data.records[0]?.OpportunityId) {
        return data.records[0].OpportunityId;
      }
    } catch (err) {
      logger.warn('Salesforce Opportunity lookup threw', { error: String(err) });
    }
    return undefined;
  }

  private async createLead(
    tokens: SalesforceTokens,
    params: { firstName?: string; lastName: string; email?: string; phone: string; company?: string },
  ): Promise<string | undefined> {
    const url = `${tokens.instanceUrl}/services/data/${API_VERSION}/sobjects/Lead`;
    const company = params.company?.trim() || 'Unknown';
    const body: Record<string, unknown> = {
      LastName: params.lastName || 'Unknown Caller',
      Company: company,
      Phone: params.phone,
      LeadSource: 'QVO AI Voice Agent',
    };
    if (params.firstName) body.FirstName = params.firstName;
    if (params.email) body.Email = params.email;

    // Pre-create the Account so it exists at conversion time and can be linked.
    if (params.company) {
      await this.findOrCreateAccount(tokens, params.company);
    }

    const res = await this.fetchWithTimeout(url, {
      method: 'POST',
      headers: this.headers(tokens.accessToken),
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      logger.warn('Salesforce Lead create failed', { status: res.status, body: text.slice(0, 200) });
      return undefined;
    }
    const data = await res.json() as { id: string };
    return data.id;
  }

  private async createContact(
    tokens: SalesforceTokens,
    params: { firstName?: string; lastName: string; email?: string; phone: string; accountId?: string },
  ): Promise<string | undefined> {
    const url = `${tokens.instanceUrl}/services/data/${API_VERSION}/sobjects/Contact`;
    const body: Record<string, unknown> = {
      LastName: params.lastName || 'Unknown Caller',
      Phone: params.phone,
      LeadSource: 'QVO AI Voice Agent',
    };
    if (params.firstName) body.FirstName = params.firstName;
    if (params.email) body.Email = params.email;
    if (params.accountId) body.AccountId = params.accountId;

    const res = await this.fetchWithTimeout(url, {
      method: 'POST',
      headers: this.headers(tokens.accessToken),
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      logger.warn('Salesforce Contact create failed', { status: res.status, body: text.slice(0, 200) });
      return undefined;
    }
    const data = await res.json() as { id: string };
    return data.id;
  }

  private async createOpportunityForContact(
    tokens: SalesforceTokens,
    contactId: string,
    params: { name: string; closeDateDaysFromNow?: number; stageName?: string; accountId?: string },
  ): Promise<string | undefined> {
    const url = `${tokens.instanceUrl}/services/data/${API_VERSION}/sobjects/Opportunity`;
    const closeDate = new Date(Date.now() + (params.closeDateDaysFromNow ?? 30) * 24 * 60 * 60 * 1000)
      .toISOString().slice(0, 10);
    const body: Record<string, unknown> = {
      Name: params.name,
      StageName: params.stageName ?? 'Prospecting',
      CloseDate: closeDate,
      LeadSource: 'QVO AI Voice Agent',
    };
    if (params.accountId) body.AccountId = params.accountId;

    const res = await this.fetchWithTimeout(url, {
      method: 'POST',
      headers: this.headers(tokens.accessToken),
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      logger.warn('Salesforce Opportunity create failed', { status: res.status, body: text.slice(0, 200) });
      return undefined;
    }
    const data = await res.json() as { id: string };
    const opportunityId = data.id;

    // Attach contact role so future lookups associate this opportunity with the contact.
    await this.fetchWithTimeout(
      `${tokens.instanceUrl}/services/data/${API_VERSION}/sobjects/OpportunityContactRole`,
      {
        method: 'POST',
        headers: this.headers(tokens.accessToken),
        body: JSON.stringify({ OpportunityId: opportunityId, ContactId: contactId, IsPrimary: true }),
      },
    ).catch(() => undefined);

    return opportunityId;
  }

  private async createTask(
    tokens: SalesforceTokens,
    params: {
      whoId?: string;
      whatId?: string;
      subject: string;
      description: string;
      durationSeconds: number;
      callSid?: string;
      callerPhone?: string;
      taskSubtype: 'Call' | 'Task';
      activityDate?: string;
      status?: string;
      callDisposition?: string;
    },
  ): Promise<string> {
    const url = `${tokens.instanceUrl}/services/data/${API_VERSION}/sobjects/Task`;
    const body: Record<string, unknown> = {
      Subject: params.subject,
      Description: params.description,
      Status: params.status ?? 'Completed',
      Priority: 'Normal',
      TaskSubtype: params.taskSubtype,
      ActivityDate: params.activityDate ?? new Date().toISOString().slice(0, 10),
    };
    if (params.taskSubtype === 'Call') {
      body.CallType = 'Inbound';
      body.CallDurationInSeconds = params.durationSeconds;
      if (params.callSid) body.CallObject = params.callSid;
    }
    if (params.callDisposition) body.CallDisposition = params.callDisposition;
    if (params.whoId) body.WhoId = params.whoId;
    if (params.whatId) body.WhatId = params.whatId;

    const res = await this.fetchWithTimeout(url, {
      method: 'POST',
      headers: this.headers(tokens.accessToken),
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const staleDetails = extractSalesforceStaleErrorDetails(res.status, text);
      if (staleDetails) {
        // Map the failing reference back to the cache slot that injected it.
        // Prefer Salesforce's own `fields` array when it tells us *which*
        // reference was stale (e.g. ["WhoId"]), so we only scrub that one
        // cache slot. Fall back to "flag every cached ID we passed" when
        // Salesforce doesn't disclose the field, since either could be the
        // culprit and clearing too much is safer than clearing too little.
        const lcFields = staleDetails.fields.map((f) => f.toLowerCase());
        const flagWho = lcFields.length === 0 || lcFields.includes('whoid');
        const flagWhat = lcFields.length === 0 || lcFields.includes('whatid');
        const whoClass = classifySalesforceId(params.whoId);
        const whatClass = classifySalesforceId(params.whatId);
        const staleIds: { contactId?: string; accountId?: string; opportunityId?: string } = {};
        // WhoId can be a Contact (003) or a Lead (00Q); only Contacts come
        // from the caller-identity cache (Leads are looked up by phone every
        // call), so we only surface Contact stale-ness.
        if (flagWho && whoClass === 'Contact' && params.whoId) staleIds.contactId = params.whoId;
        if (flagWhat && whatClass === 'Account' && params.whatId) staleIds.accountId = params.whatId;
        if (flagWhat && whatClass === 'Opportunity' && params.whatId) staleIds.opportunityId = params.whatId;
        throw new SalesforceStaleRecordError(
          `Salesforce Task create failed ${res.status} (${staleDetails.code}): ${text.slice(0, 200)}`,
          staleIds,
          staleDetails.code,
        );
      }
      throw new Error(`Salesforce Task create failed ${res.status}: ${text.slice(0, 200)}`);
    }
    const data = await res.json() as { id: string };
    return data.id;
  }

  private headers(accessToken: string): Record<string, string> {
    return {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    };
  }

  private async fetchWithTimeout(url: string, init: RequestInit = {}): Promise<Response> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      return await fetch(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timeoutId);
    }
  }
}

export { DEFAULT_SALESFORCE_DISPOSITION_MAP } from '../dispositionMap';
export type { DispositionMap } from '../dispositionMap';

export type LeadOutcome = 'qualified' | 'disqualified' | 'nurture' | 'no_answer';

export type LeadStatusMap = Record<LeadOutcome, string>;

const LEAD_OUTCOMES: LeadOutcome[] = ['qualified', 'disqualified', 'nurture', 'no_answer'];

export const DEFAULT_SALESFORCE_LEAD_STATUS_MAP: LeadStatusMap = {
  qualified: 'Qualified',
  disqualified: 'Unqualified',
  nurture: 'Working - Contacted',
  no_answer: 'Open - Not Contacted',
};

export function parseLeadStatusMap(
  credentials: Record<string, string>,
): Partial<LeadStatusMap> | undefined {
  const raw = credentials.lead_status_map;
  if (!raw || !raw.trim()) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `Invalid Salesforce lead_status_map JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Invalid Salesforce lead_status_map: expected an object of { qualified, disqualified, nurture, no_answer } string entries');
  }
  const result: Partial<LeadStatusMap> = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    const normalized = key.toLowerCase().trim().replace(/[\s-]+/g, '_') as LeadOutcome;
    if (!LEAD_OUTCOMES.includes(normalized)) continue;
    if (typeof value !== 'string') {
      throw new Error(`Invalid Salesforce lead_status_map entry for "${key}": expected a string LeadStatus value`);
    }
    const trimmed = value.trim();
    if (trimmed) result[normalized] = trimmed;
  }
  return result;
}

export function resolveLeadStatusMap(
  credentials: Record<string, string>,
): LeadStatusMap {
  let override: Partial<LeadStatusMap> | undefined;
  try {
    override = parseLeadStatusMap(credentials);
  } catch {
    // Fall back to defaults silently if the persisted JSON is invalid.
    // The settings endpoint surfaces parse errors back to the UI.
    override = undefined;
  }
  return { ...DEFAULT_SALESFORCE_LEAD_STATUS_MAP, ...(override ?? {}) };
}

export function parseDispositionMap(
  credentials: Record<string, string>,
): DispositionMap | undefined {
  return parseSharedDispositionMap(credentials, 'salesforce');
}

export function mapDispositionToTaskFields(
  disposition: string | undefined,
  customMap?: DispositionMap,
): { status: string; callDisposition?: string } {
  return mapDisposition('salesforce', disposition, customMap);
}

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
