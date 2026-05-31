import { describe, it, expect } from 'vitest';
import {
  getIndustryPack,
  getAllIndustryPacks,
  getIndustryVerticals,
  hvacPack,
} from './index';
import type { DecisionAction } from '../types';
import { makeReasoningContext } from '../__fixtures__/reasoningContext';

const ALL_VERTICALS = [
  'hvac',
  'plumbing',
  'dental',
  'medical-after-hours',
  'property-management',
  'legal',
  'restaurant',
  'real-estate',
  'insurance',
] as const;

const VALID_ACTIONS: DecisionAction[] = [
  'ask_clarifying_question',
  'continue_workflow',
  'execute_tool',
  'escalate_to_human',
  'complete_interaction',
];

const ctx = (utterance: string) => makeReasoningContext({ currentUtterance: utterance });

describe('industry-packs registry', () => {
  it('resolves every registered vertical', () => {
    for (const v of ALL_VERTICALS) {
      expect(getIndustryPack(v)?.vertical).toBe(v);
    }
  });

  it('returns undefined for an unknown vertical', () => {
    expect(getIndustryPack('aerospace')).toBeUndefined();
  });

  it('exposes all packs and verticals consistently', () => {
    expect(getAllIndustryPacks()).toHaveLength(ALL_VERTICALS.length);
    expect(new Set(getIndustryVerticals())).toEqual(new Set(ALL_VERTICALS));
  });
});

describe('industry-packs structure & behavior', () => {
  for (const pack of getAllIndustryPacks()) {
    describe(pack.vertical, () => {
      it('declares a well-formed pack', () => {
        expect(pack.displayName).toBeTruthy();
        expect(pack.rules.length).toBeGreaterThan(0);
        expect(Array.isArray(pack.escalationKeywords)).toBe(true);
        expect(Array.isArray(pack.prohibitedAdviceCategories)).toBe(true);
        for (const rule of pack.rules) {
          expect(rule.id).toBeTruthy();
          expect(rule.vertical).toBe(pack.vertical);
          expect(typeof rule.evaluate).toBe('function');
        }
        for (const [intent, manifest] of Object.entries(pack.slotManifests)) {
          expect(manifest.intent).toBe(intent);
          expect(manifest.slots.length).toBeGreaterThan(0);
        }
      });

      it('returns a not-triggered, valid result for a benign utterance', () => {
        for (const rule of pack.rules) {
          const result = rule.evaluate(ctx('good morning, thanks so much for your help today'));
          expect(result.triggered).toBe(false);
          if (result.action) expect(VALID_ACTIONS).toContain(result.action);
        }
      });

      it('always returns a valid result shape across probe utterances', () => {
        // Exercises the trigger branches where they apply, and asserts the
        // robustness invariant: evaluate never throws and never returns a
        // malformed result, whatever the caller says.
        const probes = [
          ...pack.escalationKeywords.map((k) => `we have a ${k} situation`),
          'this is an emergency, I need help right now',
          'I want to schedule something for next week',
          'can I get a quote or a refund',
        ];
        for (const rule of pack.rules) {
          for (const probe of probes) {
            const r = rule.evaluate(ctx(probe));
            expect(typeof r.triggered).toBe('boolean');
            if (r.action) expect(VALID_ACTIONS).toContain(r.action);
            if (r.urgencyOverride) {
              expect(['emergency', 'urgent', 'normal']).toContain(r.urgencyOverride);
            }
          }
        }
      });
    });
  }
});

describe('hvac pack rule branches', () => {
  const [emergencyRule, maintenanceRule] = hvacPack.rules;

  it('classifies a declared emergency keyword as an escalation', () => {
    const r = emergencyRule.evaluate(ctx('there is a gas leak in the basement'));
    expect(r.triggered).toBe(true);
    expect(r.action).toBe('escalate_to_human');
    expect(r.urgencyOverride).toBe('emergency');
  });

  it('classifies an urgent (non-emergency) pattern as urgent priority', () => {
    const r = emergencyRule.evaluate(ctx('my furnace not working since this morning'));
    expect(r.triggered).toBe(true);
    expect(r.urgencyOverride).toBe('urgent');
    expect(r.action).toBeUndefined();
  });

  it('classifies a maintenance request as normal priority', () => {
    const r = maintenanceRule.evaluate(ctx('I would like to book a seasonal tune up'));
    expect(r.triggered).toBe(true);
    expect(r.urgencyOverride).toBe('normal');
  });

  it('does not trigger maintenance classification for an emergency utterance', () => {
    expect(maintenanceRule.evaluate(ctx('gas leak!')).triggered).toBe(false);
  });
});
