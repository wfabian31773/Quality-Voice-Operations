import { describe, expect, it } from 'vitest';
import { COMPOSER_RUNTIME_KEY } from '../../voice-gateway/services/agentLoader';
import { guardRuntimeFlag, keepStoredRuntime, RUNTIME_FLAG_FORBIDDEN, RUNTIME_METADATA_KEY } from './agentRuntimeFlag';

const tenant = { isPlatformAdmin: false };
const staff = { isPlatformAdmin: true };

describe('guardRuntimeFlag', () => {
  it('guards the key the voice runtime reads', () => {
    expect(RUNTIME_METADATA_KEY).toBe(COMPOSER_RUNTIME_KEY);
  });

  it('a tenant user cannot set, change or remove runtime', () => {
    expect(guardRuntimeFlag({ ...tenant, stored: {}, requested: { runtime: 'composer' } })).toEqual({ ok: false, status: 403, error: RUNTIME_FLAG_FORBIDDEN });
    expect(guardRuntimeFlag({ ...tenant, stored: undefined, requested: { runtime: 'composer' } })).toMatchObject({ ok: false, status: 403 });
    expect(guardRuntimeFlag({ ...tenant, stored: { runtime: 'composer' }, requested: { runtime: 'legacy' } })).toMatchObject({ ok: false, status: 403 });
    expect(guardRuntimeFlag({ ...tenant, stored: { runtime: 'composer' }, requested: { runtime: null } })).toMatchObject({ ok: false, status: 403 });
  });

  it('a tenant write that omits runtime keeps the stored value', () => {
    const out = guardRuntimeFlag({ ...tenant, stored: JSON.stringify({ runtime: 'composer', businessName: 'Old' }), requested: { businessName: 'New' } });
    expect(out).toEqual({ ok: true, metadata: { businessName: 'New', runtime: 'composer' }, runtimeChanged: false });
  });

  it('a tenant write that sends the stored value back unchanged is allowed', () => {
    expect(guardRuntimeFlag({ ...tenant, stored: { runtime: 'composer' }, requested: { runtime: 'composer', a: 1 } })).toEqual({
      ok: true,
      metadata: { runtime: 'composer', a: 1 },
      runtimeChanged: false,
    });
    // No runtime stored and none sent (null is "none").
    expect(guardRuntimeFlag({ ...tenant, stored: {}, requested: { runtime: null, a: 1 } })).toEqual({ ok: true, metadata: { a: 1 }, runtimeChanged: false });
  });

  it('a platform admin can set, change and clear runtime; omitting it keeps it', () => {
    expect(guardRuntimeFlag({ ...staff, stored: {}, requested: { runtime: 'composer' } })).toEqual({ ok: true, metadata: { runtime: 'composer' }, runtimeChanged: true });
    expect(guardRuntimeFlag({ ...staff, stored: { runtime: 'composer', a: 1 }, requested: { runtime: null, a: 1 } })).toEqual({ ok: true, metadata: { a: 1 }, runtimeChanged: true });
    expect(guardRuntimeFlag({ ...staff, stored: { runtime: 'composer' }, requested: { a: 2 } })).toEqual({ ok: true, metadata: { a: 2, runtime: 'composer' }, runtimeChanged: false });
  });

  it('metadata that is not an object is a 400', () => {
    for (const requested of [null, 'composer', ['runtime'], 3]) {
      expect(guardRuntimeFlag({ ...staff, stored: {}, requested })).toMatchObject({ ok: false, status: 400 });
    }
  });
});

describe('keepStoredRuntime', () => {
  it('puts the stored runtime back, or leaves it absent', () => {
    expect(keepStoredRuntime({ runtime: 'composer', tone: 'x' }, { language: 'en' })).toEqual({ language: 'en', runtime: 'composer' });
    expect(keepStoredRuntime({}, { language: 'en', runtime: 'composer' })).toEqual({ language: 'en' });
    expect(keepStoredRuntime(null, { language: 'en' })).toEqual({ language: 'en' });
  });
});
