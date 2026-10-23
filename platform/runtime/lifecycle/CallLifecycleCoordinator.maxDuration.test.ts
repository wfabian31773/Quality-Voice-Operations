import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../core/observability/traceLogger', () => ({ recordTrace: vi.fn(async () => {}) }));
vi.mock('../../campaigns/DncService', () => ({ detectOptOutInTranscript: vi.fn(() => false), addToDnc: vi.fn(async () => {}) }));

import { CallLifecycleCoordinator, type CallPersistenceAdapter } from './CallLifecycleCoordinator';
import { getDemoMaxDurationMs, getDemoWarningMs, getMaxDurationMs } from './agentPolicy';

const persistence = (): CallPersistenceAdapter => ({
  updateTranscript: vi.fn(async () => {}),
  finalizeCall: vi.fn(async () => true),
  findCallByTwilioSid: vi.fn(async () => null),
  findCallByConferenceSid: vi.fn(async () => null),
});

describe('max call duration: website-demo cap vs ordinary calls', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function place(tenantId: string, websiteDemo?: boolean) {
    const db = persistence();
    const coordinator = new CallLifecycleCoordinator(tenantId, db);
    const warned = vi.fn();
    const terminated = vi.fn();
    coordinator.on('demo-warning', warned);
    coordinator.on('demo-force-terminate', terminated);
    coordinator.registerCall({
      callLogId: 'cs-1', tenantId: tenantId as never, twilioCallSid: 'CA-1', agentSlug: 'barbershop', websiteDemo,
    });
    return { coordinator, db, warned, terminated };
  }

  it('an ordinary inbound call to the demo tenant (Sharp Line) is not cut at the 3-minute website-demo cap', async () => {
    const { coordinator, db, warned, terminated } = place('demo');
    await vi.advanceTimersByTimeAsync(getDemoMaxDurationMs() + 1_000);
    expect(warned).not.toHaveBeenCalled();
    expect(terminated).not.toHaveBeenCalled();
    expect(db.finalizeCall).not.toHaveBeenCalled();
    expect(coordinator.getCallRecord('cs-1')).toBeDefined();
  });

  it('an ordinary demo-tenant call gets the same max duration as any tenant\'s ordinary call', async () => {
    const maxMs = getMaxDurationMs('barbershop');
    expect(maxMs).toBeGreaterThan(getDemoMaxDurationMs());
    for (const tenantId of ['demo', 'tenant-a']) {
      const { db, terminated } = place(tenantId);
      await vi.advanceTimersByTimeAsync(maxMs - 1);
      expect(db.finalizeCall).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(db.finalizeCall).toHaveBeenCalledWith(tenantId, 'cs-1', 'completed', expect.any(Date));
      expect(terminated).not.toHaveBeenCalled();
    }
  });

  it('a website demo call still gets the 30-second warning and is force-terminated at 3 minutes', async () => {
    const { db, warned, terminated } = place('demo', true);
    await vi.advanceTimersByTimeAsync(getDemoWarningMs());
    expect(warned).toHaveBeenCalledWith(expect.objectContaining({ callLogId: 'cs-1', message: 'This demo call will end in 30 seconds.' }));
    expect(terminated).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(getDemoMaxDurationMs() - getDemoWarningMs());
    expect(terminated).toHaveBeenCalledWith({ callLogId: 'cs-1', tenantId: 'demo', twilioCallSid: 'CA-1' });
    expect(db.finalizeCall).toHaveBeenCalledWith('demo', 'cs-1', 'completed', expect.any(Date));
  });
});
