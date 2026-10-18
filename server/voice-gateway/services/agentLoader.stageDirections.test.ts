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

const STAGE_DIRECTION_LOG = 'Stage directions found in agent role prompt; bracketed and asterisk ones were removed';

function ctx(over: Partial<AgentLoadContext> = {}): AgentLoadContext {
  return { tenantId: 't1' as never, agentId: 'ag1', agentType: 'answering_service', ...over };
}

function stageDirectionWarnings(warn: ReturnType<typeof vi.spyOn>) {
  return warn.mock.calls.filter(([message]: unknown[]) => message === STAGE_DIRECTION_LOG);
}

describe('loadAgentConfig strips stage directions from tenant prompts', () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stripSpy.mockClear();
    warn = vi.spyOn(StructuredLogger.prototype, 'warn');
  });

  afterEach(() => {
    warn.mockRestore();
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
    });
    expect(JSON.stringify(warnings[0])).not.toMatch(/quietly|pauses|Haircut/);
  });

  it('loads a core-receptionist agent with no tenant prompt byte-identically', () => {
    const businessName = 'Harbor Locksmith';
    const cfg = loadAgentConfig(ctx({
      agentType: 'core-receptionist',
      dbAgent: { name: 'Harbor', metadata: { businessName } },
    }));

    expect(stripSpy).toHaveBeenCalledTimes(1);
    const [input] = stripSpy.mock.calls[0] as [string];
    const result = stripSpy.mock.results[0].value as { text: string; hits: unknown[] };
    expect(result).toEqual({ text: input, hits: [] });
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
  });
});
