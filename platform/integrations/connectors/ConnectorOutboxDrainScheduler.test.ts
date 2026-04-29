import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { queryMock, releaseMock, connectMock, dispatchEventMock, writeAuditLogMock } = vi.hoisted(() => ({
  queryMock: vi.fn(),
  releaseMock: vi.fn(),
  connectMock: vi.fn(),
  dispatchEventMock: vi.fn(),
  writeAuditLogMock: vi.fn(),
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

vi.mock('../../audit/AuditService', () => ({
  writeAuditLog: writeAuditLogMock,
}));

import {
  runConnectorOutboxDrainCycle,
  startConnectorOutboxDrainScheduler,
  stopConnectorOutboxDrainScheduler,
  runOutboxArchiveSweepCycle,
  startOutboxArchiveSweepScheduler,
  stopOutboxArchiveSweepScheduler,
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
    writeAuditLogMock.mockReset();
    writeAuditLogMock.mockResolvedValue(undefined);
    delete process.env.CONNECTOR_OUTBOX_LEASE_MS;
    delete process.env.OUTBOX_ARCHIVE_RETENTION_DAYS;
  });

  afterEach(() => {
    stopConnectorOutboxDrainScheduler();
    stopOutboxArchiveSweepScheduler();
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
      expect.objectContaining({ bufferToOutbox: false }),
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

  describe('archive sweep', () => {
    /**
     * Build an in-memory `outbox_events` table and wire `queryMock` to act
     * as the DELETE … RETURNING tenant_id implementation. This lets us
     * assert the predicate behaviour end-to-end (rows within retention
     * stay, rows older than retention go, non-archived rows never touched)
     * without needing a real Postgres.
     */
    interface FakeRow {
      id: string;
      tenant_id: string;
      archived_at: Date | null;
    }

    function setupFakeTable(rows: FakeRow[]): { table: FakeRow[] } {
      const table = [...rows];
      queryMock.mockImplementation(async (sql: string, params: unknown[] = []) => {
        if (typeof sql !== 'string' || !sql.trim().startsWith('DELETE FROM outbox_events')) {
          return { rows: [] };
        }
        const days = Number(params[0]);
        const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
        const deleted: FakeRow[] = [];
        const kept: FakeRow[] = [];
        for (const row of table) {
          // The SQL predicate: archived_at IS NOT NULL AND archived_at < NOW() - interval
          if (row.archived_at !== null && row.archived_at.getTime() < cutoff) {
            deleted.push(row);
          } else {
            kept.push(row);
          }
        }
        table.length = 0;
        table.push(...kept);
        return { rows: deleted.map((r) => ({ tenant_id: r.tenant_id })) };
      });
      return { table };
    }

    it('deletes archived rows older than the retention window', async () => {
      const now = Date.now();
      const { table } = setupFakeTable([
        // Old archived rows for two tenants — should be deleted.
        { id: 'old-1', tenant_id: 'tenant-a', archived_at: new Date(now - 100 * 24 * 60 * 60 * 1000) },
        { id: 'old-2', tenant_id: 'tenant-a', archived_at: new Date(now - 95 * 24 * 60 * 60 * 1000) },
        { id: 'old-3', tenant_id: 'tenant-b', archived_at: new Date(now - 200 * 24 * 60 * 60 * 1000) },
      ]);

      const result = await runOutboxArchiveSweepCycle();

      expect(result.deleted).toBe(3);
      expect(result.retentionDays).toBe(90);
      expect(table).toHaveLength(0);
      // Per-tenant counts roll up correctly so the audit feed shows the
      // right number per tenant.
      const perTenant = Object.fromEntries(result.perTenant.map((t) => [t.tenantId, t.deleted]));
      expect(perTenant).toEqual({ 'tenant-a': 2, 'tenant-b': 1 });
    });

    it('keeps archived rows that are still within the retention window', async () => {
      const now = Date.now();
      const { table } = setupFakeTable([
        { id: 'fresh-1', tenant_id: 'tenant-a', archived_at: new Date(now - 10 * 24 * 60 * 60 * 1000) },
        { id: 'fresh-2', tenant_id: 'tenant-a', archived_at: new Date(now - 89 * 24 * 60 * 60 * 1000) },
      ]);

      const result = await runOutboxArchiveSweepCycle();

      expect(result.deleted).toBe(0);
      expect(table).toHaveLength(2);
      // Nothing to audit when nothing was deleted.
      expect(writeAuditLogMock).not.toHaveBeenCalled();
    });

    it('never touches non-archived rows even when they are older than the retention window', async () => {
      const now = Date.now();
      const { table } = setupFakeTable([
        // archived_at IS NULL — these are live rows the drain worker still
        // owns. They must never be deleted by the sweep regardless of age.
        { id: 'live-1', tenant_id: 'tenant-a', archived_at: null },
        { id: 'live-2', tenant_id: 'tenant-a', archived_at: null },
        // An old archived row to prove the sweep still runs and deletes
        // archived rows in the same call.
        { id: 'old-1', tenant_id: 'tenant-a', archived_at: new Date(now - 200 * 24 * 60 * 60 * 1000) },
      ]);

      const result = await runOutboxArchiveSweepCycle();

      expect(result.deleted).toBe(1);
      expect(table.map((r) => r.id).sort()).toEqual(['live-1', 'live-2']);
    });

    it('writes one audit log entry per tenant summarising deleted counts', async () => {
      const now = Date.now();
      setupFakeTable([
        { id: 'old-a-1', tenant_id: 'tenant-a', archived_at: new Date(now - 100 * 24 * 60 * 60 * 1000) },
        { id: 'old-a-2', tenant_id: 'tenant-a', archived_at: new Date(now - 100 * 24 * 60 * 60 * 1000) },
        { id: 'old-b-1', tenant_id: 'tenant-b', archived_at: new Date(now - 100 * 24 * 60 * 60 * 1000) },
      ]);

      await runOutboxArchiveSweepCycle();

      expect(writeAuditLogMock).toHaveBeenCalledTimes(2);
      const tenantsAudited = writeAuditLogMock.mock.calls.map((c) => (c[0] as { tenantId: string }).tenantId).sort();
      expect(tenantsAudited).toEqual(['tenant-a', 'tenant-b']);
      const callA = writeAuditLogMock.mock.calls.find(
        (c) => (c[0] as { tenantId: string }).tenantId === 'tenant-a',
      )?.[0] as Record<string, unknown>;
      expect(callA).toMatchObject({
        actorUserId: null,
        actorRole: 'system',
        action: 'connector.outbox_archive_swept',
        resourceType: 'outbox_event',
        severity: 'info',
        changes: { deleted: 2, retentionDays: 90 },
      });
    });

    it('honors OUTBOX_ARCHIVE_RETENTION_DAYS env override', async () => {
      process.env.OUTBOX_ARCHIVE_RETENTION_DAYS = '30';
      const now = Date.now();
      const { table } = setupFakeTable([
        // Within 90 days but past the 30-day override → should be deleted.
        { id: 'mid-1', tenant_id: 'tenant-a', archived_at: new Date(now - 45 * 24 * 60 * 60 * 1000) },
        // Within 30 days → should be kept.
        { id: 'fresh-1', tenant_id: 'tenant-a', archived_at: new Date(now - 10 * 24 * 60 * 60 * 1000) },
      ]);

      const result = await runOutboxArchiveSweepCycle();

      expect(result.retentionDays).toBe(30);
      expect(result.deleted).toBe(1);
      expect(table.map((r) => r.id)).toEqual(['fresh-1']);
    });

    it('falls back to the default retention when env override is invalid', async () => {
      process.env.OUTBOX_ARCHIVE_RETENTION_DAYS = 'banana';
      setupFakeTable([]);

      const result = await runOutboxArchiveSweepCycle();

      expect(result.retentionDays).toBe(90);
    });

    it('an explicit retentionDays option wins over the env override', async () => {
      process.env.OUTBOX_ARCHIVE_RETENTION_DAYS = '30';
      setupFakeTable([]);

      const result = await runOutboxArchiveSweepCycle({ retentionDays: 7 });

      expect(result.retentionDays).toBe(7);
    });

    it('returns a zeroed result and does not throw when the DELETE fails', async () => {
      queryMock.mockImplementation(async (sql: string) => {
        if (typeof sql === 'string' && sql.trim().startsWith('DELETE FROM outbox_events')) {
          throw new Error('boom');
        }
        return { rows: [] };
      });

      const result = await runOutboxArchiveSweepCycle();
      expect(result).toEqual({ deleted: 0, retentionDays: 90, perTenant: [] });
      expect(writeAuditLogMock).not.toHaveBeenCalled();
    });

    it('continues writing audit entries even if one tenant entry fails', async () => {
      const now = Date.now();
      setupFakeTable([
        { id: 'old-a', tenant_id: 'tenant-a', archived_at: new Date(now - 100 * 24 * 60 * 60 * 1000) },
        { id: 'old-b', tenant_id: 'tenant-b', archived_at: new Date(now - 100 * 24 * 60 * 60 * 1000) },
      ]);
      writeAuditLogMock
        .mockRejectedValueOnce(new Error('audit transient failure'))
        .mockResolvedValueOnce(undefined);

      const result = await runOutboxArchiveSweepCycle();

      expect(result.deleted).toBe(2);
      expect(writeAuditLogMock).toHaveBeenCalledTimes(2);
    });

    it('start/stop registers and clears sweep timers idempotently', () => {
      vi.useFakeTimers();
      startOutboxArchiveSweepScheduler(60_000);
      // Calling start again while a timer is registered is a no-op.
      startOutboxArchiveSweepScheduler(60_000);
      stopOutboxArchiveSweepScheduler();
      // Stopping when nothing is registered is safe.
      stopOutboxArchiveSweepScheduler();
    });
  });
});
