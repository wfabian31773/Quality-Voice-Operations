/**
 * Synthetic caller audio runner (RT-11). Offline and deterministic: no
 * network, no keys, no real TTS or model.
 *
 *   npx tsx scripts/quality/audio/run.ts                 # pass^5 over tests/quality/audio/scenarios
 *   npx tsx scripts/quality/audio/run.ts --pass-k=5 --out=.ci-out/quality-audio-pass5.json
 *   npx tsx scripts/quality/audio/run.ts --only=s03-dialler-never-heard
 *
 * Exits 1 when a core audio flow is below k/k, or a known-red scenario
 * stops failing exactly its pinned checks (see gate.ts).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { installEdges, REPO_ROOT, type RuntimeModules } from './edges';
import { formatAudioGate, runAudioGate, type AudioGateReport } from './gate';
import { captureConsole } from './harness';
import { loadAudioScenarioDir } from './scenario';
import { DEFAULT_PASS_K } from '../passK';

export const DEFAULT_AUDIO_DIR = path.join(REPO_ROOT, 'tests/quality/audio/scenarios');
/** --json: the report is printed on one line after this marker (the vitest suite parses it). */
export const RESULT_MARKER = 'RT11_AUDIO_RESULT ';

export interface AudioCliArgs {
  dir: string;
  k: number;
  only?: string[];
  out?: string;
  json: boolean;
}

export function parseAudioArgs(argv: string[]): AudioCliArgs {
  const args: AudioCliArgs = { dir: DEFAULT_AUDIO_DIR, k: DEFAULT_PASS_K, json: false };
  for (const value of argv) {
    if (value === '--json') {
      args.json = true;
      continue;
    }
    if (value === '--pass-k') continue;
    const match = /^--([a-z-]+)=(.*)$/.exec(value);
    if (!match) throw new Error(`unknown argument ${value}`);
    const [, key, raw] = match;
    if (key === 'dir') args.dir = path.resolve(raw);
    else if (key === 'pass-k') {
      const k = Number(raw);
      if (!Number.isInteger(k) || k < 1) throw new Error(`--pass-k needs a whole number >= 1, got ${raw}`);
      args.k = k;
    } else if (key === 'only') args.only = raw.split(',').map((id) => id.trim()).filter(Boolean);
    else if (key === 'out') args.out = raw;
    else throw new Error(`unknown argument --${key}`);
  }
  return args;
}

export interface AudioCliHooks {
  /** Runs after the edges are in and the runtime is loaded, before any call (mutation tests). */
  beforeRun?: (rt: RuntimeModules) => void;
}

export async function runAudioCli(argv: string[], hooks: AudioCliHooks = {}): Promise<{ code: number; report: AudioGateReport }> {
  const args = parseAudioArgs(argv);
  const scenarios = loadAudioScenarioDir(args.dir);
  const rt = installEdges();
  captureConsole();
  hooks.beforeRun?.(rt);
  const report = await runAudioGate(rt, scenarios, { k: args.k, only: args.only });
  if (args.out) {
    const file = path.resolve(args.out);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);
  }
  const lines = [formatAudioGate(report, scenarios)];
  if (args.out) lines.push(`report: ${path.resolve(args.out)}`);
  if (args.json) lines.push(`${RESULT_MARKER}${JSON.stringify(report)}`);
  process.stdout.write(`${lines.join('\n')}\n`);
  return { code: report.ok ? 0 : 1, report };
}

/** Exit explicitly: runtime modules may leave real timers or handles from load time. */
export function exitWith(code: number): void {
  process.stdout.write('', () => process.exit(code));
}

const invokedDirectly = process.argv[1] ? import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href : false;

if (invokedDirectly) {
  runAudioCli(process.argv.slice(2))
    .then(({ code }) => exitWith(code))
    .catch((err: unknown) => {
      process.stderr.write(`${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
      exitWith(1);
    });
}
