/**
 * Text-simulation quality harness (PR-06).
 *
 *   npm run quality:sim
 *   npx tsx scripts/quality/run-scenarios.ts --mode=scripted
 *   npx tsx scripts/quality/run-scenarios.ts --self-check
 *   QUALITY_SIM_LLM=1 npx tsx scripts/quality/run-scenarios.ts --mode=llm   # reserved; does not call xAI
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadScenarioYaml } from './loadScenario';
import { formatHumanSummary, publicReport } from './report';
import { loadScenarioDir, runScenario, runScenarios, type RunMode } from './runner';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const DEFAULT_SCENARIO_DIR = path.join(REPO_ROOT, 'tests/quality/scenarios');
export const BROKEN_FIXTURE = path.join(REPO_ROOT, 'tests/quality/fixtures/broken-success-before-commit.yaml');

export type CliArgs = {
  dir: string;
  mode: RunMode;
  out?: string;
  only?: string[];
  selfCheck: boolean;
};

export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    dir: DEFAULT_SCENARIO_DIR,
    mode: 'scripted',
    selfCheck: false,
  };
  for (const value of argv) {
    if (value === '--self-check') {
      args.selfCheck = true;
      continue;
    }
    const match = /^--([a-z-]+)=(.*)$/.exec(value);
    if (!match) continue;
    const [, key, raw] = match;
    if (key === 'dir') args.dir = path.resolve(raw);
    if (key === 'mode') {
      if (raw !== 'scripted' && raw !== 'llm') throw new Error(`unknown mode ${raw}`);
      args.mode = raw;
    }
    if (key === 'out') args.out = raw;
    if (key === 'only') args.only = raw.split(',').map((id) => id.trim()).filter(Boolean);
  }
  return args;
}

function writeOut(file: string | undefined, report: unknown): void {
  if (!file) return;
  const abs = path.resolve(file);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, `${JSON.stringify(report, null, 2)}\n`);
}

export async function runSelfCheck(): Promise<number> {
  const scenario = loadScenarioYaml(readFileSync(BROKEN_FIXTURE, 'utf8'), path.basename(BROKEN_FIXTURE));
  const result = await runScenario(scenario, { mode: 'scripted' });
  if (result.status === 'passed' || result.status === 'unexpected_pass') {
    console.error('self-check failed: broken scenario unexpectedly passed');
    return 1;
  }
  const blob = `${result.diff}\n${JSON.stringify(result.failures)}`.toLowerCase();
  if (!blob.includes('mustnotsay') || !blob.includes("you're booked")) {
    console.error('self-check failed: expected a clear mustNotSay diff for "you\'re booked"');
    console.error(result.diff || '(empty diff)');
    return 1;
  }
  console.log('self-check ok: broken scenario failed with a readable diff');
  console.log(result.diff);
  return 0;
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const args = parseArgs(argv);
  if (args.selfCheck) return runSelfCheck();
  if (args.mode === 'llm') {
    const { assertLlmModeAllowed } = await import('./llmAgent');
    assertLlmModeAllowed();
  }
  const scenarios = loadScenarioDir(args.dir);
  const report = await runScenarios(scenarios, { mode: args.mode, only: args.only });
  const json = publicReport(report);
  writeOut(args.out, json);
  console.log(formatHumanSummary(report));
  if (args.out) console.log(`report: ${path.resolve(args.out)}`);
  return report.ok ? 0 : 1;
}

const invokedDirectly = process.argv[1]
  ? import.meta.url === pathToFileURL(process.argv[1]).href
  : false;

if (invokedDirectly) {
  main().then((code) => {
    process.exitCode = code;
  }).catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(message);
    process.exitCode = 1;
  });
}
