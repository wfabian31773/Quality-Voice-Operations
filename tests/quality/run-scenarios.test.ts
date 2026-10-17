import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadScenarioYaml } from '../../scripts/quality/loadScenario';
import { createLlmAgent } from '../../scripts/quality/llmAgent';
import { DEFAULT_SCENARIO_DIR, main, parseArgs, runSelfCheck } from '../../scripts/quality/run-scenarios';
import { loadScenarioDir, runScenario, runScenarios } from '../../scripts/quality/runner';
import { createTenantStore, MemoryTenantStore } from '../../scripts/quality/seed';

const packageJson = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as {
  scripts: Record<string, string>;
};

describe('quality:sim npm script', () => {
  it('registers the harness CLI', () => {
    expect(packageJson.scripts['quality:sim']).toBe('tsx scripts/quality/run-scenarios.ts');
  });
});

describe('sample scenarios (scripted, no LLM)', () => {
  it('passes the three CI samples against FakeToolProvider', async () => {
    const scenarios = loadScenarioDir(DEFAULT_SCENARIO_DIR).filter((scenario) =>
      scenario.tags.includes('sample'),
    );
    expect(scenarios.map((scenario) => scenario.id).sort()).toEqual([
      'anyone-no-availability',
      'book-named-barber',
      'request-person-transfer',
    ]);
    const report = await runScenarios(scenarios, { mode: 'scripted' });
    expect(report.failed).toEqual([]);
    expect(report.passed.sort()).toEqual([
      'anyone-no-availability',
      'book-named-barber',
      'request-person-transfer',
    ]);
    expect(report.ok).toBe(true);
  });

  it('keeps expectedFail scenarios out of the CI failure set', async () => {
    const scenarios = loadScenarioDir(DEFAULT_SCENARIO_DIR);
    const report = await runScenarios(scenarios, { mode: 'scripted' });
    expect(report.ok).toBe(true);
    expect(report.failed).toEqual([]);
    expect(report.expectedFailed).toEqual([{ id: 'waitlist-same-slot', expectedFail: 'PR-08' }]);
    const waitlist = report.results.find((result) => result.id === 'waitlist-same-slot');
    expect(waitlist?.status).toBe('expected_fail');
    expect(waitlist?.diff).toMatch(/endState|NOT_FOUND|waitlist/i);
  });
});

describe('broken scenario', () => {
  it('fails with a readable mustNotSay diff', async () => {
    const yaml = readFileSync(join(process.cwd(), 'tests/quality/fixtures/broken-success-before-commit.yaml'), 'utf8');
    const scenario = loadScenarioYaml(yaml, 'broken-success-before-commit.yaml');
    const result = await runScenario(scenario);
    expect(result.status).toBe('failed');
    expect(result.diff).toMatch(/^FAIL broken-success-before-commit/m);
    expect(result.diff).toMatch(/mustNotSay/);
    expect(result.diff.toLowerCase()).toContain("you're booked");
  });

  it('self-check exits 0 only when the harness detects the breakage', async () => {
    await expect(runSelfCheck()).resolves.toBe(0);
  });
});

describe('tenant store selection', () => {
  it('uses the in-memory fake when no Postgres is requested', async () => {
    const store = await createTenantStore({ seed: 'barbershop-marco' });
    expect(store).toBeInstanceOf(MemoryTenantStore);
    expect(store.state.staff.some((member) => member.id === 'marco')).toBe(true);
    await store.close();
  });
});

describe('CLI flags', () => {
  it('defaults to scripted mode and the samples directory', () => {
    expect(parseArgs([])).toMatchObject({ mode: 'scripted', selfCheck: false, dir: DEFAULT_SCENARIO_DIR });
    expect(parseArgs(['--self-check', '--mode=scripted', '--only=book-named-barber']).only).toEqual([
      'book-named-barber',
    ]);
  });

  it('refuses LLM mode without QUALITY_SIM_LLM=1 and never constructs a live client', async () => {
    const prev = process.env.QUALITY_SIM_LLM;
    delete process.env.QUALITY_SIM_LLM;
    await expect(main(['--mode=llm'])).rejects.toThrow(/QUALITY_SIM_LLM/);
    expect(() => createLlmAgent({ QUALITY_SIM_LLM: '1' } as NodeJS.ProcessEnv)).not.toThrow();
    if (prev === undefined) delete process.env.QUALITY_SIM_LLM;
    else process.env.QUALITY_SIM_LLM = prev;
  });
});
