// @vitest-environment happy-dom
import * as React from 'react';
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';

import { AlertsPanel } from '../../client-app/src/pages/Operations';

void React;

const RUNBOOK_URL = 'docs/runbooks/billing-backfill-cross-day-rebalance.md';

interface TestAlertOverrides {
  id?: string;
  type?: string;
  severity?: string;
  message?: string;
  metadata?: Record<string, unknown>;
}

function buildAlert(overrides: TestAlertOverrides = {}) {
  return {
    id: overrides.id ?? 'alert-1',
    type: overrides.type ?? 'billing_backfill_cross_day',
    severity: overrides.severity ?? 'info',
    message:
      overrides.message ??
      'Backfill correction moved call ext-1 from 2026-04-27 to 2026-04-28.',
    metadata: overrides.metadata ?? {
      auto_rebalanced: true,
      runbook_url: RUNBOOK_URL,
    },
    call_session_id: null,
    agent_id: null,
    acknowledged: false,
    created_at: new Date().toISOString(),
  };
}

function renderPanel(alerts: ReturnType<typeof buildAlert>[]) {
  return render(
    <AlertsPanel
      alerts={alerts}
      unacknowledgedCount={alerts.filter((a) => !a.acknowledged).length}
      onAcknowledge={() => {}}
      onAcknowledgeAll={() => {}}
      highlightType={null}
    />,
  );
}

afterEach(() => {
  cleanup();
});

describe('AlertsPanel auto-rebalanced badge', () => {
  it('renders an "Auto-rebalanced" badge for billing_backfill_cross_day alerts with metadata.auto_rebalanced = true', () => {
    renderPanel([buildAlert()]);

    const badge = screen.getByTestId('auto-rebalanced-badge');
    expect(badge).toBeTruthy();
    expect(badge.textContent).toContain('Auto-rebalanced');
  });

  it('badge tooltip references the runbook URL from metadata so finance can verify', () => {
    renderPanel([buildAlert()]);

    const badge = screen.getByTestId('auto-rebalanced-badge');
    const title = badge.getAttribute('title') ?? '';
    expect(title).toContain('no manual action required');
    expect(title).toContain(RUNBOOK_URL);
  });

  it('omits the badge for billing_backfill_cross_day_skipped alerts (manual rebalance still required)', () => {
    renderPanel([
      buildAlert({
        id: 'alert-skipped',
        type: 'billing_backfill_cross_day_skipped',
        severity: 'warning',
        metadata: {
          auto_rebalanced: false,
          manual_rebalance_required: true,
          runbook_url: RUNBOOK_URL,
        },
      }),
    ]);

    expect(screen.queryByTestId('auto-rebalanced-badge')).toBeNull();
  });

  it('omits the badge for legacy billing_backfill_cross_day alerts that lack the metadata flag', () => {
    renderPanel([
      buildAlert({
        id: 'alert-legacy',
        metadata: { runbook_url: RUNBOOK_URL },
      }),
    ]);

    expect(screen.queryByTestId('auto-rebalanced-badge')).toBeNull();
  });

  it('does not show the badge on unrelated info alerts even if they happen to carry an auto_rebalanced flag', () => {
    renderPanel([
      buildAlert({
        id: 'alert-other',
        type: 'some_other_info_alert',
        metadata: { auto_rebalanced: true, runbook_url: RUNBOOK_URL },
      }),
    ]);

    expect(screen.queryByTestId('auto-rebalanced-badge')).toBeNull();
  });
});
