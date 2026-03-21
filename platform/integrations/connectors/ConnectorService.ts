import { createLogger } from '../../core/logger';
import { getConnectorConfig, updateConnectorSyncStatus } from './db';
import { TicketingConnectorAdapter } from './adapters/ticketing';
import { TwilioSmsConnectorAdapter } from './adapters/sms';
import { HubSpotConnectorAdapter } from './adapters/hubspot';
import { GoogleCalendarConnectorAdapter } from './adapters/google-calendar';
import { SlackConnectorAdapter } from './adapters/slack';
import { ZapierWebhookConnectorAdapter } from './adapters/zapier';
import { recordIntegrationEvent } from '../../core/observability/traceLogger';
import type { ConnectorAdapter, ConnectorPayload, ConnectorResult, ConnectorType, StandardEventType } from './types';
import type { TenantId } from '../../core/types';

const logger = createLogger('CONNECTOR_SERVICE');

const ADAPTER_REGISTRY: Record<string, ConnectorAdapter> = {
  ticketing: new TicketingConnectorAdapter(),
  sms: new TwilioSmsConnectorAdapter(),
  crm: new HubSpotConnectorAdapter(),
  scheduling: new GoogleCalendarConnectorAdapter(),
  webhook: new ZapierWebhookConnectorAdapter(),
  custom: new SlackConnectorAdapter(),
};

const STANDARD_EVENT_TYPES = new Set<string>([
  'call.completed',
  'appointment.booked',
  'sms.sent',
  'ticket.created',
  'call.missed',
]);

const EVENT_TO_CONNECTOR_TYPES: Record<string, ConnectorType[]> = {
  'call.completed': ['crm', 'custom', 'webhook'],
  'appointment.booked': ['crm', 'scheduling', 'custom', 'webhook'],
  'sms.sent': ['custom', 'webhook'],
  'ticket.created': ['custom', 'webhook'],
  'call.missed': ['custom', 'webhook'],
};

function inferConnectorType(payload: ConnectorPayload): ConnectorType | null {
  switch (payload.type) {
    case 'create_ticket':
    case 'answering_service_ticket':
    case 'after_hours_triage_ticket':
      return 'ticketing';
    case 'send_sms':
    case 'escalation_notification':
      return 'sms';
    default:
      return null;
  }
}

export class ConnectorService {
  async execute(
    tenantId: TenantId,
    connectorType: ConnectorType,
    payload: ConnectorPayload,
  ): Promise<ConnectorResult> {
    const adapter = ADAPTER_REGISTRY[connectorType];
    if (!adapter) {
      return { success: false, error: `No adapter registered for connector type: ${connectorType}` };
    }

    const config = await getConnectorConfig(tenantId, connectorType);
    if (!config) {
      logger.warn('No connector configured for type', { tenantId, connectorType });
      return {
        success: false,
        error: `No ${connectorType} connector configured for this tenant`,
      };
    }

    if (!config.isEnabled) {
      return { success: false, error: `${connectorType} connector is disabled for this tenant` };
    }

    logger.info('Dispatching to connector', { tenantId, connectorType, provider: config.provider, payloadType: payload.type });

    const startTime = Date.now();
    const result = await adapter.execute(tenantId, config, payload);
    const latencyMs = Date.now() - startTime;

    const callSessionId = (payload as Record<string, unknown>).callSessionId as string | undefined;
    const toolInvocationId = (payload as Record<string, unknown>).toolInvocationId as string | undefined;

    recordIntegrationEvent({
      tenantId,
      callSessionId,
      toolInvocationId,
      requestMethod: 'POST',
      requestUrl: `connector://${connectorType}/${config.provider}`,
      requestBody: { type: payload.type },
      responseStatus: result.success ? 200 : 500,
      responseBody: { success: result.success, error: result.error ?? null },
      latencyMs,
      errorMessage: result.error ?? undefined,
      serviceName: `${connectorType}:${config.provider}`,
    }).catch(() => {});

    updateConnectorSyncStatus(tenantId, connectorType, result.success ? 'success' : 'error').catch(() => {});

    if (!result.success && config.fallbackConnectorType) {
      logger.info('Primary connector failed, attempting fallback', {
        tenantId,
        primaryType: connectorType,
        fallbackType: config.fallbackConnectorType,
        payloadType: payload.type,
      });
      return this.executeFallback(tenantId, config.fallbackConnectorType, payload);
    }

    return result;
  }

  private async executeFallback(
    tenantId: TenantId,
    fallbackType: ConnectorType,
    payload: ConnectorPayload,
  ): Promise<ConnectorResult> {
    const adapter = ADAPTER_REGISTRY[fallbackType];
    if (!adapter) {
      return { success: false, error: `No fallback adapter for connector type: ${fallbackType}` };
    }

    const config = await getConnectorConfig(tenantId, fallbackType);
    if (!config || !config.isEnabled) {
      return { success: false, error: `Fallback connector ${fallbackType} not available` };
    }

    logger.info('Executing fallback connector', { tenantId, fallbackType, provider: config.provider });
    const startTime = Date.now();
    const result = await adapter.execute(tenantId, config, payload);
    const latencyMs = Date.now() - startTime;

    const callSessionId = (payload as Record<string, unknown>).callSessionId as string | undefined;
    const toolInvocationId = (payload as Record<string, unknown>).toolInvocationId as string | undefined;

    recordIntegrationEvent({
      tenantId,
      callSessionId,
      toolInvocationId,
      requestMethod: 'POST',
      requestUrl: `connector://${fallbackType}/${config.provider}`,
      requestBody: { type: payload.type },
      responseStatus: result.success ? 200 : 500,
      responseBody: { success: result.success, error: result.error ?? null },
      latencyMs,
      errorMessage: result.error ?? undefined,
      serviceName: `${fallbackType}:${config.provider}`,
    }).catch(() => {});

    return { ...result, meta: { ...result.meta, usedFallback: true } };
  }

  async executeByPayload(
    tenantId: TenantId,
    payload: ConnectorPayload,
  ): Promise<ConnectorResult> {
    const connectorType = inferConnectorType(payload);
    if (!connectorType) {
      logger.warn('Cannot infer connector type from payload', { tenantId, payloadType: payload.type });
      return { success: false, error: `Cannot route payload type: ${payload.type}` };
    }
    return this.execute(tenantId, connectorType, payload);
  }

  async dispatchEvent(
    tenantId: TenantId,
    eventType: StandardEventType,
    payload: ConnectorPayload,
  ): Promise<{ dispatched: number; results: Array<{ connectorType: string; provider: string; success: boolean; error?: string }> }> {
    const eventPayload = { ...payload, type: eventType };
    const results: Array<{ connectorType: string; provider: string; success: boolean; error?: string }> = [];

    const targetTypes = EVENT_TO_CONNECTOR_TYPES[eventType] ?? [];
    const dispatched = new Set<string>();

    for (const connectorType of targetTypes) {
      try {
        const config = await getConnectorConfig(tenantId, connectorType);
        if (!config || !config.isEnabled) continue;

        const key = `${connectorType}:${config.provider}`;
        if (dispatched.has(key)) continue;
        dispatched.add(key);

        const result = await this.execute(tenantId, connectorType, eventPayload);
        results.push({
          connectorType,
          provider: config.provider,
          success: result.success,
          error: result.error,
        });
      } catch (err) {
        results.push({
          connectorType,
          provider: 'unknown',
          success: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    logger.info('Event dispatched to connectors', {
      tenantId,
      eventType,
      dispatched: results.length,
      successful: results.filter((r) => r.success).length,
    });

    return { dispatched: results.length, results };
  }

  isStandardEvent(eventType: string): boolean {
    return STANDARD_EVENT_TYPES.has(eventType);
  }
}

export const connectorService = new ConnectorService();
