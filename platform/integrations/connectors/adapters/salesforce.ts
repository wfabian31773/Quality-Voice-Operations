import { createLogger } from '../../../core/logger';
import { upsertConnector } from '../db';
import {
  parseDispositionMap as parseSharedDispositionMap,
  mapDisposition,
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

type PipelineMode = 'leads' | 'contacts';

interface SalesforceTokens {
  accessToken: string;
  instanceUrl: string;
}

type SfRecord = { id: string; object: 'Contact' | 'Lead' };

export class SalesforceConnectorAdapter implements ConnectorAdapter {
  async execute(
    tenantId: TenantId,
    config: ConnectorConfig,
    payload: ConnectorPayload,
  ): Promise<ConnectorResult> {
    const tokens = await this.ensureAccessToken(tenantId, config);
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

  private async ensureAccessToken(
    tenantId: TenantId,
    config: ConnectorConfig,
  ): Promise<SalesforceTokens | null> {
    const accessToken = config.credentials.access_token ?? '';
    const refreshToken = config.credentials.refresh_token ?? '';
    const instanceUrl = config.credentials.instance_url ?? '';
    const expiresAtRaw = config.credentials.token_expires_at ?? '0';
    const expiresAt = parseInt(expiresAtRaw, 10) || 0;

    if (!accessToken || !instanceUrl) {
      logger.error('Missing Salesforce credentials', { tenantId });
      return null;
    }

    const skewMs = 60_000;
    if (expiresAt && Date.now() < expiresAt - skewMs) {
      return { accessToken, instanceUrl };
    }

    if (!refreshToken) {
      return { accessToken, instanceUrl };
    }

    const clientId = process.env.SALESFORCE_CLIENT_ID ?? '';
    const clientSecret = process.env.SALESFORCE_CLIENT_SECRET ?? '';
    const loginUrl = process.env.SALESFORCE_LOGIN_URL ?? 'https://login.salesforce.com';
    if (!clientId || !clientSecret) {
      logger.warn('Cannot refresh Salesforce token: SALESFORCE_CLIENT_ID/SECRET not set', { tenantId });
      return { accessToken, instanceUrl };
    }

    try {
      const res = await fetch(`${loginUrl}/services/oauth2/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          client_id: clientId,
          client_secret: clientSecret,
          refresh_token: refreshToken,
        }).toString(),
      });
      if (!res.ok) {
        logger.error('Salesforce token refresh failed', { tenantId, status: res.status });
        return { accessToken, instanceUrl };
      }
      const data = await res.json() as {
        access_token: string;
        instance_url?: string;
        issued_at?: string;
      };
      const newAccessToken = data.access_token;
      const newInstanceUrl = data.instance_url ?? instanceUrl;
      const newExpiresAt = Date.now() + 90 * 60 * 1000;
      await upsertConnector(tenantId, {
        connectorType: 'crm',
        provider: 'salesforce',
        name: 'Salesforce',
        credentials: {
          ...config.credentials,
          access_token: newAccessToken,
          instance_url: newInstanceUrl,
          token_expires_at: String(newExpiresAt),
        },
        isEnabled: true,
      });
      return { accessToken: newAccessToken, instanceUrl: newInstanceUrl };
    } catch (err) {
      logger.error('Salesforce token refresh threw', { tenantId, error: String(err) });
      return { accessToken, instanceUrl };
    }
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
      let convertedContactId: string | undefined;
      let convertedOpportunityId: string | undefined;
      let convertedAccountId: string | undefined;
      let convertedFromLeadId: string | undefined;
      if (who?.object === 'Lead' && this.isQualified(payload)) {
        const reuseAccountId = (payload.accountId as string | undefined)
          ?? (callerCompany ? await this.findOrCreateAccount(tokens, callerCompany) : undefined);
        const opportunityName = callerCompany
          ? `${callerCompany} - QVO Inbound Call`
          : 'QVO Inbound Opportunity';
        const conversion = await this.convertLead(tokens, who.id, {
          accountId: reuseAccountId,
          opportunityName,
        });
        if (conversion) {
          convertedFromLeadId = who.id;
          convertedContactId = conversion.contactId;
          convertedOpportunityId = conversion.opportunityId;
          convertedAccountId = conversion.accountId;
          who = { id: conversion.contactId, object: 'Contact' };
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
        disposition, convertedFromLeadId,
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
        },
      };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      logger.error('Salesforce call logging failed', { tenantId, error });
      return { success: false, error };
    }
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
        const conversion = await this.convertLead(tokens, who.id, {
          accountId: reuseAccountId,
          opportunityName,
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
      const error = err instanceof Error ? err.message : String(err);
      logger.error('Salesforce appointment logging failed', { tenantId, error });
      return { success: false, error };
    }
  }

  private async convertLead(
    tokens: SalesforceTokens,
    leadId: string,
    options: { accountId?: string; opportunityName?: string },
  ): Promise<
    | {
        leadId: string;
        contactId: string;
        accountId: string;
        opportunityId?: string;
      }
    | undefined
  > {
    const convertedStatus = await this.getConvertedLeadStatus(tokens);
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
      const res = await this.fetchWithTimeout(url, {
        method: 'POST',
        headers: this.headers(tokens.accessToken),
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        logger.warn('Salesforce Lead conversion failed', {
          leadId, status: res.status, body: text.slice(0, 300),
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
      logger.warn('Salesforce Lead conversion threw', { leadId, error: String(err) });
      return undefined;
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
