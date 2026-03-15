import { createLogger } from '../../../core/logger';
import type { ConnectorAdapter, ConnectorConfig, ConnectorPayload, ConnectorResult, CreateTicketPayload } from '../types';
import type { TenantId } from '../../../core/types';

const logger = createLogger('TICKETING_CONNECTOR');

const REQUEST_TIMEOUT_MS = 15_000;
const SUPPORTED_TYPES = new Set(['create_ticket', 'answering_service_ticket', 'after_hours_triage_ticket']);

type RawTicketPayload = Record<string, unknown>;

function normalizeTicketPayload(raw: RawTicketPayload): CreateTicketPayload {
  if (raw.type === 'create_ticket') {
    return raw as unknown as CreateTicketPayload;
  }

  const firstName = String(raw.patientFirstName ?? '');
  const lastName = String(raw.patientLastName ?? '');
  const patientFullName = [firstName, lastName].filter(Boolean).join(' ') || 'Unknown';

  if (raw.type === 'answering_service_ticket') {
    return {
      type: 'create_ticket',
      patientFullName,
      patientDob: String(raw.patientDob ?? raw.patientDOB ?? ''),
      reasonForCalling: String(raw.reasonForCall ?? raw.reasonForCalling ?? ''),
      preferredContactMethod: (raw.preferredContactMethod as 'phone' | 'sms' | 'email') ?? 'phone',
      patientPhone: String(raw.patientPhone ?? raw.callbackNumber ?? ''),
      lastProviderSeen: raw.lastProviderSeen as string | undefined,
      locationOfLastVisit: raw.locationOfLastVisit as string | undefined,
      additionalDetails: raw.additionalNotes as string | undefined,
    };
  }

  return {
    type: 'create_ticket',
    patientFullName,
    patientDob: String(raw.patientDob ?? raw.patientDOB ?? ''),
    reasonForCalling: raw.symptomDescription
      ? `${raw.symptomDescription} [Triage: ${raw.triageOutcomeLabel ?? raw.triageOutcome}]`
      : String(raw.reasonForCalling ?? ''),
    preferredContactMethod: 'phone',
    patientPhone: String(raw.callbackNumber ?? raw.patientPhone ?? ''),
    lastProviderSeen: raw.lastProviderSeen as string | undefined,
    locationOfLastVisit: raw.locationOfLastVisit as string | undefined,
    additionalDetails: raw.additionalNotes as string | undefined,
  };
}

export class TicketingConnectorAdapter implements ConnectorAdapter {
  async execute(
    tenantId: TenantId,
    config: ConnectorConfig,
    payload: ConnectorPayload,
  ): Promise<ConnectorResult> {
    if (!SUPPORTED_TYPES.has(payload.type)) {
      return { success: false, error: `Ticketing adapter does not handle payload type: ${payload.type}` };
    }

    const p = normalizeTicketPayload(payload as RawTicketPayload);
    const baseUrl = (config.credentials.base_url ?? '').replace(/\/$/, '');
    const apiKey = config.credentials.api_key ?? '';

    if (!baseUrl || !apiKey) {
      logger.error('Missing ticketing credentials', { tenantId, hasBaseUrl: !!baseUrl, hasApiKey: !!apiKey });
      return { success: false, error: 'Ticketing connector not configured: missing base_url or api_key' };
    }

    const body: Record<string, unknown> = {
      patientFullName: p.patientFullName,
      patientDOB: p.patientDob,
      reasonForCalling: p.reasonForCalling,
      preferredContactMethod: p.preferredContactMethod,
      originalPayloadType: payload.type,
    };

    if (p.patientPhone) body.patientPhone = p.patientPhone;
    if (p.patientEmail) body.patientEmail = p.patientEmail;
    if (p.lastProviderSeen) body.lastProviderSeen = p.lastProviderSeen;
    if (p.locationOfLastVisit) body.locationOfLastVisit = p.locationOfLastVisit;
    if (p.additionalDetails) body.additionalDetails = p.additionalDetails;
    if (p.idempotencyKey) body.idempotencyKey = p.idempotencyKey;

    if (p.callSid || p.callerPhone || p.agentUsed || p.callDurationSeconds) {
      body.callData = {
        callSid: p.callSid,
        callerPhone: p.callerPhone,
        agentUsed: p.agentUsed,
        callDurationSeconds: p.callDurationSeconds,
      };
    }

    const endpoint = config.credentials.endpoint ?? '/api/voice-agent/submit-ticket';
    const url = `${baseUrl}${endpoint}`;

    logger.info('Submitting ticket to external API', { tenantId, endpoint });

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': apiKey,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        logger.error('Ticketing API error', { tenantId, status: response.status, body: text.slice(0, 200) });
        return { success: false, error: `Ticketing API HTTP ${response.status}: ${text.slice(0, 100)}` };
      }

      const data = await response.json() as Record<string, unknown>;

      if (!data.success) {
        logger.error('Ticketing API returned failure', { tenantId, error: String(data.error ?? '') });
        return { success: false, error: String(data.error ?? 'Unknown ticketing error') };
      }

      const ticketNumber = data.ticketNumber as string | undefined;
      const externalId = String(data.ticketId ?? '');

      logger.info('Ticket created successfully', { tenantId, ticketNumber, externalId });
      return { success: true, ticketNumber, externalId, meta: { provider: config.provider } };
    } catch (err) {
      clearTimeout(timeoutId);
      const error = err instanceof Error ? err.message : String(err);
      logger.error('Ticketing request failed', { tenantId, error });
      return { success: false, error };
    }
  }
}
