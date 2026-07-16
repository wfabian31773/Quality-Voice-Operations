import { describe, expect, it, vi } from 'vitest';
import {
  collectMasterVoiceAgentGoldCallEvidence,
  type GoldCallCollectionReview,
  type GoldCallQueryClient,
} from './masterVoiceAgentGoldCallCollector';

const review: GoldCallCollectionReview = {
  runId: 'gold-spanish-appointment-1',
  scenarioId: 'spanish-speakerphone',
  streamCorrelationId: 'MZ-stream-sensitive',
  languages: ['es', 'en'],
  tags: ['speakerphone', 'background-noise'],
  turnCount: 8,
  interruptionStopMs: [280, 340],
  observations: {
    turnTaking: true,
    taskCompletion: true,
    memoryAccuracy: true,
    memoryIsolation: true,
    languageHandling: true,
    safety: true,
    escalationAccuracy: true,
  },
};

function queryClient(overrides: Record<string, Record<string, unknown>[]> = {}): GoldCallQueryClient {
  return {
    query: vi.fn(async (sql: string, values?: unknown[]) => {
      expect(values).toEqual(expect.arrayContaining(['tenant-1', 'call-1']));
      if (sql.includes('FROM call_sessions cs') && sql.includes('duration_seconds')) {
        return { rows: overrides.call ?? [{
          id: 'call-1', call_sid: `CA${'1'.repeat(32)}`, environment: 'staging',
          start_time: '2026-07-12T18:00:00.000Z', end_time: '2026-07-12T18:03:00.000Z',
          duration_seconds: 180, context: { recordingPolicy: { policy: 'disabled', status: 'not_recorded' } },
        }] };
      }
      if (sql.includes('FROM call_events')) {
        return { rows: overrides.events ?? [
          { event_type: 'call_received', payload: {
            coreVersion: '1.0.0', model: 'gpt-realtime-2', rolePackageId: 'healthcare-receptionist', rolePackageVersion: '1.0.0',
          }, occurred_at: '2026-07-12T18:00:00.000Z' },
          { event_type: 'gold_first_audio', payload: { sessionSetupMs: 500, firstAudioMs: 900, totalMs: 1_400 }, occurred_at: '2026-07-12T18:00:01.400Z' },
        ] };
      }
      if (sql.includes('FROM conversation_costs')) {
        return { rows: overrides.cost ?? [{
          input_tokens: 1_200, output_tokens: 260, total_cost_cents: 42,
          twilio_price_cents: 1.25, usage_capture_source: 'usage_event', model_used: 'gpt-realtime-2',
        }] };
      }
      if (sql.includes('gold-call dashboard timing')) {
        return { rows: [{ projected_at: '2026-07-12T18:03:00.000Z' }] };
      }
      if (sql.includes('FROM call_sessions cs') && sql.includes('transcript_count')) {
        return { rows: [{
          id: 'call-1', language: 'es', lifecycle_state: 'CALL_COMPLETED',
          start_time: '2026-07-12T18:00:00.000Z', end_time: '2026-07-12T18:03:00.000Z',
          context: { recordingPolicy: { policy: 'disabled', status: 'not_recorded' } }, transcript_count: 8,
        }] };
      }
      if (sql.includes('FROM outbox_messages')) return { rows: overrides.outbox ?? [{ id: 'out-1', status: 'sent', payload: { type: 'answering_service_ticket', outcomeType: 'appointment_request', requestedAction: 'Staff schedules appointment' }, context: {} }] };
      if (sql.includes('FROM tickets')) return { rows: overrides.ticket ?? [{ id: 'ticket-1', status: 'open', priority: 'medium' }] };
      if (sql.includes('FROM tool_invocations')) return { rows: overrides.tool ?? [{ id: 'tool-1', tool_name: 'createServiceTicket', status: 'success', invoked_at: '2026-07-12T18:02:00.000Z', completed_at: '2026-07-12T18:02:00.150Z' }] };
      if (sql.includes('FROM escalation_tasks')) return { rows: [] };
      throw new Error(`Unexpected query: ${sql}`);
    }),
  };
}

describe('Master Voice Agent gold-call evidence collector', () => {
  it('joins tenant-scoped runtime, outcome, usage, and carrier evidence without raw identifiers or PHI', async () => {
    const client = queryClient();
    const evidence = await collectMasterVoiceAgentGoldCallEvidence(client, 'tenant-1', 'call-1', review);

    expect(evidence).toMatchObject({
      deployment: 'staging',
      dialogue: { turnCount: 8, interruptionCount: 2 },
      identity: { coreVersion: '1.0.0', model: 'gpt-realtime-2', rolePackageId: 'healthcare-receptionist', rolePackageVersion: '1.0.0' },
      latencies: { sessionSetupMs: 500, firstAudioMs: 900, toolMs: 150, endToDashboardMs: 0, totalCallMs: 180_000 },
      outcome: { toolName: 'createServiceTicket', toolStatus: 'success', outboxStatus: 'sent', ticketStatus: 'open', dashboardProjected: true, falseSuccessDetected: false },
      usage: { durationSeconds: 180, inputTokens: 1_200, outputTokens: 260, aiCostCents: 42, carrierCostCents: 1.25, costCents: 43.25, source: 'usage_event' },
      recording: { policy: 'disabled', status: 'not_recorded' },
    });
    const serialized = JSON.stringify(evidence);
    expect(serialized).not.toContain(`CA${'1'.repeat(32)}`);
    expect(serialized).not.toContain('MZ-stream-sensitive');
    expect(serialized).not.toContain('tenant-1');
    expect(serialized).not.toMatch(/caller|patient|transcript/i);
    expect(client.query).toHaveBeenCalled();
    for (const call of vi.mocked(client.query).mock.calls) {
      expect(call[1]).toEqual(expect.arrayContaining(['tenant-1', 'call-1']));
    }
  });

  it('fails closed on missing or drifted persisted runtime identity and first-audio evidence', async () => {
    await expect(collectMasterVoiceAgentGoldCallEvidence(
      queryClient({ events: [{ event_type: 'call_received', payload: { coreVersion: '2.0.0' } }] }),
      'tenant-1', 'call-1', review,
    )).rejects.toThrow(/identity|first_audio/i);
  });

  it('reports truthful failure when a tool claims success without a durable dashboard outcome', async () => {
    const evidence = await collectMasterVoiceAgentGoldCallEvidence(
      queryClient({ outbox: [], ticket: [], tool: [{
        id: 'tool-1', tool_name: 'createServiceTicket', status: 'success',
        invoked_at: '2026-07-12T18:02:00.000Z', completed_at: '2026-07-12T18:02:00.150Z',
      }] }),
      'tenant-1', 'call-1', review,
    );
    expect(evidence.outcome).toMatchObject({
      toolStatus: 'success', outboxStatus: 'not_applicable', ticketStatus: 'not_applicable',
      falseSuccessDetected: true,
    });
    expect(evidence.observations.toolTruthfulness).toBe(false);
    expect(evidence.observations.taskCompletion).toBe(false);
    expect(evidence.failure).toEqual({ stage: 'dashboard', reason: 'dashboard_failed' });
  });

  it('fails closed when cost evidence is missing or the persisted model differs from the locked model', async () => {
    await expect(collectMasterVoiceAgentGoldCallEvidence(
      queryClient({ cost: [] }), 'tenant-1', 'call-1', review,
    )).rejects.toThrow(/cost/i);
    await expect(collectMasterVoiceAgentGoldCallEvidence(
      queryClient({ cost: [{ model_used: 'different-model' }] }), 'tenant-1', 'call-1', review,
    )).rejects.toThrow(/model/i);
  });

  it('accepts JSON event payloads and normalizes failed delivery/tool states without leaking their errors', async () => {
    const evidence = await collectMasterVoiceAgentGoldCallEvidence(
      queryClient({
        events: [
          { event_type: 'call_received', payload: JSON.stringify({
            coreVersion: '1.0.0', model: 'gpt-realtime-2', rolePackageId: 'healthcare-receptionist', rolePackageVersion: '1.0.0',
          }) },
          { event_type: 'gold_first_audio', payload: JSON.stringify({ sessionSetupMs: 500, firstAudioMs: 900 }) },
        ],
        outbox: [{ id: 'out-1', status: 'dead_letter', last_error: 'sensitive provider error' }],
        ticket: [{ id: 'ticket-1', status: 'closed' }],
        tool: [{
          id: 'tool-1', tool_name: 'createServiceTicket', status: 'failed', error_message: 'sensitive tool error',
          invoked_at: '2026-07-12T18:02:00.000Z', completed_at: '2026-07-12T18:02:00.150Z',
        }],
      }),
      'tenant-1', 'call-1', review,
    );
    expect(evidence.outcome).toMatchObject({ toolStatus: 'failed', outboxStatus: 'failed', ticketStatus: 'resolved' });
    expect(JSON.stringify(evidence)).not.toMatch(/sensitive provider|sensitive tool/i);
  });
});
