import { describe, expect, it } from 'vitest';
import { ShopFixtureStore } from '../../tests/quality/fixtures/shopFixtures';
import { DEFAULT_PASS_K, flowOf, formatPassKSummary, isCore, publicPassKReport, runPassK } from './passK';
import { parseArgs, storeFor } from './run-scenarios';
import type { Scenario, ScenarioRunResult, ScenarioStatus } from './types';

function scenario(id: string, tags: string[], seed = 'barbershop-marco'): Scenario {
  return {
    id,
    template: 'barbershop',
    tools: ['scheduling'],
    tags,
    seed,
    caller: [{ text: 'hi' }],
    expect: { endState: { bookings: { count: 0 } } },
  };
}

function result(id: string, status: ScenarioStatus): ScenarioRunResult {
  const failed = status !== 'passed';
  return {
    id,
    status,
    failures: failed ? [{ check: 'endState', message: 'bookings count' }] : [],
    diff: failed ? `FAIL ${id}\n  endState: bookings count` : '',
    trace: [],
    snapshot: { bookings: [], tickets: [], transfers: [], waitlist: [] },
  };
}

/** Fails the listed runs of one scenario; everything else passes. */
function failing(id: string, runs: number[]) {
  return async (s: Scenario, run: number) => result(s.id, s.id === id && runs.includes(run) ? 'failed' : 'passed');
}

const CORE = scenario('bb-a', ['core', 'flow:a']);
const CORE_B = scenario('bb-b', ['core', 'flow:b']);
const EXTRA = scenario('bb-extra', ['flow:extra']);

describe('pass^k runner', () => {
  it('reads the flow and core tags', () => {
    expect([flowOf(CORE), isCore(CORE)]).toEqual(['a', true]);
    expect([flowOf(scenario('no-flow', [])), isCore(EXTRA)]).toEqual(['no-flow', false]);
  });

  it('runs every scenario k times (default 5) and is ok only at k/k on every core flow', async () => {
    const seen: string[] = [];
    const report = await runPassK([CORE, CORE_B], {
      runOnce: async (s, run) => {
        seen.push(`${s.id}#${run}`);
        return result(s.id, 'passed');
      },
    });
    expect(DEFAULT_PASS_K).toBe(5);
    expect(seen).toHaveLength(10);
    expect(report).toMatchObject({ ok: true, k: 5, coreFlows: 2, coreBelowK: [] });
    expect(report.flows.map((flow) => [flow.flow, flow.passes])).toEqual([['a', 5], ['b', 5]]);
  });

  it('a core flow at 4/5 fails the gate and the summary names the flow and the failing run', async () => {
    const report = await runPassK([CORE, CORE_B], { runOnce: failing('bb-b', [2]) });
    expect(report.ok).toBe(false);
    expect(report.coreBelowK).toEqual(['b (bb-b): 4/5']);
    const summary = formatPassKSummary(report);
    expect(summary).toContain('ok=false (2 core flows, 1 below 5/5)');
    expect(summary).toContain('FAIL core 4/5  b');
    expect(summary).toContain('FAIL core flow b (bb-b): passed 4/5 runs, needs 5/5');
    expect(summary).toMatch(/run 2:\n\s+FAIL bb-b\n\s+endState: bookings count/);
  });

  it('prints a deterministic failure once for all its runs', async () => {
    const summary = formatPassKSummary(await runPassK([CORE], { k: 3, runOnce: failing('bb-a', [1, 2, 3]) }));
    expect(summary).toContain('runs 1, 2, 3:');
    expect(summary.match(/FAIL bb-a/g)).toHaveLength(1);
  });

  it('a non-core flow below k/k is reported but does not fail the gate', async () => {
    const report = await runPassK([CORE, EXTRA], { runOnce: failing('bb-extra', [1]) });
    expect(report.ok).toBe(true);
    expect(formatPassKSummary(report)).toContain('non-core flow extra (bb-extra): passed 4/5 runs');
  });

  it('expected_fail and thrown runs are not passes', async () => {
    const report = await runPassK([CORE, CORE_B], {
      k: 2,
      runOnce: async (s, run) => {
        if (s.id === 'bb-b' && run === 2) throw new Error('LLM agent timed out');
        return result(s.id, s.id === 'bb-a' ? 'expected_fail' : 'passed');
      },
    });
    expect(report.coreBelowK).toEqual(['a (bb-a): 0/2', 'b (bb-b): 1/2']);
    expect(report.flows[1].runs[1]).toMatchObject({ status: 'failed', diff: 'ERROR bb-b: LLM agent timed out' });
  });

  it('fails when no core scenario is selected, so an empty pack cannot go green', async () => {
    const report = await runPassK([EXTRA], { runOnce: failing('none', []) });
    expect(report.ok).toBe(false);
    expect(formatPassKSummary(report)).toContain('FAIL no scenario tagged `core` was selected');
    expect((await runPassK([], {})).ok).toBe(false);
  });

  it('rejects a k that is not a whole number >= 1', async () => {
    await expect(runPassK([CORE], { k: 0 })).rejects.toThrow(/k >= 1/);
  });

  it('keeps only failed runs in the JSON report', async () => {
    const report = publicPassKReport(await runPassK([CORE], { runOnce: failing('bb-a', [4]) }));
    expect(report.flows[0].runs.map((run) => run.run)).toEqual([4]);
    expect(report.flows[0].passes).toBe(4);
  });
});

describe('quality:sim CLI: --pass-k and the fixture store', () => {
  it('parses --pass-k (bare = 5) and rejects a bad k', () => {
    expect(parseArgs(['--pass-k']).passK).toBe(5);
    expect(parseArgs(['--pass-k=3']).passK).toBe(3);
    expect(parseArgs([]).passK).toBeUndefined();
    expect(() => parseArgs(['--pass-k=0'])).toThrow(/--pass-k/);
    expect(() => parseArgs(['--pass-k=two'])).toThrow(/--pass-k/);
  });

  it('picks the shop-fixture store for shop seeds, the default for seed.ts seeds, and refuses a mix', () => {
    expect(storeFor([scenario('a', [], 'barbershop-basic:existing-booking')])).toBeInstanceOf(ShopFixtureStore);
    expect(storeFor([scenario('a', [], 'barbershop-marco')])).toBeUndefined();
    expect(() => storeFor([scenario('a', [], 'barbershop-basic'), scenario('b', [], 'barbershop-marco')])).toThrow(/mixed seeds: b/);
  });
});
