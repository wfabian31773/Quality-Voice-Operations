import { describe, it, expect } from 'vitest';
import * as reasoning from './index';

describe('reasoning public barrel', () => {
  it('re-exports every engine class and registry helper', () => {
    for (const name of [
      'ReasoningEngine',
      'DecisionEngine',
      'SlotTracker',
      'ConfidenceScorer',
      'WorkflowPlanner',
      'FallbackManager',
      'EscalationManager',
      'SafetyGate',
      'ReasoningTrace',
      'MemoryManager',
      'getIndustryPack',
      'getAllIndustryPacks',
      'getIndustryVerticals',
    ] as const) {
      expect(reasoning[name], name).toBeTypeOf('function');
    }
  });
});
