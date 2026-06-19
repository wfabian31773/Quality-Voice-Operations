import { describe, it, expect } from 'vitest';
import { loadAgentConfig, type AgentLoadContext } from './agentLoader';

function ctx(over: Partial<AgentLoadContext> = {}): AgentLoadContext {
  return { tenantId: 't1' as never, agentId: 'ag1', agentType: 'answering_service', ...over };
}

describe('loadAgentConfig', () => {
  it('builds the answering-service template with defaults and appends voice principles', () => {
    const cfg = loadAgentConfig(ctx({ agentType: 'answering_service' }));
    expect(cfg).toMatchObject({ agentId: 'ag1', tenantId: 't1', voice: 'sage', model: 'gpt-realtime-2', language: 'en' });
    expect(cfg.systemPrompt).toContain('VOICE CONVERSATION PRINCIPLES');
    expect(cfg.greeting.length).toBeGreaterThan(0);
    expect(Array.isArray(cfg.tools)).toBe(true);
  });

  it('prefers an explicit DB system prompt over the template builder', () => {
    const cfg = loadAgentConfig(ctx({ dbAgent: { name: 'A', system_prompt: 'CUSTOM PROMPT BODY' } }));
    expect(cfg.systemPrompt).toContain('CUSTOM PROMPT BODY');
  });

  it('attaches medical safety guardrails for the after-hours template', () => {
    const cfg = loadAgentConfig(ctx({ agentType: 'medical_after_hours' }));
    expect(cfg.guardrails.length).toBeGreaterThan(0);
  });

  it('honours DB voice/model overrides', () => {
    const cfg = loadAgentConfig(ctx({ dbAgent: { name: 'A', system_prompt: 'X', voice: 'verse', model: 'gpt-4o-realtime' } }));
    expect(cfg.voice).toBe('verse');
    expect(cfg.model).toBe('gpt-4o-realtime');
  });

  it('appends a language directive for a non-English agent', () => {
    const cfg = loadAgentConfig(ctx({ dbAgent: { name: 'A', system_prompt: 'X', language: 'es' } }));
    expect(cfg.language).toBe('es');
    expect(cfg.systemPrompt).toContain('Respond to the caller in');
  });

  it('loads a DB-configured agent when the template is unknown', () => {
    const cfg = loadAgentConfig(ctx({ agentType: 'something_custom', dbAgent: { name: 'A', system_prompt: 'BESPOKE' } }));
    expect(cfg.systemPrompt).toContain('BESPOKE');
  });

  it('falls back to a generic config for an unknown template with no DB prompt', () => {
    const cfg = loadAgentConfig(ctx({ agentType: 'totally_unknown' }));
    expect(cfg.systemPrompt).toContain('helpful voice assistant');
    expect(cfg.tools).toEqual([]);
    expect(cfg.voice).toBe('sage');
  });

  it.each([
    'dental', 'property_management', 'home_services', 'legal',
    'customer_support', 'outbound_sales', 'technical_support', 'collections',
  ])('builds a vertical config for the %s template', (agentType) => {
    const cfg = loadAgentConfig(ctx({ agentType }));
    expect(cfg.systemPrompt).toContain('VOICE CONVERSATION PRINCIPLES');
    expect(cfg.greeting.length).toBeGreaterThan(0);
    expect(cfg.model).toBe('gpt-realtime-2');
    expect(Array.isArray(cfg.tools)).toBe(true);
  });

  it('respects tool permission overrides on a vertical template', () => {
    const cfg = loadAgentConfig(ctx({ agentType: 'dental', toolOverrides: [{ toolName: '__none__', enabled: false }] }));
    expect(Array.isArray(cfg.tools)).toBe(true);
  });
});
