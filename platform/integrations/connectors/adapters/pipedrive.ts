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
        personId: toNumericId(payload.personId),
        orgId: toNumericId(payload.orgId),
        dealId: toNumericId(payload.dealId),
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
          activityId,
          provider: 'pipedrive',
        },
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
        personId: toNumericId(payload.personId),
        orgId: toNumericId(payload.orgId),
        dealId: toNumericId(payload.dealId),
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
          activityId,
          provider: 'pipedrive',
          ...(appointmentStageId ? { stageId: appointmentStageId } : {}),
          ...(dealMoved ? { dealStageMoved: true } : {}),
        },
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
