import { describe, expect, it } from 'vitest';
import { isSalonVerticalAgent, parseReasoningMode, resolveReasoningMode } from './reasoningMode';

describe('resolveReasoningMode', () => {
  it('defaults salon / barbershop agents to shadow (agent type or metadata.vertical)', () => {
    expect(resolveReasoningMode({ agentType: 'salon' })).toEqual({ mode: 'shadow', source: 'vertical_default' });
    expect(resolveReasoningMode({ agentType: 'barbershop' })).toEqual({ mode: 'shadow', source: 'vertical_default' });
    expect(resolveReasoningMode({ agentType: 'Salon' }).mode).toBe('shadow');
    expect(resolveReasoningMode({ agentType: 'general', agentMetadata: { vertical: 'barbershop' } }).mode).toBe('shadow');
    expect(resolveReasoningMode({ agentType: 'core-receptionist', agentMetadata: { vertical: 'salon' } }).mode).toBe('shadow');
  });

  it('defaults every other agent type to enforce (today\'s behavior)', () => {
    for (const agentType of ['core-receptionist', 'general', 'dental', 'healthcare-receptionist', 'medical-after-hours', 'legal', 'home-services', '', undefined, null]) {
      expect(resolveReasoningMode({ agentType }), String(agentType)).toEqual({ mode: 'enforce', source: 'vertical_default' });
    }
    expect(resolveReasoningMode({ agentType: 'dental', agentMetadata: { vertical: 'dental' } }).mode).toBe('enforce');
    expect(resolveReasoningMode({ agentType: 'dental', agentMetadata: {}, tenantSettings: {} }).mode).toBe('enforce');
  });

  it('agent config wins over tenant settings and the vertical default', () => {
    expect(resolveReasoningMode({
      agentType: 'salon',
      agentMetadata: { reasoningMode: 'enforce' },
      tenantSettings: { reasoningMode: 'off' },
    })).toEqual({ mode: 'enforce', source: 'agent' });
    expect(resolveReasoningMode({
      agentType: 'dental',
      agentMetadata: { reasoningMode: 'shadow' },
      tenantSettings: { reasoningMode: 'enforce' },
    })).toEqual({ mode: 'shadow', source: 'agent' });
  });

  it('tenant settings win over the vertical default', () => {
    expect(resolveReasoningMode({ agentType: 'salon', tenantSettings: { reasoningMode: 'enforce' } }))
      .toEqual({ mode: 'enforce', source: 'tenant' });
    expect(resolveReasoningMode({ agentType: 'dental', tenantSettings: { reasoningMode: 'shadow' } }))
      .toEqual({ mode: 'shadow', source: 'tenant' });
    expect(resolveReasoningMode({ agentType: 'dental', tenantSettings: { reasoningMode: 'off' } }).mode).toBe('off');
  });

  it('ignores unknown or non-string values and falls through to the next level', () => {
    expect(resolveReasoningMode({
      agentType: 'salon',
      agentMetadata: { reasoningMode: 'shadoww' },
      tenantSettings: { reasoningMode: 'ENFORCE' },
    })).toEqual({ mode: 'enforce', source: 'tenant' });
    expect(resolveReasoningMode({
      agentType: 'salon',
      agentMetadata: { reasoningMode: true },
      tenantSettings: { reasoningMode: 42 },
    })).toEqual({ mode: 'shadow', source: 'vertical_default' });
  });

  it('parses and classifies', () => {
    expect(parseReasoningMode(' Shadow ')).toBe('shadow');
    expect(parseReasoningMode('nope')).toBeNull();
    expect(isSalonVerticalAgent({ agentType: 'salon' })).toBe(true);
    expect(isSalonVerticalAgent({ agentType: 'nail-salon' })).toBe(false);
  });
});
