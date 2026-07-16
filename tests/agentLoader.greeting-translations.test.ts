import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';

import { loadAgentConfig } from '../server/voice-gateway/services/agentLoader';
import {
  buildLocalizedGreeting,
  type GreetingTemplateKey,
} from '../platform/agent-templates/greetingTranslations';
import { AGENT_LANGUAGES } from '../platform/agent-templates/agentLanguages';
import { buildHealthcareReceptionistGreeting } from '../platform/agent-templates/healthcare-receptionist';
import type { TenantId } from '../platform/core/types';

const ALL_TEMPLATE_KEYS: GreetingTemplateKey[] = [
  'dental',
  'property-management',
  'home-services',
  'legal',
  'customer-support',
  'outbound-sales',
  'technical-support',
  'collections',
  'medical-after-hours',
  'answering-service',
];

function makeCtx(agentType: string, language: string | undefined, meta: Record<string, unknown>) {
  return {
    tenantId: randomUUID() as TenantId,
    agentId: 'agent_test',
    agentType,
    callerPhone: '+15551234567',
    dbAgent: {
      name: 'Test Agent',
      voice: 'sage',
      model: 'gpt-4o-realtime-preview',
      metadata: meta,
      ...(language !== undefined ? { language } : {}),
    },
  };
}

describe('buildLocalizedGreeting', () => {
  it('returns localized output for every supported language across every template', () => {
    for (const key of ALL_TEMPLATE_KEYS) {
      for (const lang of AGENT_LANGUAGES) {
        const greeting = buildLocalizedGreeting(key, 'Acme Co', lang.code);
        expect(typeof greeting).toBe('string');
        expect(greeting.length).toBeGreaterThan(0);
        expect(greeting).toContain('Acme Co');
      }
    }
  });

  it('falls back to English when language is unsupported or missing', () => {
    const en = buildLocalizedGreeting('dental', 'Smile Dental', 'en');
    expect(buildLocalizedGreeting('dental', 'Smile Dental', 'xx')).toBe(en);
    expect(buildLocalizedGreeting('dental', 'Smile Dental', undefined)).toBe(en);
    expect(buildLocalizedGreeting('dental', 'Smile Dental', '')).toBe(en);
  });

  it('produces distinct localized text for non-English languages', () => {
    const en = buildLocalizedGreeting('dental', 'Smile Dental', 'en');
    const es = buildLocalizedGreeting('dental', 'Smile Dental', 'es');
    const fr = buildLocalizedGreeting('dental', 'Smile Dental', 'fr');
    expect(es).not.toBe(en);
    expect(fr).not.toBe(en);
    expect(es).not.toBe(fr);
  });

  it('substitutes the {name} placeholder rather than leaving it raw', () => {
    for (const key of ALL_TEMPLATE_KEYS) {
      for (const lang of AGENT_LANGUAGES) {
        const greeting = buildLocalizedGreeting(key, 'XYZ Corp', lang.code);
        expect(greeting).not.toContain('{name}');
      }
    }
  });
});

describe('loadAgentConfig - localized default greeting per template', () => {
  it('uses the localized greeting for a Spanish dental agent', () => {
    const cfg = loadAgentConfig(makeCtx('dental', 'es', { practiceName: 'Sonrisa Dental' }));
    expect(cfg.greeting).toBe(buildLocalizedGreeting('dental', 'Sonrisa Dental', 'es'));
    expect(cfg.greeting).not.toContain('Thank you for calling');
  });

  it('uses the localized greeting for a French legal agent', () => {
    const cfg = loadAgentConfig(makeCtx('legal', 'fr', { firmName: 'Cabinet Dupont' }));
    expect(cfg.greeting).toBe(buildLocalizedGreeting('legal', 'Cabinet Dupont', 'fr'));
  });

  it('uses the localized greeting for a German home-services agent', () => {
    const cfg = loadAgentConfig(makeCtx('home-services', 'de', { companyName: 'Mustermann GmbH' }));
    expect(cfg.greeting).toBe(buildLocalizedGreeting('home-services', 'Mustermann GmbH', 'de'));
  });

  it('uses the localized greeting for a Japanese answering-service agent', () => {
    const cfg = loadAgentConfig(makeCtx('answering-service', 'ja', { practiceName: '青クリニック' }));
    expect(cfg.greeting).toBe(buildHealthcareReceptionistGreeting('青クリニック', 'ja'));
  });

  it('uses the localized greeting for a Portuguese medical-after-hours agent', () => {
    const cfg = loadAgentConfig(makeCtx('medical-after-hours', 'pt', { practiceName: 'Clínica Sol' }));
    expect(cfg.greeting).toBe(buildLocalizedGreeting('medical-after-hours', 'Clínica Sol', 'pt'));
    expect(cfg.greeting).toContain('Clínica Sol');
  });

  it('honors a custom greeting saved in metadata over the localized default', () => {
    const customGreeting = 'Custom multilingual hello';
    const cfg = loadAgentConfig(
      makeCtx('dental', 'es', { practiceName: 'Sonrisa Dental', greeting: customGreeting }),
    );
    expect(cfg.greeting).toBe(customGreeting);
  });

  it('falls back to the English greeting when no language is set', () => {
    const cfg = loadAgentConfig(makeCtx('dental', undefined, { practiceName: 'Test Dental' }));
    expect(cfg.greeting).toBe(buildLocalizedGreeting('dental', 'Test Dental', 'en'));
  });
});
