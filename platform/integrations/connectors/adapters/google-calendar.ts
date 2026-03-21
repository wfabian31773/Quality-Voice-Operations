import { createLogger } from '../../../core/logger';
import type { ConnectorAdapter, ConnectorConfig, ConnectorPayload, ConnectorResult } from '../types';
import type { TenantId } from '../../../core/types';

const logger = createLogger('GCAL_CONNECTOR');
const REQUEST_TIMEOUT_MS = 15_000;
const GCAL_API = 'https://www.googleapis.com/calendar/v3';

export class GoogleCalendarConnectorAdapter implements ConnectorAdapter {
  async execute(
    tenantId: TenantId,
    config: ConnectorConfig,
    payload: ConnectorPayload,
  ): Promise<ConnectorResult> {
    const accessToken = await this.getAccessToken(config);
    if (!accessToken) {
      logger.error('Missing Google Calendar credentials', { tenantId });
      return { success: false, error: 'Google Calendar connector not configured: missing credentials' };
    }

    switch (payload.type) {
      case 'appointment.booked':
        return this.createEvent(tenantId, accessToken, config, payload);
      case 'check_availability':
        return this.checkAvailability(tenantId, accessToken, config, payload);
      default:
        return { success: false, error: `Google Calendar adapter does not handle event: ${payload.type}` };
    }
  }

  private async getAccessToken(config: ConnectorConfig): Promise<string | null> {
    if (config.credentials.access_token) {
      return config.credentials.access_token;
    }

    const refreshToken = config.credentials.refresh_token;
    const clientId = config.credentials.client_id;
    const clientSecret = config.credentials.client_secret;

    if (!refreshToken || !clientId || !clientSecret) {
      return null;
    }

    try {
      const res = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
          client_id: clientId,
          client_secret: clientSecret,
        }).toString(),
      });

      if (!res.ok) return null;
      const data = await res.json() as { access_token: string };
      return data.access_token;
    } catch {
      return null;
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
