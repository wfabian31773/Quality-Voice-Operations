import { describe, it, expect } from 'vitest';
import {
  UnifiedToolRegistry,
  redactToolParameters,
  type EnhancedToolDefinition,
} from './ToolRegistry';

function tool(overrides: Partial<EnhancedToolDefinition> = {}): EnhancedToolDefinition {
  return {
    name: 'createServiceTicket',
    description: 'Create a ticket',
    inputSchema: {
      type: 'object',
      required: ['callerName'],
      properties: {
        callerName: { type: 'string' },
        priority: { type: 'string', enum: ['low', 'normal', 'high'] },
        count: { type: 'number' },
      },
    },
    handler: async () => ({}),
    ...overrides,
  };
}

describe('redactToolParameters', () => {
  it('redacts PHI in string, array and nested object values', () => {
    const out = redactToolParameters({
      caller: 'call 555-123-4567',
      tags: ['ssn 123-45-6789', 5],
      nested: { note: 'my name is Ada Lovelace' },
      flag: true,
    });
    expect(out.caller).toContain('[PHONE_REDACTED]');
    expect((out.tags as unknown[])[0]).toContain('[SSN_REDACTED]');
    expect((out.tags as unknown[])[1]).toBe(5);
    expect((out.nested as Record<string, unknown>).note).toContain('[NAME_REDACTED]');
    expect(out.flag).toBe(true);
  });
});

describe('UnifiedToolRegistry validation', () => {
  it('registers and retrieves enhanced tools', () => {
    const reg = new UnifiedToolRegistry();
    const t = tool({ name: 'myTool' });
    reg.registerEnhanced(t);
    expect(reg.getEnhanced('myTool')).toBe(t);
    expect(reg.getAll().some((x) => x.name === 'myTool')).toBe(true);
  });

  it('passes validation for well-formed input', () => {
    const reg = new UnifiedToolRegistry();
    reg.registerEnhanced(tool());
    expect(reg.validateToolInput('createServiceTicket', { callerName: 'Ada', priority: 'high' })).toEqual({
      valid: true,
      errors: [],
    });
  });

  it('flags missing required fields and type/enum mismatches', () => {
    const reg = new UnifiedToolRegistry();
    reg.registerEnhanced(tool());
    const result = reg.validateToolInput('createServiceTicket', {
      priority: 'urgent', // not in enum
      count: 'seven', // wrong type
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Missing required field: callerName');
    expect(result.errors.some((e) => e.includes('count') && e.includes('number'))).toBe(true);
    expect(result.errors.some((e) => e.includes('one of'))).toBe(true);
  });

  it('treats an unknown tool as valid (no schema to enforce)', () => {
    const reg = new UnifiedToolRegistry();
    expect(reg.validateToolInput('ghostTool', { anything: 1 })).toEqual({ valid: true, errors: [] });
  });
});

describe('UnifiedToolRegistry rate limiting', () => {
  it('allows up to the per-minute limit then blocks', () => {
    const reg = new UnifiedToolRegistry();
    // Unique tenant/tool keys to avoid the module-level counter maps colliding
    // with other tests.
    const name = `rl_tool_${Math.random().toString(36).slice(2)}`;
    reg.registerEnhanced(tool({ name, rateLimit: { maxPerMinute: 2, maxPerHour: 100 } }));
    expect(reg.checkRateLimit('tenant-rl', name)).toBe(true);
    expect(reg.checkRateLimit('tenant-rl', name)).toBe(true);
    expect(reg.checkRateLimit('tenant-rl', name)).toBe(false);
  });
});

describe('UnifiedToolRegistry recovery & permissions', () => {
  it('returns tool-specific recovery instructions with a generic fallback', () => {
    const reg = new UnifiedToolRegistry();
    expect(reg.getRecoveryInstructions('createServiceTicket')).toContain('unable to create the ticket');
    expect(reg.getRecoveryInstructions('totallyUnknownTool')).toContain('Tool execution failed');
  });

  it('prefers an enhanced tool recovery override', () => {
    const reg = new UnifiedToolRegistry();
    reg.registerEnhanced(tool({ name: 'custom', recoveryInstructions: 'do the custom thing' }));
    expect(reg.getRecoveryInstructions('custom')).toBe('do the custom thing');
  });

  it('resolves a registered tool with no template restriction', () => {
    const reg = new UnifiedToolRegistry();
    reg.registerEnhanced(tool({ name: 'resolvable' }));
    const { tool: resolved, denied } = reg.getToolWithPermissions('resolvable');
    expect(denied).toBe(false);
    expect(resolved?.name).toBe('resolvable');
  });

  it('returns undefined (not denied) for an unknown tool', () => {
    const reg = new UnifiedToolRegistry();
    expect(reg.getToolWithPermissions('nope')).toEqual({ tool: undefined, denied: false });
  });

  it('produces a registry snapshot with normalized fields', () => {
    const reg = new UnifiedToolRegistry();
    reg.registerEnhanced(tool({ name: 'snap', category: 'core' }));
    const snap = reg.getRegistrySnapshot().find((s) => s.name === 'snap');
    expect(snap).toMatchObject({ category: 'core', hasRecoveryInstructions: false });
    expect(snap?.rateLimit).toEqual({ maxPerMinute: 30, maxPerHour: 300 });
  });
});
