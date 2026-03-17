import { getPlatformPool, withPrivilegedClient } from '../db';
import { createLogger } from '../core/logger';
import { redactPHI } from '../core/phi/redact';

const logger = createLogger('GIN_AGGREGATION');

export interface AggregatedSignal {
  industry: string | null;
  totalCalls: number;
  completedCalls: number;
  failedCalls: number;
  escalatedCalls: number;
  avgDurationSeconds: number;
  avgQualityScore: number;
  bookingConversionRate: number;
  avgResponseTimeSeconds: number;
  commonQuestions: string[];
  promptPatterns: string[];
  workflowSequences: string[];
}

export interface AggregationRunResult {
  runId: string;
  tenantsProcessed: number;
  signalsCollected: number;
  status: 'completed' | 'failed';
}

function detectIndustryVertical(agentTypes: string[]): string | null {
  const typeMap: Record<string, string> = {
    'dental': 'dental',
    'medical-after-hours': 'medical',
    'home-services': 'home_services',
    'property-management': 'property_management',
    'answering-service': 'general',
    'outbound-sales': 'general',
    'customer-support': 'general',
    'technical-support': 'general',
    'legal': 'legal',
  };

  for (const t of agentTypes) {
    const mapped = typeMap[t];
    if (mapped && mapped !== 'general') return mapped;
  }
  return agentTypes.length > 0 ? 'general' : null;
}

function extractAnonymizedPromptPatterns(prompts: string[]): string[] {
  const patterns: string[] = [];
  for (const prompt of prompts) {
    const redacted = redactPHI(prompt);
    const anonymized = redacted
      .replace(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)+\b/g, '[BUSINESS_NAME]')
      .replace(/\b\d{1,5}\s+\w+\s+(?:Street|St|Avenue|Ave|Road|Rd|Drive|Dr|Boulevard|Blvd)\b/gi, '[ADDRESS]')
      .replace(/\b[\w.-]+@[\w.-]+\.\w{2,}\b/g, '[EMAIL]');

    if (anonymized.length > 50) {
      const structure = anonymized.length > 300 ? anonymized.slice(0, 300) + '...' : anonymized;
      patterns.push(structure);
    }
  }
  return patterns.slice(0, 5);
}

function extractQuestionPatterns(transcripts: string[]): string[] {
  const questionCounts = new Map<string, number>();

  for (const transcript of transcripts) {
    const redacted = redactPHI(transcript);
    const questions = redacted.match(/[^.!?]*\?/g) || [];
    for (const q of questions) {
      const normalized = q.trim().toLowerCase()
        .replace(/\b\d{3}[-.]?\d{3}[-.]?\d{4}\b/g, '')
        .replace(/\s+/g, ' ')
        .trim();
      if (normalized.length > 10 && normalized.length < 200) {
        questionCounts.set(normalized, (questionCounts.get(normalized) || 0) + 1);
      }
    }
  }

  return Array.from(questionCounts.entries())
    .filter(([, count]) => count >= 2)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 10)
    .map(([q]) => q);
}

const ALLOWED_TOOL_NAMES = new Set([
  'book_appointment', 'check_availability', 'retrieve_knowledge',
  'transfer_call', 'send_sms', 'create_ticket', 'lookup_patient',
  'lookup_customer', 'schedule_callback', 'collect_payment',
  'verify_insurance', 'check_warranty', 'dispatch_technician',
  'update_crm', 'send_email', 'get_directions', 'check_inventory',
]);

function sanitizeToolName(tool: string): string {
  const normalized = tool.toLowerCase().replace(/[^a-z0-9_]/g, '_');
  if (ALLOWED_TOOL_NAMES.has(normalized)) return normalized;
  const prefix = normalized.split('_').slice(0, 2).join('_');
  return ALLOWED_TOOL_NAMES.has(prefix) ? prefix : 'custom_tool';
}

function extractWorkflowSequences(events: Array<{ eventType: string; tool?: string }>): string[] {
  const sequences: string[] = [];
  let currentSeq: string[] = [];

  for (const e of events) {
    if (e.eventType === 'TOOL_START' && e.tool) {
      currentSeq.push(sanitizeToolName(e.tool));
    } else if (e.eventType === 'TOOL_END') {
      if (currentSeq.length >= 2) {
        sequences.push(currentSeq.join(' -> '));
      }
      if (currentSeq.length >= 3) {
        currentSeq = [];
      }
    }
  }
  if (currentSeq.length >= 2) {
    sequences.push(currentSeq.join(' -> '));
  }

  const seqCounts = new Map<string, number>();
  for (const s of sequences) {
    seqCounts.set(s, (seqCounts.get(s) || 0) + 1);
  }

  return Array.from(seqCounts.entries())
    .filter(([, count]) => count >= 2)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 5)
    .map(([seq]) => seq);
}

export async function runAggregationPipeline(): Promise<AggregationRunResult> {
  return withPrivilegedClient(async (client) => {
    let runId: string;

    const { rows: runRows } = await client.query(
      `INSERT INTO gin_aggregation_runs (run_type, status)
       VALUES ('full_aggregation', 'running')
       RETURNING id`,
    );
    runId = runRows[0].id as string;

    try {
      const { rows: tenants } = await client.query(
        `SELECT id FROM tenants WHERE status = 'active' AND gin_participation = TRUE LIMIT 500`,
      );

      let signalsCollected = 0;
      const now = new Date();
      const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

      const industrySignals = new Map<string, AggregatedSignal[]>();

      for (const tenant of tenants) {
        try {
          const tenantId = tenant.id as string;

          const { rows: agentTypeRows } = await client.query(
            `SELECT DISTINCT type FROM agents WHERE tenant_id = $1 AND status = 'deployed'`,
            [tenantId],
          );
          const agentTypes = agentTypeRows.map(r => r.type as string);
          const industry = detectIndustryVertical(agentTypes) || 'general';

          const { rows: callMetrics } = await client.query(
            `SELECT
               COUNT(*)::int AS total_calls,
               COUNT(*) FILTER (WHERE lifecycle_state = 'CALL_COMPLETED')::int AS completed,
               COUNT(*) FILTER (WHERE lifecycle_state = 'CALL_FAILED')::int AS failed,
               COUNT(*) FILTER (WHERE lifecycle_state = 'ESCALATED' OR escalation_target IS NOT NULL)::int AS escalated,
               COALESCE(AVG(duration_seconds) FILTER (WHERE duration_seconds > 0), 0)::float AS avg_duration
             FROM call_sessions
             WHERE tenant_id = $1 AND created_at >= $2 AND created_at < $3`,
            [tenantId, thirtyDaysAgo, now],
          );

          const cmRaw = callMetrics[0] || {};
          const cm = {
            total_calls: Number(cmRaw.total_calls || 0),
            completed: Number(cmRaw.completed || 0),
            failed: Number(cmRaw.failed || 0),
            escalated: Number(cmRaw.escalated || 0),
            avg_duration: Number(cmRaw.avg_duration || 0),
          };
          if (cm.total_calls < 5) continue;

          const { rows: qualityRows } = await client.query(
            `SELECT COALESCE(AVG(score), 0)::float AS avg_quality
             FROM call_quality_scores
             WHERE tenant_id = $1 AND scored_at >= $2 AND scored_at < $3`,
            [tenantId, thirtyDaysAgo, now],
          );

          const { rows: conversionRows } = await client.query(
            `SELECT
               COUNT(*) FILTER (WHERE stage = 'booking_confirmed')::int AS bookings,
               COUNT(*) FILTER (WHERE stage = 'call_started')::int AS started
             FROM conversion_events
             WHERE tenant_id = $1 AND created_at >= $2 AND created_at < $3`,
            [tenantId, thirtyDaysAgo, now],
          ).catch(() => ({ rows: [{ bookings: 0, started: 0 }] }));

          const { rows: promptRows } = await client.query(
            `SELECT system_prompt FROM agents
             WHERE tenant_id = $1 AND status = 'deployed' AND system_prompt IS NOT NULL
             LIMIT 10`,
            [tenantId],
          ).catch(() => ({ rows: [] }));

          const rawPrompts = promptRows.map(r => String(r.system_prompt || ''));
          const anonymizedPrompts = extractAnonymizedPromptPatterns(rawPrompts);

          const { rows: transcriptRows } = await client.query(
            `SELECT LEFT(context->>'transcript', 1000) AS transcript_snippet
             FROM call_sessions
             WHERE tenant_id = $1
               AND created_at >= $2 AND created_at < $3
               AND context->>'transcript' IS NOT NULL
             ORDER BY created_at DESC
             LIMIT 50`,
            [tenantId, thirtyDaysAgo, now],
          ).catch(() => ({ rows: [] }));

          const transcripts = transcriptRows.map(r => String(r.transcript_snippet || ''));
          const commonQuestions = extractQuestionPatterns(transcripts);

          const { rows: toolEvents } = await client.query(
            `SELECT event_type, COALESCE((payload->>'tool')::text, 'unknown') AS tool
             FROM call_events
             WHERE tenant_id = $1
               AND event_type IN ('TOOL_START', 'TOOL_END')
               AND occurred_at >= $2 AND occurred_at < $3
             ORDER BY occurred_at
             LIMIT 500`,
            [tenantId, thirtyDaysAgo, now],
          ).catch(() => ({ rows: [] }));

          const workflowSequences = extractWorkflowSequences(
            toolEvents.map(e => ({ eventType: e.event_type as string, tool: e.tool as string })),
          );

          const convRaw = conversionRows[0] || {};
          const convStarted = Number(convRaw.started || 0);
          const convBookings = Number(convRaw.bookings || 0);
          const bookingRate = convStarted > 0 ? convBookings / convStarted : 0;

          const signal: AggregatedSignal = {
            industry,
            totalCalls: cm.total_calls || 0,
            completedCalls: cm.completed || 0,
            failedCalls: cm.failed || 0,
            escalatedCalls: cm.escalated || 0,
            avgDurationSeconds: Math.round(cm.avg_duration || 0),
            avgQualityScore: parseFloat(String(qualityRows[0]?.avg_quality || 0)),
            bookingConversionRate: bookingRate,
            avgResponseTimeSeconds: 0,
            commonQuestions,
            promptPatterns: anonymizedPrompts,
            workflowSequences,
          };

          if (!industrySignals.has(industry)) {
            industrySignals.set(industry, []);
          }
          industrySignals.get(industry)!.push(signal);
          signalsCollected++;
        } catch (err) {
          logger.error('Failed to collect signals from tenant', { tenantId: String(tenant.id), error: String(err) });
        }
      }

      const periodStart = thirtyDaysAgo.toISOString().slice(0, 10);
      const periodEnd = now.toISOString().slice(0, 10);

      for (const [industry, signals] of industrySignals) {
        if (signals.length < 3) continue;

        const avgBookingRate = signals.reduce((s, sig) => s + sig.bookingConversionRate, 0) / signals.length;
        const avgDuration = signals.reduce((s, sig) => s + sig.avgDurationSeconds, 0) / signals.length;
        const avgQuality = signals.reduce((s, sig) => s + sig.avgQualityScore, 0) / signals.length;
        const totalCallsAll = signals.reduce((s, sig) => s + sig.totalCalls, 0);
        const totalCompleted = signals.reduce((s, sig) => s + sig.completedCalls, 0);
        const completionRate = totalCallsAll > 0 ? totalCompleted / totalCallsAll : 0;
        const totalEscalated = signals.reduce((s, sig) => s + sig.escalatedCalls, 0);
        const escalationRate = totalCallsAll > 0 ? totalEscalated / totalCallsAll : 0;

        const sortedBooking = signals.map(s => s.bookingConversionRate).sort((a, b) => a - b);
        const sortedDuration = signals.map(s => s.avgDurationSeconds).sort((a, b) => a - b);
        const sortedQuality = signals.map(s => s.avgQualityScore).sort((a, b) => a - b);

        const p25 = (arr: number[]) => arr[Math.floor(arr.length * 0.25)] || 0;
        const p50 = (arr: number[]) => arr[Math.floor(arr.length * 0.5)] || 0;
        const p75 = (arr: number[]) => arr[Math.floor(arr.length * 0.75)] || 0;

        const benchmarks = [
          { metric: 'booking_conversion_rate', value: avgBookingRate, sorted: sortedBooking },
          { metric: 'avg_call_duration_seconds', value: avgDuration, sorted: sortedDuration },
          { metric: 'avg_quality_score', value: avgQuality, sorted: sortedQuality },
          { metric: 'call_completion_rate', value: completionRate, sorted: signals.map(s => s.totalCalls > 0 ? s.completedCalls / s.totalCalls : 0).sort((a, b) => a - b) },
          { metric: 'escalation_rate', value: escalationRate, sorted: signals.map(s => s.totalCalls > 0 ? s.escalatedCalls / s.totalCalls : 0).sort((a, b) => a - b) },
        ];

        for (const bm of benchmarks) {
          await client.query(
            `INSERT INTO industry_benchmarks (industry_vertical, metric_name, metric_value, sample_size, percentile_25, percentile_50, percentile_75, period_start, period_end, aggregation_run_id)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
             ON CONFLICT (industry_vertical, metric_name, period_start, period_end)
             DO UPDATE SET metric_value = $3, sample_size = $4, percentile_25 = $5, percentile_50 = $6, percentile_75 = $7, aggregation_run_id = $10, updated_at = NOW()`,
            [industry, bm.metric, bm.value, signals.length, p25(bm.sorted), p50(bm.sorted), p75(bm.sorted), periodStart, periodEnd, runId],
          );
        }

        await client.query(
          `INSERT INTO workflow_performance_metrics (industry_vertical, workflow_type, metric_name, metric_value, sample_size, period_start, period_end, aggregation_run_id, metadata)
           VALUES ($1, 'inbound_call', 'completion_rate', $2, $3, $4, $5, $6, $7)`,
          [
            industry, completionRate, signals.length, periodStart, periodEnd, runId,
            JSON.stringify({
              commonQuestions: signals.flatMap(s => s.commonQuestions).slice(0, 20),
              promptPatterns: signals.flatMap(s => s.promptPatterns).slice(0, 10),
              workflowSequences: signals.flatMap(s => s.workflowSequences).slice(0, 10),
            }),
          ],
        );
      }

      await client.query(
        `UPDATE gin_aggregation_runs SET status = 'completed', tenants_processed = $2, signals_collected = $3, completed_at = NOW()
         WHERE id = $1`,
        [runId, tenants.length, signalsCollected],
      );

      logger.info('Aggregation pipeline completed', { runId, tenantsProcessed: tenants.length, signalsCollected });
      return { runId, tenantsProcessed: tenants.length, signalsCollected, status: 'completed' as const };
    } catch (err) {
      await client.query(
        `UPDATE gin_aggregation_runs SET status = 'failed', error_message = $2, completed_at = NOW() WHERE id = $1`,
        [runId, String(err)],
      ).catch(() => {});
      logger.error('Aggregation pipeline failed', { error: String(err) });
      return { runId, tenantsProcessed: 0, signalsCollected: 0, status: 'failed' as const };
    }
  });
}

export async function getAggregationRuns(limit = 20): Promise<Array<Record<string, unknown>>> {
  const pool = getPlatformPool();
  const { rows } = await pool.query(
    `SELECT * FROM gin_aggregation_runs ORDER BY started_at DESC LIMIT $1`,
    [limit],
  );
  return rows;
}
