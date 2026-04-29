import { describe, it, expect, beforeEach, vi } from 'vitest';

const queryMock = vi.fn();

vi.mock('../../platform/db', () => ({
  getPlatformPool: () => ({ query: queryMock }),
}));

vi.mock('../../platform/billing/guardrails/TrialGuard', () => ({
  checkTrialAgentLimit: vi.fn(async () => ({ allowed: true })),
}));

vi.mock('../../platform/activation/ActivationService', () => ({
  recordActivationEvent: vi.fn(async () => undefined),
}));

beforeEach(() => {
  queryMock.mockReset();
});

interface InsertCapture {
  systemPrompt: string | null;
  welcomeGreeting: string | null;
  language: string | null;
}

function captureInsert(tenantSettings: Record<string, unknown> | null): InsertCapture {
  const captured: InsertCapture = { systemPrompt: null, welcomeGreeting: null, language: null };
  queryMock.mockImplementation(async (sql: string, params: unknown[]) => {
    if (sql.includes('FROM tenants WHERE id = $1')) {
      return { rows: [{ settings: tenantSettings }] };
    }
    if (sql.includes('INSERT INTO agents')) {
      captured.systemPrompt = params[3] as string | null;
      captured.welcomeGreeting = params[4] as string | null;
      captured.language = params[5] as string | null;
      return {
        rows: [{ id: 'agent-1', name: params[1], type: params[2], status: 'draft', language: params[5] }],
      };
    }
    return { rows: [] };
  });
  return captured;
}

describe('PlatformAssistant create_agent — tenant language', () => {
  it('seeds an English-tenant restaurant agent with English industry copy', async () => {
    const captured = captureInsert({ primaryLanguage: 'en' });
    const { executeToolCall } = await import('../../platform/assistant/PlatformAssistantService');

    const result = await executeToolCall(
      'create_agent',
      { name: 'Front Desk', type: 'restaurant' },
      'tenant-en',
      'tenant_owner',
    );

    expect(result.status).toBe('success');
    expect(result.message).toBe('Agent "Front Desk" created successfully');
    expect(captured.language).toBe('en');
    expect(captured.welcomeGreeting).toMatch(/reservation/i);
    expect(captured.systemPrompt).toMatch(/restaurant reservations host/i);
  });

  it('seeds a Spanish-tenant restaurant agent with Spanish industry copy', async () => {
    const captured = captureInsert({ primaryLanguage: 'es' });
    const { executeToolCall } = await import('../../platform/assistant/PlatformAssistantService');

    const result = await executeToolCall(
      'create_agent',
      { name: 'Recepción', type: 'restaurant' },
      'tenant-es',
      'tenant_owner',
    );

    expect(result.status).toBe('success');
    expect(result.message).toBe('Agent "Recepción" created successfully');
    expect(captured.language).toBe('es');
    // The Spanish industry copy mentions "reserva" — verify we did NOT fall back to English.
    expect(captured.welcomeGreeting).toMatch(/reserva/i);
    expect(captured.welcomeGreeting).not.toMatch(/reservation\b/i);
    expect(captured.systemPrompt).toMatch(/anfitri|reserva/i);
  });

  it('seeds a Hindi-tenant restaurant agent with Hindi industry copy and no English-fallback hint', async () => {
    const captured = captureInsert({ primaryLanguage: 'hi' });
    const { executeToolCall } = await import('../../platform/assistant/PlatformAssistantService');

    const result = await executeToolCall(
      'create_agent',
      { name: 'Front Desk', type: 'restaurant' },
      'tenant-hi',
      'tenant_owner',
    );

    expect(result.status).toBe('success');
    expect(captured.language).toBe('hi');
    // Hindi industry copy exists, so no fallback hint should be appended.
    expect(result.message).toBe('Agent "Front Desk" created successfully');
    // The greeting should be in Hindi (Devanagari script).
    expect(captured.welcomeGreeting).toMatch(/[\u0900-\u097F]/);
  });

  it('appends the fallback hint when the helper reports usedEnglishFallback=true', async () => {
    // Force the fallback path by mocking the i18n helper. This guards against
    // future template gaps (e.g. adding a new language without industry copy)
    // by verifying the assistant surfaces the same hint the Agents page shows.
    vi.resetModules();
    vi.doMock('../../client-app/src/lib/agentBuilderI18n', async () => {
      const actual = await vi.importActual<typeof import('../../client-app/src/lib/agentBuilderI18n')>(
        '../../client-app/src/lib/agentBuilderI18n',
      );
      return {
        ...actual,
        getIndustryTemplateCopy: () => ({
          welcomeGreeting: 'Hello (English fallback).',
          systemPrompt: 'English system prompt fallback.',
          nodes: {},
          language: 'es',
          usedEnglishFallback: true,
        }),
      };
    });

    const captured = captureInsert({ primaryLanguage: 'es' });
    const { executeToolCall } = await import('../../platform/assistant/PlatformAssistantService');

    const result = await executeToolCall(
      'create_agent',
      { name: 'Recepción', type: 'restaurant' },
      'tenant-es',
      'tenant_owner',
    );

    expect(result.status).toBe('success');
    expect(captured.language).toBe('es');
    expect(captured.welcomeGreeting).toBe('Hello (English fallback).');
    expect(captured.systemPrompt).toBe('English system prompt fallback.');
    // The hint must be the exact same localized string the Agents page
    // surfaces via `makeBuilderT('templateFallbackHint')`, so the two flows
    // stay in sync as translations evolve.
    const { makeBuilderT } = await import('../../client-app/src/lib/agentBuilderI18n');
    const { getAgentLanguageLabel } = await import('../../client-app/src/lib/agentLanguages');
    const expectedHint = makeBuilderT('es')('templateFallbackHint', {
      language: getAgentLanguageLabel('es'),
    });
    expect(result.message).toBe(`Agent "Recepción" created successfully. ${expectedHint}`);

    vi.doUnmock('../../client-app/src/lib/agentBuilderI18n');
    vi.resetModules();
  });

  it('uses the generic localized defaults for non-industry agent types', async () => {
    const captured = captureInsert({ primaryLanguage: 'es' });
    const { executeToolCall } = await import('../../platform/assistant/PlatformAssistantService');

    const result = await executeToolCall(
      'create_agent',
      { name: 'Genérico', type: 'general' },
      'tenant-es',
      'tenant_owner',
    );

    expect(result.status).toBe('success');
    expect(captured.language).toBe('es');
    // Generic Spanish greeting starts with "¡Hola!".
    expect(captured.welcomeGreeting).toMatch(/¡Hola!/);
    // No industry-template fallback hint for non-template types.
    expect(result.message).toBe('Agent "Genérico" created successfully');
  });

  it('preserves the caller-supplied custom system prompt instead of seeding template copy', async () => {
    const captured = captureInsert({ primaryLanguage: 'fr' });
    const { executeToolCall } = await import('../../platform/assistant/PlatformAssistantService');

    const customPrompt = 'You are a custom French agent.';
    const result = await executeToolCall(
      'create_agent',
      { name: 'Custom', type: 'restaurant', system_prompt: customPrompt },
      'tenant-fr',
      'tenant_owner',
    );

    expect(result.status).toBe('success');
    expect(captured.language).toBe('fr');
    expect(captured.systemPrompt).toBe(customPrompt);
    expect(captured.welcomeGreeting).toBeNull();
    expect(result.message).toBe('Agent "Custom" created successfully');
  });

  it('falls back to English when the tenant has no primaryLanguage setting', async () => {
    const captured = captureInsert({});
    const { executeToolCall } = await import('../../platform/assistant/PlatformAssistantService');

    const result = await executeToolCall(
      'create_agent',
      { name: 'Default', type: 'general' },
      'tenant-default',
      'tenant_owner',
    );

    expect(result.status).toBe('success');
    expect(captured.language).toBe('en');
    expect(captured.welcomeGreeting).toMatch(/Hello/);
  });
});
