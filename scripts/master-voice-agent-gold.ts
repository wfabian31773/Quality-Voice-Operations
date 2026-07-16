/**
 * Redaction-safe operator CLI for WP6 / GTM-008.
 *
 * Commands:
 *   pnpm run gold:manifest
 *   pnpm run gold:preflight
 *   pnpm run gold:collect -- --tenant=... --call=... --review=/absolute/path/to/review.json
 *   pnpm run gold:evaluate -- --file=/absolute/path/to/evidence.json
 *   pnpm exec tsx scripts/master-voice-agent-gold.ts --mode=validate --file=...
 *   pnpm exec tsx scripts/master-voice-agent-gold.ts --mode=stream
 */
import { readFileSync, statSync } from 'fs';
import { resolve } from 'path';
import { config as loadDotEnv } from 'dotenv';
import {
  GOLD_CALL_EVIDENCE_SCHEMA_VERSION,
  GOLD_CALL_MIN_FIRST_AUDIO_SAMPLES,
  GOLD_CALL_MIN_INTERRUPTION_SAMPLES,
  GOLD_CALL_MIN_RUNS_PER_SCENARIO,
  assertGoldCallLiveExecutionAllowed,
  buildGoldCallPreflight,
  evaluateGoldCallEvidenceSuite,
  sanitizeStreamDiagnosticForGoldCall,
  validateGoldCallEvidence,
} from '../platform/agent-runtime/masterVoiceAgentGoldCall';
import {
  MASTER_VOICE_AGENT_CORE_VERSION,
  MASTER_VOICE_AGENT_MODEL,
} from '../platform/agent-runtime/masterVoiceAgent';
import {
  MASTER_VOICE_AGENT_GOLD_THRESHOLDS,
  MASTER_VOICE_AGENT_SCENARIOS,
} from '../platform/agent-runtime/masterVoiceAgentEvaluation';
import { HEALTHCARE_RECEPTIONIST_ROLE_VERSION } from '../platform/agent-templates/healthcare-receptionist/rolePackage';

if (process.env.WP6_SKIP_DOTENV !== 'true') loadDotEnv({ quiet: true });

const MAX_EVIDENCE_FILE_BYTES = 5 * 1024 * 1024;
const MAX_EVIDENCE_RECORDS = 10_000;

function parseArgs(argv: string[]): Record<string, string> {
  const args: Record<string, string> = {};
  for (const value of argv) {
    const match = /^--([a-z-]+)=(.*)$/.exec(value);
    if (match && match[2].length <= 2_000) args[match[1]] = match[2];
  }
  return args;
}

function writeJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function readEvidenceFile(fileArg: string | undefined): unknown[] {
  if (!fileArg) throw new Error('file_required');
  const path = resolve(fileArg);
  const stats = statSync(path);
  if (!stats.isFile() || stats.size > MAX_EVIDENCE_FILE_BYTES) throw new Error('file_invalid_or_too_large');
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  if (!Array.isArray(parsed) || parsed.length > MAX_EVIDENCE_RECORDS) throw new Error('evidence_array_required');
  return parsed;
}

function readReviewFile(fileArg: string | undefined): unknown {
  if (!fileArg) throw new Error('review_file_required');
  const path = resolve(fileArg);
  const stats = statSync(path);
  if (!stats.isFile() || stats.size > 64 * 1024) throw new Error('review_file_invalid_or_too_large');
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}

function safeIdentifier(value: string | undefined): string {
  if (!value || value.length > 200 || !/^[A-Za-z0-9][A-Za-z0-9._:-]+$/.test(value)) {
    throw new Error('identifier_invalid');
  }
  return value;
}

function validationSummary(values: unknown[]) {
  const invalidEvidence = values.flatMap((value, index) => {
    const result = validateGoldCallEvidence(value);
    return result.valid ? [] : [{ record: index, errors: result.errors }];
  });
  return { valid: invalidEvidence.length === 0, recordCount: values.length, invalidEvidence };
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const mode = args.mode ?? 'manifest';

  if (mode === 'manifest') {
    writeJson({
      schemaVersion: GOLD_CALL_EVIDENCE_SCHEMA_VERSION,
      coreVersion: MASTER_VOICE_AGENT_CORE_VERSION,
      model: MASTER_VOICE_AGENT_MODEL,
      rolePackageId: 'healthcare-receptionist',
      rolePackageVersion: HEALTHCARE_RECEPTIONIST_ROLE_VERSION,
      thresholds: MASTER_VOICE_AGENT_GOLD_THRESHOLDS,
      sampleFloors: {
        runsPerScenario: GOLD_CALL_MIN_RUNS_PER_SCENARIO,
        firstAudio: GOLD_CALL_MIN_FIRST_AUDIO_SAMPLES,
        interruptionStop: GOLD_CALL_MIN_INTERRUPTION_SAMPLES,
      },
      scenarios: MASTER_VOICE_AGENT_SCENARIOS,
    });
    return 0;
  }

  if (mode === 'preflight') {
    const report = buildGoldCallPreflight(process.env);
    writeJson(report);
    return report.canRunLive ? 0 : 1;
  }

  if (mode === 'validate') {
    const summary = validationSummary(readEvidenceFile(args.file));
    writeJson(summary);
    return summary.valid ? 0 : 1;
  }

  if (mode === 'evaluate') {
    const report = evaluateGoldCallEvidenceSuite(readEvidenceFile(args.file));
    writeJson(report);
    return report.canActivate ? 0 : 1;
  }

  if (mode === 'collect') {
    if (process.env.WP6_TARGET_ENV !== 'staging'
      || process.env.APP_ENV === 'production'
      || process.env.WP6_SYNTHETIC_DATA_ACK !== 'true') {
      throw new Error('collection_not_authorized');
    }
    const tenantId = safeIdentifier(args.tenant);
    const callId = safeIdentifier(args.call);
    const review = readReviewFile(args.review);
    const [{ getPlatformPool, withTenantContext }, { collectMasterVoiceAgentGoldCallEvidence }] = await Promise.all([
      import('../platform/db'),
      import('../server/voice-gateway/services/masterVoiceAgentGoldCallCollector'),
    ]);
    const client = await getPlatformPool().connect();
    try {
      await client.query('BEGIN');
      await withTenantContext(client, tenantId, async () => {});
      const evidence = await collectMasterVoiceAgentGoldCallEvidence(
        client,
        tenantId,
        callId,
        review as Parameters<typeof collectMasterVoiceAgentGoldCallEvidence>[3],
      );
      await client.query('COMMIT');
      writeJson(evidence);
      return 0;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  if (mode === 'stream') {
    assertGoldCallLiveExecutionAllowed(process.env);
    const { runRealtimeStreamDiagnostic } = await import('../server/voice-gateway/services/streamDiagnostic');
    const rawReport = await runRealtimeStreamDiagnostic({ mode: 'full' });
    const report = sanitizeStreamDiagnosticForGoldCall(rawReport);
    writeJson(report);
    return report.ok ? 0 : 1;
  }

  throw new Error('unsupported_mode');
}

main()
  .then((exitCode) => { process.exitCode = exitCode; })
  .catch((error) => {
    const code = error instanceof Error && /^[a-z0-9_]+$/.test(error.message)
      ? error.message
      : 'gold_call_command_failed';
    writeJson({ ok: false, errorCode: code });
    process.exitCode = 2;
  });
