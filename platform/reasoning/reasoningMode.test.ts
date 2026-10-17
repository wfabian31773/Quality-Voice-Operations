import { describe, expect, it } from 'vitest';
import { isSalonVerticalAgent, parseReasoningMode, resolveReasoningMode } from './reasoningMode';

describe('resolveReasoningMode', () => {
  it('defaults salon / barbershop agents to shadow (agent type or template key)', () => {
    expect(resolveReasoningMode({ agentType: 'salon' })).toEqual({ mode: 'shadow', source: 'vertical_default' });
    expect(resolveReasoningMode({ agentType: 'barbershop' })).toEqual({ mode: 'shadow', source: 'vertical_default' });
    expect(resolveReasoningMode({ agentType: 'Salon' }).mode).toBe('shadow');
  });

  it('metadata.vertical cannot put a non-salon agent into shadow', () => {
    for (const agentType of ['healthcare-receptionist', 'core-receptionist', 'general']) {
      for (const vertical of ['salon', 'barbershop']) {
        expect(resolveReasoningMode({ agentType, agentMetadata: { vertical, reasoningMode: 'shadow' } }), `${agentType} ${vertical}`)
          .toEqual({ mode: 'enforce', source: 'vertical_default' });
        expect(resolveReasoningMode({
          agentType,
          agentMetadata: { vertical },
          tenantSettings: { reasoningMode: 'shadow' },
        }).mode).toBe('enforce');
        expect(isSalonVerticalAgent({ agentType })).toBe(false);
      }
    }
  });

  it('defaults every other agent type to enforce (today\'s behavior)', () => {
    for (const agentType of ['core-receptionist', 'general', 'dental', 'healthcare-receptionist', 'medical-after-hours', 'legal', 'home-services', '', undefined, null]) {
      expect(resolveReasoningMode({ agentType }), String(agentType)).toEqual({ mode: 'enforce', source: 'vertical_default' });
    }
    expect(resolveReasoningMode({ agentType: 'dental', agentMetadata: { vertical: 'dental' } }).mode).toBe('enforce');
    expect(resolveReasoningMode({ agentType: 'dental', agentMetadata: {}, tenantSettings: {} }).mode).toBe('enforce');
  });

  it('non-salon agents resolve to enforce whatever agent metadata or tenant settings say', () => {
    for (const agentType of ['healthcare-receptionist', 'medical-after-hours', 'general', 'dental']) {
      for (const value of ['shadow', 'off', 'SHADOW', 'enforce']) {
        expect(resolveReasoningMode({ agentType, agentMetadata: { reasoningMode: value } }), `${agentType} agent ${value}`)
          .toEqual({ mode: 'enforce', source: 'vertical_default' });
        expect(resolveReasoningMode({ agentType, tenantSettings: { reasoningMode: value } }), `${agentType} tenant ${value}`)
          .toEqual({ mode: 'enforce', source: 'vertical_default' });
        expect(resolveReasoningMode({
          agentType,
          agentMetadata: { vertical: 'healthcare', reasoningMode: value },
          tenantSettings: { reasoningMode: value },
        }).mode).toBe('enforce');
      }
    }
  });

  it('agent config wins over tenant settings and the vertical default (salon)', () => {
    expect(resolveReasoningMode({
      agentType: 'salon',
      agentMetadata: { reasoningMode: 'enforce' },
      tenantSettings: { reasoningMode: 'shadow' },
    })).toEqual({ mode: 'enforce', source: 'agent' });
    expect(resolveReasoningMode({
      agentType: 'barbershop',
      agentMetadata: { reasoningMode: 'shadow' },
      tenantSettings: { reasoningMode: 'enforce' },
    })).toEqual({ mode: 'shadow', source: 'agent' });
  });

  it('tenant settings win over the vertical default (salon)', () => {
    expect(resolveReasoningMode({ agentType: 'salon', tenantSettings: { reasoningMode: 'enforce' } }))
      .toEqual({ mode: 'enforce', source: 'tenant' });
    expect(resolveReasoningMode({ agentType: 'salon', tenantSettings: { reasoningMode: 'shadow' } }))
      .toEqual({ mode: 'shadow', source: 'tenant' });
  });

  it('treats off as invalid: it falls through to the next level', () => {
    expect(resolveReasoningMode({ agentType: 'salon', agentMetadata: { reasoningMode: 'off' } }))
      .toEqual({ mode: 'shadow', source: 'vertical_default' });
    expect(resolveReasoningMode({
      agentType: 'salon',
      agentMetadata: { reasoningMode: 'off' },
      tenantSettings: { reasoningMode: 'enforce' },
    })).toEqual({ mode: 'enforce', source: 'tenant' });
    expect(parseReasoningMode('off')).toBeNull();
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
