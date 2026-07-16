import { createHash } from 'crypto';
import { HEALTHCARE_RECEPTIONIST_ROLE_VERSION } from '../agent-templates/healthcare-receptionist/rolePackage';
import {
  MASTER_VOICE_AGENT_CORE_VERSION,
  MASTER_VOICE_AGENT_MODEL,
} from './masterVoiceAgent';
import {
  MASTER_VOICE_AGENT_GOLD_THRESHOLDS,
  MASTER_VOICE_AGENT_SCENARIOS,
  evaluateMasterVoiceAgent,
  type MasterVoiceAgentEvaluationMetrics,
  type MasterVoiceAgentMetric,
} from './masterVoiceAgentEvaluation';

export const GOLD_CALL_EVIDENCE_SCHEMA_VERSION = '1.0.0';
export const GOLD_CALL_MIN_RUNS_PER_SCENARIO = 5;
export const GOLD_CALL_MIN_FIRST_AUDIO_SAMPLES = 40;
export const GOLD_CALL_MIN_INTERRUPTION_SAMPLES = 20;

type DependencyStatus = 'ready' | 'missing' | 'invalid';

export interface GoldCallDependencyCheck {
  name: string;
  status: DependencyStatus;
  detail: string;
}

export interface GoldCallPreflightReport {
  schemaVersion: typeof GOLD_CALL_EVIDENCE_SCHEMA_VERSION;
  canRunLive: boolean;
  checks: GoldCallDependencyCheck[];
  missing: string[];
  invalid: string[];
  requiredEnvironmentKeys: string[];
}

const REQUIRED_ENVIRONMENT_KEYS = Object.freeze([
  'WP6_TARGET_ENV',
  'TWILIO_ACCOUNT_SID',
  'TWILIO_AUTH_TOKEN',
  'OPENAI_API_KEY',
  'DATABASE_URL or PLATFORM_DB_POOL_URL',
  'VOICE_GATEWAY_BASE_URL',
  'VOICE_GATEWAY_STREAM_URL',
  'VOICE_GATEWAY_STREAM_TOKEN',
  'WP6_QVO_TEST_NUMBER',
  'WP6_AUTHORIZED_CALLER_NUMBER',
  'WP6_SYNTHETIC_DATA_ACK',
  'WP6_ALLOW_SYNTHETIC_LIVE_CALL',
]);

function dependencyCheck(
  name: string,
  values: Array<string | undefined>,
  valid: () => boolean,
  detail: string,
): GoldCallDependencyCheck {
  if (values.some((value) => !value)) return { name, status: 'missing', detail: 'not configured' };
  return valid()
    ? { name, status: 'ready', detail }
    : { name, status: 'invalid', detail: 'configured value does not meet the WP6 safety contract' };
}

function isHttpsUrl(value: string | undefined): boolean {
  if (!value) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && Boolean(url.hostname);
  } catch {
    return false;
  }
}

function isWssUrl(value: string | undefined): boolean {
  if (!value) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'wss:' && Boolean(url.hostname);
  } catch {
    return false;
  }
}

function isPostgresUrl(value: string | undefined): boolean {
  if (!value) return false;
  try {
    const url = new URL(value);
    return (url.protocol === 'postgres:' || url.protocol === 'postgresql:') && Boolean(url.hostname);
  } catch {
    return false;
  }
}

function isE164(value: string | undefined): boolean {
  return typeof value === 'string' && /^\+[1-9][0-9]{7,14}$/.test(value);
}

export function buildGoldCallPreflight(env: NodeJS.ProcessEnv): GoldCallPreflightReport {
  const databaseUrl = env.PLATFORM_DB_POOL_URL || env.DATABASE_URL;
  const checks: GoldCallDependencyCheck[] = [
    dependencyCheck(
      'target_environment',
      [env.WP6_TARGET_ENV],
      () => env.WP6_TARGET_ENV === 'staging' && env.APP_ENV !== 'production',
      'explicit non-production staging target',
    ),
    dependencyCheck(
      'twilio_account',
      [env.TWILIO_ACCOUNT_SID, env.TWILIO_AUTH_TOKEN],
      () => /^AC[a-f0-9]{32}$/i.test(env.TWILIO_ACCOUNT_SID ?? '')
        && /^[A-Za-z0-9]{16,128}$/.test(env.TWILIO_AUTH_TOKEN ?? ''),
      'account credentials shaped and present',
    ),
    dependencyCheck(
      'openai_realtime',
      [env.OPENAI_API_KEY],
      () => /^sk-[A-Za-z0-9_-]{16,200}$/.test(env.OPENAI_API_KEY ?? ''),
      'Realtime credential shaped and present',
    ),
    dependencyCheck(
      'database',
      [databaseUrl],
      () => isPostgresUrl(databaseUrl),
      'PostgreSQL target shaped and present',
    ),
    dependencyCheck(
      'voice_gateway',
      [env.VOICE_GATEWAY_BASE_URL, env.VOICE_GATEWAY_STREAM_URL, env.VOICE_GATEWAY_STREAM_TOKEN],
      () => isHttpsUrl(env.VOICE_GATEWAY_BASE_URL)
        && isWssUrl(env.VOICE_GATEWAY_STREAM_URL)
        && /^[A-Za-z0-9._~-]{16,256}$/.test(env.VOICE_GATEWAY_STREAM_TOKEN ?? ''),
      'HTTPS/WSS staging gateway and stream authentication configured',
    ),
    dependencyCheck(
      'qvo_test_number',
      [env.WP6_QVO_TEST_NUMBER],
      () => isE164(env.WP6_QVO_TEST_NUMBER),
      'synthetic QVO test number configured',
    ),
    dependencyCheck(
      'authorized_test_caller',
      [env.WP6_AUTHORIZED_CALLER_NUMBER],
      () => isE164(env.WP6_AUTHORIZED_CALLER_NUMBER),
      'authorized synthetic caller configured',
    ),
    dependencyCheck(
      'synthetic_data_ack',
      [env.WP6_SYNTHETIC_DATA_ACK],
      () => env.WP6_SYNTHETIC_DATA_ACK === 'true',
      'synthetic-data-only acknowledgement enabled',
    ),
    dependencyCheck(
      'live_call_opt_in',
      [env.WP6_ALLOW_SYNTHETIC_LIVE_CALL],
      () => env.WP6_ALLOW_SYNTHETIC_LIVE_CALL === 'true',
      'explicit live-call opt-in enabled',
    ),
  ];
  const missing = checks.filter((check) => check.status === 'missing').map((check) => check.name);
  const invalid = checks.filter((check) => check.status === 'invalid').map((check) => check.name);
  return {
    schemaVersion: GOLD_CALL_EVIDENCE_SCHEMA_VERSION,
    canRunLive: missing.length === 0 && invalid.length === 0,
    checks,
    missing,
    invalid,
    requiredEnvironmentKeys: [...REQUIRED_ENVIRONMENT_KEYS],
  };
}

export function assertGoldCallLiveExecutionAllowed(env: NodeJS.ProcessEnv): void {
  const report = buildGoldCallPreflight(env);
  if (!report.canRunLive) {
    const blockers = [...report.missing, ...report.invalid].join(', ');
    throw new Error(`WP6 live execution is not authorized; dependency checks failed: ${blockers}`);
  }
}

export type GoldCallFailureStage = 'preflight' | 'carrier' | 'ws_connect' | 'session_setup' | 'first_audio' | 'conversation' | 'tool' | 'persistence' | 'dashboard';
export type GoldCallFailureReason = 'dependency_missing' | 'dependency_invalid' | 'auth_rejected' | 'connect_timeout' | 'connect_refused' | 'bad_handshake' | 'setup_timeout' | 'setup_error' | 'first_audio_timeout' | 'closed_early' | 'tool_failed' | 'persistence_failed' | 'dashboard_failed' | 'other';

export interface GoldCallEvidence {
  schemaVersion: typeof GOLD_CALL_EVIDENCE_SCHEMA_VERSION;
  runId: string;
  scenarioId: string;
  dataClassification: 'synthetic';
  deployment: 'staging';
  startedAt: string;
  finishedAt: string;
  identity: {
    coreVersion: string;
    model: string;
    rolePackageId: 'healthcare-receptionist';
    rolePackageVersion: string;
  };
  trace: {
    twilioCallSidFingerprint: string;
    streamCorrelationFingerprint: string;
    callIdFingerprint: string;
  };
  languages: string[];
  tags: string[];
  dialogue: {
    turnCount: number;
    interruptionCount: number;
  };
  latencies: {
    sessionSetupMs: number;
    firstAudioMs: number;
    toolMs: number | null;
    endToDashboardMs: number | null;
    totalCallMs: number;
  };
  interruptionStopMs: number[];
  observations: {
    turnTaking: boolean;
    taskCompletion: boolean;
    toolTruthfulness: boolean;
    memoryAccuracy: boolean;
    memoryIsolation: boolean;
    languageHandling: boolean;
    safety: boolean;
    escalationAccuracy: boolean;
  };
  outcome: {
    toolName: 'createServiceTicket' | null;
    toolStatus: 'success' | 'failed' | 'not_invoked';
    outboxStatus: 'sent' | 'pending' | 'retry' | 'failed' | 'not_applicable';
    ticketStatus: 'open' | 'in_progress' | 'resolved' | 'queued' | 'not_applicable';
    dashboardProjected: boolean;
    falseSuccessDetected: boolean;
  };
  usage: {
    durationSeconds: number;
    inputTokens: number;
    outputTokens: number;
    aiCostCents: number;
    carrierCostCents: number;
    costCents: number;
    source: 'usage_event' | 'estimate';
  };
  recording: {
    policy: 'disabled' | 'enabled';
    status: 'not_recorded' | 'recorded' | 'unavailable';
  };
  failure: { stage: GoldCallFailureStage; reason: GoldCallFailureReason } | null;
}

export interface GoldCallEvidenceInput {
  runId: string;
  scenarioId: string;
  deployment: 'staging';
  startedAt: string;
  finishedAt: string;
  rawTrace: {
    twilioCallSid: string;
    streamCorrelationId: string;
    callId: string;
  };
  languages: string[];
  tags: string[];
  dialogue: GoldCallEvidence['dialogue'];
  latencies: {
    sessionSetupMs: number;
    firstAudioMs: number;
    toolMs?: number | null;
    endToDashboardMs?: number | null;
    totalCallMs: number;
  };
  interruptionStopMs: number[];
  observations: GoldCallEvidence['observations'];
  outcome: GoldCallEvidence['outcome'];
  usage: GoldCallEvidence['usage'];
  recording: GoldCallEvidence['recording'];
  failure?: GoldCallEvidence['failure'];
}

export function fingerprintGoldCallIdentifier(value: string): string {
  if (!value || value.length > 500) throw new Error('Gold call identifier must contain 1 to 500 characters');
  return `sha256:${createHash('sha256').update(value).digest('hex').slice(0, 16)}`;
}

export function createGoldCallEvidence(input: GoldCallEvidenceInput): GoldCallEvidence {
  const evidence: GoldCallEvidence = {
    schemaVersion: GOLD_CALL_EVIDENCE_SCHEMA_VERSION,
    runId: input.runId,
    scenarioId: input.scenarioId,
    dataClassification: 'synthetic',
    deployment: input.deployment,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    identity: {
      coreVersion: MASTER_VOICE_AGENT_CORE_VERSION,
      model: MASTER_VOICE_AGENT_MODEL,
      rolePackageId: 'healthcare-receptionist',
      rolePackageVersion: HEALTHCARE_RECEPTIONIST_ROLE_VERSION,
    },
    trace: {
      twilioCallSidFingerprint: fingerprintGoldCallIdentifier(input.rawTrace.twilioCallSid),
      streamCorrelationFingerprint: fingerprintGoldCallIdentifier(input.rawTrace.streamCorrelationId),
      callIdFingerprint: fingerprintGoldCallIdentifier(input.rawTrace.callId),
    },
    languages: [...input.languages],
    tags: [...input.tags],
    dialogue: { ...input.dialogue },
    latencies: {
      sessionSetupMs: input.latencies.sessionSetupMs,
      firstAudioMs: input.latencies.firstAudioMs,
      toolMs: input.latencies.toolMs ?? null,
      endToDashboardMs: input.latencies.endToDashboardMs ?? null,
      totalCallMs: input.latencies.totalCallMs,
    },
    interruptionStopMs: [...input.interruptionStopMs],
    observations: { ...input.observations },
    outcome: { ...input.outcome },
    usage: { ...input.usage },
    recording: { ...input.recording },
    failure: input.failure ? { ...input.failure } : null,
  };
  const validation = validateGoldCallEvidence(evidence);
  if (!validation.valid) throw new Error(`Invalid gold call evidence: ${validation.errors.join('; ')}`);
  return evidence;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function rejectUnknownKeys(
  value: unknown,
  allowed: readonly string[],
  path: string,
  errors: string[],
): value is Record<string, unknown> {
  if (!isRecord(value)) {
    errors.push(`${path} must be an object`);
    return false;
  }
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) errors.push(`unknown field ${path}.${key}`);
  }
  return true;
}

function finiteNonNegative(value: unknown): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function boundedText(value: unknown, max = 120): boolean {
  return typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000-\u001F]/.test(value);
}

function validIso(value: unknown): boolean {
  return typeof value === 'string' && value.length <= 40 && !Number.isNaN(new Date(value).getTime());
}

function scanForSensitiveContent(value: unknown, path: string, errors: string[]): void {
  if (typeof value === 'string') {
    if (/\bsk-(?:proj-)?[A-Za-z0-9_-]{12,}\b|postgres(?:ql)?:\/\/[^\s]+|\bAC[a-f0-9]{32}\b|\+?[1-9][0-9]{9,14}\b/i.test(value)) {
      errors.push(`secret or raw identifier detected at ${path}`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => scanForSensitiveContent(item, `${path}[${index}]`, errors));
    return;
  }
  if (isRecord(value)) {
    for (const [key, child] of Object.entries(value)) {
      const normalizedKey = key.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase();
      if (/(?:^|_)(?:secret|password|api_?key|auth_?token|access_?token|transcript|phone_?number|database_?url|raw_?error)(?:$|_)/.test(normalizedKey)) {
        errors.push(`sensitive or prohibited field ${path}.${key}`);
      }
      scanForSensitiveContent(child, `${path}.${key}`, errors);
    }
  }
}

export function validateGoldCallEvidence(value: unknown): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  scanForSensitiveContent(value, 'evidence', errors);
  if (!rejectUnknownKeys(value, [
    'schemaVersion', 'runId', 'scenarioId', 'dataClassification', 'deployment', 'startedAt', 'finishedAt',
    'identity', 'trace', 'languages', 'tags', 'dialogue', 'latencies', 'interruptionStopMs',
    'observations', 'outcome', 'usage', 'recording', 'failure',
  ], 'evidence', errors)) return { valid: false, errors };

  if (value.schemaVersion !== GOLD_CALL_EVIDENCE_SCHEMA_VERSION) errors.push('schemaVersion is not supported');
  if (!boundedText(value.runId) || !/^[A-Za-z0-9][A-Za-z0-9._:-]+$/.test(String(value.runId))) errors.push('runId is invalid');
  const canonicalScenarioIds = new Set(MASTER_VOICE_AGENT_SCENARIOS.map((scenario) => scenario.id));
  if (!boundedText(value.scenarioId)
    || !/^[a-z0-9][a-z0-9-]+$/.test(String(value.scenarioId))
    || !canonicalScenarioIds.has(String(value.scenarioId))) errors.push('scenarioId is invalid');
  if (value.dataClassification !== 'synthetic') errors.push('dataClassification must be synthetic');
  if (value.deployment !== 'staging') errors.push('deployment must be staging');
  if (!validIso(value.startedAt) || !validIso(value.finishedAt)) errors.push('timestamps must be valid ISO values');
  if (validIso(value.startedAt) && validIso(value.finishedAt)
    && new Date(String(value.finishedAt)).getTime() < new Date(String(value.startedAt)).getTime()) {
    errors.push('finishedAt must not precede startedAt');
  }

  if (rejectUnknownKeys(value.identity, ['coreVersion', 'model', 'rolePackageId', 'rolePackageVersion'], 'identity', errors)) {
    if (value.identity.coreVersion !== MASTER_VOICE_AGENT_CORE_VERSION) errors.push('identity coreVersion drifted from the locked core');
    if (value.identity.model !== MASTER_VOICE_AGENT_MODEL) errors.push('identity model drifted from the locked model');
    if (value.identity.rolePackageId !== 'healthcare-receptionist') errors.push('identity rolePackageId is invalid');
    if (value.identity.rolePackageVersion !== HEALTHCARE_RECEPTIONIST_ROLE_VERSION) errors.push('identity rolePackageVersion drifted');
  }

  if (rejectUnknownKeys(value.trace, ['twilioCallSidFingerprint', 'streamCorrelationFingerprint', 'callIdFingerprint'], 'trace', errors)) {
    for (const key of ['twilioCallSidFingerprint', 'streamCorrelationFingerprint', 'callIdFingerprint']) {
      if (!/^sha256:[a-f0-9]{16}$/.test(String(value.trace[key] ?? ''))) errors.push(`trace.${key} is invalid`);
    }
  }

  if (!Array.isArray(value.languages) || value.languages.length === 0 || value.languages.length > 8
    || value.languages.some((language) => typeof language !== 'string' || !/^[a-z]{2,3}(?:-[A-Z]{2})?$/.test(language))) {
    errors.push('languages must contain 1 to 8 language codes');
  }
  if (!Array.isArray(value.tags) || value.tags.length === 0 || value.tags.length > 20
    || value.tags.some((tag) => typeof tag !== 'string' || !/^[a-z0-9][a-z0-9-]{0,49}$/.test(tag))) {
    errors.push('tags are invalid');
  }

  if (rejectUnknownKeys(value.dialogue, ['turnCount', 'interruptionCount'], 'dialogue', errors)) {
    for (const key of ['turnCount', 'interruptionCount']) {
      if (!Number.isSafeInteger(value.dialogue[key]) || Number(value.dialogue[key]) < 0) {
        errors.push(`dialogue.${key} must be a non-negative safe integer`);
      }
    }
    if (Number(value.dialogue.interruptionCount) !== (Array.isArray(value.interruptionStopMs) ? value.interruptionStopMs.length : -1)) {
      errors.push('dialogue.interruptionCount must match interruptionStopMs samples');
    }
  }

  if (rejectUnknownKeys(value.latencies, ['sessionSetupMs', 'firstAudioMs', 'toolMs', 'endToDashboardMs', 'totalCallMs'], 'latencies', errors)) {
    for (const key of ['sessionSetupMs', 'firstAudioMs', 'totalCallMs']) {
      if (!finiteNonNegative(value.latencies[key])) errors.push(`latencies.${key} must be finite and non-negative`);
    }
    for (const key of ['toolMs', 'endToDashboardMs']) {
      if (value.latencies[key] !== null && !finiteNonNegative(value.latencies[key])) errors.push(`latencies.${key} must be null or finite and non-negative`);
    }
  }
  if (!Array.isArray(value.interruptionStopMs) || value.interruptionStopMs.length > 100
    || value.interruptionStopMs.some((sample) => !finiteNonNegative(sample))) {
    errors.push('interruptionStopMs must contain bounded non-negative samples');
  }

  const observationKeys = [
    'turnTaking', 'taskCompletion', 'toolTruthfulness', 'memoryAccuracy', 'memoryIsolation',
    'languageHandling', 'safety', 'escalationAccuracy',
  ];
  if (rejectUnknownKeys(value.observations, observationKeys, 'observations', errors)) {
    for (const key of observationKeys) {
      if (typeof value.observations[key] !== 'boolean') errors.push(`observations.${key} must be boolean`);
    }
  }

  if (rejectUnknownKeys(value.outcome, ['toolName', 'toolStatus', 'outboxStatus', 'ticketStatus', 'dashboardProjected', 'falseSuccessDetected'], 'outcome', errors)) {
    if (value.outcome.toolName !== null && value.outcome.toolName !== 'createServiceTicket') errors.push('outcome.toolName is invalid');
    if (!['success', 'failed', 'not_invoked'].includes(String(value.outcome.toolStatus))) errors.push('outcome.toolStatus is invalid');
    if (!['sent', 'pending', 'retry', 'failed', 'not_applicable'].includes(String(value.outcome.outboxStatus))) errors.push('outcome.outboxStatus is invalid');
    if (!['open', 'in_progress', 'resolved', 'queued', 'not_applicable'].includes(String(value.outcome.ticketStatus))) errors.push('outcome.ticketStatus is invalid');
    if (typeof value.outcome.dashboardProjected !== 'boolean' || typeof value.outcome.falseSuccessDetected !== 'boolean') errors.push('outcome truth fields must be boolean');
    if (value.outcome.toolName === 'createServiceTicket' && isRecord(value.latencies) && value.latencies.toolMs === null) {
      errors.push('tool latency is required when createServiceTicket was invoked');
    }
    if (value.outcome.dashboardProjected === true && isRecord(value.latencies) && value.latencies.endToDashboardMs === null) {
      errors.push('dashboard latency is required when the outcome was projected');
    }
  }

  if (rejectUnknownKeys(value.usage, ['durationSeconds', 'inputTokens', 'outputTokens', 'aiCostCents', 'carrierCostCents', 'costCents', 'source'], 'usage', errors)) {
    for (const key of ['durationSeconds', 'inputTokens', 'outputTokens', 'aiCostCents', 'carrierCostCents', 'costCents']) {
      if (!finiteNonNegative(value.usage[key])) errors.push(`usage.${key} must be finite and non-negative`);
    }
    if (finiteNonNegative(value.usage.aiCostCents) && finiteNonNegative(value.usage.carrierCostCents)
      && finiteNonNegative(value.usage.costCents)
      && Math.abs(Number(value.usage.costCents) - Number(value.usage.aiCostCents) - Number(value.usage.carrierCostCents)) > 0.0001) {
      errors.push('usage.costCents must equal AI plus carrier cost');
    }
    if (!['usage_event', 'estimate'].includes(String(value.usage.source))) errors.push('usage.source is invalid');
  }

  if (rejectUnknownKeys(value.recording, ['policy', 'status'], 'recording', errors)) {
    if (!['disabled', 'enabled'].includes(String(value.recording.policy))) errors.push('recording.policy is invalid');
    if (!['not_recorded', 'recorded', 'unavailable'].includes(String(value.recording.status))) errors.push('recording.status is invalid');
    if (value.recording.policy === 'disabled' && value.recording.status === 'recorded') errors.push('disabled recording policy cannot report recorded audio');
  }

  if (value.failure !== null) {
    if (rejectUnknownKeys(value.failure, ['stage', 'reason'], 'failure', errors)) {
      const stages: GoldCallFailureStage[] = ['preflight', 'carrier', 'ws_connect', 'session_setup', 'first_audio', 'conversation', 'tool', 'persistence', 'dashboard'];
      const reasons: GoldCallFailureReason[] = ['dependency_missing', 'dependency_invalid', 'auth_rejected', 'connect_timeout', 'connect_refused', 'bad_handshake', 'setup_timeout', 'setup_error', 'first_audio_timeout', 'closed_early', 'tool_failed', 'persistence_failed', 'dashboard_failed', 'other'];
      if (!stages.includes(value.failure.stage as GoldCallFailureStage)) errors.push('failure.stage is invalid');
      if (!reasons.includes(value.failure.reason as GoldCallFailureReason)) errors.push('failure.reason is invalid');
    }
  }
  return { valid: errors.length === 0, errors: [...new Set(errors)] };
}

export interface GoldCallStreamDiagnosticInput {
  correlationId: string;
  mode: string;
  target?: string;
  ok: boolean;
  stages?: unknown[];
  latencies: Partial<Record<'ws_connect' | 'session_setup' | 'first_audio' | 'total', number>>;
  failureStage?: string;
  failureReason?: string;
  error?: string;
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
}

export interface SanitizedGoldCallStreamDiagnostic {
  correlationFingerprint: string;
  ok: boolean;
  latencies: Partial<Record<'ws_connect' | 'session_setup' | 'first_audio' | 'total', number>>;
  failureStage?: 'ws_connect' | 'session_setup' | 'first_audio' | 'total';
  failureReason?: GoldCallFailureReason;
}

export function sanitizeStreamDiagnosticForGoldCall(
  report: GoldCallStreamDiagnosticInput,
): SanitizedGoldCallStreamDiagnostic {
  const latencies: SanitizedGoldCallStreamDiagnostic['latencies'] = {};
  for (const key of ['ws_connect', 'session_setup', 'first_audio', 'total'] as const) {
    const sample = report.latencies[key];
    if (finiteNonNegative(sample)) latencies[key] = sample;
  }
  const allowedStages = new Set(['ws_connect', 'session_setup', 'first_audio', 'total']);
  const reasonMap = new Set<GoldCallFailureReason>([
    'auth_rejected', 'connect_timeout', 'connect_refused', 'bad_handshake', 'setup_timeout',
    'setup_error', 'first_audio_timeout', 'closed_early', 'other',
  ]);
  const failureStage = allowedStages.has(report.failureStage ?? '')
    ? report.failureStage as SanitizedGoldCallStreamDiagnostic['failureStage']
    : undefined;
  const failureReason = report.failureReason
    ? reasonMap.has(report.failureReason as GoldCallFailureReason)
      ? report.failureReason as GoldCallFailureReason
      : 'other'
    : undefined;
  return {
    correlationFingerprint: fingerprintGoldCallIdentifier(report.correlationId),
    ok: report.ok,
    latencies,
    ...(failureStage ? { failureStage } : {}),
    ...(failureReason ? { failureReason } : {}),
  };
}

function percentile95(samples: number[]): number {
  if (samples.length === 0) return Number.NaN;
  const sorted = [...samples].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)];
}

function observationRate(
  evidence: GoldCallEvidence[],
  key: keyof GoldCallEvidence['observations'],
): number {
  if (evidence.length === 0) return Number.NaN;
  return evidence.filter((record) => record.observations[key]).length / evidence.length;
}

export interface GoldCallSuiteEvaluation {
  canActivate: boolean;
  metrics: MasterVoiceAgentEvaluationMetrics;
  thresholdFailures: MasterVoiceAgentMetric[];
  completenessFailures: string[];
  invalidEvidence: Array<{ runId: string; errors: string[] }>;
  scenarioCounts: Record<string, number>;
  sampleCounts: { firstAudio: number; interruptionStop: number };
  thresholds: typeof MASTER_VOICE_AGENT_GOLD_THRESHOLDS;
}

export function evaluateGoldCallEvidenceSuite(values: unknown[]): GoldCallSuiteEvaluation {
  const validEvidence: GoldCallEvidence[] = [];
  const invalidEvidence: GoldCallSuiteEvaluation['invalidEvidence'] = [];
  values.forEach((value, index) => {
    const validation = validateGoldCallEvidence(value);
    if (validation.valid) validEvidence.push(value as GoldCallEvidence);
    else invalidEvidence.push({
      runId: isRecord(value) && typeof value.runId === 'string' ? value.runId : `record-${index}`,
      errors: validation.errors,
    });
  });

  const firstAudioSamples = validEvidence.map((record) => record.latencies.firstAudioMs);
  const interruptionSamples = validEvidence.flatMap((record) => record.interruptionStopMs);
  const metrics: MasterVoiceAgentEvaluationMetrics = {
    firstAudioP95Ms: percentile95(firstAudioSamples),
    interruptionStopP95Ms: percentile95(interruptionSamples),
    turnTakingPassRate: observationRate(validEvidence, 'turnTaking'),
    taskCompletionRate: observationRate(validEvidence, 'taskCompletion'),
    toolTruthfulnessRate: observationRate(validEvidence, 'toolTruthfulness'),
    memoryAccuracyRate: observationRate(validEvidence, 'memoryAccuracy'),
    memoryIsolationRate: observationRate(validEvidence, 'memoryIsolation'),
    languageHandlingRate: observationRate(validEvidence, 'languageHandling'),
    safetyPassRate: observationRate(validEvidence, 'safety'),
    escalationAccuracyRate: observationRate(validEvidence, 'escalationAccuracy'),
  };
  const thresholdResult = evaluateMasterVoiceAgent(metrics);

  const scenarioCounts: Record<string, number> = {};
  for (const evidence of validEvidence) {
    scenarioCounts[evidence.scenarioId] = (scenarioCounts[evidence.scenarioId] ?? 0) + 1;
  }
  const canonicalCounts = MASTER_VOICE_AGENT_SCENARIOS.map((scenario) => scenarioCounts[scenario.id] ?? 0);
  const completenessFailures: string[] = [];
  if (canonicalCounts.some((count) => count === 0)) completenessFailures.push('missing_canonical_scenarios');
  if (canonicalCounts.some((count) => count < GOLD_CALL_MIN_RUNS_PER_SCENARIO)) completenessFailures.push('insufficient_runs_per_scenario');
  if (firstAudioSamples.length < GOLD_CALL_MIN_FIRST_AUDIO_SAMPLES) completenessFailures.push('insufficient_first_audio_samples');
  if (interruptionSamples.length < GOLD_CALL_MIN_INTERRUPTION_SAMPLES) completenessFailures.push('insufficient_interruption_samples');

  return {
    canActivate: invalidEvidence.length === 0
      && completenessFailures.length === 0
      && thresholdResult.canActivate,
    metrics,
    thresholdFailures: thresholdResult.failures,
    completenessFailures,
    invalidEvidence,
    scenarioCounts,
    sampleCounts: { firstAudio: firstAudioSamples.length, interruptionStop: interruptionSamples.length },
    thresholds: MASTER_VOICE_AGENT_GOLD_THRESHOLDS,
  };
}
