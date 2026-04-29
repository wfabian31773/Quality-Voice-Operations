/**
 * Coverage for `raiseDemoAnalyticsWriteFailureAlert`, the helper that pages
 * ops when a `demo_analytics` insert silently fails.
 *
 * The helper writes a `critical` row to `error_logs` via `logError` (the
 * same alert channel used by support-reply / docs-feedback delivery
 * failures) and applies an in-memory cooldown so a downed DB cannot spam
 * a page-per-CTA-click.
 *
 * These tests pin down four behaviours:
 *
 *   1. The first failure inside a quiet window dispatches a critical
 *      `error_logs` row carrying the event_type, cta_type, agent_type and
 *      the underlying error string.
 *   2. A second failure inside the cooldown window is suppressed (no
 *      additional `logError` call).
 *   3. After the cooldown elapses, the next failure dispatches again and
 *      includes a `suppressed_since_last_alert` count in the metadata.
 *   4. The helper never throws back into the caller, even if the
 *      underlying alert sink raises.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { logErrorMock } = vi.hoisted(() => ({
  logErrorMock: vi.fn(),
}));

vi.mock('../../platform/core/observability', () => ({
  logError: logErrorMock,
}));

vi.mock('../../platform/core/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import {
  raiseDemoAnalyticsWriteFailureAlert,
  __resetDemoAnalyticsAlertDedupForTests,
  DEFAULT_DEMO_ANALYTICS_ALERT_DEDUP_MS,
} from '../../platform/analytics/demoAnalyticsAlert';

describe('raiseDemoAnalyticsWriteFailureAlert', () => {
  beforeEach(() => {
    logErrorMock.mockReset().mockResolvedValue(undefined);
    __resetDemoAnalyticsAlertDedupForTests();
    delete process.env.DEMO_ANALYTICS_ALERT_DEDUP_MS;
  });

  afterEach(() => {
    vi.useRealTimers();
    delete process.env.DEMO_ANALYTICS_ALERT_DEDUP_MS;
  });

  it('writes a critical error_log carrying the failure context on first failure', async () => {
    await raiseDemoAnalyticsWriteFailureAlert({
      eventType: 'cta_clicked',
      ctaType: 'start_free_trial',
      agentType: 'medical-after-hours',
      error: new Error('connection refused'),
    });

    expect(logErrorMock).toHaveBeenCalledTimes(1);
    const [tenantId, severity, message, ctx] = logErrorMock.mock.calls[0] as [
      string | null,
      string,
      string,
      { service?: string; errorCode?: string; extra?: Record<string, unknown> },
    ];

    // Anonymous demo traffic — no tenant. Severity must be `critical` so the
    // existing high-priority alert surfaces fan it out.
    expect(tenantId).toBeNull();
    expect(severity).toBe('critical');
    expect(message).toMatch(/cta_clicked/);
    expect(message).toMatch(/demo_analytics/i);

    expect(ctx.service).toBe('demo_analytics');
    expect(ctx.errorCode).toBe('demo_analytics_write_failed');
    expect(ctx.extra).toMatchObject({
      event_type: 'cta_clicked',
      cta_type: 'start_free_trial',
      agent_type: 'medical-after-hours',
      error: 'connection refused',
      suppressed_since_last_alert: 0,
    });
  });

  it('suppresses repeat failures inside the cooldown window so a downed DB cannot spam', async () => {
    await raiseDemoAnalyticsWriteFailureAlert({
      eventType: 'cta_clicked',
      ctaType: 'start_free_trial',
      error: new Error('boom'),
    });
    await raiseDemoAnalyticsWriteFailureAlert({
      eventType: 'cta_clicked',
      ctaType: 'book_demo',
      error: new Error('boom again'),
    });
    await raiseDemoAnalyticsWriteFailureAlert({
      eventType: 'cta_clicked',
      ctaType: 'start_free_trial',
      error: new Error('still on fire'),
    });

    expect(logErrorMock).toHaveBeenCalledTimes(1);
  });

  it('fires again once the cooldown elapses and reports the suppressed count', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-29T12:00:00Z'));

    await raiseDemoAnalyticsWriteFailureAlert({
      eventType: 'cta_clicked',
      ctaType: 'start_free_trial',
      error: new Error('boom'),
    });
    // Two more failures while we're inside the cooldown window — both
    // must be suppressed but counted.
    await raiseDemoAnalyticsWriteFailureAlert({
      eventType: 'cta_clicked',
      ctaType: 'book_demo',
      error: new Error('boom 2'),
    });
    await raiseDemoAnalyticsWriteFailureAlert({
      eventType: 'cta_clicked',
      ctaType: 'start_free_trial',
      error: new Error('boom 3'),
    });

    expect(logErrorMock).toHaveBeenCalledTimes(1);

    // Advance past the cooldown.
    vi.setSystemTime(
      new Date(Date.now() + DEFAULT_DEMO_ANALYTICS_ALERT_DEDUP_MS + 1_000),
    );

    await raiseDemoAnalyticsWriteFailureAlert({
      eventType: 'cta_clicked',
      ctaType: 'start_free_trial',
      error: new Error('still bad'),
    });

    expect(logErrorMock).toHaveBeenCalledTimes(2);
    const secondCall = logErrorMock.mock.calls[1] as [
      string | null,
      string,
      string,
      { extra?: Record<string, unknown> },
    ];
    expect(secondCall[2]).toMatch(/2 additional failure\(s\) suppressed/);
    expect(secondCall[3].extra).toMatchObject({
      event_type: 'cta_clicked',
      cta_type: 'start_free_trial',
      error: 'still bad',
      suppressed_since_last_alert: 2,
    });
  });

  it('respects DEMO_ANALYTICS_ALERT_DEDUP_MS when set', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-29T12:00:00Z'));
    process.env.DEMO_ANALYTICS_ALERT_DEDUP_MS = '1000';

    await raiseDemoAnalyticsWriteFailureAlert({
      eventType: 'cta_clicked',
      error: new Error('boom'),
    });
    await raiseDemoAnalyticsWriteFailureAlert({
      eventType: 'cta_clicked',
      error: new Error('boom'),
    });
    expect(logErrorMock).toHaveBeenCalledTimes(1);

    // Just past the configured 1s window.
    vi.setSystemTime(new Date(Date.now() + 1_500));
    await raiseDemoAnalyticsWriteFailureAlert({
      eventType: 'cta_clicked',
      error: new Error('boom'),
    });
    expect(logErrorMock).toHaveBeenCalledTimes(2);
  });

  it('never throws into the caller even if the alert sink itself fails', async () => {
    logErrorMock.mockRejectedValueOnce(new Error('error_logs unreachable'));

    await expect(
      raiseDemoAnalyticsWriteFailureAlert({
        eventType: 'cta_clicked',
        ctaType: 'start_free_trial',
        error: new Error('original failure'),
      }),
    ).resolves.toBeUndefined();
  });

  it('coerces non-Error rejection values to a string for the alert payload', async () => {
    await raiseDemoAnalyticsWriteFailureAlert({
      eventType: 'cta_clicked',
      ctaType: 'start_free_trial',
      error: 'plain string failure',
    });

    expect(logErrorMock).toHaveBeenCalledTimes(1);
    const [, , , ctx] = logErrorMock.mock.calls[0] as [
      unknown,
      unknown,
      unknown,
      { extra?: Record<string, unknown> },
    ];
    expect(ctx.extra?.error).toBe('plain string failure');
  });
});
