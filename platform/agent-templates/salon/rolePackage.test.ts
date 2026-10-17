import { describe, expect, it } from 'vitest';
import { compileRolePackage } from '../../agent-runtime/masterVoiceAgent';
import {
  SALON_MESSAGE_CONSENT_RULE,
  SALON_ROLE_ID,
  SALON_TOOLS,
  appendSalonCallRules,
  buildCallerIdPromptLine,
  createSalonRolePackage,
} from './rolePackage';

describe('salon role package', () => {
  it('compiles onto the locked xAI core and exposes the booking tool library', () => {
    const compiled = compileRolePackage(createSalonRolePackage({
      businessName: 'Northside Barbers',
      preferredLanguage: 'en',
      timeZone: 'America/Los_Angeles',
    }));

    expect(compiled.coreVersion).toBe('2.0.0');
    expect(compiled.model).toBe('grok-voice-think-fast-2.0');
    expect(compiled.rolePackageId).toBe(SALON_ROLE_ID);
    expect(compiled.greeting).toContain('Northside Barbers');
    expect(compiled.tools.map((tool) => tool.name)).toEqual(
      SALON_TOOLS.map((tool) => tool.name),
    );
    expect(compiled.tools.map((tool) => tool.name)).toEqual(expect.arrayContaining([
      'create_booking',
      'update_booking',
      'send_sms',
      'create_ticket',
      'escalate_to_human',
      'get_current_tenant_time',
    ]));
    expect(compiled.rolePrompt).toContain('create_booking');
    expect(compiled.rolePrompt).toContain('update_booking');
    expect(compiled.rolePrompt).not.toMatch(/diagnos|prescription|phi/i);
  });

  it('renders only the last four digits of the caller ID and the caller-ID token', () => {
    const role = createSalonRolePackage({ businessName: 'Sharp Line Barbers', callerPhone: '+1 (555) 555-0142' });
    expect(role.prompt).toContain('calling from a number ending in 0142');
    expect(role.prompt).toContain('"caller_id"');
    expect(role.prompt).not.toMatch(/555.?555.?0142/);
    expect(buildCallerIdPromptLine('')).toBe('');
    expect(buildCallerIdPromptLine('anonymous')).toBe('');
  });

  it('tells the agent to wait for a yes before create_ticket, with no time promise', () => {
    const prompt = appendSalonCallRules('Tenant prompt.', '+15555550142');
    expect(prompt.startsWith('Tenant prompt.')).toBe(true);
    expect(prompt).toContain('Call create_ticket only after the caller says yes');
    expect(prompt).not.toMatch(/within the hour/i);
    expect(createSalonRolePackage({}).prompt).toContain(SALON_MESSAGE_CONSENT_RULE);
  });

  it('rejects a role package that tries to pick another runtime', () => {
    expect(() => compileRolePackage({
      ...createSalonRolePackage({}),
      model: 'gpt-realtime-2',
    } as never)).toThrow(/core setting.*model/i);
  });
});
