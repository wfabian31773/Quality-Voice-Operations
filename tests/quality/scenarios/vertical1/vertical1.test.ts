import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { formatHumanSummary } from '../../../../scripts/quality/report';
import { loadScenarioDir, runScenario, runScenarios } from '../../../../scripts/quality/runner';
import type { Scenario } from '../../../../scripts/quality/types';
import {
  buildShopFixture,
  listShopFixtureNames,
  ShopFixtureStore,
  weekdayOf,
} from '../../fixtures/shopFixtures';

const DIR = path.dirname(fileURLToPath(import.meta.url));

/** The only PRs a vertical1 scenario may wait on (task brief). */
const ALLOWED_EXPECTED_FAIL = ['PR-13', 'PR-14', 'PR-17', 'PR-20', 'PR-26'];

/** Expected-fail ledger: when one of these PRs lands, move its ids to passing. */
const EXPECTED_FAIL: Record<string, string> = {
  'v1-sched-bb-change-after-readback': 'PR-13',
  'v1-sched-bb-reschedule-verified': 'PR-14',
  'v1-sms-bb-destination-ending-in': 'PR-17',
  'v1-sms-ns-es-different-mobile': 'PR-17',
  'v1-sms-bb-inbound-x-cancels': 'PR-17',
  'v1-tickets-bb-repeat-dedupe': 'PR-20',
  'v1-transfer-bb-after-hours-message': 'PR-26',
};

const BANNED_EN = ["you're booked", "I've sent", "I've texted you", "I've let them know", 'your order is in'];
const BANNED_ES = ['ya está reservado', 'le envié', 'ya le avisé'];

const scenarios = loadScenarioDir(DIR);

function category(id: string): string {
  return id.split('-')[1];
}

function scriptCalls(scenario: Scenario): string[] {
  return (scenario.script ?? []).flatMap((turn) =>
    turn.steps.flatMap((step) => ('call' in step ? [step.call.name] : [])),
  );
}

/** Drop the steps that make the scenario succeed: commits for writes, every call for reads. */
function sabotage(scenario: Scenario): Scenario {
  const hasCommit = scriptCalls(scenario).some((name) => name.endsWith('.commit'));
  return {
    ...scenario,
    script: (scenario.script ?? []).map((turn) => {
      const steps = turn.steps.filter((step) => !('call' in step) || (hasCommit && !step.call.name.endsWith('.commit')));
      return { ...turn, steps: steps.length > 0 ? steps : [{ say: 'One moment.' }] };
    }),
  };
}

describe('vertical1 shop fixtures', () => {
  it('barbershop-basic: 3 barbers, Tue–Sun, Marco off Wednesdays, one unpriced service', () => {
    const state = buildShopFixture('barbershop-basic');
    expect(state.template).toBe('barbershop');
    expect(state.staff.map((member) => member.id)).toEqual(['marco', 'andre', 'tony']);
    const days = new Set(state.slots.map((slot) => weekdayOf(slot.start.slice(0, 10))));
    expect([...days].sort()).toEqual(['fri', 'sat', 'sun', 'thu', 'tue', 'wed']);
    const wednesday = state.slots.filter((slot) => weekdayOf(slot.start.slice(0, 10)) === 'wed');
    expect(wednesday.length).toBeGreaterThan(0);
    expect(wednesday.some((slot) => slot.staffId === 'marco')).toBe(false);
    const prices = Object.fromEntries(state.services.map((service) => [service.id, service.priceText]));
    expect(prices['mens-cut']).toMatch(/^from \$/);
    expect(prices['beard-trim']).toMatch(/^\$\d+$/);
    expect(prices['hot-towel-shave']).toBe('');
    // Only Marco does cut + beard.
    const both = state.staff.filter((member) => ['mens-cut', 'beard-trim'].every((id) => member.serviceIds.includes(id)));
    expect(both.map((member) => member.id)).toEqual(['marco']);
  });

  it('nail-salon-basic: 4 techs, gel removal add-on, closed Sunday', () => {
    const state = buildShopFixture('nail-salon-basic');
    expect(state.template).toBe('nail_salon');
    expect(state.staff).toHaveLength(4);
    expect(state.services.map((service) => service.id).sort()).toEqual(['gel-manicure', 'gel-removal', 'manicure', 'pedicure']);
    expect(state.slots.some((slot) => weekdayOf(slot.start.slice(0, 10)) === 'sun')).toBe(false);
  });

  it('builds DST-correct slots across Sun Nov 1, 2026', () => {
    const state = buildShopFixture('barbershop-basic');
    const starts = state.slots.map((slot) => slot.start);
    expect(starts).toContain('2026-10-31T10:00:00-04:00');
    expect(starts).toContain('2026-11-01T10:00:00-05:00');
    expect(starts).not.toContain('2026-11-01T10:00:00-04:00');
  });

  it('applies variants and rejects unknown seeds', () => {
    expect(buildShopFixture('barbershop-basic:after-same-day-cutoff').slots.some((slot) => slot.start.startsWith('2026-10-20'))).toBe(false);
    const held = buildShopFixture('barbershop-basic:slot-held-by-other-caller');
    expect(held.bookings).toMatchObject([{ status: 'held', staffName: 'Marco', startLocal: '15:30' }]);
    expect(buildShopFixture('barbershop-basic:sms-opted-out').sms.optedOut).toContain('+15555550142');
    expect(buildShopFixture('nail-salon-basic:sms-disabled').sms.messagingEnabled).toBe(false);
    expect(() => buildShopFixture('barbershop-marco')).toThrow(/unknown shop fixture/);
    expect(() => buildShopFixture('barbershop-basic:nope')).toThrow(/unknown shop fixture/);
  });
});

describe('vertical1 scenario pack: shape', () => {
  it('loads all 30 scenarios with unique ids matching file names', () => {
    const files = readdirSync(DIR).filter((name) => name.endsWith('.yaml')).sort();
    expect(files).toHaveLength(30);
    expect(scenarios).toHaveLength(30);
    expect(scenarios.map((scenario) => `${scenario.id}.yaml`)).toEqual(files);
  });

  it('spreads across scheduling, SMS, tickets and transfer/knowledge', () => {
    const counts: Record<string, number> = {};
    for (const scenario of scenarios) counts[category(scenario.id)] = (counts[category(scenario.id)] ?? 0) + 1;
    expect(counts).toEqual({ sched: 14, sms: 6, tickets: 6, transfer: 2, info: 2 });
  });

  it('includes Spanish callers in scheduling, SMS and tickets', () => {
    const spanish = scenarios.filter((scenario) => scenario.tags.includes('lang:es'));
    expect(new Set(spanish.map((scenario) => category(scenario.id)))).toEqual(new Set(['sched', 'sms', 'tickets']));
    expect(spanish.length).toBeGreaterThanOrEqual(4);
  });

  it.each(scenarios.map((scenario) => [scenario.id, scenario] as const))('%s follows the pack conventions', (_id, scenario) => {
    expect(listShopFixtureNames()).toContain(scenario.seed);
    expect(scenario.tags).toContain(`template:${scenario.template}`);
    expect(scenario.tags.some((tag) => tag.startsWith('tool:') && scenario.tools.includes(tag.slice(5) as never))).toBe(true);
    expect(scenario.tags.some((tag) => tag.startsWith('spec:'))).toBe(true);
    // Real assertions: expected actions, plus an end state.
    expect(scenario.expect.actions?.length ?? 0).toBeGreaterThan(0);
    expect(scenario.expect.endState).toBeDefined();
    expect(scenario.expect.mustNotSay).toEqual(expect.arrayContaining([...BANNED_EN, ...BANNED_ES]));
    const calls = scriptCalls(scenario);
    if (calls.some((name) => name.endsWith('.prepare') || name.endsWith('.commit'))) {
      expect(scenario.expect.readbackRequired).toBe(true);
    }
    expect(scenario.expectedFail).toBe(EXPECTED_FAIL[scenario.id]);
    if (scenario.expectedFail) {
      expect(ALLOWED_EXPECTED_FAIL).toContain(scenario.expectedFail);
      expect(scenario.tags).toContain('expected-fail');
    }
  });
});

describe('vertical1 scenario pack: deterministic run', () => {
  it('passes every scenario not marked expectedFail and reports expected failures separately', async () => {
    const report = await runScenarios(scenarios, { mode: 'scripted', store: new ShopFixtureStore() });
    const diffs = report.results.filter((result) => result.status === 'failed').map((result) => result.diff);
    expect(diffs.join('\n\n')).toBe('');
    expect(report.failed).toEqual([]);
    expect(report.unexpectedPassed).toEqual([]);
    expect(report.ok).toBe(true);
    expect(Object.fromEntries(report.expectedFailed.map((row) => [row.id, row.expectedFail]))).toEqual(EXPECTED_FAIL);
    expect(report.passed).toHaveLength(30 - Object.keys(EXPECTED_FAIL).length);
    console.log(formatHumanSummary(report));
  });

  it('fails every passing scenario when its commits (or reads) are removed', async () => {
    const store = new ShopFixtureStore();
    const passing = scenarios.filter((scenario) => !scenario.expectedFail);
    const stillPassing: string[] = [];
    for (const scenario of passing) {
      const result = await runScenario(sabotage(scenario), { mode: 'scripted', store });
      if (result.status !== 'failed') stillPassing.push(scenario.id);
    }
    expect(stillPassing).toEqual([]);
  });
});
