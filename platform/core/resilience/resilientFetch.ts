import { getCircuitBreaker } from './circuitBreakerRegistry';
import { withRetry } from './retry';
import { withTimeout } from './timeout';
import { withResiliency } from './index';
import { CircuitOpenError } from './circuitBreaker';
import { OPENAI_RETRY_CONFIG } from './presets';
import type { RetryOptions } from './types';

export async function resilientFetch(
  url: string,
  options: RequestInit,
  config: {
    circuitName: string;
    retryOptions?: Partial<RetryOptions>;
    timeoutMs?: number;
    context?: string;
    observability?: {
      tenantId: string;
      callSessionId?: string;
      toolInvocationId?: string;
      serviceName?: string;
    };
  },
): Promise<Response> {
  const circuitBreaker = getCircuitBreaker(config.circuitName);
  const retryOpts: RetryOptions = {
    ...OPENAI_RETRY_CONFIG,
    ...config.retryOptions,
  };

  const startTime = Date.now();

  const operation = async () => {
    const fetchPromise = fetch(url, options);
    const response = config.timeoutMs
      ? await withTimeout(fetchPromise, config.timeoutMs, config.context)
      : await fetchPromise;

    if (!response.ok && response.status >= 500) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    return response;
  };

  const result = await withResiliency(operation, circuitBreaker, retryOpts, config.context);

  if (config.observability) {
    const latencyMs = Date.now() - startTime;
    let requestBodyData: unknown = null;
    try {
      if (options.body && typeof options.body === 'string') {
        requestBodyData = JSON.parse(options.body);
      } else if (options.body) {
        requestBodyData = { raw: String(options.body).slice(0, 500) };
      }
    } catch {
      requestBodyData = { raw: String(options.body ?? '').slice(0, 500) };
    }

    let responseBodyData: unknown = null;
    if (result.success && result.result) {
      try {
        const cloned = result.result.clone();
        cloned.text().then(text => {
          try { responseBodyData = JSON.parse(text); } catch { responseBodyData = { raw: text.slice(0, 500) }; }
          import('../observability/traceLogger').then(({ recordIntegrationEvent }) => {
            recordIntegrationEvent({
              tenantId: config.observability!.tenantId,
              callSessionId: config.observability!.callSessionId,
              toolInvocationId: config.observability!.toolInvocationId,
              requestMethod: (options.method ?? 'GET').toUpperCase(),
              requestUrl: url,
              requestHeaders: options.headers as Record<string, unknown> | undefined,
              requestBody: requestBodyData,
              responseStatus: result.result?.status,
              responseBody: responseBodyData,
              latencyMs,
              serviceName: config.observability!.serviceName ?? config.circuitName,
            }).catch(() => {});
          }).catch(() => {});
        }).catch(() => {});
      } catch {
        import('../observability/traceLogger').then(({ recordIntegrationEvent }) => {
          recordIntegrationEvent({
            tenantId: config.observability!.tenantId,
            callSessionId: config.observability!.callSessionId,
            toolInvocationId: config.observability!.toolInvocationId,
            requestMethod: (options.method ?? 'GET').toUpperCase(),
            requestUrl: url,
            requestHeaders: options.headers as Record<string, unknown> | undefined,
            requestBody: requestBodyData,
            responseStatus: result.result?.status,
            latencyMs,
            serviceName: config.observability!.serviceName ?? config.circuitName,
          }).catch(() => {});
        }).catch(() => {});
      }
    } else {
      import('../observability/traceLogger').then(({ recordIntegrationEvent }) => {
        recordIntegrationEvent({
          tenantId: config.observability!.tenantId,
          callSessionId: config.observability!.callSessionId,
          toolInvocationId: config.observability!.toolInvocationId,
          requestMethod: (options.method ?? 'GET').toUpperCase(),
          requestUrl: url,
          requestHeaders: options.headers as Record<string, unknown> | undefined,
          requestBody: requestBodyData,
          latencyMs,
          errorMessage: String(result.error),
          serviceName: config.observability!.serviceName ?? config.circuitName,
        }).catch(() => {});
      }).catch(() => {});
    }
  }

  if (!result.success) {
    throw result.error;
  }

  return result.result!;
}
