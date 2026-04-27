import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { queryMock, releaseMock, connectMock, dispatchEventMock } = vi.hoisted(() => ({
  queryMock: vi.fn(),
  releaseMock: vi.fn(),
  connectMock: vi.fn(),
  dispatchEventMock: vi.fn(),
}));

vi.mock('../../db', () => ({
  getPlatformPool: () => ({
    query: queryMock,
    connect: connectMock,
  }),
}));

vi.mock('./ConnectorService', () => ({
  connectorService: { dispatchEvent: dispatchEventMock },
}));

import {
  runConnectorOutboxDrainCycle,
  startConnectorOutboxDrainScheduler,
  stopConnectorOutboxDrainScheduler,
} from './ConnectorOutboxDrainScheduler';

interface MockClient {
  query: ReturnType<typeof vi.fn>;
  release: ReturnType<typeof vi.fn>;
}

function makeClient(claimedRows: unknown[]): MockClient {
  const clientQuery = vi.fn(async (sql: string) => {
    if (typeof sql === 'string' && sql.startsWith('BEGIN')) return { rows: [] };
    if (typeof sql === 'string' && sql.startsWith('COMMIT')) return { rows: [] };
    if (typeof sql === 'string' && sql.startsWith('ROLLBACK')) return { rows: [] };
    // The CTE UPDATE query that returns the claimed rows.
    return { rows: claimedRows };
  });
  return { query: clientQuery, release: releaseMock };
}

describe('ConnectorOutboxDrainScheduler', () => {
  beforeEach(() => {
    queryMock.mockReset();
    releaseMock.mockReset();
    connectMock.mockReset();
    dispatchEventMock.mockReset();
  });

  afterEach(() => {
    stopConnectorOutboxDrainScheduler();
    vi.useRealTimers();
  });

  it('does nothing when no rows are claimable', async () => {
    const client = makeClient([]);
    connectMock.mockResolvedValue(client);

    const result = await runConnectorOutboxDrainCycle();

    expect(result).toEqual({ claimed: 0, delivered: 0, failed: 0, deadLettered: 0 });
    expect(dispatchEventMock).not.toHaveBeenCalled();
    expect(releaseMock).toHaveBeenCalledTimes(1);
  });

  it('dispatches claimed rows and marks them delivered on full success', async () => {
    const claimed = [
      {
        id: 'evt-1',
        tenant_id: 'tenant-a',
        event_type: 'appointment.booked',
        payload: { callerPhone: '+15551234567' },
        attempts: 1,
        max_attempts: 5,
      },
    ];
    connectMock.mockResolvedValue(makeClient(claimed));
    dispatchEventMock.mockResolvedValue({
      dispatched: 1,
      results: [{ connectorType: 'crm', provider: 'hubspot', success: true }],
    });
    queryMock.mockResolvedValue({ rows: [] });

    const result = await runConnectorOutboxDrainCycle();

    expect(result.claimed).toBe(1);
    expect(result.delivered).toBe(1);
    expect(result.failed).toBe(0);
    expect(dispatchEventMock).toHaveBeenCalledWith(
      'tenant-a',
      'appointment.booked',
      expect.objectContaining({ callerPhone: '+15551234567' }),
    );
    const updateCalls = queryMock.mock.calls.filter((c) =>
      typeof c[0] === 'string' && (c[0] as string).includes("status = 'delivered'"),
    );
    expect(updateCalls).toHaveLength(1);
  });

  it('treats dispatched=0 (no enabled connectors) as delivered to avoid retry storms', async () => {
    const claimed = [
      {
        id: 'evt-2',
        tenant_id: 'tenant-b',
        event_type: 'call.completed',
        payload: {},
        attempts: 1,
        max_attempts: 5,
      },
    ];
    connectMock.mockResolvedValue(makeClient(claimed));
    dispatchEventMock.mockResolvedValue({ dispatched: 0, results: [] });
    queryMock.mockResolvedValue({ rows: [] });

    const result = await runConnectorOutboxDrainCycle();

    expect(result.delivered).toBe(1);
    expect(result.failed).toBe(0);
  });

  it('marks failed and schedules backoff when dispatch result has a failed adapter', async () => {
    const claimed = [
      {
        id: 'evt-3',
        tenant_id: 'tenant-c',
        event_type: 'appointment.booked',
        payload: { callerPhone: '+1' },
        attempts: 2,
        max_attempts: 5,
      },
    ];
    connectMock.mockResolvedValue(makeClient(claimed));
    dispatchEventMock.mockResolvedValue({
      dispatched: 1,
      results: [{ connectorType: 'crm', provider: 'hubspot', success: false, error: 'boom' }],
    });
    queryMock.mockResolvedValue({ rows: [] });

    const result = await runConnectorOutboxDrainCycle();

    expect(result.failed).toBe(1);
    expect(result.deadLettered).toBe(0);
    const failedUpdate = queryMock.mock.calls.find((c) =>
      typeof c[0] === 'string' && (c[0] as string).includes("status = 'failed'"),
    );
    expect(failedUpdate).toBeTruthy();
    expect(failedUpdate?.[1]).toEqual(['evt-3', 'boom', expect.any(String)]);
  });

  it('promotes to dead_letter when attempts have reached max_attempts', async () => {
    const claimed = [
      {
        id: 'evt-4',
        tenant_id: 'tenant-d',
        event_type: 'appointment.booked',
        payload: {},
        attempts: 5,
        max_attempts: 5,
      },
    ];
    connectMock.mockResolvedValue(makeClient(claimed));
    dispatchEventMock.mockResolvedValue({
      dispatched: 1,
      results: [{ connectorType: 'crm', provider: 'salesforce', success: false, error: 'gone' }],
    });
    queryMock.mockResolvedValue({ rows: [] });

    const result = await runConnectorOutboxDrainCycle();

    expect(result.deadLettered).toBe(1);
    expect(result.failed).toBe(0);
    const deadUpdate = queryMock.mock.calls.find((c) =>
      typeof c[0] === 'string' && (c[0] as string).includes("status = 'dead_letter'"),
    );
    expect(deadUpdate).toBeTruthy();
  });

  it('records a failure when dispatchEvent itself throws', async () => {
    const claimed = [
      {
        id: 'evt-5',
        tenant_id: 'tenant-e',
        event_type: 'call.completed',
        payload: {},
        attempts: 1,
        max_attempts: 5,
      },
    ];
    connectMock.mockResolvedValue(makeClient(claimed));
    dispatchEventMock.mockRejectedValue(new Error('downstream exploded'));
    queryMock.mockResolvedValue({ rows: [] });

    const result = await runConnectorOutboxDrainCycle();

    expect(result.failed).toBe(1);
    const failedUpdate = queryMock.mock.calls.find((c) =>
      typeof c[0] === 'string' && (c[0] as string).includes("status = 'failed'"),
    );
    expect(failedUpdate?.[1]?.[1]).toBe('downstream exploded');
  });

  it('returns a zeroed result and does not throw when the pg client cannot be acquired', async () => {
    connectMock.mockRejectedValue(new Error('pool exhausted'));

    const result = await runConnectorOutboxDrainCycle();

    expect(result).toEqual({ claimed: 0, delivered: 0, failed: 0, deadLettered: 0 });
    expect(dispatchEventMock).not.toHaveBeenCalled();
  });

  it('uses FOR UPDATE SKIP LOCKED when claiming rows', async () => {
    const client = makeClient([]);
    connectMock.mockResolvedValue(client);

    await runConnectorOutboxDrainCycle();

    const claimSql = client.query.mock.calls
      .map((c) => c[0])
      .find((s) => typeof s === 'string' && (s as string).includes('outbox_events'));
    expect(claimSql).toContain('FOR UPDATE SKIP LOCKED');
    expect(claimSql).toMatch(/status\s+IN\s*\(\s*'pending',\s*'failed'\s*\)/);
    expect(claimSql).toContain('attempts < max_attempts');
  });

  it('start/stop registers and clears interval timers idempotently', () => {
    vi.useFakeTimers();
    startConnectorOutboxDrainScheduler(5_000);
    // Calling start again is a no-op while a timer is registered.
    startConnectorOutboxDrainScheduler(5_000);
    stopConnectorOutboxDrainScheduler();
    // Stopping when nothing is registered is also safe.
    stopConnectorOutboxDrainScheduler();
  });
});
