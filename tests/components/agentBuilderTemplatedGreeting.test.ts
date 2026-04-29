import { describe, it, expect } from 'vitest';

import {
  getGreetingTemplateKeyForAgentType,
  getAgentTypeLabelTKey,
  getTemplatedWelcomeGreeting,
  isTemplatedWelcomeGreeting,
} from '../../client-app/src/lib/agentBuilderI18n';
import { buildLocalizedGreeting } from '../../platform/agent-templates/greetingTranslations';

describe('agent-type → greeting template mapping', () => {
  it('maps the canonical kebab-case agent types to template keys', () => {
    expect(getGreetingTemplateKeyForAgentType('dental')).toBe('dental');
    expect(getGreetingTemplateKeyForAgentType('home-services')).toBe('home-services');
    expect(getGreetingTemplateKeyForAgentType('property-management')).toBe('property-management');
    expect(getGreetingTemplateKeyForAgentType('legal')).toBe('legal');
    expect(getGreetingTemplateKeyForAgentType('customer-support')).toBe('customer-support');
    expect(getGreetingTemplateKeyForAgentType('outbound-sales')).toBe('outbound-sales');
    expect(getGreetingTemplateKeyForAgentType('technical-support')).toBe('technical-support');
    expect(getGreetingTemplateKeyForAgentType('collections')).toBe('collections');
    expect(getGreetingTemplateKeyForAgentType('medical-after-hours')).toBe('medical-after-hours');
    expect(getGreetingTemplateKeyForAgentType('answering-service')).toBe('answering-service');
  });

  it('also accepts the snake_case variants used by some legacy callers', () => {
    expect(getGreetingTemplateKeyForAgentType('home_services')).toBe('home-services');
    expect(getGreetingTemplateKeyForAgentType('medical_after_hours')).toBe('medical-after-hours');
    expect(getGreetingTemplateKeyForAgentType('customer_support')).toBe('customer-support');
  });

  it('returns null for unknown / generic / empty agent types', () => {
    expect(getGreetingTemplateKeyForAgentType('')).toBeNull();
    expect(getGreetingTemplateKeyForAgentType(null)).toBeNull();
    expect(getGreetingTemplateKeyForAgentType(undefined)).toBeNull();
    expect(getGreetingTemplateKeyForAgentType('general')).toBeNull();
    expect(getGreetingTemplateKeyForAgentType('custom')).toBeNull();
  });

  it('exposes a translation key matching every supported template', () => {
    expect(getAgentTypeLabelTKey('dental')).toBe('agentTypeDental');
    expect(getAgentTypeLabelTKey('home-services')).toBe('agentTypeHomeServices');
    expect(getAgentTypeLabelTKey('medical-after-hours')).toBe('agentTypeMedicalAfterHours');
    expect(getAgentTypeLabelTKey('answering-service')).toBe('agentTypeAnsweringService');
    expect(getAgentTypeLabelTKey('general')).toBeNull();
  });
});

describe('getTemplatedWelcomeGreeting', () => {
  it('produces the localized per-template greeting using the agent name', () => {
    const greeting = getTemplatedWelcomeGreeting('dental', 'es', 'Sonrisa Dental');
    expect(greeting).toBe(buildLocalizedGreeting('dental', 'Sonrisa Dental', 'es'));
    expect(greeting).toContain('Sonrisa Dental');
    expect(greeting).not.toContain('{name}');
  });

  it('falls back to a localised placeholder name when the agent has none yet', () => {
    const en = getTemplatedWelcomeGreeting('dental', 'en', '   ');
    expect(en).toBe(buildLocalizedGreeting('dental', 'your business', 'en'));

    const es = getTemplatedWelcomeGreeting('dental', 'es', null);
    expect(es).toBe(buildLocalizedGreeting('dental', 'su negocio', 'es'));
  });

  it('returns null when the agent has no per-template type', () => {
    expect(getTemplatedWelcomeGreeting('', 'en', 'Foo')).toBeNull();
    expect(getTemplatedWelcomeGreeting('general', 'en', 'Foo')).toBeNull();
    expect(getTemplatedWelcomeGreeting(null, 'en', 'Foo')).toBeNull();
  });

  it('switches the language while keeping the same name', () => {
    const en = getTemplatedWelcomeGreeting('home-services', 'en', 'Acme Plumbing');
    const fr = getTemplatedWelcomeGreeting('home-services', 'fr', 'Acme Plumbing');
    expect(en).toContain('Acme Plumbing');
    expect(fr).toContain('Acme Plumbing');
    expect(en).not.toBe(fr);
  });
});

describe('Agent Builder greeting state transitions (handleSettingChange semantics)', () => {
  // These tests mirror the exact branches of `handleSettingChange` in
  // `AgentBuilder.tsx`, exercising the helpers in the same sequences the
  // builder uses: initial load → language switch → custom edit → name change.

  type GreetingState = {
    welcome_greeting: string;
    language: string;
    name: string;
    agent_type: string;
  };

  const isDefaultLikeOrTemplated = (state: GreetingState): boolean => {
    const cur = state.welcome_greeting.trim();
    if (!cur) return true;
    // The real `isDefaultGreeting` checks against generic localized defaults;
    // for these tests we focus on empty + templated detection, which is the
    // critical preservation path.
    return isTemplatedWelcomeGreeting(state.welcome_greeting, state.agent_type, state.name);
  };

  const switchLanguage = (state: GreetingState, newLang: string): GreetingState => {
    const next = { ...state, language: newLang };
    if (isDefaultLikeOrTemplated(state)) {
      next.welcome_greeting =
        getTemplatedWelcomeGreeting(state.agent_type, newLang, state.name) ??
        state.welcome_greeting;
    }
    return next;
  };

  const renameAgent = (state: GreetingState, newName: string): GreetingState => {
    const next = { ...state, name: newName };
    if (
      state.agent_type &&
      isTemplatedWelcomeGreeting(state.welcome_greeting, state.agent_type, state.name)
    ) {
      const reinterpolated = getTemplatedWelcomeGreeting(
        state.agent_type,
        state.language,
        newName,
      );
      if (reinterpolated) next.welcome_greeting = reinterpolated;
    }
    return next;
  };

  it('seeds the templated suggestion on initial load when greeting is empty', () => {
    const initial: GreetingState = {
      welcome_greeting: '',
      language: 'en',
      name: 'Smile Dental',
      agent_type: 'dental',
    };
    const seeded = {
      ...initial,
      welcome_greeting:
        getTemplatedWelcomeGreeting(initial.agent_type, initial.language, initial.name) ?? '',
    };
    expect(seeded.welcome_greeting).toContain('Smile Dental');
    expect(isTemplatedWelcomeGreeting(seeded.welcome_greeting, 'dental', 'Smile Dental')).toBe(
      true,
    );
  });

  it('re-localises an untouched templated greeting when the language changes', () => {
    const initial: GreetingState = {
      welcome_greeting: buildLocalizedGreeting('dental', 'Smile Dental', 'en'),
      language: 'en',
      name: 'Smile Dental',
      agent_type: 'dental',
    };
    const switched = switchLanguage(initial, 'es');
    expect(switched.language).toBe('es');
    expect(switched.welcome_greeting).toBe(
      buildLocalizedGreeting('dental', 'Smile Dental', 'es'),
    );
    expect(switched.welcome_greeting).not.toBe(initial.welcome_greeting);
  });

  it('preserves a customised greeting across language changes', () => {
    const initial: GreetingState = {
      welcome_greeting: 'Hi there, this is a totally custom intro!',
      language: 'en',
      name: 'Smile Dental',
      agent_type: 'dental',
    };
    const switched = switchLanguage(initial, 'es');
    expect(switched.welcome_greeting).toBe(initial.welcome_greeting);
    expect(switched.language).toBe('es');
  });

  it('re-interpolates the templated greeting when the agent is renamed', () => {
    const initial: GreetingState = {
      welcome_greeting: buildLocalizedGreeting('dental', 'Acme Dental', 'en'),
      language: 'en',
      name: 'Acme Dental',
      agent_type: 'dental',
    };
    const renamed = renameAgent(initial, 'Beta Dental');
    expect(renamed.name).toBe('Beta Dental');
    expect(renamed.welcome_greeting).toBe(
      buildLocalizedGreeting('dental', 'Beta Dental', 'en'),
    );
    expect(renamed.welcome_greeting).toContain('Beta Dental');
    expect(renamed.welcome_greeting).not.toContain('Acme Dental');
  });

  it('preserves a customised greeting when the agent is renamed', () => {
    const initial: GreetingState = {
      welcome_greeting: 'Hi there, this is a totally custom intro!',
      language: 'en',
      name: 'Acme Dental',
      agent_type: 'dental',
    };
    const renamed = renameAgent(initial, 'Beta Dental');
    expect(renamed.welcome_greeting).toBe(initial.welcome_greeting);
    expect(renamed.name).toBe('Beta Dental');
  });

  it('keeps language re-localisation working after a rename (no stale-name bug)', () => {
    let state: GreetingState = {
      welcome_greeting: '',
      language: 'en',
      name: 'Acme Dental',
      agent_type: 'dental',
    };
    // Initial seed.
    state = {
      ...state,
      welcome_greeting:
        getTemplatedWelcomeGreeting(state.agent_type, state.language, state.name) ?? '',
    };
    // Rename — greeting should re-interpolate so the suggestion is fresh.
    state = renameAgent(state, 'Beta Dental');
    expect(state.welcome_greeting).toBe(
      buildLocalizedGreeting('dental', 'Beta Dental', 'en'),
    );
    // Now the operator switches language — greeting must still be detected as
    // templated (with the *new* name), so it is re-localised cleanly.
    state = switchLanguage(state, 'fr');
    expect(state.welcome_greeting).toBe(
      buildLocalizedGreeting('dental', 'Beta Dental', 'fr'),
    );
  });
});

describe('isTemplatedWelcomeGreeting', () => {
  it('matches the template suggestion for the agent type in any language', () => {
    const en = buildLocalizedGreeting('dental', 'Smile Dental', 'en');
    const es = buildLocalizedGreeting('dental', 'Smile Dental', 'es');
    expect(isTemplatedWelcomeGreeting(en, 'dental', 'Smile Dental')).toBe(true);
    expect(isTemplatedWelcomeGreeting(es, 'dental', 'Smile Dental')).toBe(true);
  });

  it('matches the placeholder-name suggestion when the agent name is blank', () => {
    const placeholder = buildLocalizedGreeting('dental', 'your business', 'en');
    expect(isTemplatedWelcomeGreeting(placeholder, 'dental', '')).toBe(true);
    const placeholderEs = buildLocalizedGreeting('dental', 'su negocio', 'es');
    expect(isTemplatedWelcomeGreeting(placeholderEs, 'dental', '')).toBe(true);
  });

  it('returns false for customised greetings, empty values, and non-template agents', () => {
    expect(isTemplatedWelcomeGreeting('Hi there!', 'dental', 'Smile Dental')).toBe(false);
    expect(isTemplatedWelcomeGreeting('', 'dental', 'Smile Dental')).toBe(false);
    const dentalEn = buildLocalizedGreeting('dental', 'Acme', 'en');
    expect(isTemplatedWelcomeGreeting(dentalEn, 'general', 'Acme')).toBe(false);
  });

  it('returns false when the greeting matches a different template than the agent type', () => {
    // Distinct templates produce distinct copy for the same name + language.
    const legalEn = buildLocalizedGreeting('legal', 'Smith & Co', 'en');
    expect(isTemplatedWelcomeGreeting(legalEn, 'dental', 'Smith & Co')).toBe(false);
  });
});
