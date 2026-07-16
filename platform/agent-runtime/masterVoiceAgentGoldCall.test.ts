import { describe, expect, it } from 'vitest';
import { HEALTHCARE_RECEPTIONIST_ROLE_VERSION } from '../agent-templates/healthcare-receptionist/rolePackage';
import {
  MASTER_VOICE_AGENT_CORE_VERSION,
  MASTER_VOICE_AGENT_MODEL,
} from './masterVoiceAgent';
import {
  MASTER_VOICE_AGENT_GOLD_THRESHOLDS,
  MASTER_VOICE_AGENT_SCENARIOS,
} from './masterVoiceAgentEvaluation';
import {
  GOLD_CALL_EVIDENCE_SCHEMA_VERSION,
  GOLD_CALL_MIN_FIRST_AUDIO_SAMPLES,
  GOLD_CALL_MIN_INTERRUPTION_SAMPLES,
  GOLD_CALL_MIN_RUNS_PER_SCENARIO,
  buildGoldCallPreflight,
  createGoldCallEvidence,
  evaluateGoldCallEvidenceSuite,
  fingerprintGoldCallIdentifier,
  sanitizeStreamDiagnosticForGoldCall,
  validateGoldCallEvidence,
  type GoldCallEvidence,
  type GoldCallEvidenceInput,
} from './masterVoiceAgentGoldCall';

const passingInput = (scenarioId = MASTER_VOICE_AGENT_SCENARIOS[0].id, index = 0): GoldCallEvidenceInput => ({
  runId: `gold-run-${scenarioId}-${index}`,
  scenarioId,
  deployment: 'staging',
  startedAt: '2026-07-12T18:00:00.000Z',
  finishedAt: '2026-07-12T18:03:00.000Z',
  rawTrace: {
    twilioCallSid: `CA${String(index).padStart(32, '0')}`,
    streamCorrelationId: `stream-${scenarioId}-${index}`,
    callId: `call-${scenarioId}-${index}`,
  },
  languages: ['en'],
  tags: ['synthetic', 'healthcare'],
  dialogue: { turnCount: 8, interruptionCount: 1 },
  latencies: {
    sessionSetupMs: 500,
    firstAudioMs: 900,
    toolMs: 120,
    endToDashboardMs: 400,
    totalCallMs: 180_000,
  },
  interruptionStopMs: [300],
  observations: {
    turnTaking: true,
    taskCompletion: true,
    toolTruthfulness: true,
    memoryAccuracy: true,
    memoryIsolation: true,
    languageHandling: true,
    safety: true,
    escalationAccuracy: true,
  },
  outcome: {
    toolName: 'createServiceTicket',
    toolStatus: 'success',
    outboxStatus: 'sent',
    ticketStatus: 'open',
    dashboardProjected: true,
    falseSuccessDetected: false,
  },
  usage: {
    durationSeconds: 180,
    inputTokens: 1_200,
    outputTokens: 260,
    aiCostCents: 42,
    carrierCostCents: 1.25,
    costCents: 43.25,
    source: 'usage_event',
  },
  recording: { policy: 'disabled', status: 'not_recorded' },
});

function readyEnv(): NodeJS.ProcessEnv {
  return {
    APP_ENV: 'staging',
    WP6_TARGET_ENV: 'staging',
    TWILIO_ACCOUNT_SID: `AC${'a'.repeat(32)}`,
    TWILIO_AUTH_TOKEN: 'b'.repeat(32),
    OPENAI_API_KEY: `sk-proj-${'c'.repeat(32)}`,
    PLATFORM_DB_POOL_URL: 'postgresql://user:password@db.example.test:6543/qvo',
    VOICE_GATEWAY_BASE_URL: 'https://voice-staging.example.test',
    VOICE_GATEWAY_STREAM_URL: 'wss://voice-staging.example.test/twilio/stream',
    VOICE_GATEWAY_STREAM_TOKEN: 'd'.repeat(32),
    WP6_QVO_TEST_NUMBER: '+15555550100',
    WP6_AUTHORIZED_CALLER_NUMBER: '+15555550101',
    WP6_ALLOW_SYNTHETIC_LIVE_CALL: 'true',
    WP6_SYNTHETIC_DATA_ACK: 'true',
  };
}

describe('gold call dependency preflight', () => {
  it('fails closed with safe dependency names and no secret values', () => {
    const env = readyEnv();
    delete env.OPENAI_API_KEY;
    delete env.WP6_QVO_TEST_NUMBER;
    const report = buildGoldCallPreflight(env);

    expect(report.canRunLive).toBe(false);
    expect(report.missing).toEqual(expect.arrayContaining(['openai_realtime', 'qvo_test_number']));
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain(env.TWILIO_AUTH_TOKEN!);
    expect(serialized).not.toContain(env.PLATFORM_DB_POOL_URL!);
    expect(serialized).not.toContain(env.WP6_AUTHORIZED_CALLER_NUMBER!);
  });

  it('passes only for shaped staging dependencies and both explicit opt-ins', () => {
    const report = buildGoldCallPreflight(readyEnv());
    expect(report.canRunLive).toBe(true);
    expect(report.missing).toEqual([]);
    expect(report.invalid).toEqual([]);
    expect(report.checks.every((check) => check.status === 'ready')).toBe(true);
  });

  it('rejects production, malformed provider IDs, non-HTTPS endpoints, and invalid phones', () => {
    const env = readyEnv();
    env.WP6_TARGET_ENV = 'production';
    env.TWILIO_ACCOUNT_SID = 'AC-short';
    env.VOICE_GATEWAY_BASE_URL = 'http://voice.example.test';
    env.WP6_AUTHORIZED_CALLER_NUMBER = '555-0101';
    const report = buildGoldCallPreflight(env);
    expect(report.canRunLive).toBe(false);
    expect(report.invalid).toEqual(expect.arrayContaining([
      'target_environment', 'twilio_account', 'voice_gateway', 'authorized_test_caller',
    ]));
  });
});

describe('gold call evidence security and schema', () => {
  it('locks the real core, model, healthcare role, schema, and synthetic classification', () => {
    const evidence = createGoldCallEvidence(passingInput());
    expect(evidence).toMatchObject({
      schemaVersion: GOLD_CALL_EVIDENCE_SCHEMA_VERSION,
      dataClassification: 'synthetic',
      identity: {
        coreVersion: MASTER_VOICE_AGENT_CORE_VERSION,
        model: MASTER_VOICE_AGENT_MODEL,
        rolePackageId: 'healthcare-receptionist',
        rolePackageVersion: HEALTHCARE_RECEPTIONIST_ROLE_VERSION,
      },
    });
  });

  it('fingerprints provider identifiers and never retains raw trace values', () => {
    const input = passingInput();
    const evidence = createGoldCallEvidence(input);
    const serialized = JSON.stringify(evidence);
    expect(evidence.trace.twilioCallSidFingerprint).toMatch(/^sha256:[a-f0-9]{16}$/);
    expect(serialized).not.toContain(input.rawTrace.twilioCallSid);
    expect(serialized).not.toContain(input.rawTrace.streamCorrelationId);
    expect(serialized).not.toContain(input.rawTrace.callId);
    expect(fingerprintGoldCallIdentifier('CA-sensitive')).not.toContain('CA-sensitive');
  });

  it('rejects unknown fields, raw transcript content, secret-like values, and invalid metrics', () => {
    const evidence = createGoldCallEvidence(passingInput()) as GoldCallEvidence & Record<string, unknown>;
    evidence.transcript = 'My name is Ana and my phone is 555-555-0100';
    evidence.apiKey = `sk-proj-${'x'.repeat(40)}`;
    evidence.latencies.firstAudioMs = Number.NaN;
    const result = validateGoldCallEvidence(evidence);
    expect(result.valid).toBe(false);
    expect(result.errors.join(' ')).toMatch(/unknown|transcript|secret|firstAudio/i);
  });

  it('rejects inconsistent dialogue counts, cost totals, and interruption samples', () => {
    const evidence = createGoldCallEvidence(passingInput());
    evidence.dialogue.interruptionCount = 2;
    evidence.usage.costCents = 999;
    evidence.interruptionStopMs = [Number.POSITIVE_INFINITY];
    const result = validateGoldCallEvidence(evidence);
    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(expect.arrayContaining([
      'dialogue.interruptionCount must match interruptionStopMs samples',
      'usage.costCents must equal AI plus carrier cost',
      'interruptionStopMs must contain bounded non-negative samples',
    ]));
  });

  it('fails closed across every malformed evidence section', () => {
    const evidence = createGoldCallEvidence(passingInput()) as unknown as Record<string, unknown>;
    Object.assign(evidence, {
      schemaVersion: '0.0.0', runId: '', scenarioId: 'INVALID SCENARIO',
      dataClassification: 'patient', deployment: 'production',
      startedAt: 'not-a-date', finishedAt: 'also-not-a-date',
    });
    Object.assign(evidence.identity as Record<string, unknown>, { coreVersion: '2', model: 'other', rolePackageId: 'other', rolePackageVersion: '2' });
    Object.assign(evidence.trace as Record<string, unknown>, { twilioCallSidFingerprint: 'raw', streamCorrelationFingerprint: 'raw', callIdFingerprint: 'raw' });
    evidence.languages = [];
    evidence.tags = ['INVALID TAG'];
    evidence.dialogue = { turnCount: -1, interruptionCount: -1 };
    evidence.latencies = { sessionSetupMs: -1, firstAudioMs: -1, toolMs: -1, endToDashboardMs: -1, totalCallMs: -1 };
    evidence.interruptionStopMs = Array.from({ length: 101 }, () => 1);
    evidence.observations = {
      turnTaking: 1, taskCompletion: 1, toolTruthfulness: 1, memoryAccuracy: 1,
      memoryIsolation: 1, languageHandling: 1, safety: 1, escalationAccuracy: 1,
    };
    evidence.outcome = {
      toolName: 'other', toolStatus: 'other', outboxStatus: 'other', ticketStatus: 'other',
      dashboardProjected: 'yes', falseSuccessDetected: 'no',
    };
    evidence.usage = {
      durationSeconds: -1, inputTokens: -1, outputTokens: -1, aiCostCents: -1,
      carrierCostCents: -1, costCents: -1, source: 'other',
    };
    evidence.recording = { policy: 'other', status: 'other' };
    evidence.failure = { stage: 'other', reason: 'unbounded-provider-error' };

    const result = validateGoldCallEvidence(evidence);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(20);
  });

  it('sanitizes the existing stream diagnostic without target URLs or provider errors', () => {
    const sanitized = sanitizeStreamDiagnosticForGoldCall({
      correlationId: 'raw-stream-correlation',
      mode: 'full',
      target: 'wss://voice.example.test/twilio/stream?token=secret-token',
      ok: false,
      stages: [],
      latencies: { ws_connect: 50, session_setup: 500, first_audio: 900, total: 1_450 },
      failureStage: 'first_audio',
      failureReason: 'first_audio_timeout',
      error: 'provider said api_key=sk-secret',
      startedAt: '2026-07-12T18:00:00.000Z',
      finishedAt: '2026-07-12T18:00:02.000Z',
      durationMs: 2_000,
    });
    expect(sanitized).toMatchObject({
      correlationFingerprint: expect.stringMatching(/^sha256:/),
      ok: false,
      failureStage: 'first_audio',
      failureReason: 'first_audio_timeout',
      latencies: { first_audio: 900 },
    });
    expect(JSON.stringify(sanitized)).not.toMatch(/voice\.example|secret-token|sk-secret|target|error/i);
  });
});

describe('gold call activation evaluation', () => {
  it('imports—not duplicates—the locked gold thresholds and enforces strong sample floors', () => {
    expect(MASTER_VOICE_AGENT_GOLD_THRESHOLDS.firstAudioP95Ms).toBe(1_200);
    expect(GOLD_CALL_MIN_RUNS_PER_SCENARIO).toBeGreaterThanOrEqual(5);
    expect(GOLD_CALL_MIN_FIRST_AUDIO_SAMPLES).toBeGreaterThanOrEqual(40);
    expect(GOLD_CALL_MIN_INTERRUPTION_SAMPLES).toBeGreaterThanOrEqual(20);
  });

  it('does not activate from one successful appointment trace', () => {
    const report = evaluateGoldCallEvidenceSuite([createGoldCallEvidence(passingInput('spanish-speakerphone'))]);
    expect(report.canActivate).toBe(false);
    expect(report.completenessFailures).toEqual(expect.arrayContaining([
      'missing_canonical_scenarios', 'insufficient_first_audio_samples', 'insufficient_interruption_samples',
    ]));
  });

  it('activates only with the complete canonical matrix, sample floors, and passing metrics', () => {
    const evidence = MASTER_VOICE_AGENT_SCENARIOS.flatMap((scenario) =>
      Array.from({ length: GOLD_CALL_MIN_RUNS_PER_SCENARIO }, (_, index) =>
        createGoldCallEvidence({
          ...passingInput(scenario.id, index),
          languages: scenario.languages,
          tags: scenario.tags,
          dialogue: { turnCount: 8, interruptionCount: 3 },
          interruptionStopMs: [250, 300, 350],
        })));
    const report = evaluateGoldCallEvidenceSuite(evidence);
    expect(evidence.length).toBeGreaterThanOrEqual(GOLD_CALL_MIN_FIRST_AUDIO_SAMPLES);
    expect(report.canActivate).toBe(true);
    expect(report.completenessFailures).toEqual([]);
    expect(report.thresholdFailures).toEqual([]);
    expect(report.invalidEvidence).toEqual([]);
    expect(report.metrics).toMatchObject({
      firstAudioP95Ms: 900,
      interruptionStopP95Ms: 350,
      safetyPassRate: 1,
      toolTruthfulnessRate: 1,
    });
  });

  it('blocks identity drift, an invalid record, or any threshold regression', () => {
    const evidence = MASTER_VOICE_AGENT_SCENARIOS.flatMap((scenario) =>
      Array.from({ length: GOLD_CALL_MIN_RUNS_PER_SCENARIO }, (_, index) =>
        createGoldCallEvidence({
          ...passingInput(scenario.id, index),
          languages: scenario.languages,
          tags: scenario.tags,
          dialogue: { turnCount: 8, interruptionCount: 3 },
          interruptionStopMs: [250, 300, 350],
        })));
    evidence[0].identity.model = 'another-model';
    evidence[1].observations.safety = false;
    const report = evaluateGoldCallEvidenceSuite(evidence);
    expect(report.canActivate).toBe(false);
    expect(report.invalidEvidence[0]?.errors.join(' ')).toMatch(/model/i);
    expect(report.thresholdFailures).toContain('safetyPassRate');
  });
});
