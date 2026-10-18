// RT-09 flag on: a barbershop agent whose metadata says runtime: 'composer'
// loads from compose(barbershop@1, …) with contract tools only.
import { describe, expect, it } from 'vitest';
import { RUNTIME_TOOL_NAMES } from '../../../platform/agent-runtime/composer';
import { BARBERSHOP_TEMPLATE_V1 } from '../../../platform/agent-templates/barbershop';
import { CALLER_ID_TOKEN } from '../../../platform/reasoning/sessionBinding';
import { TOOL_LIBRARY_NAMES } from '../../../platform/tools/library/catalog';
import { COMPOSER_RUNTIME, composerTemplateFor, loadAgentConfig, type AgentLoadContext } from './agentLoader';

const SHOP_PROMPT = 'Hours: Tuesday to Saturday, 9 AM to 7 PM. Closed Sunday and Monday. Address: 412 Main Street.';

function composerCtx(over: { language?: string; metadata?: Record<string, unknown>; system_prompt?: string; callerPhone?: string } = {}): AgentLoadContext {
  return {
    tenantId: 't-shop' as never,
    agentId: 'ag-shop',
    agentType: 'barbershop',
    callerPhone: over.callerPhone ?? '+15555550142',
    dbAgent: {
      name: 'Front desk',
      system_prompt: over.system_prompt ?? SHOP_PROMPT,
      voice: 'ara',
      language: over.language ?? 'en',
      tenant_timezone: 'America/Chicago',
      metadata: { businessName: 'Sharp Line Barbers', runtime: COMPOSER_RUNTIME, ...over.metadata },
    },
  };
}

const CONTRACT_TOOLS = [
  'scheduling_book_prepare',
  'scheduling_book_commit',
  'scheduling_find_bookings',
  'scheduling_reschedule_prepare',
  'scheduling_reschedule_commit',
  'scheduling_cancel_prepare',
  'scheduling_cancel_commit',
  'tickets_open_prepare',
  'tickets_open_commit',
  // barbershop@1's reads: ids and open times for booking and moving.
  'scheduling_list_services',
  'scheduling_list_staff',
  'scheduling_check_availability',
];

describe('composer flag', () => {
  it('is on only for runtime exactly "composer" on an agent type with a composer template', () => {
    expect(composerTemplateFor('barbershop', { runtime: 'composer' })).toBe(BARBERSHOP_TEMPLATE_V1);
    expect(composerTemplateFor('barbershop', {})).toBeUndefined();
    expect(composerTemplateFor('barbershop', { runtime: 'Composer ' })).toBeUndefined();
    expect(composerTemplateFor('barbershop', { runtime: true })).toBeUndefined();
    expect(composerTemplateFor('salon', { runtime: 'composer' })).toBeUndefined();
    expect(composerTemplateFor('constructor', { runtime: 'composer' })).toBeUndefined();
  });
});

describe('loadAgentConfig with the composer flag on', () => {
  const cfg = loadAgentConfig(composerCtx());

  it('loads barbershop@1, not the salon role package', () => {
    expect(cfg.rolePackageId).toBe('barbershop');
    expect(cfg.rolePackageVersion).toBe('1.0.0');
    expect(cfg.metadata).toMatchObject({ role: 'barbershop', template: 'barbershop@1', runtime: 'composer', businessName: 'Sharp Line Barbers' });
    expect(cfg.model).toBe('grok-voice-3.0');
    expect(cfg.timeZone).toBe('America/Chicago');
  });

  it('exposes exactly the contract actions plus the runtime tools: no library tool', () => {
    expect(cfg.tools.map((t) => t.name)).toEqual([...CONTRACT_TOOLS, ...RUNTIME_TOOL_NAMES]);
    const library = TOOL_LIBRARY_NAMES.filter((n) => !(RUNTIME_TOOL_NAMES as readonly string[]).includes(n));
    expect(cfg.tools.filter((t) => library.includes(t.name) || t.name === 'escalate_to_human')).toEqual([]);
    expect(Object.keys(cfg.contractTools?.actions ?? {})).toEqual(CONTRACT_TOOLS);
  });

  it('puts the persona, the shop\'s facts and the caller ID in the role prompt', () => {
    expect(cfg.rolePrompt.startsWith(BARBERSHOP_TEMPLATE_V1.persona.en)).toBe(true);
    expect(cfg.rolePrompt).toContain('- Name: Sharp Line Barbers');
    expect(cfg.rolePrompt).toContain(SHOP_PROMPT);
    expect(cfg.rolePrompt).toContain('a number ending in 0142');
    expect(cfg.rolePrompt).not.toContain('5555550142');
    expect(cfg.systemPrompt).toContain(cfg.rolePrompt);
    expect(cfg.greeting).toBe('Thanks for calling Sharp Line Barbers. How can I help you today?');
    expect(cfg.keyterms).toEqual(['Sharp Line Barbers']);
  });

  it('every tool the full system prompt names is in the tool list', () => {
    const named = [...new Set(cfg.systemPrompt.match(/\b[a-z][a-z0-9]+(?:[._][a-z0-9]+)+\b/g) ?? [])]
      .filter((n) => n !== CALLER_ID_TOKEN);
    const known = new Set([...cfg.tools.map((t) => t.name), ...Object.values(cfg.contractTools?.actions ?? {})]);
    expect(named.filter((n) => !known.has(n))).toEqual([]);
    expect(cfg.systemPrompt).not.toContain('business.get_info');
  });

  it('a Spanish agent gets the Spanish persona and greeting', () => {
    const es = loadAgentConfig(composerCtx({ language: 'es' }));
    expect(es.language).toBe('es');
    expect(es.rolePrompt.startsWith(BARBERSHOP_TEMPLATE_V1.persona.es)).toBe(true);
    expect(es.greeting).toBe('Gracias por llamar a Sharp Line Barbers. ¿En qué le puedo ayudar?');
    expect(es.systemPrompt).toContain('Begin in Spanish');
  });

  it('keeps the shop\'s own greeting, and leaves out stock builder copy and a withheld caller ID', () => {
    const own = loadAgentConfig(composerCtx({ metadata: { greeting: 'Sharp Line, this is the front desk.' }, system_prompt: '', callerPhone: '' }));
    expect(own.greeting).toBe('Sharp Line, this is the front desk.');
    expect(own.rolePrompt).not.toContain('Caller ID:');
    expect(own.rolePrompt).toContain('- Name: Sharp Line Barbers\nIf a business detail');
  });
});
