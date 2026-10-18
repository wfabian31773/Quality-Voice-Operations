import { describe, expect, it } from 'vitest';

import { fixtureDbCalls, fixtureTwilioCalls, fixtureTwilioRecordings, fixtureXaiUsage } from './__fixtures__/fixtureDay';
import { parseCostReconcileArgs, runCostReconcile } from './cli';

describe('parseCostReconcileArgs', () => {
  it('parses --date, --out and --xai-usage-file in both forms', () => {
    expect(parseCostReconcileArgs(['--date', '2026-10-15', '--out=r.json', '--xai-usage-file', 'u.json'])).toEqual({
      date: '2026-10-15', out: 'r.json', xaiUsageFile: 'u.json',
    });
    expect(parseCostReconcileArgs(['--date=2026-10-15'])).toEqual({ date: '2026-10-15', out: null, xaiUsageFile: null });
  });

  it('rejects missing, bad or unknown arguments', () => {
    expect(() => parseCostReconcileArgs([])).toThrow('--date');
    expect(() => parseCostReconcileArgs(['--date', '10/15/2026'])).toThrow();
    expect(() => parseCostReconcileArgs(['--date', '2026-10-15', '--write-db'])).toThrow('Unknown argument');
    expect(() => parseCostReconcileArgs(['--date'])).toThrow('needs a value');
  });
});

describe('runCostReconcile', () => {
  it('passes the local-day window to every source and reconciles their rows', async () => {
    const windows: string[] = [];
    const report = await runCostReconcile('2026-10-15', {
      xai: { fetchUsage: async (w) => { windows.push(w.startUtc); return fixtureXaiUsage; } },
      twilio: {
        fetchCalls: async (w) => { windows.push(w.startUtc); return fixtureTwilioCalls; },
        fetchRecordings: async (w) => { windows.push(w.startUtc); return fixtureTwilioRecordings; },
      },
      db: { fetchCalls: async (w) => { windows.push(w.startUtc); return fixtureDbCalls; } },
    });
    expect(new Set(windows)).toEqual(new Set(['2026-10-15T04:00:00.000Z']));
    expect(report.totals.totalCents).toBe(74);
    expect(report.totals.centsPerMinute).toBe(8.74);
  });
});
