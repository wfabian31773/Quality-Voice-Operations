import { createLogger } from '../../../core/logger';
import { ensureFreshOAuthToken } from '../tokenRefresh';
import type { ConnectorAdapter, ConnectorConfig, ConnectorPayload, ConnectorResult } from '../types';
import type { TenantId } from '../../../core/types';

const logger = createLogger('GCAL_CONNECTOR');
const REQUEST_TIMEOUT_MS = 15_000;
const GCAL_API = 'https://www.googleapis.com/calendar/v3';

export interface GoogleCalendarSummary {
  id: string;
  name: string;
  primary: boolean;
}

export async function fetchGoogleCalendarList(
  tenantId: TenantId,
  config: ConnectorConfig,
): Promise<GoogleCalendarSummary[]> {
  const fresh = await ensureFreshOAuthToken(config);
  const accessToken = fresh.credentials.access_token ?? '';
  if (!accessToken) {
    throw new Error('Missing Google Calendar access token — please reconnect.');
  }
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(`${GCAL_API}/users/me/calendarList?minAccessRole=writer&maxResults=250`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Google Calendar list error ${res.status}: ${text.slice(0, 200)}`);
    }
    const data = await res.json() as {
      items?: Array<{
        id: string;
        summary?: string;
        summaryOverride?: string;
        primary?: boolean;
      }>;
    };
    const items = data.items ?? [];
    logger.info('Google Calendar list fetched', { tenantId, count: items.length });
    return items.map((item) => ({
      id: item.id,
      name: item.summaryOverride ?? item.summary ?? item.id,
      primary: !!item.primary,
    }));
  } finally {
    clearTimeout(timeoutId);
  }
}

export class GoogleCalendarConnectorAdapter implements ConnectorAdapter {
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
      logger.error('Google Calendar token refresh failed', { tenantId, error });
      return { success: false, error: `Google Calendar token refresh failed: ${error}` };
    }
    const accessToken = activeConfig.credentials.access_token ?? '';
    if (!accessToken) {
      logger.error('Missing Google Calendar credentials', { tenantId });
      return {
        success: false,
        error: 'Google Calendar authentication error 401: missing access token, please reconnect',
      };
    }

    switch (payload.type) {
      case 'appointment.booked':
        return this.createEvent(tenantId, accessToken, activeConfig, payload);
      case 'check_availability':
        return this.checkAvailability(tenantId, accessToken, activeConfig, payload);
      default:
        return { success: false, error: `Google Calendar adapter does not handle event: ${payload.type}` };
    }
  }

  private async createEvent(
    tenantId: TenantId,
    accessToken: string,
    config: ConnectorConfig,
    payload: ConnectorPayload,
  ): Promise<ConnectorResult> {
    const calendarId = config.credentials.calendar_id ?? 'primary';
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
      summary,
      description: [
        description,
        callerPhone ? `Phone: ${callerPhone}` : '',
        'Booked by AI Voice Agent',
      ].filter(Boolean).join('\n'),
      start: { dateTime: start, timeZone: config.credentials.timezone ?? 'America/New_York' },
      end: { dateTime: end, timeZone: config.credentials.timezone ?? 'America/New_York' },
    };

    if (attendeeEmail) {
      eventBody.attendees = [{ email: attendeeEmail }];
    }

    try {
      const res = await fetch(`${GCAL_API}/calendars/${encodeURIComponent(calendarId)}/events`, {
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
        logger.error('Google Calendar event creation failed', { tenantId, status: res.status });
        return { success: false, error: `Google Calendar API error ${res.status}: ${text.slice(0, 200)}` };
      }

      const data = await res.json() as { id: string; htmlLink: string };
      logger.info('Google Calendar event created', { tenantId, eventId: data.id });
      return {
        success: true,
        externalId: data.id,
        meta: { eventId: data.id, htmlLink: data.htmlLink, provider: 'google-calendar' },
      };
    } catch (err) {
      clearTimeout(timeoutId);
      const error = err instanceof Error ? err.message : String(err);
      logger.error('Google Calendar request failed', { tenantId, error });
      return { success: false, error };
    }
  }

  private async checkAvailability(
    tenantId: TenantId,
    accessToken: string,
    config: ConnectorConfig,
    payload: ConnectorPayload,
  ): Promise<ConnectorResult> {
    const calendarId = config.credentials.calendar_id ?? 'primary';
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    const timeMin = (payload.timeMin as string) ?? new Date().toISOString();
    const timeMax = (payload.timeMax as string) ?? new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

    try {
      const url = new URL(`${GCAL_API}/calendars/${encodeURIComponent(calendarId)}/events`);
      url.searchParams.set('timeMin', timeMin);
      url.searchParams.set('timeMax', timeMax);
      url.searchParams.set('singleEvents', 'true');
      url.searchParams.set('orderBy', 'startTime');
      url.searchParams.set('maxResults', '50');

      const res = await fetch(url.toString(), {
        headers: { Authorization: `Bearer ${accessToken}` },
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        return { success: false, error: `Google Calendar API error ${res.status}: ${text.slice(0, 200)}` };
      }

      const data = await res.json() as {
        items: Array<{
          id: string;
          summary: string;
          start: { dateTime?: string; date?: string };
          end: { dateTime?: string; date?: string };
        }>;
      };

      const busySlots = data.items.map((item) => ({
        start: item.start.dateTime ?? item.start.date ?? '',
        end: item.end.dateTime ?? item.end.date ?? '',
        summary: item.summary,
      }));

      logger.info('Google Calendar availability checked', { tenantId, busySlots: busySlots.length });
      return {
        success: true,
        meta: { busySlots, provider: 'google-calendar' },
      };
    } catch (err) {
      clearTimeout(timeoutId);
      const error = err instanceof Error ? err.message : String(err);
      logger.error('Google Calendar availability check failed', { tenantId, error });
      return { success: false, error };
    }
  }
}
