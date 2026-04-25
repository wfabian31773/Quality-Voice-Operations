import { createLogger } from '../../../core/logger';
import { ensureFreshOAuthToken } from '../tokenRefresh';
import { parseDispositionMap, mapDisposition } from '../dispositionMap';
import { resolveZohoApiDomain } from '../zohoRegion';
import type { ConnectorAdapter, ConnectorConfig, ConnectorPayload, ConnectorResult } from '../types';
import type { TenantId } from '../../../core/types';

const logger = createLogger('ZOHO_CONNECTOR');
const REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_API_DOMAIN = 'https://www.zohoapis.com';

interface ZohoAuth {
  accessToken: string;
  apiBase: string;
}

interface DealRefs {
  contactId?: string;
  accountId?: string;
  dealId?: string;
}

type ResolveAuthOutcome =
  | { ok: true; auth: ZohoAuth }
  | { ok: false; error: string };

function resolveAuth(config: ConnectorConfig): ResolveAuthOutcome {
  const accessToken = config.credentials.access_token ?? '';
  if (!accessToken) {
    return { ok: false, error: 'Zoho connector not configured: missing access_token' };
  }
  // Validate `api_domain` against Zoho's published API host allowlist before
  // using it as a fetch base — every CRM call carries an
  // `Authorization: Zoho-oauthtoken …` header, so a tampered or
  // tenant-edited domain pointing at an attacker-controlled or internal
  // host would be a direct SSRF + token-exfiltration primitive.
  const storedApiDomain = config.credentials.api_domain;
  const validatedApiDomain = resolveZohoApiDomain(storedApiDomain);
  if (storedApiDomain && !validatedApiDomain) {
    return {
      ok: false,
      error: `Zoho connector refusing to dispatch: stored api_domain "${storedApiDomain}" is not a recognized Zoho API host. Reconnect via OAuth.`,
    };
  }
  const apiDomain = validatedApiDomain ?? DEFAULT_API_DOMAIN;
  return { ok: true, auth: { accessToken, apiBase: `${apiDomain}/crm/v2` } };
}

function authHeaders(auth: ZohoAuth): Record<string, string> {
  return {
    Authorization: `Zoho-oauthtoken ${auth.accessToken}`,
    'Content-Type': 'application/json',
  };
}

interface ZohoFetchResult<T> {
  ok: boolean;
  status: number;
  data?: T;
  error?: string;
}

async function zohoFetch<T = unknown>(
  auth: ZohoAuth,
  path: string,
  init?: { method?: string; body?: unknown },
): Promise<ZohoFetchResult<T>> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const url = `${auth.apiBase}${path}`;
    const res = await fetch(url, {
      method: init?.method ?? 'GET',
      headers: authHeaders(auth),
      body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
      signal: controller.signal,
    });
    // Zoho returns 204 (no records) for empty searches; treat as ok with empty data.
    if (res.status === 204) {
      return { ok: true, status: 204, data: { data: [] } as unknown as T };
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return { ok: false, status: res.status, error: `Zoho ${res.status}: ${text.slice(0, 200)}` };
    }
    const data = (await res.json()) as T;
    return { ok: true, status: res.status, data };
  } catch (err) {
    return { ok: false, status: 0, error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timeoutId);
  }
}

interface ZohoSearchResponse {
  data?: Array<{ id: string }>;
}

interface ZohoWriteResponse {
  data?: Array<{
    code?: string;
    status?: string;
    message?: string;
    details?: { id?: string };
  }>;
}

function extractWrittenId(res: ZohoFetchResult<ZohoWriteResponse>): string | undefined {
  if (!res.ok || !res.data?.data?.length) return undefined;
  const entry = res.data.data[0];
  if (entry.status && entry.status !== 'success') return undefined;
  return entry.details?.id;
}

function escapeCriteria(value: string): string {
  // Zoho's search criteria DSL needs parentheses and commas escaped; backslashes
  // are the standard escape character.
  return value.replace(/[\\()]/g, (m) => `\\${m}`);
}

export class ZohoConnectorAdapter implements ConnectorAdapter {
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
      logger.error('Zoho token refresh failed', { tenantId, error });
      return { success: false, error: `Zoho token refresh failed: ${error}` };
    }
    const authResult = resolveAuth(activeConfig);
    if (!authResult.ok) {
      logger.error(authResult.error, { tenantId });
      return { success: false, error: authResult.error };
    }
    const auth = authResult.auth;

    switch (payload.type) {
      case 'call.completed':
        return this.handleCallCompleted(tenantId, auth, payload, activeConfig);
      case 'appointment.booked':
        return this.handleAppointmentBooked(tenantId, auth, payload, activeConfig);
      default:
        return { success: false, error: `Zoho adapter does not handle event: ${payload.type}` };
    }
  }

  private async handleCallCompleted(
    tenantId: TenantId,
    auth: ZohoAuth,
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
      const customMap = parseDispositionMap(config.credentials, 'zoho');
      const dispositionFields = mapDisposition('zoho', disposition, customMap);

      const refs: DealRefs = {
        contactId: payload.contactId as string | undefined,
        accountId: payload.accountId as string | undefined,
        dealId: payload.dealId as string | undefined,
      };

      if (!refs.accountId && callerCompany) {
        refs.accountId = await this.findOrCreateAccount(auth, callerCompany);
      }

      if (!refs.contactId && callerPhone) {
        refs.contactId = await this.findOrCreateContact(auth, callerPhone, payload, refs.accountId);
      }

      const callBody: Record<string, unknown> = {
        Subject: dispositionFields.callDisposition || 'AI Voice Call',
        Call_Type: 'Inbound',
        Call_Start_Time: new Date().toISOString(),
        Call_Duration: this.formatDuration(duration),
        Call_Duration_in_seconds: Math.max(0, Math.round(duration)),
        Call_Status: dispositionFields.status || 'Completed',
        Description: summary + (callSid ? `\n\nCall SID: ${callSid}` : ''),
      };
      if (dispositionFields.callDisposition) {
        callBody.Call_Purpose = dispositionFields.callDisposition;
      }
      if (callerPhone) callBody.Caller_ID = callerPhone;
      if (refs.contactId) {
        callBody.Who_Id = { id: refs.contactId };
        callBody.$se_module = 'Contacts';
      }
      if (refs.dealId) {
        callBody.What_Id = { id: refs.dealId };
        callBody.$se_module = 'Deals';
      } else if (refs.accountId) {
        callBody.What_Id = { id: refs.accountId };
        callBody.$se_module = 'Accounts';
      }

      const callRes = await zohoFetch<ZohoWriteResponse>(auth, '/Calls', {
        method: 'POST',
        body: { data: [callBody] },
      });
      const callId = extractWrittenId(callRes);
      if (!callId) {
        throw new Error(callRes.error ?? 'Zoho Call create failed');
      }

      logger.info('Zoho call logged', {
        tenantId,
        contactId: refs.contactId,
        accountId: refs.accountId,
        dealId: refs.dealId,
        callId,
      });
      return {
        success: true,
        externalId: callId,
        meta: {
          contactId: refs.contactId,
          accountId: refs.accountId,
          dealId: refs.dealId,
          callId,
          activityId: callId,
          provider: 'zoho',
        },
      };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      logger.error('Zoho call logging failed', { tenantId, error });
      return { success: false, error };
    }
  }

  private async handleAppointmentBooked(
    tenantId: TenantId,
    auth: ZohoAuth,
    payload: ConnectorPayload,
    config: ConnectorConfig,
  ): Promise<ConnectorResult> {
    const callerPhone = payload.callerPhone as string | undefined;
    const callerCompany = payload.callerCompany as string | undefined;
    const summary = payload.summary as string | undefined;
    const dateStr = payload.appointmentDate as string | undefined;
    const timeStr = payload.appointmentTime as string | undefined;
    const appointmentStageName = (payload.appointmentStageId as string | undefined)
      ?? config.credentials.appointment_stage_id
      ?? undefined;
    const pipelineLayoutId = (payload.pipelineId as string | undefined)
      ?? config.credentials.appointment_pipeline_id
      ?? undefined;

    try {
      // Validate disposition map up-front so a bad config surfaces in the
      // connector activity log even when this code path doesn't read call
      // disposition fields.
      parseDispositionMap(config.credentials, 'zoho');

      const refs: DealRefs = {
        contactId: payload.contactId as string | undefined,
        accountId: payload.accountId as string | undefined,
        dealId: payload.dealId as string | undefined,
      };

      // Resolve account first so the new Contact can be linked at create time.
      if (!refs.accountId && callerCompany) {
        refs.accountId = await this.findOrCreateAccount(auth, callerCompany);
      }

      if (!refs.contactId && callerPhone) {
        refs.contactId = await this.findOrCreateContact(auth, callerPhone, payload, refs.accountId);
      }

      // Auto-promote: ensure a Deal exists tied to the Contact (and Account
      // when present) so the booked appointment is reflected in pipeline
      // reporting end-to-end.
      let dealMoved = false;
      if (refs.contactId) {
        if (!refs.dealId) {
          refs.dealId = await this.findOpenDealForContact(auth, refs.contactId);
        }
        if (!refs.dealId) {
          refs.dealId = await this.createDealForContact(
            auth,
            refs.contactId,
            payload,
            refs.accountId,
            appointmentStageName,
            pipelineLayoutId,
          );
        } else if (appointmentStageName) {
          dealMoved = await this.moveDealStage(
            auth,
            refs.dealId,
            appointmentStageName,
            refs.accountId,
            pipelineLayoutId,
          );
        } else if (refs.accountId) {
          await this.ensureDealAccount(auth, refs.dealId, refs.accountId);
        }
      }

      const noteBody = [
        'Appointment booked via AI voice agent',
        summary ? `Details: ${summary}` : '',
        dateStr ? `Date: ${dateStr}` : '',
        timeStr ? `Time: ${timeStr}` : '',
        refs.dealId ? `Deal ID: ${refs.dealId}` : '',
      ].filter(Boolean).join('\n');

      const noteParent = refs.dealId
        ? { id: refs.dealId, module: 'Deals' as const }
        : refs.contactId
          ? { id: refs.contactId, module: 'Contacts' as const }
          : refs.accountId
            ? { id: refs.accountId, module: 'Accounts' as const }
            : null;

      let noteId: string | undefined;
      if (noteParent) {
        const noteRes = await zohoFetch<ZohoWriteResponse>(auth, '/Notes', {
          method: 'POST',
          body: {
            data: [{
              Note_Title: 'Appointment Booked',
              Note_Content: noteBody,
              Parent_Id: { id: noteParent.id },
              se_module: noteParent.module,
            }],
          },
        });
        noteId = extractWrittenId(noteRes);
        if (!noteId) {
          throw new Error(noteRes.error ?? 'Zoho Note create failed');
        }
      } else {
        // No record to attach the note to — log the booking as a stand-alone
        // Task instead so the activity is still discoverable in Zoho.
        const taskRes = await zohoFetch<ZohoWriteResponse>(auth, '/Tasks', {
          method: 'POST',
          body: {
            data: [{
              Subject: 'Appointment Booked',
              Status: 'Completed',
              Description: noteBody,
              ...(dateStr ? { Due_Date: dateStr } : {}),
            }],
          },
        });
        noteId = extractWrittenId(taskRes);
        if (!noteId) {
          throw new Error(taskRes.error ?? 'Zoho Task create failed');
        }
      }

      logger.info('Zoho appointment processed', {
        tenantId,
        contactId: refs.contactId,
        accountId: refs.accountId,
        dealId: refs.dealId,
        noteId,
        appointmentStageName,
        pipelineLayoutId,
        dealMoved,
      });
      return {
        success: true,
        externalId: noteId,
        meta: {
          contactId: refs.contactId,
          accountId: refs.accountId,
          dealId: refs.dealId,
          noteId,
          activityId: noteId,
          provider: 'zoho',
          ...(pipelineLayoutId ? { pipelineId: pipelineLayoutId } : {}),
          ...(appointmentStageName ? { stageId: appointmentStageName } : {}),
          ...(dealMoved ? { dealStageMoved: true } : {}),
        },
      };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      logger.error('Zoho appointment logging failed', { tenantId, error });
      return { success: false, error };
    }
  }

  private async findOrCreateContact(
    auth: ZohoAuth,
    phone: string,
    payload: ConnectorPayload,
    accountId?: string,
  ): Promise<string | undefined> {
    const search = await zohoFetch<ZohoSearchResponse>(
      auth,
      `/Contacts/search?phone=${encodeURIComponent(phone)}`,
    );
    if (search.ok && search.data?.data?.length) {
      return search.data.data[0].id;
    }

    const firstName = (payload.callerFirstName as string) ?? '';
    const lastName = (payload.callerLastName as string) ?? '';
    const email = (payload.callerEmail as string) ?? '';
    const last = lastName.trim() || firstName.trim() || `Caller ${phone}`;

    const body: Record<string, unknown> = {
      Last_Name: last,
      Phone: phone,
    };
    if (firstName && lastName) body.First_Name = firstName;
    if (email) body.Email = email;
    if (accountId) body.Account_Name = { id: accountId };

    const create = await zohoFetch<ZohoWriteResponse>(auth, '/Contacts', {
      method: 'POST',
      body: { data: [body] },
    });
    const id = extractWrittenId(create);
    if (!id) {
      logger.warn('Zoho contact create failed', { error: create.error });
      return undefined;
    }
    return id;
  }

  private async findOrCreateAccount(
    auth: ZohoAuth,
    name: string,
  ): Promise<string | undefined> {
    const trimmed = name.trim();
    if (!trimmed || trimmed.toLowerCase() === 'unknown') return undefined;

    const criteria = `(Account_Name:equals:${escapeCriteria(trimmed)})`;
    const search = await zohoFetch<ZohoSearchResponse>(
      auth,
      `/Accounts/search?criteria=${encodeURIComponent(criteria)}`,
    );
    if (search.ok && search.data?.data?.length) {
      return search.data.data[0].id;
    }

    const create = await zohoFetch<ZohoWriteResponse>(auth, '/Accounts', {
      method: 'POST',
      body: { data: [{ Account_Name: trimmed }] },
    });
    const id = extractWrittenId(create);
    if (!id) {
      logger.warn('Zoho account create failed', { error: create.error });
      return undefined;
    }
    return id;
  }

  private async findOpenDealForContact(
    auth: ZohoAuth,
    contactId: string,
  ): Promise<string | undefined> {
    const res = await zohoFetch<{
      data?: Array<{ id: string; Stage?: string }>;
    }>(auth, `/Contacts/${encodeURIComponent(contactId)}/Deals?per_page=10`);
    if (!res.ok || !res.data?.data?.length) return undefined;
    const open = res.data.data.find((d) => {
      const stage = (d.Stage ?? '').toLowerCase();
      return stage !== 'closed won' && stage !== 'closed lost';
    });
    return (open ?? res.data.data[0]).id;
  }

  private async createDealForContact(
    auth: ZohoAuth,
    contactId: string,
    payload: ConnectorPayload,
    accountId?: string,
    stageName?: string,
    layoutId?: string,
  ): Promise<string | undefined> {
    const summary = (payload.summary as string | undefined) ?? '';
    const company = (payload.callerCompany as string | undefined) ?? '';
    const titleSeed = company || summary.slice(0, 60) || 'Inbound Lead';
    const dealName = payload.type === 'appointment.booked'
      ? `${titleSeed} - QVO Appointment`
      : `AI Voice Call: ${titleSeed}`;
    const closingDate = (payload.appointmentDate as string | undefined)
      ?? new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

    const body: Record<string, unknown> = {
      Deal_Name: dealName.slice(0, 250),
      Stage: stageName || 'Qualification',
      Closing_Date: closingDate,
      Contact_Name: { id: contactId },
    };
    if (accountId) body.Account_Name = { id: accountId };
    if (layoutId) body.Layout = { id: layoutId };

    const create = await zohoFetch<ZohoWriteResponse>(auth, '/Deals', {
      method: 'POST',
      body: { data: [body] },
    });
    const id = extractWrittenId(create);
    if (!id) {
      logger.warn('Zoho deal create failed', { contactId, error: create.error });
      return undefined;
    }
    return id;
  }

  private async moveDealStage(
    auth: ZohoAuth,
    dealId: string,
    stageName: string,
    accountId?: string,
    layoutId?: string,
  ): Promise<boolean> {
    const body: Record<string, unknown> = {
      id: dealId,
      Stage: stageName,
    };
    if (accountId) body.Account_Name = { id: accountId };
    if (layoutId) body.Layout = { id: layoutId };

    const update = await zohoFetch<ZohoWriteResponse>(auth, '/Deals', {
      method: 'PUT',
      body: { data: [body] },
    });
    if (!update.ok || !update.data?.data?.length || update.data.data[0].status !== 'success') {
      logger.warn('Zoho deal stage move failed', { dealId, stageName, error: update.error });
      return false;
    }
    return true;
  }

  private async ensureDealAccount(
    auth: ZohoAuth,
    dealId: string,
    accountId: string,
  ): Promise<void> {
    const update = await zohoFetch<ZohoWriteResponse>(auth, '/Deals', {
      method: 'PUT',
      body: {
        data: [{
          id: dealId,
          Account_Name: { id: accountId },
        }],
      },
    });
    if (!update.ok || !update.data?.data?.length || update.data.data[0].status !== 'success') {
      logger.warn('Zoho deal account link failed', { dealId, accountId, error: update.error });
    }
  }

  private formatDuration(seconds: number): string {
    const total = Math.max(0, Math.round(seconds));
    const mm = Math.floor(total / 60).toString().padStart(2, '0');
    const ss = (total % 60).toString().padStart(2, '0');
    return `${mm}:${ss}`;
  }
}
