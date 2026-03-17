import { getPlatformPool, withPrivilegedClient, withTenantContext } from '../../db';
import { createLogger } from '../logger';

const logger = createLogger('TRACE_LOGGER');

export type TraceType =
  | 'intent_classified'
  | 'slot_collected'
  | 'tool_invoked'
  | 'tool_responded'
  | 'model_prompted'
  | 'model_responded'
  | 'workflow_started'
  | 'workflow_step'
  | 'escalation_check'
  | 'call_started'
  | 'call_ended'
  | 'confirmation_requested'
  | 'integration_call';

export interface TraceEvent {
  tenantId: string;
  callSessionId: string;
  traceType: TraceType;
  stepName: string;
  sequenceNumber?: number;
  startedAt?: Date;
  endedAt?: Date;
  durationMs?: number;
  inputData?: Record<string, unknown>;
  outputData?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  parentTraceId?: string;
}

const PII_FIELDS = ['phone', 'email', 'ssn', 'dob', 'address', 'caller_number', 'called_number', 'from', 'to', 'name', 'patient', 'date_of_birth', 'social_security', 'credit_card', 'card_number', 'account_number'];

function maskPII(data: unknown): unknown {
  if (data === null || data === undefined) return null;
  if (typeof data === 'string') return data;
  if (Array.isArray(data)) return data.map(item => maskPII(item));
  if (typeof data !== 'object') return data;
  const obj = data as Record<string, unknown>;
  const masked: Record<string, unknown> = {};
  for (const key of Object.keys(obj)) {
    const lowerKey = key.toLowerCase();
    if (PII_FIELDS.some(f => lowerKey.includes(f))) {
      const val = String(obj[key] ?? '');
      masked[key] = val.length > 4 ? '***' + val.slice(-4) : '***';
    } else {
      masked[key] = maskPII(obj[key]);
    }
  }
  return masked;
}

export function maskPIIPublic(data: unknown): unknown {
  return maskPII(data);
}

export async function recordTrace(event: TraceEvent): Promise<string | null> {
  try {
    return await withPrivilegedClient(async (client) => {
      const seqResult = await client.query(
        `SELECT COALESCE(MAX(sequence_number), 0) + 1 AS next_seq
         FROM execution_traces
         WHERE call_session_id = $1`,
        [event.callSessionId],
      );
      const seq = event.sequenceNumber ?? (seqResult.rows[0]?.next_seq ?? 1);
      const { rows } = await client.query(
        `INSERT INTO execution_traces
          (tenant_id, call_session_id, trace_type, step_name, sequence_number,
           started_at, ended_at, duration_ms, input_data, output_data, metadata, parent_trace_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         RETURNING id`,
        [
          event.tenantId,
          event.callSessionId,
          event.traceType,
          event.stepName,
          seq,
          event.startedAt ?? new Date(),
          event.endedAt ?? null,
          event.durationMs ?? null,
          event.inputData ? JSON.stringify(maskPII(event.inputData)) : null,
          event.outputData ? JSON.stringify(maskPII(event.outputData)) : null,
          event.metadata ? JSON.stringify(event.metadata) : '{}',
          event.parentTraceId ?? null,
        ],
      );
      return rows[0]?.id ?? null;
    });
  } catch (err) {
    logger.error('Failed to record trace', {
      tenantId: event.tenantId,
      callSessionId: event.callSessionId,
      traceType: event.traceType,
      error: String(err),
    });
    return null;
  }
}

export async function getCallTraces(tenantId: string, callSessionId: string): Promise<TraceEvent[]> {
  const pool = getPlatformPool();
  const client = await pool.connect();
  try {
    return await withTenantContext(client, tenantId, async () => {
      const { rows } = await client.query(
        `SELECT id, trace_type, step_name, sequence_number, started_at, ended_at,
                duration_ms, input_data, output_data, metadata, parent_trace_id
         FROM execution_traces
         WHERE tenant_id = $1 AND call_session_id = $2
         ORDER BY sequence_number ASC, started_at ASC`,
        [tenantId, callSessionId],
      );
      return rows.map((r: Record<string, unknown>) => ({
        id: r.id,
        tenantId,
        callSessionId,
        traceType: r.trace_type as TraceType,
        stepName: r.step_name as string,
        sequenceNumber: r.sequence_number as number,
        startedAt: r.started_at as Date,
        endedAt: r.ended_at as Date | null,
        durationMs: r.duration_ms as number | null,
        inputData: r.input_data as Record<string, unknown> | null,
        outputData: r.output_data as Record<string, unknown> | null,
        metadata: r.metadata as Record<string, unknown>,
        parentTraceId: r.parent_trace_id as string | null,
      }));
    });
  } catch (err) {
    logger.error('Failed to get call traces', { tenantId, callSessionId, error: String(err) });
    return [];
  } finally {
    client.release();
  }
}

export async function recordIntegrationEvent(event: {
  tenantId: string;
  callSessionId?: string;
  toolInvocationId?: string;
  requestMethod: string;
  requestUrl: string;
  requestHeaders?: Record<string, unknown>;
  requestBody?: unknown;
  responseStatus?: number;
  responseBody?: unknown;
  responseHeaders?: Record<string, unknown>;
  latencyMs?: number;
  errorMessage?: string;
  serviceName?: string;
}): Promise<string | null> {
  try {
    return await withPrivilegedClient(async (client) => {
      const sanitizedHeaders = event.requestHeaders ? sanitizeHeaders(event.requestHeaders) : {};
      const { rows } = await client.query(
        `INSERT INTO integration_event_logs
          (tenant_id, call_session_id, tool_invocation_id, request_method, request_url,
           request_headers, request_body, response_status, response_body, response_headers,
           latency_ms, error_message, service_name)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
         RETURNING id`,
        [
          event.tenantId,
          event.callSessionId ?? null,
          event.toolInvocationId ?? null,
          event.requestMethod,
          event.requestUrl,
          JSON.stringify(sanitizedHeaders),
          event.requestBody ? JSON.stringify(maskPII(event.requestBody as Record<string, unknown>)) : null,
          event.responseStatus ?? null,
          event.responseBody ? JSON.stringify(maskPII(event.responseBody as Record<string, unknown>)) : null,
          event.responseHeaders ? JSON.stringify(sanitizeHeaders(event.responseHeaders)) : '{}',
          event.latencyMs ?? null,
          event.errorMessage ?? null,
          event.serviceName ?? null,
        ],
      );
      return rows[0]?.id ?? null;
    });
  } catch (err) {
    logger.error('Failed to record integration event', {
      tenantId: event.tenantId,
      error: String(err),
    });
    return null;
  }
}

export async function getIntegrationEvents(tenantId: string, callSessionId: string) {
  const pool = getPlatformPool();
  const client = await pool.connect();
  try {
    return await withTenantContext(client, tenantId, async () => {
      const { rows } = await client.query(
        `SELECT id, tool_invocation_id, request_method, request_url,
                request_headers, request_body, response_status, response_body,
                response_headers, latency_ms, error_message, service_name, created_at
         FROM integration_event_logs
         WHERE tenant_id = $1 AND call_session_id = $2
         ORDER BY created_at ASC`,
        [tenantId, callSessionId],
      );
      return rows;
    });
  } catch (err) {
    logger.error('Failed to get integration events', { tenantId, callSessionId, error: String(err) });
    return [];
  } finally {
    client.release();
  }
}

function sanitizeHeaders(headers: Record<string, unknown>): Record<string, unknown> {
  const sanitized = { ...headers };
  const sensitiveKeys = ['authorization', 'x-api-key', 'cookie', 'set-cookie', 'x-auth-token'];
  for (const key of Object.keys(sanitized)) {
    if (sensitiveKeys.includes(key.toLowerCase())) {
      sanitized[key] = '[REDACTED]';
    }
  }
  return sanitized;
}
