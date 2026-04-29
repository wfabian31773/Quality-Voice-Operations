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

function withDefaultPriorStatus(rows: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return rows.map((r) => ({ prior_status: 'pending', ...r }));
}

function makeClient(claimedRows: Array<Record<string, unknown>>): MockClient {
  const augmented = withDefaultPriorStatus(claimedRows);
  const clientQuery = vi.fn(async (sql: string) => {
    if (typeof sql === 'string' && sql.startsWith('BEGIN')) return { rows: [] };
    if (typeof sql === 'string' && sql.startsWith('COMMIT')) return { rows: [] };
    if (typeof sql === 'string' && sql.startsWith('ROLLBACK')) return { rows: [] };
    // The CTE UPDATE query that returns the claimed rows.
    return { rows: augmented };
  });
  return { query: clientQuery, release: releaseMock };
}

describe('ConnectorOutboxDrainScheduler', () => {
  beforeEach(() => {
    queryMock.mockReset();
    releaseMock.mockReset();
    connectMock.mockReset();
    dispatchEventMock.mockReset();
    delete process.env.CONNECTOR_OUTBOX_LEASE_MS;
  });

  afterEach(() => {
    stopConnectorOutboxDrainScheduler();
    vi.useRealTimers();
  });

  it('does nothing when no rows are claimable', async () => {
    const client = makeClient([]);
    connectMock.mockResolvedValue(client);

    const result = await runConnectorOutboxDrainCycle();

    expect(result).toEqual({ claimed: 0, reclaimed: 0, delivered: 0, failed: 0, deadLettered: 0 });
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
    expect(result.reclaimed).toBe(0);
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
    // markDelivered must clear the lease so the row is no longer reapable.
    expect(updateCalls[0]?.[0]).toContain('lease_expires_at = NULL');
    expect(updateCalls[0]?.[0]).toContain('claimed_at = NULL');
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
    // Failure path must also clear the lease so the reaper doesn't double-process.
    expect(failedUpdate?.[0]).toContain('lease_expires_at = NULL');
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
    expect(deadUpdate?.[0]).toContain('lease_expires_at = NULL');
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

    expect(result).toEqual({ claimed: 0, reclaimed: 0, delivered: 0, failed: 0, deadLettered: 0 });
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

  describe('stuck-claim recovery (lease reaper)', () => {
    it('reclaims processing rows whose lease has expired and counts them in the cycle result', async () => {
      const claimed = [
        {
          id: 'stale-1',
          tenant_id: 'tenant-f',
          event_type: 'appointment.booked',
          payload: { callerPhone: '+15550001111' },
          attempts: 2, // already 1 from the crashed worker; reaper bumped to 2
          max_attempts: 5,
          prior_status: 'processing', // <-- the row was stranded by a crashed worker
        },
        {
          id: 'fresh-1',
          tenant_id: 'tenant-f',
          event_type: 'call.completed',
          payload: {},
          attempts: 1,
          max_attempts: 5,
          prior_status: 'pending',
        },
      ];
      connectMock.mockResolvedValue(makeClient(claimed));
      dispatchEventMock.mockResolvedValue({
        dispatched: 1,
        results: [{ connectorType: 'crm', provider: 'hubspot', success: true }],
      });
      queryMock.mockResolvedValue({ rows: [] });

      const result = await runConnectorOutboxDrainCycle();

      expect(result.claimed).toBe(2);
      expect(result.reclaimed).toBe(1);
      expect(result.delivered).toBe(2);
      expect(dispatchEventMock).toHaveBeenCalledTimes(2);
      // Both rows should have been re-dispatched, including the previously
      // stranded one.
      const dispatchedIds = dispatchEventMock.mock.calls.map((c) => c[1]);
      expect(dispatchedIds).toEqual(expect.arrayContaining(['appointment.booked', 'call.completed']));
    });

    it('claim SQL reaps processing rows whose lease has expired AND passes the lease duration as a parameter', async () => {
      const client = makeClient([]);
      connectMock.mockResolvedValue(client);

      await runConnectorOutboxDrainCycle({ leaseDurationMs: 123_000 });

      const claimCall = client.query.mock.calls.find(
        (c) => typeof c[0] === 'string' && (c[0] as string).includes('outbox_events'),
      );
      expect(claimCall).toBeTruthy();
      const claimSql = claimCall?.[0] as string;
      // The reaper branch in the WHERE clause.
      expect(claimSql).toMatch(/status\s*=\s*'processing'/);
      expect(claimSql).toContain('lease_expires_at IS NOT NULL');
      expect(claimSql).toMatch(/lease_expires_at\s*<=\s*NOW\(\)/);
      // And the UPDATE refreshes the lease using the supplied duration.
      expect(claimSql).toContain('lease_expires_at = NOW() +');
      expect(claimSql).toContain('claimed_at = NOW()');
      expect(claimSql).toMatch(/RETURNING[\s\S]*c\.prior_status/);
      // Lease duration is the second parameter (after the batch limit), in ms.
      const params = claimCall?.[1] as unknown[];
      expect(params?.[0]).toBe(50);
      expect(params?.[1]).toBe('123000');
    });

    it('honors CONNECTOR_OUTBOX_LEASE_MS env override', async () => {
      process.env.CONNECTOR_OUTBOX_LEASE_MS = '7500';
      const client = makeClient([]);
      connectMock.mockResolvedValue(client);

      await runConnectorOutboxDrainCycle();

      const claimCall = client.query.mock.calls.find(
        (c) => typeof c[0] === 'string' && (c[0] as string).includes('outbox_events'),
      );
      const params = claimCall?.[1] as unknown[];
      expect(params?.[1]).toBe('7500');
    });

    it('falls back to default lease when env override is invalid', async () => {
      process.env.CONNECTOR_OUTBOX_LEASE_MS = 'banana';
      const client = makeClient([]);
      connectMock.mockResolvedValue(client);

      await runConnectorOutboxDrainCycle();

      const claimCall = client.query.mock.calls.find(
        (c) => typeof c[0] === 'string' && (c[0] as string).includes('outbox_events'),
      );
      const params = claimCall?.[1] as unknown[];
      // Default is 5 minutes = 300000 ms.
      expect(params?.[1]).toBe('300000');
    });

    it('eventually dead-letters a poison-pill row that keeps getting reclaimed', async () => {
      // Simulate a row that has been reclaimed enough times that its attempt
      // count is now at max_attempts and dispatch still fails. The reaper
      // bumps attempts on every reclaim, so a row that perpetually crashes
      // the worker won't loop forever — it will dead-letter.
      const claimed = [
        {
          id: 'poison-1',
          tenant_id: 'tenant-g',
          event_type: 'appointment.booked',
          payload: {},
          attempts: 5,
          max_attempts: 5,
          prior_status: 'processing',
        },
      ];
      connectMock.mockResolvedValue(makeClient(claimed));
      dispatchEventMock.mockRejectedValue(new Error('still exploding'));
      queryMock.mockResolvedValue({ rows: [] });

      const result = await runConnectorOutboxDrainCycle();

      expect(result.reclaimed).toBe(1);
      expect(result.deadLettered).toBe(1);
      expect(result.failed).toBe(0);
    });
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
