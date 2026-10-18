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
const STAGE_DIRECTION_DEBUG_LOG = 'Possible stage directions in agent role prompt; nothing removed';

function ctx(over: Partial<AgentLoadContext> = {}): AgentLoadContext {
  return { tenantId: 't1' as never, agentId: 'ag1', agentType: 'answering_service', ...over };
}

function stageDirectionWarnings(warn: ReturnType<typeof vi.spyOn>) {
  return warn.mock.calls.filter(([message]: unknown[]) => message === STAGE_DIRECTION_LOG);
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

    expect(stripSpy).toHaveBeenCalledTimes(1);
    const [input] = stripSpy.mock.calls[0] as [string];
    const result = stripSpy.mock.results[0].value as { text: string; hits: unknown[]; removed: number };
    expect(result).toEqual({ text: input, hits: [], removed: 0 });
    expect(cfg.rolePrompt).toBe(createCoreReceptionistRolePackage({ businessName }).prompt.trim());
    expect(cfg.systemPrompt).toContain(cfg.rolePrompt);
    expect(stageDirectionWarnings(warn)).toEqual([]);
  });

  it.each([
    'answering_service', 'medical_after_hours', 'salon', 'dental', 'property_management', 'home_services',
    'legal', 'customer_support', 'outbound_sales', 'technical_support', 'collections', 'totally_unknown',
  ])('leaves the built-in %s prompt unchanged', (agentType) => {
    loadAgentConfig(ctx({ agentType, callerPhone: '+15555550100' }));

    expect(stripSpy).toHaveBeenCalledTimes(1);
    const [input] = stripSpy.mock.calls[0] as [string];
    expect((stripSpy.mock.results[0].value as { text: string }).text).toBe(input);
    expect(stageDirectionWarnings(warn)).toEqual([]);
    expect(stageDirectionDebugs(debug)).toEqual([]);
  });
});
