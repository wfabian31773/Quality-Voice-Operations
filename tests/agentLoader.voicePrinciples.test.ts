import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';

import { loadAgentConfig } from '../server/voice-gateway/services/agentLoader';
import { VOICE_CONVERSATION_PRINCIPLES } from '../platform/agent-templates/voicePrinciples';
import type { TenantId } from '../platform/core/types';

function ctxFor(agentType: string, dbAgentOverrides: Record<string, unknown> = {}) {
  return {
    tenantId: randomUUID() as TenantId,
    agentId: 'agent_test',
    agentType,
    callerPhone: '+15551234567',
    dbAgent: {
      name: 'Test Agent',
      voice: 'sage',
      model: 'grok-voice-think-fast-2.0',
      metadata: { practiceName: 'Test Clinic', companyName: 'Test Co', firmName: 'Test LLP' },
      ...dbAgentOverrides,
    },
  };
}

const ALL_TEMPLATES = [
  'answering-service',
  'medical-after-hours',
  'dental',
  'property-management',
  'legal',
  'customer-support',
  'collections',
  'home-services',
];

describe('VOICE_CONVERSATION_PRINCIPLES global injection', () => {
  it.each(ALL_TEMPLATES)(
    'is appended to the %s template prompt',
    (template) => {
      const cfg = loadAgentConfig(ctxFor(template));
      expect(cfg.systemPrompt).toContain('VOICE CONVERSATION PRINCIPLES');
      expect(cfg.systemPrompt).toContain(VOICE_CONVERSATION_PRINCIPLES);
    },
  );

  it('is appended to a DB-defined (custom) agent prompt with no matching template', () => {
    const cfg = loadAgentConfig(
      ctxFor('does-not-exist-template', {
        system_prompt: 'You are a custom voice agent built by the tenant.',
      }),
    );
    expect(cfg.systemPrompt).toContain('You are a custom voice agent built by the tenant.');
    expect(cfg.systemPrompt).toContain('VOICE CONVERSATION PRINCIPLES');
  });

  it('is appended to the generic fallback agent (no template, no DB prompt)', () => {
    const cfg = loadAgentConfig({
      tenantId: randomUUID() as TenantId,
      agentId: 'agent_test',
      agentType: 'does-not-exist',
      callerPhone: '+15551234567',
    });
    expect(cfg.systemPrompt).toContain('VOICE CONVERSATION PRINCIPLES');
  });

  it('appears at most once even if the prompt already references it (no double-append on re-finalize)', () => {
    const cfg = loadAgentConfig(
      ctxFor('customer-support', {
        system_prompt: `Custom prompt body.\n\n${VOICE_CONVERSATION_PRINCIPLES}`,
      }),
    );
    const occurrences = cfg.systemPrompt.split('VOICE CONVERSATION PRINCIPLES').length - 1;
    expect(occurrences).toBe(1);
  });

  it('appears AFTER the agent-specific instructions so the model weights it most heavily', () => {
    const cfg = loadAgentConfig(ctxFor('customer-support'));
    const principlesIdx = cfg.systemPrompt.indexOf('VOICE CONVERSATION PRINCIPLES');
    const roleIdx = cfg.systemPrompt.indexOf('YOUR ROLE');
    expect(principlesIdx).toBeGreaterThan(-1);
    expect(roleIdx).toBeGreaterThan(-1);
    expect(principlesIdx).toBeGreaterThan(roleIdx);
  });
});
