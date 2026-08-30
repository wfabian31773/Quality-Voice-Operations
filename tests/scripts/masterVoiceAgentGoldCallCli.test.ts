import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawnSync } from 'child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { createGoldCallEvidence } from '../../platform/agent-runtime/masterVoiceAgentGoldCall';
import { MASTER_VOICE_AGENT_SCENARIOS } from '../../platform/agent-runtime/masterVoiceAgentEvaluation';

const packageJson = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as {
  scripts: Record<string, string>;
};
const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

function runCli(args: string[], extraEnv: NodeJS.ProcessEnv = {}) {
  return spawnSync('pnpm', ['exec', 'tsx', 'scripts/master-voice-agent-gold.ts', ...args], {
    cwd: process.cwd(),
    env: { ...process.env, WP6_SKIP_DOTENV: 'true', ...extraEnv },
    encoding: 'utf8',
    timeout: 15_000,
  });
}

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

describe('Master Voice Agent gold-call CLI', () => {
  it('registers one-command manifest, preflight, collection, and evaluation scripts', () => {
    expect(packageJson.scripts['gold:manifest']).toBe('tsx scripts/master-voice-agent-gold.ts --mode=manifest');
    expect(packageJson.scripts['gold:preflight']).toBe('tsx scripts/master-voice-agent-gold.ts --mode=preflight');
    expect(packageJson.scripts['gold:collect']).toBe('tsx scripts/master-voice-agent-gold.ts --mode=collect');
    expect(packageJson.scripts['gold:evaluate']).toBe('tsx scripts/master-voice-agent-gold.ts --mode=evaluate');
  });

  it('prints the locked manifest without credentials or mutable thresholds', () => {
    const result = runCli(['--mode=manifest']);
    expect(result.status).toBe(0);
    const output = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(output).toMatchObject({
      coreVersion: '2.0.0',
      model: 'grok-voice-think-fast-2.0',
      rolePackageId: 'healthcare-receptionist',
      rolePackageVersion: '1.0.0',
    });
    expect((output.scenarios as unknown[]).length).toBe(MASTER_VOICE_AGENT_SCENARIOS.length);
    expect(JSON.stringify(output)).not.toMatch(/auth.?token|api.?key|database.?url/i);
  });

  it('returns a safe green preflight only when every dependency and opt-in is ready', () => {
    const env = readyEnv();
    const result = runCli(['--mode=preflight'], env);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ canRunLive: true, missing: [], invalid: [] });
    expect(result.stdout).not.toContain(env.TWILIO_AUTH_TOKEN!);
    expect(result.stdout).not.toContain(env.PLATFORM_DB_POOL_URL!);
    expect(result.stdout).not.toContain(env.WP6_AUTHORIZED_CALLER_NUMBER!);
  });

  it('exits non-zero with dependency names—not values—when live proof is unavailable', () => {
    const result = runCli(['--mode=preflight'], { APP_ENV: 'staging', WP6_TARGET_ENV: 'staging' });
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({ canRunLive: false });
    expect(result.stdout).toMatch(/openai_realtime|twilio_account|qvo_test_number/);
  });

  it('validates and evaluates a redacted evidence file without echoing its contents', () => {
    const dir = mkdtempSync(join(tmpdir(), 'qvo-gold-call-'));
    tempDirs.push(dir);
    const file = join(dir, 'evidence.json');
    const evidence = createGoldCallEvidence({
      runId: 'gold-cli-one',
      scenarioId: 'spanish-speakerphone',
      deployment: 'staging',
      startedAt: '2026-07-12T18:00:00.000Z',
      finishedAt: '2026-07-12T18:03:00.000Z',
      rawTrace: { twilioCallSid: `CA${'1'.repeat(32)}`, streamCorrelationId: 'stream-cli', callId: 'call-cli' },
      languages: ['es', 'en'],
      tags: ['code-switch', 'interruption'],
      dialogue: { turnCount: 8, interruptionCount: 1 },
      latencies: { sessionSetupMs: 500, firstAudioMs: 900, toolMs: 120, endToDashboardMs: 400, totalCallMs: 180_000 },
      interruptionStopMs: [300],
      observations: {
        turnTaking: true, taskCompletion: true, toolTruthfulness: true, memoryAccuracy: true,
        memoryIsolation: true, languageHandling: true, safety: true, escalationAccuracy: true,
      },
      outcome: {
        toolName: 'createServiceTicket', toolStatus: 'success', outboxStatus: 'sent',
        ticketStatus: 'open', dashboardProjected: true, falseSuccessDetected: false,
      },
      usage: { durationSeconds: 180, inputTokens: 1_200, outputTokens: 260, aiCostCents: 42, carrierCostCents: 1.25, costCents: 43.25, source: 'usage_event' },
      recording: { policy: 'disabled', status: 'not_recorded' },
    });
    writeFileSync(file, JSON.stringify([evidence]));

    const validate = runCli(['--mode=validate', `--file=${file}`]);
    expect(validate.status).toBe(0);
    expect(JSON.parse(validate.stdout)).toEqual({ valid: true, recordCount: 1, invalidEvidence: [] });

    const evaluate = runCli(['--mode=evaluate', `--file=${file}`]);
    expect(evaluate.status).toBe(1);
    expect(JSON.parse(evaluate.stdout)).toMatchObject({
      canActivate: false,
      completenessFailures: expect.arrayContaining(['missing_canonical_scenarios']),
    });
    expect(evaluate.stdout).not.toContain('gold-cli-one');
  });

  it('fails safely on a file containing prohibited transcript data', () => {
    const dir = mkdtempSync(join(tmpdir(), 'qvo-gold-call-'));
    tempDirs.push(dir);
    const file = join(dir, 'unsafe.json');
    writeFileSync(file, JSON.stringify([{ transcript: 'Caller phone +15555550100' }]));
    const result = runCli(['--mode=validate', `--file=${file}`]);
    expect(result.status).toBe(1);
    expect(result.stdout).not.toContain('+15555550100');
    expect(result.stdout).not.toContain('Caller phone');
    expect(result.stdout).toMatch(/invalidEvidence/);
  });

  it('refuses evidence collection before any database access without staging synthetic authorization', () => {
    const result = runCli(['--mode=collect', '--tenant=tenant-1', '--call=call-1', '--review=/does/not/matter.json']);
    expect(result.status).toBe(2);
    expect(JSON.parse(result.stdout)).toEqual({ ok: false, errorCode: 'collection_not_authorized' });
    expect(result.stderr).toBe('');
  });
});
