import { describe, expect, it } from 'vitest';
import { compileRolePackage } from '../../agent-runtime/masterVoiceAgent';
import {
  SALON_ROLE_ID,
  SALON_TOOLS,
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

  it('rejects a role package that tries to pick another runtime', () => {
    expect(() => compileRolePackage({
      ...createSalonRolePackage({}),
      model: 'gpt-realtime-2',
    } as never)).toThrow(/core setting.*model/i);
  });
});
