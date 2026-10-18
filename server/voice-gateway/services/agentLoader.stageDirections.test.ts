import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadAgentConfig, type AgentLoadContext } from './agentLoader';
import { StructuredLogger } from '../../../platform/core/logger';
import { findStageDirections } from '../../../platform/agent-runtime/promptLint';
import { createCoreReceptionistRolePackage } from '../../../platform/agent-templates/core-receptionist';

const { stripSpy } = vi.hoisted(() => ({ stripSpy: vi.fn() }));

vi.mock('../../../platform/agent-runtime/promptLint', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../platform/agent-runtime/promptLint')>();
  stripSpy.mockImplementation(actual.stripStageDirections);
  return { ...actual, stripStageDirections: stripSpy };
});

const STAGE_DIRECTION_LOG = 'Stage directions removed from agent role prompt';
const STAGE_DIRECTION_GREETING_LOG = 'Stage directions removed from agent greeting';
const STAGE_DIRECTION_DEBUG_LOG ='Possible stage directions in agent role prompt; nothing removed';

function ctx(over: Partial<AgentLoadContext> = {}): AgentLoadContext {
  return { tenantId: 't1' as never, agentId: 'ag1', agentType: 'answering_service', ...over };
}

function stageDirectionWarnings(warn: ReturnType<typeof vi.spyOn>) {
  return warn.mock.calls.filter(([message]: unknown[]) => message === STAGE_DIRECTION_LOG);
}

function greetingWarnings(warn: ReturnType<typeof vi.spyOn>) {
  return warn.mock.calls.filter(([message]: unknown[]) => message === STAGE_DIRECTION_GREETING_LOG);
}

function stageDirectionDebugs(debug: ReturnType<typeof vi.spyOn>) {
  return debug.mock.calls.filter(([message]: unknown[]) => message === STAGE_DIRECTION_DEBUG_LOG);
}

describe('loadAgentConfig strips stage directions from tenant prompts', () => {
  let warn: ReturnType<typeof vi.spyOn>;
  let debug: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stripSpy.mockClear();
    warn = vi.spyOn(StructuredLogger.prototype, 'warn');
    debug = vi.spyOn(StructuredLogger.prototype, 'debug');
  });

  afterEach(() => {
    warn.mockRestore();
    debug.mockRestore();
  });

  it('removes bracketed and asterisk directions from salon business details and keeps the details', () => {
    const businessDetails = 'Services: Haircut 30 min, Fade 45 min. Hours Tue–Sat 9–7.';
    const cfg = loadAgentConfig(ctx({
      agentType: 'salon',
      dbAgent: {
        name: 'Front Desk',
        system_prompt: `${businessDetails} After a booking, call create_ticket (file the ticket quietly) and *pauses* confirm the time.`,
        metadata: { businessName: 'Sharp Line Barbers' },
      },
    }));

    expect(cfg.systemPrompt).toContain(businessDetails);
    expect(cfg.systemPrompt).toContain('call create_ticket and confirm the time.');
    expect(cfg.systemPrompt).not.toContain('(file the ticket quietly)');
    expect(cfg.systemPrompt).not.toContain('*pauses*');
    expect(findStageDirections(cfg.systemPrompt).filter((hit) => hit.rule !== 'narration-word')).toEqual([]);

    const warnings = stageDirectionWarnings(warn);
    expect(warnings).toHaveLength(1);
    expect(warnings[0][1]).toEqual({
      tenantId: 't1',
      agentId: 'ag1',
      counts: { 'bracketed-narration': 1, 'asterisk-action': 1 },
      removed: 2,
    });
    expect(JSON.stringify(warnings[0])).not.toMatch(/quietly|pauses|Haircut/);
  });

  it('keeps tenant emphasis and "aside" content, and logs the kept hits at debug only', () => {
    const businessDetails = 'Hours Tue–Sat 9–7. *Closed Sundays.* Open Mon–Sat (aside from holidays).';
    const cfg = loadAgentConfig(ctx({
      agentType: 'salon',
      dbAgent: { name: 'Front Desk', system_prompt: businessDetails, metadata: { businessName: 'Sharp Line Barbers' } },
    }));

    expect(cfg.systemPrompt).toContain(businessDetails);
    expect(stageDirectionWarnings(warn)).toEqual([]);
    const debugs = stageDirectionDebugs(debug);
    expect(debugs).toHaveLength(1);
    expect(debugs[0][1]).toEqual({
      tenantId: 't1',
      agentId: 'ag1',
      counts: { 'asterisk-action': 1, 'bracketed-narration': 1 },
      removed: 0,
    });
    expect(JSON.stringify(debugs[0])).not.toMatch(/Sundays|holidays/);
  });

  it('does not warn for a tenant prompt holding only a narration word', () => {
    const cfg = loadAgentConfig(ctx({
      agentType: 'salon',
      dbAgent: { name: 'Front Desk', system_prompt: 'Do not silently hang up.', metadata: { businessName: 'Sharp Line Barbers' } },
    }));

    expect(cfg.systemPrompt).toContain('Do not silently hang up.');
    expect(stageDirectionWarnings(warn)).toEqual([]);
    const debugs = stageDirectionDebugs(debug);
    expect(debugs).toHaveLength(1);
    expect(debugs[0][1]).toEqual({ tenantId: 't1', agentId: 'ag1', counts: { 'narration-word': 1 }, removed: 0 });
    expect(JSON.stringify(debugs[0])).not.toMatch(/silently|hang up/);
  });

  it('loads a core-receptionist agent with no tenant prompt byte-identically', () => {
    const businessName = 'Harbor Locksmith';
    const cfg = loadAgentConfig(ctx({
      agentType: 'core-receptionist',
      dbAgent: { name: 'Harbor', metadata: { businessName } },
    }));

    // Called once for the role prompt and once for the greeting.
    expect(stripSpy).toHaveBeenCalledTimes(2);
    for (const [index, [input]] of (stripSpy.mock.calls as [string][]).entries()) {
      const result = stripSpy.mock.results[index].value as { text: string; hits: unknown[]; removed: number };
      expect(result).toEqual({ text: input, hits: [], removed: 0 });
    }
    const builtIn = createCoreReceptionistRolePackage({ businessName });
    expect(cfg.rolePrompt).toBe(builtIn.prompt.trim());
    expect(cfg.greeting).toBe(builtIn.greeting);
    expect(cfg.systemPrompt).toContain(cfg.rolePrompt);
    expect(stageDirectionWarnings(warn)).toEqual([]);
  });

  it.each([
    'answering_service', 'medical_after_hours', 'salon', 'dental', 'property_management', 'home_services',
    'legal', 'customer_support', 'outbound_sales', 'technical_support', 'collections', 'totally_unknown',
  ])('leaves the built-in %s prompt and greeting unchanged', (agentType) => {
    for (const language of ['en', 'es']) {
      stripSpy.mockClear();
      loadAgentConfig(ctx({ agentType, callerPhone: '+15555550100', dbAgent: { name: 'Front Desk', language } }));

      expect(stripSpy).toHaveBeenCalledTimes(2);
      for (const [index, [input]] of (stripSpy.mock.calls as [string][]).entries()) {
        expect((stripSpy.mock.results[index].value as { text: string }).text).toBe(input);
      }
    }
    expect(stageDirectionWarnings(warn)).toEqual([]);
    expect(stageDirectionDebugs(debug)).toEqual([]);
  });
});

describe('loadAgentConfig strips stage directions from tenant greetings', () => {
  let warn: ReturnType<typeof vi.spyOn>;
  let debug: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warn = vi.spyOn(StructuredLogger.prototype, 'warn');
    debug = vi.spyOn(StructuredLogger.prototype, 'debug');
  });

  afterEach(() => {
    warn.mockRestore();
    debug.mockRestore();
  });

  function withGreeting(agentType: string, greeting?: string) {
    return loadAgentConfig(ctx({
      agentType,
      // A tenant prompt, so the unknown type takes the DB path, which reads metadata.greeting.
      dbAgent: {
        name: 'Front Desk',
        system_prompt: 'Answer questions about the business.',
        metadata: { businessName: 'Sharp Line Barbers', practiceName: 'Bright Smiles', greeting },
      },
    }));
  }

  it.each<[string, string, string, Record<string, number>]>([
    ['salon', '*pauses* Welcome to the shop', 'Welcome to the shop', { 'asterisk-action': 1 }],
    ['dental', '(smiles) Hello', 'Hello', { 'bracketed-narration': 1 }],
  ])('removes the direction from a %s tenant greeting', (agentType, greeting, expected, counts) => {
    const cfg = withGreeting(agentType, greeting);

    expect(cfg.greeting).toBe(expected);
    const warnings = greetingWarnings(warn);
    expect(warnings).toHaveLength(1);
    expect(warnings[0][1]).toEqual({ tenantId: 't1', agentId: 'ag1', counts, removed: 1 });
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/pauses|smiles|Welcome|Hello/);
  });

  it.each(['salon', 'core-receptionist', 'dental', 'medical_after_hours', 'totally_unknown'])(
    'falls back to the built-in %s greeting when the tenant greeting is only a direction',
    (agentType) => {
      const builtIn = withGreeting(agentType).greeting;
      warn.mockClear();

      const cfg = withGreeting(agentType, '(pause)');

      expect(cfg.greeting).toBe(builtIn);
      expect(cfg.greeting).toMatch(/\w/);
      const warnings = greetingWarnings(warn);
      expect(warnings).toHaveLength(1);
      expect(warnings[0][1]).toEqual({
        tenantId: 't1',
        agentId: 'ag1',
        counts: { 'bracketed-narration': 1 },
        removed: 1,
        fallback: agentType === 'totally_unknown' ? 'generic' : 'built-in',
      });
      expect(JSON.stringify(warn.mock.calls)).not.toMatch(/pause/);
    },
  );

  it('keeps a normal tenant greeting as-is with no log', () => {
    const greeting = 'Thanks for calling Sharp Line Barbers, this is Ara. Booking or a question?';
    const cfg = withGreeting('salon', greeting);

    expect(cfg.greeting).toBe(greeting);
    expect(greetingWarnings(warn)).toEqual([]);
    expect(debug.mock.calls.filter(([message]: unknown[]) => String(message).includes('greeting'))).toEqual([]);
  });
});

describe('loadAgentConfig falls back when a tenant prompt is only stage directions', () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warn = vi.spyOn(StructuredLogger.prototype, 'warn');
  });

  afterEach(() => {
    warn.mockRestore();
  });

  it.each<[string, string, 'built-in' | 'generic']>([
    ['dental', '(pause)', 'built-in'],
    ['medical_after_hours', '*pauses*', 'built-in'],
    ['totally_unknown', '(pause)', 'generic'],
    ['totally_unknown', '*pauses*', 'generic'],
  ])('loads a %s agent whose prompt is %s without throwing', (agentType, systemPrompt, fallback) => {
    const builtIn = loadAgentConfig(ctx({ agentType, callerPhone: '+15555550100' }));
    warn.mockClear();

    const cfg = loadAgentConfig(ctx({
      agentType,
      callerPhone: '+15555550100',
      dbAgent: { name: 'Front Desk', system_prompt: systemPrompt },
    }));

    expect(cfg.rolePrompt.trim()).not.toBe('');
    expect(cfg.rolePrompt).toBe(builtIn.rolePrompt);
    expect(findStageDirections(cfg.rolePrompt).filter((hit) => hit.rule !== 'narration-word')).toEqual([]);
    const warnings = stageDirectionWarnings(warn);
    expect(warnings).toHaveLength(1);
    expect((warnings[0][1] as { fallback?: string }).fallback).toBe(fallback);
    expect((warnings[0][1] as { removed: number }).removed).toBe(1);
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/pause/);
  });
});
