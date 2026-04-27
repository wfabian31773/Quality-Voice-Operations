import { createLogger } from '../../../core/logger';
import { safeFetch, SsrfBlockedError } from '../ssrfGuard';
import { retryFetch } from '../retryWithBackoff';
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

    if (!SUPPORTED_EVENTS.has(payload.type)) {
      return { success: false, error: `Zapier adapter does not handle event: ${payload.type}` };
    }

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

      // BL-014 (Task #248): retry transient 429/5xx + network errors via
      // retryFetch, but plug `safeFetch` in as the fetcher so the SSRF guard
      // still runs on every attempt. Retry-After on a 429 is honoured.
      // The 60s per-dispatch budget is enforced by retryFetch itself; the
      // per-attempt AbortController owns the request timeout.
      const res = await retryFetch(
        webhookUrl,
        {
          method: 'POST',
          headers,
          body: JSON.stringify(eventPayload),
        },
        {
          label: 'zapier',
          fetcher: async (input, opts) => {
            const c = new AbortController();
            const t = setTimeout(() => c.abort(), REQUEST_TIMEOUT_MS);
            try {
              return await safeFetch(typeof input === 'string' ? input : String(input), {
                ...opts,
                signal: c.signal,
              });
            } finally {
              clearTimeout(t);
            }
          },
        },
      );

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
      if (err instanceof SsrfBlockedError) {
        logger.error('Webhook URL blocked by SSRF policy', { tenantId, reason: err.reason });
        return { success: false, error: 'Webhook URL must be a public HTTPS URL' };
      }
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
