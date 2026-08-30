import { describe, expect, it } from 'vitest';
import { compileRolePackage } from '../../agent-runtime/masterVoiceAgent';
import {
  CORE_RECEPTIONIST_ROLE_ID,
  CORE_RECEPTIONIST_TOOLS,
  createCoreReceptionistRolePackage,
} from './rolePackage';

describe('core-receptionist role package', () => {
  it('compiles onto the locked xAI core and exposes the tool library', () => {
    const compiled = compileRolePackage(createCoreReceptionistRolePackage({
      businessName: 'Harbor Locksmith',
      preferredLanguage: 'en',
      timeZone: 'America/New_York',
    }));

    expect(compiled.coreVersion).toBe('2.0.0');
    expect(compiled.model).toBe('grok-voice-think-fast-2.0');
    expect(compiled.rolePackageId).toBe(CORE_RECEPTIONIST_ROLE_ID);
    expect(compiled.greeting).toContain('Harbor Locksmith');
    expect(compiled.tools.map((tool) => tool.name)).toEqual(
      CORE_RECEPTIONIST_TOOLS.map((tool) => tool.name),
    );
    expect(compiled.tools.map((tool) => tool.name)).toEqual(expect.arrayContaining([
      'send_sms',
      'send_email',
      'create_ticket',
      'create_booking',
      'create_dispatch_job',
    ]));
  });

  it('rejects a role package that tries to pick another runtime', () => {
    expect(() => compileRolePackage({
      ...createCoreReceptionistRolePackage({}),
      model: 'gpt-realtime-2',
    } as never)).toThrow(/core setting.*model/i);
  });
});
