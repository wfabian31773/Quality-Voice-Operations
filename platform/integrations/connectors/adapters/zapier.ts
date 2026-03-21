import { createLogger } from '../../../core/logger';
import type { ConnectorAdapter, ConnectorConfig, ConnectorPayload, ConnectorResult } from '../types';
import type { TenantId } from '../../../core/types';

const logger = createLogger('ZAPIER_CONNECTOR');
const REQUEST_TIMEOUT_MS = 15_000;

const SUPPORTED_EVENTS = new Set([
  'call.completed',
  'appointment.booked',
  'sms.sent',
  'ticket.created',
]);

function isAllowedWebhookUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') return false;
    const hostname = parsed.hostname.toLowerCase();
    const blocked = [
      'localhost', '127.0.0.1', '0.0.0.0', '::1',
      '169.254.169.254', 'metadata.google.internal',
    ];
    if (blocked.includes(hostname)) return false;
    if (hostname.endsWith('.local') || hostname.endsWith('.internal')) return false;
    const parts = hostname.split('.');
    if (parts.length >= 1) {
      const first = parseInt(parts[0], 10);
      if (first === 10) return false;
      if (first === 172 && parts.length >= 2) {
        const second = parseInt(parts[1], 10);
        if (second >= 16 && second <= 31) return false;
      }
      if (first === 192 && parts.length >= 2 && parseInt(parts[1], 10) === 168) return false;
    }
    return true;
  } catch {
    return false;
  }
}

export class ZapierWebhookConnectorAdapter implements ConnectorAdapter {
  async execute(
    tenantId: TenantId,
    config: ConnectorConfig,
    payload: ConnectorPayload,
  ): Promise<ConnectorResult> {
    const webhookUrl = config.credentials.webhook_url ?? config.credentials.endpoint_url ?? '';
    if (!webhookUrl) {
      logger.error('Missing Zapier webhook URL', { tenantId });
      return { success: false, error: 'Zapier connector not configured: missing webhook_url' };
    }

    if (!isAllowedWebhookUrl(webhookUrl)) {
      logger.error('Webhook URL blocked by SSRF policy', { tenantId });
      return { success: false, error: 'Webhook URL must be a public HTTPS URL' };
    }

    if (!SUPPORTED_EVENTS.has(payload.type)) {
      return { success: false, error: `Zapier adapter does not handle event: ${payload.type}` };
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    const eventPayload = {
      event: payload.type,
      timestamp: new Date().toISOString(),
      tenantId,
      data: this.sanitizePayload(payload),
    };

    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };

      const apiKey = config.credentials.api_key ?? config.credentials.secret ?? '';
      if (apiKey) {
        headers['X-API-Key'] = apiKey;
      }

      const res = await fetch(webhookUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(eventPayload),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        logger.error('Zapier webhook failed', { tenantId, status: res.status });
        return { success: false, error: `Webhook error ${res.status}: ${text.slice(0, 200)}` };
      }

      let responseId: string | undefined;
      try {
        const data = await res.json() as Record<string, unknown>;
        responseId = (data.id as string) ?? (data.request_id as string) ?? undefined;
      } catch {
        // Zapier may return empty or non-JSON response
      }

      logger.info('Zapier webhook delivered', { tenantId, event: payload.type });
      return {
        success: true,
        externalId: responseId,
        meta: { event: payload.type, webhookUrl: this.redactUrl(webhookUrl), provider: 'zapier' },
      };
    } catch (err) {
      clearTimeout(timeoutId);
      const error = err instanceof Error ? err.message : String(err);
      logger.error('Zapier webhook request failed', { tenantId, error });
      return { success: false, error };
    }
  }

  private sanitizePayload(payload: ConnectorPayload): Record<string, unknown> {
    const sanitized: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(payload)) {
      if (key === 'type') continue;
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || value === null) {
        sanitized[key] = value;
      } else if (typeof value === 'object') {
        sanitized[key] = value;
      }
    }
    return sanitized;
  }

  private redactUrl(url: string): string {
    try {
      const u = new URL(url);
      return `${u.protocol}//${u.hostname}/***`;
    } catch {
      return '***';
    }
  }
}
