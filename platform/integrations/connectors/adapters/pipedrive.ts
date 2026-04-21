import { createLogger } from '../../../core/logger';
import { ensureFreshOAuthToken } from '../tokenRefresh';
import type { ConnectorAdapter, ConnectorConfig, ConnectorPayload, ConnectorResult } from '../types';
import type { TenantId } from '../../../core/types';

const logger = createLogger('PIPEDRIVE_CONNECTOR');
const REQUEST_TIMEOUT_MS = 15_000;

interface PipedriveAuth {
  apiToken?: string;
  accessToken?: string;
  apiBase: string;
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
  data: Array<{ id: number; status: string; title: string }> | null;
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
        return this.handleCallCompleted(tenantId, auth, payload);
      case 'appointment.booked':
        return this.handleAppointmentBooked(tenantId, auth, payload);
      default:
        return { success: false, error: `Pipedrive adapter does not handle event: ${payload.type}` };
    }
  }

  private async handleCallCompleted(
    tenantId: TenantId,
    auth: PipedriveAuth,
    payload: ConnectorPayload,
  ): Promise<ConnectorResult> {
    const callerPhone = payload.callerPhone as string | undefined;
    const summary = (payload.summary as string | undefined) ?? 'AI voice call completed';
    const duration = (payload.durationSeconds as number | undefined) ?? 0;
    const callSid = payload.callSid as string | undefined;

    try {
      let personId: number | undefined;
      if (callerPhone) {
        personId = await this.findOrCreatePerson(auth, callerPhone, payload);
      }

      let dealId: number | undefined;
      if (personId) {
        dealId = await this.findOpenDealForPerson(auth, personId);
        if (!dealId) {
          dealId = await this.createDealForPerson(auth, personId, payload);
        }
      }

      const activityRes = await pdFetch<{ success: boolean; data: { id: number } }>(auth, '/activities', {
        method: 'POST',
        body: {
          subject: 'AI Voice Call',
          type: 'call',
          done: 1,
          duration: this.formatDuration(duration),
          note: summary + (callSid ? `\n\nCall SID: ${callSid}` : ''),
          ...(personId ? { person_id: personId } : {}),
          ...(dealId ? { deal_id: dealId } : {}),
        },
      });

      if (!activityRes.ok || !activityRes.data?.success) {
        throw new Error(activityRes.error ?? 'Pipedrive activity create failed');
      }

      const activityId = String(activityRes.data.data.id);
      logger.info('Pipedrive call activity logged', { tenantId, personId, dealId, activityId });
      return {
        success: true,
        externalId: activityId,
        meta: { personId, dealId, activityId, provider: 'pipedrive' },
      };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      logger.error('Pipedrive call logging failed', { tenantId, error });
      return { success: false, error };
    }
  }

  private async handleAppointmentBooked(
    tenantId: TenantId,
    auth: PipedriveAuth,
    payload: ConnectorPayload,
  ): Promise<ConnectorResult> {
    const callerPhone = payload.callerPhone as string | undefined;
    const summary = payload.summary as string | undefined;
    const dateStr = payload.appointmentDate as string | undefined;
    const timeStr = payload.appointmentTime as string | undefined;

    try {
      let personId: number | undefined;
      if (callerPhone) {
        personId = await this.findOrCreatePerson(auth, callerPhone, payload);
      }

      let dealId: number | undefined;
      if (personId) {
        dealId = await this.findOpenDealForPerson(auth, personId);
        if (!dealId) {
          dealId = await this.createDealForPerson(auth, personId, payload);
        }
      }

      const noteBody = [
        'Appointment booked via AI voice agent',
        summary ? `Details: ${summary}` : '',
        dateStr ? `Date: ${dateStr}` : '',
        timeStr ? `Time: ${timeStr}` : '',
      ].filter(Boolean).join('\n');

      const activityRes = await pdFetch<{ success: boolean; data: { id: number } }>(auth, '/activities', {
        method: 'POST',
        body: {
          subject: 'Appointment Booked',
          type: 'meeting',
          done: 0,
          note: noteBody,
          ...(dateStr ? { due_date: dateStr } : {}),
          ...(timeStr ? { due_time: timeStr } : {}),
          ...(personId ? { person_id: personId } : {}),
          ...(dealId ? { deal_id: dealId } : {}),
        },
      });

      if (!activityRes.ok || !activityRes.data?.success) {
        throw new Error(activityRes.error ?? 'Pipedrive activity create failed');
      }

      const activityId = String(activityRes.data.data.id);
      logger.info('Pipedrive appointment activity created', { tenantId, personId, dealId, activityId });
      return {
        success: true,
        externalId: activityId,
        meta: { personId, dealId, activityId, provider: 'pipedrive' },
      };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      logger.error('Pipedrive appointment logging failed', { tenantId, error });
      return { success: false, error };
    }
  }

  private async findOrCreatePerson(
    auth: PipedriveAuth,
    phone: string,
    payload: ConnectorPayload,
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
      },
    });

    if (!create.ok || !create.data?.success) {
      logger.warn('Pipedrive person create failed', { error: create.error });
      return undefined;
    }
    return create.data.data.id;
  }

  private async findOpenDealForPerson(auth: PipedriveAuth, personId: number): Promise<number | undefined> {
    const res = await pdFetch<PdDealsResponse>(auth, `/persons/${personId}/deals?status=open&limit=1`);
    if (res.ok && res.data?.success && res.data.data?.length) {
      return res.data.data[0].id;
    }
    return undefined;
  }

  private async createDealForPerson(
    auth: PipedriveAuth,
    personId: number,
    payload: ConnectorPayload,
  ): Promise<number | undefined> {
    const summary = (payload.summary as string | undefined) ?? '';
    const title = summary
      ? `AI Voice Call: ${summary.slice(0, 60)}`
      : 'AI Voice Call - Inbound Lead';
    const create = await pdFetch<{ success: boolean; data: { id: number } }>(auth, '/deals', {
      method: 'POST',
      body: {
        title,
        person_id: personId,
        status: 'open',
      },
    });
    if (!create.ok || !create.data?.success) {
      logger.warn('Pipedrive deal create failed', { personId, error: create.error });
      return undefined;
    }
    return create.data.data.id;
  }

  private formatDuration(seconds: number): string {
    const total = Math.max(0, Math.round(seconds));
    const mm = Math.floor(total / 60).toString().padStart(2, '0');
    const ss = (total % 60).toString().padStart(2, '0');
    return `${mm}:${ss}`;
  }
}

