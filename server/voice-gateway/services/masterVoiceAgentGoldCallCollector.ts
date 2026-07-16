import {
  createGoldCallEvidence,
  type GoldCallEvidence,
} from '../../../platform/agent-runtime/masterVoiceAgentGoldCall';
import {
  MASTER_VOICE_AGENT_CORE_VERSION,
  MASTER_VOICE_AGENT_MODEL,
} from '../../../platform/agent-runtime/masterVoiceAgent';
import { HEALTHCARE_RECEPTIONIST_ROLE_VERSION } from '../../../platform/agent-templates/healthcare-receptionist/rolePackage';
import { loadHealthcareOutcomeDashboardProjection } from '../../admin-api/services/healthcareOutcomeDashboard';

export interface GoldCallQueryClient {
  query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

export interface GoldCallCollectionReview {
  runId: string;
  scenarioId: string;
  streamCorrelationId: string;
  languages: string[];
  tags: string[];
  turnCount: number;
  interruptionStopMs: number[];
  observations: Omit<GoldCallEvidence['observations'], 'toolTruthfulness'>;
}

function record(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function finite(value: unknown, name: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`Gold call ${name} evidence is missing or invalid`);
  return parsed;
}

function iso(value: unknown, name: string): string {
  const date = value instanceof Date ? value : new Date(String(value ?? ''));
  if (Number.isNaN(date.getTime())) throw new Error(`Gold call ${name} timestamp is missing or invalid`);
  return date.toISOString();
}

function mapToolStatus(value: unknown): GoldCallEvidence['outcome']['toolStatus'] {
  const status = String(value ?? '').toLowerCase();
  if (['success', 'succeeded', 'completed'].includes(status)) return 'success';
  if (status) return 'failed';
  return 'not_invoked';
}

function mapOutboxStatus(value: unknown): GoldCallEvidence['outcome']['outboxStatus'] {
  const status = String(value ?? '').toLowerCase();
  if (status === 'sent') return 'sent';
  if (status === 'pending') return 'pending';
  if (status === 'retry') return 'retry';
  if (status === 'failed' || status === 'dead_letter') return 'failed';
  return 'not_applicable';
}

function mapTicketStatus(value: unknown): GoldCallEvidence['outcome']['ticketStatus'] {
  const status = String(value ?? '').toLowerCase();
  if (status === 'open') return 'open';
  if (status === 'in_progress') return 'in_progress';
  if (status === 'resolved' || status === 'closed') return 'resolved';
  if (status === 'queued' || status === 'pending') return 'queued';
  return 'not_applicable';
}

function elapsedMs(start: unknown, end: unknown): number | null {
  if (!start || !end) return null;
  const elapsed = new Date(String(end)).getTime() - new Date(String(start)).getTime();
  return Number.isFinite(elapsed) && elapsed >= 0 ? elapsed : null;
}

export async function collectMasterVoiceAgentGoldCallEvidence(
  client: GoldCallQueryClient,
  tenantId: string,
  callId: string,
  review: GoldCallCollectionReview,
): Promise<GoldCallEvidence> {
  if (!tenantId || !callId) throw new Error('Gold call tenant and call identifiers are required');

  const { rows: callRows } = await client.query(
    `SELECT cs.id, cs.call_sid, cs.environment, cs.start_time, cs.end_time,
            cs.duration_seconds, cs.context
       FROM call_sessions cs
      WHERE cs.tenant_id = $1 AND cs.id = $2`,
    [tenantId, callId],
  );
  const call = callRows[0];
  if (!call) throw new Error('Gold call session was not found in the requested tenant');
  if (call.environment !== 'staging') throw new Error('Gold call deployment must be staging');

  const { rows: eventRows } = await client.query(
    `SELECT event_type, payload, occurred_at
       FROM call_events
      WHERE tenant_id = $1 AND call_session_id = $2
        AND event_type IN ('call_received', 'gold_first_audio')
      ORDER BY occurred_at ASC`,
    [tenantId, callId],
  );
  const identity = record(eventRows.find((row) => row.event_type === 'call_received')?.payload);
  const expectedIdentity = {
    coreVersion: MASTER_VOICE_AGENT_CORE_VERSION,
    model: MASTER_VOICE_AGENT_MODEL,
    rolePackageId: 'healthcare-receptionist',
    rolePackageVersion: HEALTHCARE_RECEPTIONIST_ROLE_VERSION,
  };
  for (const [key, expected] of Object.entries(expectedIdentity)) {
    if (identity[key] !== expected) throw new Error(`Gold call persisted runtime identity mismatch: ${key}`);
  }
  const firstAudio = record(eventRows.find((row) => row.event_type === 'gold_first_audio')?.payload);
  const sessionSetupMs = finite(firstAudio.sessionSetupMs, 'session_setup');
  const firstAudioMs = finite(firstAudio.firstAudioMs, 'first_audio');

  const projection = await loadHealthcareOutcomeDashboardProjection(client, tenantId, callId);
  if (!projection) throw new Error('Gold call dashboard projection is missing');

  const { rows: costRows } = await client.query(
    `SELECT input_tokens, output_tokens, total_cost_cents, twilio_price_cents,
            usage_capture_source, model_used
       FROM conversation_costs
      WHERE tenant_id = $1 AND call_session_id = $2`,
    [tenantId, callId],
  );
  const cost = costRows[0];
  if (!cost) throw new Error('Gold call usage and cost evidence is missing');
  if (cost.model_used !== MASTER_VOICE_AGENT_MODEL) throw new Error('Gold call persisted cost model differs from the locked model');

  const { rows: timingRows } = await client.query(
    `/* gold-call tool timing */
     SELECT invoked_at, completed_at
       FROM tool_invocations
      WHERE tenant_id = $1 AND call_session_id = $2
        AND tool_name = 'createServiceTicket'
      ORDER BY invoked_at DESC
      LIMIT 1`,
    [tenantId, callId],
  );
  const { rows: dashboardTimingRows } = await client.query(
    `/* gold-call dashboard timing */
     SELECT MAX(projected_at) AS projected_at
       FROM (
         SELECT updated_at AS projected_at
           FROM outbox_messages
          WHERE tenant_id = $1 AND call_log_id = $2
            AND payload->>'type' = 'answering_service_ticket'
         UNION ALL
         SELECT updated_at AS projected_at
           FROM tickets
          WHERE tenant_id = $1 AND call_id = $2
       ) durable_outcomes`,
    [tenantId, callId],
  );

  const toolStatus = mapToolStatus(projection.tool?.status);
  const outboxStatus = mapOutboxStatus(projection.delivery?.status);
  const ticketStatus = mapTicketStatus(projection.followUp?.status);
  const hasDurableOutcome = outboxStatus !== 'not_applicable' || ticketStatus !== 'not_applicable';
  const falseSuccessDetected = toolStatus === 'success' && !hasDurableOutcome;
  const dashboardProjected = projection.callId === callId;
  const taskCompletion = review.observations.taskCompletion && hasDurableOutcome && dashboardProjected;
  const toolTruthfulness = !falseSuccessDetected;
  const startedAt = iso(call.start_time, 'start');
  const finishedAt = iso(call.end_time, 'finish');
  const aiCostCents = finite(cost.total_cost_cents, 'AI cost');
  const carrierCostCents = finite(cost.twilio_price_cents, 'carrier cost');
  const toolMs = elapsedMs(timingRows[0]?.invoked_at, timingRows[0]?.completed_at);
  const projectedAt = dashboardTimingRows[0]?.projected_at;
  const endToDashboardElapsed = elapsedMs(finishedAt, projectedAt);
  const endToDashboardMs = projectedAt ? Math.max(0, endToDashboardElapsed ?? 0) : null;

  return createGoldCallEvidence({
    runId: review.runId,
    scenarioId: review.scenarioId,
    deployment: 'staging',
    startedAt,
    finishedAt,
    rawTrace: {
      twilioCallSid: String(call.call_sid ?? ''),
      streamCorrelationId: review.streamCorrelationId,
      callId,
    },
    languages: review.languages,
    tags: review.tags,
    dialogue: {
      turnCount: review.turnCount,
      interruptionCount: review.interruptionStopMs.length,
    },
    latencies: {
      sessionSetupMs,
      firstAudioMs,
      toolMs,
      endToDashboardMs,
      totalCallMs: finite(call.duration_seconds, 'duration') * 1_000,
    },
    interruptionStopMs: review.interruptionStopMs,
    observations: {
      ...review.observations,
      taskCompletion,
      toolTruthfulness,
    },
    outcome: {
      toolName: projection.tool?.name === 'createServiceTicket' ? 'createServiceTicket' : null,
      toolStatus,
      outboxStatus,
      ticketStatus,
      dashboardProjected,
      falseSuccessDetected,
    },
    usage: {
      durationSeconds: finite(call.duration_seconds, 'duration'),
      inputTokens: finite(cost.input_tokens, 'input token'),
      outputTokens: finite(cost.output_tokens, 'output token'),
      aiCostCents,
      carrierCostCents,
      costCents: aiCostCents + carrierCostCents,
      source: cost.usage_capture_source === 'usage_event' ? 'usage_event' : 'estimate',
    },
    recording: {
      policy: projection.recording.policy,
      status: projection.recording.status,
    },
    failure: falseSuccessDetected || !taskCompletion
      ? { stage: 'dashboard', reason: 'dashboard_failed' }
      : null,
  });
}
