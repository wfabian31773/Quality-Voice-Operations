import { createLogger } from '../../../core/logger';
import type { ConnectorAdapter, ConnectorConfig, ConnectorPayload, ConnectorResult } from '../types';
import type { TenantId } from '../../../core/types';

const logger = createLogger('OUTLOOK_CONNECTOR');
const REQUEST_TIMEOUT_MS = 15_000;
const GRAPH_API = 'https://graph.microsoft.com/v1.0';
const TOKEN_URL = 'https://login.microsoftonline.com/common/oauth2/v2.0/token';
const DEFAULT_SCOPES = 'https://graph.microsoft.com/Calendars.ReadWrite offline_access';

export class OutlookCalendarConnectorAdapter implements ConnectorAdapter {
  async execute(
    tenantId: TenantId,
    config: ConnectorConfig,
    payload: ConnectorPayload,
  ): Promise<ConnectorResult> {
    const accessToken = await this.getAccessToken(config);
    if (!accessToken) {
      logger.error('Missing Outlook Calendar credentials', { tenantId });
      return { success: false, error: 'Outlook Calendar connector not configured: missing credentials' };
    }

    switch (payload.type) {
      case 'appointment.booked':
        return this.createEvent(tenantId, accessToken, config, payload);
      case 'check_availability':
        return this.checkAvailability(tenantId, accessToken, config, payload);
      default:
        return { success: false, error: `Outlook Calendar adapter does not handle event: ${payload.type}` };
    }
  }

  private async getAccessToken(config: ConnectorConfig): Promise<string | null> {
    const expiresAtStr = config.credentials.token_expires_at;
    const expiresAt = expiresAtStr ? Number(expiresAtStr) : 0;
    const stillFresh = expiresAt && Date.now() < expiresAt - 60_000;

    if (config.credentials.access_token && stillFresh) {
      return config.credentials.access_token;
    }

    const refreshToken = config.credentials.refresh_token;
    const clientId = config.credentials.client_id ?? process.env.MICROSOFT_CLIENT_ID ?? '';
    const clientSecret = config.credentials.client_secret ?? process.env.MICROSOFT_CLIENT_SECRET ?? '';

    if (!refreshToken || !clientId || !clientSecret) {
      return config.credentials.access_token || null;
    }

    try {
      const res = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
          client_id: clientId,
          client_secret: clientSecret,
          scope: DEFAULT_SCOPES,
        }).toString(),
      });

      if (!res.ok) {
        logger.warn('Outlook token refresh failed', { status: res.status });
        return config.credentials.access_token || null;
      }
      const data = await res.json() as { access_token: string };
      return data.access_token;
    } catch (err) {
      logger.warn('Outlook token refresh error', { error: String(err) });
      return config.credentials.access_token || null;
    }
  }

  private async createEvent(
    tenantId: TenantId,
    accessToken: string,
    config: ConnectorConfig,
    payload: ConnectorPayload,
  ): Promise<ConnectorResult> {
    const calendarId = config.credentials.calendar_id;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    const summary = (payload.summary as string) ?? 'Appointment (AI Booked)';
    const description = (payload.description as string) ?? '';
    const startTime = payload.startTime as string | undefined;
    const endTime = payload.endTime as string | undefined;
    const appointmentDate = payload.appointmentDate as string | undefined;
    const appointmentTime = payload.appointmentTime as string | undefined;
    const durationMinutes = (payload.durationMinutes as number) ?? 30;
    const attendeeEmail = payload.attendeeEmail as string | undefined;
    const callerPhone = payload.callerPhone as string | undefined;
    const timeZone = config.credentials.timezone ?? 'America/New_York';

    let start: string;
    let end: string;

    if (startTime && endTime) {
      start = startTime;
      end = endTime;
    } else if (appointmentDate && appointmentTime) {
      const dateStr = `${appointmentDate}T${appointmentTime}`;
      const startDate = new Date(dateStr);
      const endDate = new Date(startDate.getTime() + durationMinutes * 60 * 1000);
      start = startDate.toISOString();
      end = endDate.toISOString();
    } else {
      const startDate = new Date(Date.now() + 24 * 60 * 60 * 1000);
      start = startDate.toISOString();
      end = new Date(startDate.getTime() + durationMinutes * 60 * 1000).toISOString();
    }

    const eventBody: Record<string, unknown> = {
      subject: summary,
      body: {
        contentType: 'Text',
        content: [
          description,
          callerPhone ? `Phone: ${callerPhone}` : '',
          'Booked by AI Voice Agent',
        ].filter(Boolean).join('\n'),
      },
      start: { dateTime: start, timeZone },
      end: { dateTime: end, timeZone },
    };

    if (attendeeEmail) {
      eventBody.attendees = [
        { emailAddress: { address: attendeeEmail }, type: 'required' },
      ];
    }

    const url = calendarId
      ? `${GRAPH_API}/me/calendars/${encodeURIComponent(calendarId)}/events`
      : `${GRAPH_API}/me/events`;

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(eventBody),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        logger.error('Outlook Calendar event creation failed', { tenantId, status: res.status });
        return { success: false, error: `Microsoft Graph API error ${res.status}: ${text.slice(0, 200)}` };
      }

      const data = await res.json() as { id: string; webLink?: string };
      logger.info('Outlook Calendar event created', { tenantId, eventId: data.id });
      return {
        success: true,
        externalId: data.id,
        meta: { eventId: data.id, htmlLink: data.webLink, provider: 'outlook-calendar' },
      };
    } catch (err) {
      clearTimeout(timeoutId);
      const error = err instanceof Error ? err.message : String(err);
      logger.error('Outlook Calendar request failed', { tenantId, error });
      return { success: false, error };
    }
  }

  private async checkAvailability(
    tenantId: TenantId,
    accessToken: string,
    config: ConnectorConfig,
    payload: ConnectorPayload,
  ): Promise<ConnectorResult> {
    const calendarId = config.credentials.calendar_id;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    const timeMin = (payload.timeMin as string) ?? new Date().toISOString();
    const timeMax = (payload.timeMax as string) ?? new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    const timeZone = config.credentials.timezone ?? 'America/New_York';

    try {
      const base = calendarId
        ? `${GRAPH_API}/me/calendars/${encodeURIComponent(calendarId)}/calendarView`
        : `${GRAPH_API}/me/calendarView`;
      const url = new URL(base);
      url.searchParams.set('startDateTime', timeMin);
      url.searchParams.set('endDateTime', timeMax);
      url.searchParams.set('$select', 'id,subject,start,end');
      url.searchParams.set('$top', '50');
      url.searchParams.set('$orderby', 'start/dateTime');

      const res = await fetch(url.toString(), {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Prefer: `outlook.timezone="${timeZone}"`,
        },
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        return { success: false, error: `Microsoft Graph API error ${res.status}: ${text.slice(0, 200)}` };
      }

      const data = await res.json() as {
        value: Array<{
          id: string;
          subject: string;
          start: { dateTime: string; timeZone: string };
          end: { dateTime: string; timeZone: string };
        }>;
      };

      const busySlots = (data.value ?? []).map((item) => ({
        start: item.start?.dateTime ?? '',
        end: item.end?.dateTime ?? '',
        summary: item.subject,
      }));

      logger.info('Outlook Calendar availability checked', { tenantId, busySlots: busySlots.length });
      return {
        success: true,
        meta: { busySlots, provider: 'outlook-calendar' },
      };
    } catch (err) {
      clearTimeout(timeoutId);
      const error = err instanceof Error ? err.message : String(err);
      logger.error('Outlook Calendar availability check failed', { tenantId, error });
      return { success: false, error };
    }
  }
}
