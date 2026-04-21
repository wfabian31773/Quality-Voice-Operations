import { createLogger } from '../../core/logger';
import { getConnectorConfig, listEnabledConnectorConfigs, updateConnectorSyncStatus } from './db';
import type { ConnectorConfig as ConnectorConfigType } from './types';
import { TicketingConnectorAdapter } from './adapters/ticketing';
import { TwilioSmsConnectorAdapter } from './adapters/sms';
import { HubSpotConnectorAdapter } from './adapters/hubspot';
import { GoogleCalendarConnectorAdapter } from './adapters/google-calendar';
import { OutlookCalendarConnectorAdapter } from './adapters/outlook-calendar';
import { SlackConnectorAdapter } from './adapters/slack';
import { ZapierWebhookConnectorAdapter } from './adapters/zapier';
import { PipedriveConnectorAdapter } from './adapters/pipedrive';
import { QuickBooksConnectorAdapter } from './adapters/quickbooks';
import { SalesforceConnectorAdapter } from './adapters/salesforce';
import { recordIntegrationEvent } from '../../core/observability/traceLogger';
import type { ConnectorAdapter, ConnectorPayload, ConnectorResult, ConnectorType, StandardEventType } from './types';
import type { TenantId } from '../../core/types';

const logger = createLogger('CONNECTOR_SERVICE');

const googleCalendarAdapter = new GoogleCalendarConnectorAdapter();
const outlookCalendarAdapter = new OutlookCalendarConnectorAdapter();
const hubspotAdapter = new HubSpotConnectorAdapter();
const salesforceAdapter = new SalesforceConnectorAdapter();
const pipedriveAdapter = new PipedriveConnectorAdapter();
const slackAdapter = new SlackConnectorAdapter();
const zapierAdapter = new ZapierWebhookConnectorAdapter();
const twilioSmsAdapter = new TwilioSmsConnectorAdapter();
const quickbooksAdapter = new QuickBooksConnectorAdapter();

const TYPE_ADAPTER_REGISTRY: Record<string, ConnectorAdapter> = {
  ticketing: new TicketingConnectorAdapter(),
  sms: twilioSmsAdapter,
  crm: hubspotAdapter,
  scheduling: googleCalendarAdapter,
  webhook: zapierAdapter,
  custom: slackAdapter,
  accounting: quickbooksAdapter,
};

const PROVIDER_ADAPTER_REGISTRY: Record<string, ConnectorAdapter> = {
  hubspot: hubspotAdapter,
  salesforce: salesforceAdapter,
  pipedrive: pipedriveAdapter,
  'google-calendar': googleCalendarAdapter,
  'outlook-calendar': outlookCalendarAdapter,
  slack: slackAdapter,
  zapier: zapierAdapter,
  webhook: zapierAdapter,
  twilio: twilioSmsAdapter,
  quickbooks: quickbooksAdapter,
};

const ADAPTER_REGISTRY: Record<string, ConnectorAdapter> = {
  ...TYPE_ADAPTER_REGISTRY,
  'crm:salesforce': salesforceAdapter,
  'crm:hubspot': hubspotAdapter,
  'crm:pipedrive': pipedriveAdapter,
  'accounting:quickbooks': quickbooksAdapter,
};

const SCHEDULING_ADAPTERS: Record<string, ConnectorAdapter> = {
  'google-calendar': googleCalendarAdapter,
  'outlook-calendar': outlookCalendarAdapter,
};

function resolveAdapter(connectorType: ConnectorType, provider?: string): ConnectorAdapter | undefined {
  if (connectorType === 'scheduling' && provider && SCHEDULING_ADAPTERS[provider]) {
    return SCHEDULING_ADAPTERS[provider];
  }
  if (provider) {
    const keyed = ADAPTER_REGISTRY[`${connectorType}:${provider}`] || PROVIDER_ADAPTER_REGISTRY[provider];
    if (keyed) return keyed;
  }
  return ADAPTER_REGISTRY[connectorType];
}

const STANDARD_EVENT_TYPES = new Set<string>([
  'call.completed',
  'appointment.booked',
  'sms.sent',
  'ticket.created',
  'call.missed',
]);

const EVENT_TO_CONNECTOR_TYPES: Record<string, ConnectorType[]> = {
  'call.completed': ['crm', 'accounting', 'custom', 'webhook'],
  'appointment.booked': ['crm', 'scheduling', 'accounting', 'custom', 'webhook'],
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
    provider?: string,
  ): Promise<ConnectorResult> {
    const config = await getConnectorConfig(tenantId, connectorType, provider);
    const adapter = resolveAdapter(connectorType, config?.provider ?? provider);
    if (!adapter) {
      return { success: false, error: `No adapter registered for connector type: ${connectorType}` };
    }

    if (!config) {
      logger.warn('No connector configured for type', { tenantId, connectorType, provider });
      return {
        success: false,
        error: `No ${connectorType} connector configured for this tenant`,
      };
    }

    return this.executeWithConfig(tenantId, config, payload);
  }

  private async executeWithConfig(
    tenantId: TenantId,
    config: ConnectorConfigType,
    payload: ConnectorPayload,
  ): Promise<ConnectorResult> {
    const adapter = resolveAdapter(config.connectorType, config.provider);
    if (!adapter) {
      return { success: false, error: `No adapter for ${config.connectorType}:${config.provider}` };
    }

    if (!config.isEnabled) {
      return { success: false, error: `${config.connectorType} connector is disabled for this tenant` };
    }

    logger.info('Dispatching to connector', {
      tenantId,
      connectorType: config.connectorType,
      provider: config.provider,
      payloadType: payload.type,
    });

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
      requestUrl: `connector://${config.connectorType}/${config.provider}`,
      requestBody: { type: payload.type },
      responseStatus: result.success ? 200 : 500,
      responseBody: { success: result.success, error: result.error ?? null },
      latencyMs,
      errorMessage: result.error ?? undefined,
      serviceName: `${config.connectorType}:${config.provider}`,
    }).catch(() => {});

    updateConnectorSyncStatus(
      tenantId,
      config.connectorType,
      result.success ? 'success' : 'error',
      config.provider,
    ).catch(() => {});

    if (!result.success && config.fallbackConnectorType) {
      logger.info('Primary connector failed, attempting fallback', {
        tenantId,
        primaryType: config.connectorType,
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
    const config = await getConnectorConfig(tenantId, fallbackType);
    if (!config || !config.isEnabled) {
      return { success: false, error: `Fallback connector ${fallbackType} not available` };
    }

    const adapter = resolveAdapter(fallbackType, config.provider);
    if (!adapter) {
      return { success: false, error: `No fallback adapter for ${fallbackType}/${config.provider}` };
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
    if (targetTypes.length === 0) {
      return { dispatched: 0, results };
    }

    const configs = await listEnabledConnectorConfigs(tenantId, targetTypes);
    const dispatched = new Set<string>();

    for (const config of configs) {
      const key = `${config.connectorType}:${config.provider}`;
      if (dispatched.has(key)) continue;
      dispatched.add(key);

      try {
        const result = await this.executeWithConfig(tenantId, config, eventPayload);
        results.push({
          connectorType: config.connectorType,
          provider: config.provider,
          success: result.success,
          error: result.error,
        });
      } catch (err) {
        results.push({
          connectorType: config.connectorType,
          provider: config.provider,
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
