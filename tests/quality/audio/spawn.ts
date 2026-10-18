/**
 * Runs the audio harness the way production loads code (`node --import tsx`,
 * cwd = repo root, CJS), in a clean environment: no inherited env, so no
 * secrets and no vitest state reach the child. Collects stdout and parses the
 * --json report line.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import type { AudioGateReport } from '../../../scripts/quality/audio/gate';
import { RESULT_MARKER } from '../../../scripts/quality/audio/run';

export const REPO_ROOT = path.resolve(__dirname, '../../..');
export const CLI = 'scripts/quality/audio/run.ts';
export const MUTANTS = 'tests/quality/audio/mutants.ts';
export const STRESS = 'tests/quality/audio/stress.ts';
/** The env the child starts with. The harness clears its env to HARNESS_ENV anyway (edges.ts), so a CI runner's env can't change a run. */
export const CLEAN_ENV: NodeJS.ProcessEnv = { TZ: 'UTC' };

export interface HarnessRun {
  code: number | null;
  stdout: string;
  stderr: string;
  report?: AudioGateReport;
  reports: Array<{ mutant: string; code: number; report: AudioGateReport }>;
}

export function runHarness(entry: string, args: string[], env: NodeJS.ProcessEnv = CLEAN_ENV): Promise<HarnessRun> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', entry, ...args], { cwd: REPO_ROOT, env });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => out.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => err.push(chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      const stdout = Buffer.concat(out).toString('utf8');
      const reports: HarnessRun['reports'] = [];
      let report: AudioGateReport | undefined;
      for (const line of stdout.split('\n')) {
        if (!line.startsWith(RESULT_MARKER)) continue;
        const parsed = JSON.parse(line.slice(RESULT_MARKER.length)) as AudioGateReport & { mutant?: string; code?: number };
        if (parsed.mutant) reports.push({ mutant: parsed.mutant, code: parsed.code ?? -1, report: parsed });
        else report = parsed;
      }
      resolve({ code, stdout, stderr: Buffer.concat(err).toString('utf8'), report, reports });
    });
  });
}
