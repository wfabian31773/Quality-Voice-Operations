import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const query = vi.fn();

vi.mock('../db', () => ({
  getPlatformPool: () => ({ query }),
}));

vi.mock('../core/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { runCallEventsRetentionCycle } from './CallEventsRetentionScheduler';

describe('call_events partition pruning safety gate', () => {
  beforeEach(() => {
    delete process.env.CALL_EVENTS_PARTITION_PRUNING_ENABLED;
    query.mockReset();
    query.mockImplementation(async (sql: string) => {
      if (sql.includes('ensure_call_events_partition')) {
        return { rows: [{ ensure_call_events_partition: 'call_events_2026_08' }] };
      }
      return { rows: [] };
    });
  });

  afterEach(() => {
    delete process.env.CALL_EVENTS_PARTITION_PRUNING_ENABLED;
  });

  it('creates current and future partitions but does not prune by default', async () => {
    const result = await runCallEventsRetentionCycle(90);

    expect(query.mock.calls.filter(([sql]) => String(sql).includes('ensure_call_events_partition'))).toHaveLength(2);
    expect(query.mock.calls.some(([sql]) => String(sql).includes('prune_call_events_older_than'))).toBe(false);
    expect(result.dropped).toEqual([]);
  });

  it('prunes only when the destructive operation is explicitly enabled', async () => {
    process.env.CALL_EVENTS_PARTITION_PRUNING_ENABLED = 'true';
    query.mockImplementation(async (sql: string) => {
      if (sql.includes('ensure_call_events_partition')) {
        return { rows: [{ ensure_call_events_partition: 'call_events_2026_08' }] };
      }
      if (sql.includes('prune_call_events_older_than')) {
        return { rows: [{ prune_call_events_older_than: ['call_events_2026_03'] }] };
      }
      return { rows: [] };
    });

    const result = await runCallEventsRetentionCycle(90);

    expect(query.mock.calls.some(([sql]) => String(sql).includes('prune_call_events_older_than'))).toBe(true);
    expect(result.dropped).toEqual(['call_events_2026_03']);
  });
});
