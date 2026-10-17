import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { formatHumanSummary } from '../../../../scripts/quality/report';
import { loadScenarioDir, runScenario, runScenarios } from '../../../../scripts/quality/runner';
import type { CheckName, Scenario } from '../../../../scripts/quality/types';
import {
  buildShopFixture,
  listShopFixtureNames,
  loadShopFixture,
  ShopFixtureStore,
  slotEnd,
  weekdayOf,
} from '../../fixtures/shopFixtures';

const DIR = path.dirname(fileURLToPath(import.meta.url));

/** The only PRs a vertical1 scenario may wait on (task brief). PR-13 and PR-14 landed. */
const ALLOWED_EXPECTED_FAIL = ['PR-17', 'PR-20', 'PR-26'];

/**
 * Harness follow-ups no product PR fixes. `matcher-es-readback`: readbackRequired
 * only accepts the fake's English readback verbatim, so a Spanish readback fails.
 */
const ALLOWED_FOLLOW_UPS = ['matcher-es-readback'];

type PinnedFailure = [check: CheckName, messageSubstring: string];

const BOOK_READBACK_NOT_SPOKEN: PinnedFailure = [
  'readbackRequired',
  'scheduling.book.prepare readback was not spoken before scheduling.book.commit',
];

/**
 * Expected-fail ledger: when one of these lands, move its ids to passing.
 * `failures` pins the exact checks that must fail (in matcher order), so a typo
 * or broken script can't pass as the expected failure.
 */
const EXPECTED_FAIL: Record<string, { pr: string; failures: PinnedFailure[] }> = {
  'v1-sms-bb-opted-out-no-text-claim': {
    pr: 'PR-17',
    failures: [['mustSay', `agent never said "I can't text this number"`]],
  },
  'v1-sms-ns-flag-off-truthful-fallback': {
    pr: 'PR-17',
    failures: [['mustSay', `agent never said "I can't text this number"`]],
  },
  'v1-sms-bb-es-opted-out': {
    pr: 'PR-17',
    failures: [['mustSay', 'agent never said "No puedo enviarle mensajes"'], BOOK_READBACK_NOT_SPOKEN],
  },
  'v1-sms-bb-destination-ending-in': {
    pr: 'PR-17',
    failures: [['actions', 'sms.send_confirmation.commit ran but did not succeed']],
  },
  'v1-sms-ns-es-different-mobile': {
    pr: 'PR-17',
    failures: [['actions', 'sms.send_confirmation.commit ran but did not succeed'], BOOK_READBACK_NOT_SPOKEN],
  },
  'v1-sms-bb-inbound-x-cancels': { pr: 'PR-17', failures: [['endState', 'no booking matched']] },
  'v1-tickets-bb-repeat-dedupe': { pr: 'PR-20', failures: [['endState', 'tickets count']] },
  'v1-transfer-bb-after-hours-message': {
    pr: 'PR-26',
    failures: [
      ['endState', 'transfers count'],
      ['readbackRequired', 'calls.transfer_to_human.prepare readback was not spoken'],
    ],
  },
  'v1-sched-bb-es-anyone-saturday': { pr: 'matcher-es-readback', failures: [BOOK_READBACK_NOT_SPOKEN] },
  'v1-sched-ns-es-gel-plus-removal': { pr: 'matcher-es-readback', failures: [BOOK_READBACK_NOT_SPOKEN] },
  'v1-tickets-ns-es-callback': {
    pr: 'matcher-es-readback',
    failures: [['readbackRequired', 'tickets.open.prepare readback was not spoken before tickets.open.commit']],
  },
};

const BANNED_EN = ["you're booked", "I've sent", "I've texted you", "I've let them know", 'your order is in'];
// The matcher doesn't map Spanish phrases to a commit, so these never unlock:
// post-commit Spanish lines must avoid them too.
const BANNED_ES = [
  'ya está reservado',
  'quedó confirmada',
  'quedó confirmado',
  'su cita está confirmada',
  'ya quedó',
  'quedó registrado',
  'le envié',
  'ya le avisé',
];

const scenarios = loadScenarioDir(DIR);

/** Tests that run every scenario back to back outgrow Vitest's 5 s default. */
const ALL_SCENARIOS_TIMEOUT_MS = 60_000;

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

  it('carries the trusted caller ID and the cancellation window into the tenant state', () => {
    expect(buildShopFixture('barbershop-basic').callerNumber).toBeNull();
    expect(buildShopFixture('barbershop-basic:existing-booking').callerNumber).toBe('+15555550142');
    expect(buildShopFixture('barbershop-basic:existing-booking').cancellationWindowHours).toBe(24);
    const family = buildShopFixture('barbershop-basic:family-on-one-phone');
    expect(family.bookings.map((row) => [row.customerName, row.customerPhone, row.staffName])).toEqual([
      ['Luis Garcia', '+15555550142', 'Marco'],
      ['Luis Garcia Jr.', '+15555550142', 'Andre'],
    ]);
  });

  it('carries transferHours into the tenant state', () => {
    const { transferHours } = buildShopFixture('barbershop-basic');
    expect(transferHours.days).toEqual(['tue', 'wed', 'thu', 'fri', 'sat', 'sun']);
    expect(transferHours.days).not.toContain('mon');
  });

  it('sizes slots from the booked services, not a shop-wide length', () => {
    const slotAt = (seed: string, staffId: string, start: string) =>
      buildShopFixture(seed).slots.find((slot) => slot.staffId === staffId && slot.start === start);
    // Cut + beard trim = 30 + 15; gel manicure + gel removal = 45 + 15.
    expect(slotEnd(loadShopFixture('barbershop-basic'), '10:00', ['mens-cut', 'beard-trim'])).toBe('10:45');
    expect(slotEnd(loadShopFixture('nail-salon-basic'), '13:00', ['gel-manicure', 'gel-removal'])).toBe('14:00');
    expect(slotAt('barbershop-basic:cut-and-beard', 'marco', '2026-10-22T10:00:00-04:00')?.end).toBe('2026-10-22T10:45:00-04:00');
    expect(slotAt('nail-salon-basic:gel-plus-removal', 'rosa', '2026-10-22T13:00:00-04:00')?.end).toBe('2026-10-22T14:00:00-04:00');
    expect(slotAt('barbershop-basic', 'marco', '2026-10-22T10:00:00-04:00')?.end).toBe('2026-10-22T10:30:00-04:00');
    // Sunday closes at 4: a 3:30 cut fits, a 3:30 cut + beard (until 4:15) doesn't.
    expect(slotAt('barbershop-basic', 'marco', '2026-10-25T15:30:00-04:00')?.end).toBe('2026-10-25T16:00:00-04:00');
    expect(slotAt('barbershop-basic:cut-and-beard', 'marco', '2026-10-25T15:30:00-04:00')).toBeUndefined();
    // The cut and beard combo is one 45-minute service: Marco's 4:30 today runs to 5:15.
    expect(slotAt('barbershop-basic:cut-beard-combo', 'marco', '2026-10-20T16:30:00-04:00')?.end).toBe('2026-10-20T17:15:00-04:00');
  });

  it('hands out a fresh copy of the seed on every build', () => {
    const first = buildShopFixture('barbershop-basic:existing-booking');
    first.bookings[0].status = 'cancelled';
    first.slots.pop();
    const second = buildShopFixture('barbershop-basic:existing-booking');
    expect(second.bookings[0].status).toBe('confirmed');
    expect(second.slots).toHaveLength(first.slots.length + 1);
  });
});

describe('vertical1 scenario pack: shape', () => {
  it('loads all 34 scenarios with unique ids matching file names', () => {
    const files = readdirSync(DIR).filter((name) => name.endsWith('.yaml')).sort();
    expect(files).toHaveLength(34);
    expect(scenarios).toHaveLength(34);
    expect(scenarios.map((scenario) => `${scenario.id}.yaml`)).toEqual(files);
  });

  it('spreads across scheduling, SMS, tickets and transfer/knowledge', () => {
    const counts: Record<string, number> = {};
    for (const scenario of scenarios) counts[category(scenario.id)] = (counts[category(scenario.id)] ?? 0) + 1;
    expect(counts).toEqual({ sched: 18, sms: 6, tickets: 6, transfer: 2, info: 2 });
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
    expect(scenario.expectedFail).toBe(EXPECTED_FAIL[scenario.id]?.pr);
    if (scenario.expectedFail) {
      expect([...ALLOWED_EXPECTED_FAIL, ...ALLOWED_FOLLOW_UPS]).toContain(scenario.expectedFail);
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
    expect(Object.fromEntries(report.expectedFailed.map((row) => [row.id, row.expectedFail]))).toEqual(
      Object.fromEntries(Object.entries(EXPECTED_FAIL).map(([id, entry]) => [id, entry.pr])),
    );
    // Totals quoted in COVERAGE.md.
    expect(report.passed).toHaveLength(23);
    const byPr: Record<string, number> = {};
    for (const row of report.expectedFailed) byPr[row.expectedFail] = (byPr[row.expectedFail] ?? 0) + 1;
    expect(byPr).toEqual({ 'PR-17': 6, 'PR-20': 1, 'PR-26': 1, 'matcher-es-readback': 3 });
    console.log(formatHumanSummary(report));
  }, ALL_SCENARIOS_TIMEOUT_MS);

  it.each(Object.entries(EXPECTED_FAIL))('%s fails only on its pinned checks', async (id, entry) => {
    const scenario = scenarios.find((row) => row.id === id);
    expect(scenario).toBeDefined();
    const result = await runScenario(scenario!, { mode: 'scripted', store: new ShopFixtureStore() });
    expect(result.status).toBe('expected_fail');
    const pinned = entry.failures;
    const actual = result.failures.map((failure, index): PinnedFailure => {
      const want = pinned[index];
      const matches = want && want[0] === failure.check && failure.message.includes(want[1]);
      return [failure.check, matches ? want[1] : failure.message];
    });
    expect(actual).toEqual(pinned);
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
  }, ALL_SCENARIOS_TIMEOUT_MS);
});
