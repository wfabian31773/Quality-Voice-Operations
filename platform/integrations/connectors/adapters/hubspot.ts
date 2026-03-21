import { createLogger } from '../../../core/logger';
import type { ConnectorAdapter, ConnectorConfig, ConnectorPayload, ConnectorResult } from '../types';
import type { TenantId } from '../../../core/types';

const logger = createLogger('HUBSPOT_CONNECTOR');
const REQUEST_TIMEOUT_MS = 15_000;
const HUBSPOT_API = 'https://api.hubapi.com';

export class HubSpotConnectorAdapter implements ConnectorAdapter {
  async execute(
    tenantId: TenantId,
    config: ConnectorConfig,
    payload: ConnectorPayload,
  ): Promise<ConnectorResult> {
    const accessToken = config.credentials.access_token ?? '';
    if (!accessToken) {
      logger.error('Missing HubSpot access token', { tenantId });
      return { success: false, error: 'HubSpot connector not configured: missing access_token' };
    }

    switch (payload.type) {
      case 'call.completed':
        return this.handleCallCompleted(tenantId, accessToken, payload);
      case 'appointment.booked':
        return this.handleAppointmentBooked(tenantId, accessToken, payload);
      default:
        return { success: false, error: `HubSpot adapter does not handle event: ${payload.type}` };
    }
  }

  private async handleCallCompleted(
    tenantId: TenantId,
    accessToken: string,
    payload: ConnectorPayload,
  ): Promise<ConnectorResult> {
    const callerPhone = payload.callerPhone as string | undefined;
    const summary = payload.summary as string | undefined;
    const duration = payload.durationSeconds as number | undefined;
    const callSid = payload.callSid as string | undefined;

    try {
      let contactId: string | undefined;
      if (callerPhone) {
        contactId = await this.findOrCreateContact(accessToken, callerPhone, payload);
      }

      const engagementResult = await this.logCallEngagement(accessToken, {
        contactId,
        summary: summary ?? 'AI voice call completed',
        durationMs: (duration ?? 0) * 1000,
        callSid,
        callerPhone,
      });

      logger.info('HubSpot call logged', { tenantId, contactId, engagementId: engagementResult });
      return {
        success: true,
        externalId: engagementResult,
        meta: { contactId, engagementId: engagementResult, provider: 'hubspot' },
      };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      logger.error('HubSpot call logging failed', { tenantId, error });
      return { success: false, error };
    }
  }

  private async handleAppointmentBooked(
    tenantId: TenantId,
    accessToken: string,
    payload: ConnectorPayload,
  ): Promise<ConnectorResult> {
    const callerPhone = payload.callerPhone as string | undefined;
    const summary = payload.summary as string | undefined;

    try {
      let contactId: string | undefined;
      if (callerPhone) {
        contactId = await this.findOrCreateContact(accessToken, callerPhone, payload);
      }

      const note = [
        'Appointment Booked via AI Agent',
        summary ? `Details: ${summary}` : '',
        payload.appointmentDate ? `Date: ${payload.appointmentDate}` : '',
        payload.appointmentTime ? `Time: ${payload.appointmentTime}` : '',
      ].filter(Boolean).join('\n');

      const engagementId = await this.createNote(accessToken, contactId, note);

      logger.info('HubSpot appointment note created', { tenantId, contactId, engagementId });
      return {
        success: true,
        externalId: engagementId,
        meta: { contactId, engagementId, provider: 'hubspot' },
      };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      logger.error('HubSpot appointment logging failed', { tenantId, error });
      return { success: false, error };
    }
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

  private async logCallEngagement(
    accessToken: string,
    params: {
      contactId?: string;
      summary: string;
      durationMs: number;
      callSid?: string;
      callerPhone?: string;
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
          hs_call_status: 'COMPLETED',
          hs_call_direction: 'INBOUND',
          ...(params.callerPhone && { hs_call_from_number: params.callerPhone }),
          ...(params.callSid && { hs_call_external_id: params.callSid }),
        },
        ...(params.contactId && {
          associations: [{
            to: { id: params.contactId },
            types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 194 }],
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
    body: string,
  ): Promise<string> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const payload: Record<string, unknown> = {
        properties: {
          hs_note_body: body,
          hs_timestamp: new Date().toISOString(),
        },
        ...(contactId && {
          associations: [{
            to: { id: contactId },
            types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 202 }],
          }],
        }),
      };

      const res = await fetch(`${HUBSPOT_API}/crm/v3/objects/notes`, {
        method: 'POST',
        headers: this.headers(accessToken),
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      if (!res.ok) {
        const text = await res.text().catch(() => '');
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
