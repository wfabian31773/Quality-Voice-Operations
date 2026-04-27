import { z } from 'zod';

/**
 * Window during which a "live" call event is accepted by `/v1/ingest/calls`.
 * Anything older must be sent through `/v1/ingest/calls/backfill` with an
 * explicit attestation block.
 */
export const INGEST_FRESH_WINDOW_DAYS = 7;

/**
 * Maximum age accepted by `/v1/ingest/calls/backfill`. Events older than this
 * are rejected outright — they would skew historical billing/usage reporting
 * by more than a single billing cycle.
 */
export const INGEST_BACKFILL_WINDOW_DAYS = 30;

export const CallCompletionEventV1Schema = z.object({
  version: z.literal('v1'),
  event_type: z.literal('call.completed'),
  timestamp: z.string().datetime(),
  idempotency_key: z.string().min(1).max(255),
  tenant_id: z.string().min(1),
  agent_remote_id: z.string().min(1).max(120),

  external_id: z.string().min(1),
  twilio_sid: z.string().optional(),
  direction: z.enum(['inbound', 'outbound']),
  from_number: z.string().min(1),
  to_number: z.string().min(1),
  status: z.string().min(1),
  start_time: z.string().datetime(),
  end_time: z.string().datetime(),
  duration_seconds: z.number().int().min(0),

  transferred_to_human: z.boolean().default(false),
  escalation_reason: z.string().optional(),

  transcript: z.string().default(''),
  summary: z.string().optional(),
  recording_url: z.string().url().optional(),

  costs: z.object({
    twilio_cents: z.number().min(0),
    openai_cents: z.number().min(0),
    total_cents: z.number().min(0),
    is_estimated: z.boolean(),
  }),

  tokens: z.object({
    input_audio: z.number().int().min(0),
    output_audio: z.number().int().min(0),
    input_text: z.number().int().min(0),
    output_text: z.number().int().min(0),
  }).optional(),

  quality: z.object({
    sentiment: z.string().optional(),
    agent_outcome: z.string().optional(),
    score: z.number().min(0).max(10).optional(),
    analysis: z.string().optional(),
  }).optional(),

  telemetry: z.object({
    total_turns: z.number().int().min(0),
    interruption_count: z.number().int().min(0).optional(),
    tool_call_count: z.number().int().min(0).optional(),
    who_hung_up: z.string().optional(),
  }).optional(),
});

export type CallCompletionEventV1 = z.infer<typeof CallCompletionEventV1Schema>;

/**
 * Backfill variant of the call-completion event. Carries the same payload as
 * the live event, plus a mandatory `backfill_attestation` block recording who
 * authorized the late ingest and why. The presence of this block is treated
 * as the operator's signed acknowledgement that the historical figures
 * (usage_metrics, daily_org_usage, billing rollups) will be adjusted.
 */
export const CallBackfillEventV1Schema = CallCompletionEventV1Schema.extend({
  backfill_attestation: z.object({
    reason: z.string().min(8).max(500),
    attested_by: z.string().min(1).max(120),
    original_system: z.string().min(1).max(120).optional(),
    attested_at: z.string().datetime().optional(),
  }),
});

export type CallBackfillEventV1 = z.infer<typeof CallBackfillEventV1Schema>;

export const TicketCreationEventV1Schema = z.object({
  version: z.literal('v1'),
  event_type: z.literal('ticket.created'),
  timestamp: z.string().datetime(),
  idempotency_key: z.string().min(1).max(255),
  tenant_id: z.string().min(1),
  agent_remote_id: z.string().min(1).max(120),

  call_external_id: z.string().optional(),
  subject: z.string().min(1).max(500),
  description: z.string().default(''),
  priority: z.enum(['low', 'medium', 'high', 'urgent']),
  external_number: z.string().optional(),
  patient_first_name: z.string().optional(),
  patient_last_name: z.string().optional(),
  created_at: z.string().datetime(),
});

export type TicketCreationEventV1 = z.infer<typeof TicketCreationEventV1Schema>;
