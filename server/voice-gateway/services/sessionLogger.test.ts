import { describe, it, expect, vi, beforeEach } from 'vitest';

const a = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));

vi.mock('../../../platform/core/logger', () => ({ createLogger: () => ({ info: a.info, warn: a.warn, error: a.error, debug: a.debug }) }));

import { createSessionLogger } from './sessionLogger';

beforeEach(() => { a.info.mockReset(); a.warn.mockReset(); a.error.mockReset(); a.debug.mockReset(); });

describe('createSessionLogger', () => {
  const ctx = { tenantId: 't1', callId: 'c1', callSid: 'CA1' };

  it('merges the session context into every level and preserves extra fields', () => {
    const log = createSessionLogger('VG', ctx);
    log.info('started', { foo: 'bar' });
    expect(a.info).toHaveBeenCalledWith('started', { tenantId: 't1', callId: 'c1', callSid: 'CA1', foo: 'bar' });
    log.warn('careful');
    expect(a.warn).toHaveBeenCalledWith('careful', { tenantId: 't1', callId: 'c1', callSid: 'CA1' });
    log.error('boom', { code: 9 });
    expect(a.error).toHaveBeenCalledWith('boom', expect.objectContaining({ callSid: 'CA1', code: 9 }));
    log.debug('trace');
    expect(a.debug).toHaveBeenCalledWith('trace', expect.objectContaining({ callId: 'c1' }));
  });

  it('lets extra fields override the base context keys', () => {
    const log = createSessionLogger('VG', ctx);
    log.info('switch', { tenantId: 't2' });
    expect(a.info).toHaveBeenCalledWith('switch', expect.objectContaining({ tenantId: 't2' }));
  });
});
