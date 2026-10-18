import { describe, expect, it } from 'vitest';
import { classifyIsolationProbeError, isPermissionDenied } from './isolationProbeErrors';

describe('classifyIsolationProbeError', () => {
  it('does not treat a 42501 error as isolated', () => {
    const err = Object.assign(new Error('insufficient privilege'), { code: '42501' });
    expect(isPermissionDenied(err)).toBe(true);
    expect(classifyIsolationProbeError(err)).toBe('permission_denied');
  });

  it('does not treat a "permission denied" message as isolated', () => {
    expect(classifyIsolationProbeError(new Error('permission denied for table agents'))).toBe('permission_denied');
  });

  it('fails closed when a permission-denied message also mentions a policy', () => {
    expect(classifyIsolationProbeError(new Error('permission denied for table agents (policy check)')))
      .toBe('permission_denied');
  });

  it('still treats genuine RLS policy / row_security errors as isolated', () => {
    expect(classifyIsolationProbeError(new Error('new row violates row-level security policy for table "agents"')))
      .toBe('rls_blocked');
    expect(classifyIsolationProbeError(new Error('query would be affected by row_security policy')))
      .toBe('rls_blocked');
  });

  it('classifies anything else as unexpected', () => {
    expect(classifyIsolationProbeError(new Error('relation "agents" does not exist'))).toBe('unexpected');
    expect(isPermissionDenied(null)).toBe(false);
  });
});
