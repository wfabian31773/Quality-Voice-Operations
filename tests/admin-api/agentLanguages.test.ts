import { describe, it, expect } from 'vitest';
import {
  AGENT_LANGUAGES,
  DEFAULT_AGENT_LANGUAGE,
  getAgentLanguageLabel,
  isSupportedAgentLanguage,
  normalizeAgentLanguage,
} from '../../platform/agent-templates/agentLanguages';
import { loadAgentConfig } from '../../server/voice-gateway/services/agentLoader';

describe('agentLanguages catalog', () => {
  it('exposes the 12 supported languages required by BL-021', () => {
    expect(AGENT_LANGUAGES).toHaveLength(12);
    const codes = AGENT_LANGUAGES.map((l) => l.code);
    expect(codes).toEqual([
      'en', 'es', 'fr', 'de', 'pt', 'it', 'nl', 'zh', 'ja', 'ko', 'ar', 'hi',
    ]);
  });

  it('defaults to English', () => {
    expect(DEFAULT_AGENT_LANGUAGE).toBe('en');
  });

  it('isSupportedAgentLanguage accepts known codes only', () => {
    expect(isSupportedAgentLanguage('es')).toBe(true);
    expect(isSupportedAgentLanguage('en')).toBe(true);
    expect(isSupportedAgentLanguage('xx')).toBe(false);
    expect(isSupportedAgentLanguage(null)).toBe(false);
    expect(isSupportedAgentLanguage(undefined)).toBe(false);
  });

  it('getAgentLanguageLabel returns human label, falling back to English', () => {
    expect(getAgentLanguageLabel('es')).toBe('Spanish');
    expect(getAgentLanguageLabel('fr')).toBe('French');
    expect(getAgentLanguageLabel('xx')).toBe('English');
  });

  it('normalizeAgentLanguage handles codes, labels, and bad input', () => {
    expect(normalizeAgentLanguage('es')).toBe('es');
    expect(normalizeAgentLanguage('Spanish')).toBe('es');
    expect(normalizeAgentLanguage('  french  ')).toBe('fr');
    expect(normalizeAgentLanguage('')).toBe('en');
    expect(normalizeAgentLanguage(null)).toBe('en');
    expect(normalizeAgentLanguage('klingon')).toBe('en');
  });
});

describe('agentLoader language wiring', () => {
  const baseDbAgent = {
    name: 'Test Agent',
    system_prompt: 'You are a helpful assistant for ACME Co.',
    voice: 'sage',
    model: 'gpt-4o-realtime-preview',
    tools: [],
    metadata: {},
  };

  it('returns the default language when none is configured', () => {
    const cfg = loadAgentConfig({
      tenantId: 'tenant-1' as never,
      agentId: 'agent-1',
      agentType: 'customer-support',
      dbAgent: { ...baseDbAgent },
    });

    expect(cfg.language).toBe('en');
    expect(cfg.systemPrompt).not.toMatch(/Respond to the caller in/i);
  });

  it('appends a language directive to the system prompt for non-English languages', () => {
    const cfg = loadAgentConfig({
      tenantId: 'tenant-1' as never,
      agentId: 'agent-1',
      agentType: 'customer-support',
      dbAgent: { ...baseDbAgent, language: 'es' },
    });

    expect(cfg.language).toBe('es');
    expect(cfg.systemPrompt).toContain('Respond to the caller in Spanish');
    expect(cfg.systemPrompt).toContain('All spoken responses must be in Spanish');
  });

  it('normalizes invalid language codes back to the default', () => {
    const cfg = loadAgentConfig({
      tenantId: 'tenant-1' as never,
      agentId: 'agent-1',
      agentType: 'customer-support',
      dbAgent: { ...baseDbAgent, language: 'klingon' },
    });

    expect(cfg.language).toBe('en');
    expect(cfg.systemPrompt).not.toMatch(/Respond to the caller in/i);
  });

  it('reads language from db metadata fallback when column is missing', () => {
    const cfg = loadAgentConfig({
      tenantId: 'tenant-1' as never,
      agentId: 'agent-1',
      agentType: 'customer-support',
      dbAgent: { ...baseDbAgent, metadata: { language: 'fr' } },
    });

    expect(cfg.language).toBe('fr');
    expect(cfg.systemPrompt).toContain('Respond to the caller in French');
  });

  it('does not duplicate the directive when the prompt already contains it', () => {
    const promptWithDirective =
      'You are a helpful assistant.\n\nRespond to the caller in German. All spoken responses must be in German.';

    const cfg = loadAgentConfig({
      tenantId: 'tenant-1' as never,
      agentId: 'agent-1',
      agentType: 'customer-support',
      dbAgent: { ...baseDbAgent, system_prompt: promptWithDirective, language: 'de' },
    });

    const matches = cfg.systemPrompt.match(/Respond to the caller in German/g) ?? [];
    expect(matches.length).toBe(1);
  });
});
