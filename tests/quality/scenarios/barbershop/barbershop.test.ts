import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FakeToolProvider, FILE_FLOOR, toE164 } from '../../../../scripts/quality/fakeToolProvider';
import { formatPassKSummary, runPassK, type PassKReport } from '../../../../scripts/quality/passK';
import { main } from '../../../../scripts/quality/run-scenarios';
import { loadScenarioDir, runScenario } from '../../../../scripts/quality/runner';
import type { TenantState } from '../../../../scripts/quality/seed';
import type { Scenario, ToolCallContext } from '../../../../scripts/quality/types';
import { ShopFixtureStore } from '../../fixtures/shopFixtures';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const scenarios = loadScenarioDir(DIR);

/** The core barbershop flows RT-10 must hold at pass^5 (gate G1). */
const CORE_FLOWS = [
  'book-named-barber',
  'book-anyone',
  'no-availability-alternative',
  'no-availability-message',
  'message-caller-id',
  'message-hidden-caller-id',
  'find-right-name',
  'find-wrong-name',
  'reschedule',
  'cancel',
  'hangup-mid-request',
  'hangup-name-only',
  'es-booking',
];

/** Every run of the pack is 13 flows x 5 runs back to back. */
const PACK_TIMEOUT_MS = 60_000;

const passK = (only?: string[], opts: Parameters<typeof runPassK>[1] = {}) =>
  runPassK(scenarios, { mode: 'scripted', k: 5, store: new ShopFixtureStore(), only, ...opts });

function stateOf(fake: FakeToolProvider): TenantState {
  return (fake as unknown as { state: TenantState }).state;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('barbershop pack: shape', () => {
  it('has one core scenario per flow, ids matching file names, every call ending through the floor', () => {
    const files = readdirSync(DIR).filter((name) => name.endsWith('.yaml')).sort();
    expect(scenarios.map((scenario) => `${scenario.id}.yaml`)).toEqual(files);
    const flows = scenarios.map((scenario) => scenario.tags.find((tag) => tag.startsWith('flow:'))?.slice(5));
    expect([...flows].sort()).toEqual([...CORE_FLOWS].sort());
    for (const scenario of scenarios) {
      expect(scenario.template).toBe('barbershop');
      expect(scenario.tags).toEqual(expect.arrayContaining(['barbershop', 'core', 'template:barbershop']));
      expect(scenario.floor).toBe(true);
      expect(scenario.expectedFail).toBeUndefined();
      // Graded on end state: every scenario pins bookings or tickets.
      expect(scenario.expect.endState?.bookings ?? scenario.expect.endState?.tickets).toBeDefined();
    }
  });

  it('covers caller ID present, hidden, and Spanish', () => {
    expect(scenarios.some((scenario) => scenario.callerId === null)).toBe(true);
    expect(scenarios.some((scenario) => scenario.tags.includes('lang:es'))).toBe(true);
  });
});

describe('barbershop pack: pass^5 gate (scripted)', () => {
  it('passes 5/5 on every core flow', async () => {
    const report = await passK();
    console.log(formatPassKSummary(report));
    expect(report.flows.map((flow) => `${flow.flow} ${flow.passes}/${flow.k}`)).toEqual(
      report.flows.map((flow) => `${flow.flow} 5/5`),
    );
    expect(report.coreFlows).toBe(CORE_FLOWS.length);
    expect(report.coreBelowK).toEqual([]);
    expect(report.ok).toBe(true);
  }, PACK_TIMEOUT_MS);

  it('the CLI gate (npm run quality:sim -- --dir=<pack> --pass-k=5) exits 0', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await expect(main([`--dir=${DIR}`, '--pass-k=5'])).resolves.toBe(0);
  }, PACK_TIMEOUT_MS);
});

describe('barbershop pack: the gate goes red (mutation proof)', () => {
  function expectRed(report: PassKReport, flow: string, id: string, passes: number): string {
    const summary = formatPassKSummary(report);
    console.log(summary);
    expect(report.ok).toBe(false);
    expect(report.coreBelowK).toContain(`${flow} (${id}): ${passes}/5`);
    expect(summary).toContain(`FAIL core flow ${flow} (${id}): passed ${passes}/5 runs, needs 5/5`);
    return summary;
  }

  it('a fake that files two floor tickets fails hangup-mid-request 0/5, on the count and the one-floor invariant', async () => {
    const invoke = FakeToolProvider.prototype.invoke;
    vi.spyOn(FakeToolProvider.prototype, 'invoke').mockImplementation(async function (
      this: FakeToolProvider,
      name: string,
      input: Record<string, unknown>,
      ctx: ToolCallContext,
    ) {
      const result = await invoke.call(this, name, input, ctx);
      const filed = stateOf(this).tickets.find((row) => row.floor);
      if (name === FILE_FLOOR && filed) stateOf(this).tickets.push({ ...filed, id: `${filed.id}_again` });
      return result;
    });
    const summary = expectRed(await passK(['bb-hangup-mid-request']), 'hangup-mid-request', 'bb-hangup-mid-request', 0);
    expect(summary).toContain('endState: tickets count');
    expect(summary).toContain('invariant: floor.more_than_one: 2 floor tickets on one call');
  }, PACK_TIMEOUT_MS);

  it('a fake that skips the first-name check fails find-wrong-name 0/5: a booking is read back', async () => {
    const invoke = FakeToolProvider.prototype.invoke;
    vi.spyOn(FakeToolProvider.prototype, 'invoke').mockImplementation(async function (
      this: FakeToolProvider,
      name: string,
      input: Record<string, unknown>,
      ctx: ToolCallContext,
    ) {
      if (name !== 'scheduling.find_bookings') return invoke.call(this, name, input, ctx);
      // Phone match alone: answer as if the name on the booking had been given.
      const phone = toE164(String(input.phone ?? ''));
      const onPhone = stateOf(this).bookings.find((row) => toE164(row.customerPhone) === phone);
      return invoke.call(this, name, { ...input, name: onPhone?.customerName ?? input.name }, ctx);
    });
    const report = await passK(['bb-find-wrong-name', 'bb-find-right-name']);
    const summary = expectRed(report, 'find-wrong-name', 'bb-find-wrong-name', 0);
    expect(summary).toContain('endState: bookings disclosed to the agent (find_bookings) count');
    expect(summary).toContain('invariant: find.readback_before_name_match: find_bookings returned bk_luis_thu for name "Carlos"');
    // The right-name flow goes red too: its first, phone-only lookup now reads the booking back before any name.
    expectRed(report, 'find-right-name', 'bb-find-right-name', 0);
    expect(summary).toContain('find_bookings returned bk_luis_thu for name ""');
  }, PACK_TIMEOUT_MS);

  it('a flow that fails 1 run of 5 is caught: 4/5 is red, with the failing run named', async () => {
    const flaky = (scenario: Scenario, run: number) =>
      runScenario(
        run === 3 && scenario.id === 'bb-book-named-barber'
          ? // Run 3 loses the commit: the caller said yes and nothing was booked.
            { ...scenario, script: scenario.script?.map((turn) => ({ ...turn, steps: turn.steps.filter((step) => !('call' in step) || !step.call.name.endsWith('.commit')) })) }
          : scenario,
        { mode: 'scripted', store: new ShopFixtureStore() },
      );
    const report = await passK(['bb-book-named-barber', 'bb-book-anyone'], { runOnce: flaky });
    const summary = expectRed(report, 'book-named-barber', 'bb-book-named-barber', 4);
    expect(summary).toMatch(/run 3:\n\s+FAIL bb-book-named-barber/);
    expect(report.flows.find((flow) => flow.id === 'bb-book-anyone')?.passes).toBe(5);
  }, PACK_TIMEOUT_MS);
});
