import { describe, it, expect, vi, beforeEach } from 'vitest';

const a = vi.hoisted(() => ({ logErrorMock: vi.fn() }));

vi.mock('../../../platform/core/logger', () => ({ createLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() }) }));
vi.mock('../../../platform/core/observability', () => ({ logError: a.logErrorMock }));

import {
  recordRejection, getTwilioSignatureMetrics, __resetTwilioSignatureMetricsForTests, REJECTION_REASONS,
} from './twilioSignatureMetrics';

beforeEach(() => {
  a.logErrorMock.mockReset();
  __resetTwilioSignatureMetricsForTests();
});

describe('recordRejection + getTwilioSignatureMetrics', () => {
  it('starts from an all-zero snapshot', () => {
    const snap = getTwilioSignatureMetrics();
    for (const r of REJECTION_REASONS) {
      expect(snap.totals[r]).toBe(0);
      expect(snap.lastRejectionAt[r]).toBeNull();
    }
  });

  it('accumulates totals and the current-minute rate', () => {
    recordRejection('missing_header');
    recordRejection('missing_header');
    recordRejection('invalid_signature');
    const snap = getTwilioSignatureMetrics();
    expect(snap.totals.missing_header).toBe(2);
    expect(snap.totals.invalid_signature).toBe(1);
    expect(snap.ratePerMinute.missing_header).toBe(2);
    expect(snap.lastRejectionAt.missing_header).not.toBeNull();
  });

  it('fires a critical alert once the per-minute threshold is crossed (validator_unavailable = 1)', () => {
    recordRejection('validator_unavailable');
    expect(a.logErrorMock).toHaveBeenCalledWith(null, 'critical', expect.stringContaining('validator_unavailable'), expect.objectContaining({ service: 'voice-gateway' }));
    const snap = getTwilioSignatureMetrics();
    expect(snap.alertActive.validator_unavailable).toBe(true);
  });

  it('does not re-fire within the cooldown window', () => {
    recordRejection('validator_unavailable');
    recordRejection('validator_unavailable');
    expect(a.logErrorMock).toHaveBeenCalledTimes(1);
  });

  it('does not alert below the threshold', () => {
    recordRejection('invalid_signature'); // threshold is 5/min
    expect(a.logErrorMock).not.toHaveBeenCalled();
  });

  it('exposes thresholds and a cooldown in the snapshot', () => {
    const snap = getTwilioSignatureMetrics();
    expect(snap.thresholdsPerMinute.invalid_signature).toBe(5);
    expect(snap.alertCooldownMs).toBeGreaterThan(0);
  });
});
