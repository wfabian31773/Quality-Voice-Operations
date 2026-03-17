import { createLogger } from '../../core/logger';
import { getConnectorConfig } from './db';
import { TicketingConnectorAdapter } from './adapters/ticketing';
import { TwilioSmsConnectorAdapter } from './adapters/sms';
import type { ConnectorAdapter, ConnectorPayload, ConnectorResult, ConnectorType } from './types';
import type { TenantId } from '../../core/types';

const logger = createLogger('CONNECTOR_SERVICE');

const ADAPTER_REGISTRY: Record<string, ConnectorAdapter> = {
  ticketing: new TicketingConnectorAdapter(),
  sms: new TwilioSmsConnectorAdapter(),
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

    const result = await adapter.execute(tenantId, config, payload);

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
    const result = await adapter.execute(tenantId, config, payload);
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
}

export const connectorService = new ConnectorService();
