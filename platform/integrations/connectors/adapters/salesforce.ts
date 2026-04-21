import { createLogger } from '../../../core/logger';
import { upsertConnector } from '../db';
import type { ConnectorAdapter, ConnectorConfig, ConnectorPayload, ConnectorResult } from '../types';
import type { TenantId } from '../../../core/types';

const logger = createLogger('SALESFORCE_CONNECTOR');
const REQUEST_TIMEOUT_MS = 15_000;
const API_VERSION = 'v59.0';

interface SalesforceTokens {
  accessToken: string;
  instanceUrl: string;
}

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
        return this.handleCallCompleted(tenantId, tokens, payload);
      case 'appointment.booked':
        return this.handleAppointmentBooked(tenantId, tokens, payload);
      default:
        return { success: false, error: `Salesforce adapter does not handle event: ${payload.type}` };
    }
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
      // No refresh token — return current token and let API call surface auth errors.
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
      // Salesforce access tokens default to ~2h; cache for 90 minutes.
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
  ): Promise<ConnectorResult> {
    const callerPhone = payload.callerPhone as string | undefined;
    const summary = payload.summary as string | undefined;
    const duration = payload.durationSeconds as number | undefined;
    const callSid = payload.callSid as string | undefined;

    try {
      const who = callerPhone
        ? await this.findOrCreateLeadOrContact(tokens, callerPhone, payload)
        : undefined;

      const whatId = who?.object === 'Contact'
        ? await this.findOpenOpportunityForContact(tokens, who.id)
        : undefined;

      const taskId = await this.createTask(tokens, {
        whoId: who?.id,
        whatId,
        subject: 'AI Voice Call',
        description: summary ?? 'AI voice call completed',
        durationSeconds: duration ?? 0,
        callSid,
        callerPhone,
        taskSubtype: 'Call',
      });

      logger.info('Salesforce call task created', { tenantId, whoId: who?.id, whatId, taskId });
      return {
        success: true,
        externalId: taskId,
        meta: { whoId: who?.id, whatId, taskId, provider: 'salesforce' },
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
  ): Promise<ConnectorResult> {
    const callerPhone = payload.callerPhone as string | undefined;
    const summary = payload.summary as string | undefined;

    try {
      const who = callerPhone
        ? await this.findOrCreateLeadOrContact(tokens, callerPhone, payload)
        : undefined;

      const whatId = who?.object === 'Contact'
        ? await this.findOpenOpportunityForContact(tokens, who.id)
        : undefined;

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
      });

      logger.info('Salesforce appointment task created', { tenantId, whoId: who?.id, whatId, taskId });
      return {
        success: true,
        externalId: taskId,
        meta: { whoId: who?.id, whatId, taskId, provider: 'salesforce' },
      };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      logger.error('Salesforce appointment logging failed', { tenantId, error });
      return { success: false, error };
    }
  }

  private async findOrCreateLeadOrContact(
    tokens: SalesforceTokens,
    phone: string,
    payload: ConnectorPayload,
  ): Promise<{ id: string; object: 'Contact' | 'Lead' } | undefined> {
    const existing = await this.findContactOrLeadByPhone(tokens, phone);
    if (existing) return existing;

    const firstName = (payload.callerFirstName as string) ?? '';
    const lastName = (payload.callerLastName as string) ?? 'Unknown Caller';
    const email = (payload.callerEmail as string) ?? '';

    const leadId = await this.createLead(tokens, { firstName, lastName, email, phone });
    return leadId ? { id: leadId, object: 'Lead' } : undefined;
  }

  private async findContactOrLeadByPhone(
    tokens: SalesforceTokens,
    phone: string,
  ): Promise<{ id: string; object: 'Contact' | 'Lead' } | undefined> {
    const escaped = phone.replace(/'/g, "\\'");
    const queries: Array<{ object: 'Contact' | 'Lead'; soql: string }> = [
      { object: 'Contact', soql: `SELECT Id FROM Contact WHERE Phone = '${escaped}' OR MobilePhone = '${escaped}' LIMIT 1` },
      { object: 'Lead', soql: `SELECT Id FROM Lead WHERE Phone = '${escaped}' OR MobilePhone = '${escaped}' LIMIT 1` },
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
    params: { firstName?: string; lastName: string; email?: string; phone: string },
  ): Promise<string | undefined> {
    const url = `${tokens.instanceUrl}/services/data/${API_VERSION}/sobjects/Lead`;
    const body: Record<string, unknown> = {
      LastName: params.lastName || 'Unknown Caller',
      Company: 'Unknown',
      Phone: params.phone,
      LeadSource: 'QVO AI Voice Agent',
    };
    if (params.firstName) body.FirstName = params.firstName;
    if (params.email) body.Email = params.email;

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
    },
  ): Promise<string> {
    const url = `${tokens.instanceUrl}/services/data/${API_VERSION}/sobjects/Task`;
    const body: Record<string, unknown> = {
      Subject: params.subject,
      Description: params.description,
      Status: 'Completed',
      Priority: 'Normal',
      TaskSubtype: params.taskSubtype,
      ActivityDate: params.activityDate ?? new Date().toISOString().slice(0, 10),
    };
    if (params.taskSubtype === 'Call') {
      body.CallType = 'Inbound';
      body.CallDurationInSeconds = params.durationSeconds;
      if (params.callSid) body.CallObject = params.callSid;
    }
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
