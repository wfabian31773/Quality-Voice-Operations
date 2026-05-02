import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { withPrivilegedClientMock, writeAuditLogMock, deletePrivateObjectMock } = vi.hoisted(() => ({
  withPrivilegedClientMock: vi.fn(),
  writeAuditLogMock: vi.fn(),
  deletePrivateObjectMock: vi.fn(),
}));

vi.mock('../db', () => ({
  withPrivilegedClient: withPrivilegedClientMock,
}));

vi.mock('../audit/AuditService', () => ({
  writeAuditLog: writeAuditLogMock,
}));

import {
  runRouteExportArchiveCleanupCycle,
  startRouteExportArchiveCleanupScheduler,
  stopRouteExportArchiveCleanupScheduler,
} from './RouteExportArchiveCleanupScheduler';

function makeStorage(): { deletePrivateObject: (path: string) => Promise<boolean> } {
  return {
    deletePrivateObject: (path: string) => deletePrivateObjectMock(path) as Promise<boolean>,
  };
}

/**
 * Drives the privileged-client mock so tests can configure successive
 * calls (the SELECT pass first, then one UPDATE per cleaned row).
 *
 * `responses` is the queue of values returned by the user-supplied
 * callback's `client.query(...)` for the corresponding `withPrivilegedClient`
 * invocation: index 0 → SELECT, then UPDATEs.
 */
function configurePrivilegedClient(responses: unknown[][]): void {
  let call = 0;
  withPrivilegedClientMock.mockImplementation(async (fn: (c: { query: (sql: string, values?: unknown[]) => Promise<{ rows: unknown[] }> }) => Promise<unknown>) => {
    const rows = responses[call] ?? [];
    call += 1;
    const client = {
      query: vi.fn(async () => ({ rows })),
    };
    return await fn(client);
  });
}

describe('RouteExportArchiveCleanupScheduler', () => {
  beforeEach(() => {
    withPrivilegedClientMock.mockReset();
    writeAuditLogMock.mockReset().mockResolvedValue(undefined);
    deletePrivateObjectMock.mockReset();
  });

  afterEach(() => {
    stopRouteExportArchiveCleanupScheduler();
    vi.useRealTimers();
  });

  it('does nothing when no expired archives exist', async () => {
    configurePrivilegedClient([[]]);

    const result = await runRouteExportArchiveCleanupCycle({ storage: makeStorage() });

    expect(result).toEqual({ scanned: 0, deleted: 0, alreadyGone: 0, failed: 0 });
    expect(deletePrivateObjectMock).not.toHaveBeenCalled();
    expect(writeAuditLogMock).not.toHaveBeenCalled();
  });

  it('deletes expired archives and clears bookkeeping columns + writes audit', async () => {
    const expired = [
      {
        id: 'exp-1',
        tenant_id: 'tenant-a',
        archive_object_path: '/bucket/dispatch-route-exports/tenant-a/exp-1.zip',
        archive_filename: 'dispatch-routes-exp-1.zip',
        download_expires_at: new Date('2026-04-20T00:00:00Z'),
      },
      {
        id: 'exp-2',
        tenant_id: 'tenant-b',
        archive_object_path: '/bucket/dispatch-route-exports/tenant-b/exp-2.zip',
        archive_filename: null,
        download_expires_at: '2026-04-21T12:00:00.000Z',
      },
    ];
    // SELECT returns the two expired rows; each row triggers an UPDATE.
    configurePrivilegedClient([expired, [], []]);
    deletePrivateObjectMock.mockResolvedValue(true);

    const result = await runRouteExportArchiveCleanupCycle({ storage: makeStorage() });

    expect(result).toEqual({ scanned: 2, deleted: 2, alreadyGone: 0, failed: 0 });
    expect(deletePrivateObjectMock).toHaveBeenCalledTimes(2);
    expect(deletePrivateObjectMock).toHaveBeenNthCalledWith(
      1,
      '/bucket/dispatch-route-exports/tenant-a/exp-1.zip',
    );
    expect(deletePrivateObjectMock).toHaveBeenNthCalledWith(
      2,
      '/bucket/dispatch-route-exports/tenant-b/exp-2.zip',
    );

    expect(writeAuditLogMock).toHaveBeenCalledTimes(2);
    expect(writeAuditLogMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        tenantId: 'tenant-a',
        actorUserId: null,
        action: 'dispatch.route_export.archive_purged',
        resourceType: 'dispatch_route_export_job',
        resourceId: 'exp-1',
        changes: expect.objectContaining({
          archive_object_path: '/bucket/dispatch-route-exports/tenant-a/exp-1.zip',
          archive_filename: 'dispatch-routes-exp-1.zip',
          object_already_gone: false,
          source: 'scheduled_sweep',
        }),
      }),
    );
  });

  it('treats already-deleted objects as success and still clears the row', async () => {
    const expired = [
      {
        id: 'exp-3',
        tenant_id: 'tenant-c',
        archive_object_path: '/bucket/dispatch-route-exports/tenant-c/exp-3.zip',
        archive_filename: 'x.zip',
        download_expires_at: new Date('2026-04-22T00:00:00Z'),
      },
    ];
    configurePrivilegedClient([expired, []]);
    deletePrivateObjectMock.mockResolvedValue(false);

    const result = await runRouteExportArchiveCleanupCycle({ storage: makeStorage() });

    expect(result).toEqual({ scanned: 1, deleted: 0, alreadyGone: 1, failed: 0 });
    expect(writeAuditLogMock).toHaveBeenCalledWith(
      expect.objectContaining({
        resourceId: 'exp-3',
        changes: expect.objectContaining({ object_already_gone: true }),
      }),
    );
  });

  it('continues processing other rows when one storage delete throws', async () => {
    const expired = [
      {
        id: 'exp-4',
        tenant_id: 'tenant-d',
        archive_object_path: '/bucket/bad.zip',
        archive_filename: null,
        download_expires_at: new Date('2026-04-22T00:00:00Z'),
      },
      {
        id: 'exp-5',
        tenant_id: 'tenant-e',
        archive_object_path: '/bucket/good.zip',
        archive_filename: null,
        download_expires_at: new Date('2026-04-23T00:00:00Z'),
      },
    ];
    // SELECT, then only one UPDATE for the row that succeeds.
    configurePrivilegedClient([expired, []]);
    deletePrivateObjectMock
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(true);

    const result = await runRouteExportArchiveCleanupCycle({ storage: makeStorage() });

    expect(result.scanned).toBe(2);
    expect(result.failed).toBe(1);
    expect(result.deleted).toBe(1);
    // Only the successful row should have written an audit entry.
    expect(writeAuditLogMock).toHaveBeenCalledTimes(1);
    expect(writeAuditLogMock).toHaveBeenCalledWith(
      expect.objectContaining({ resourceId: 'exp-5' }),
    );
  });

  it('returns an empty cycle when the SELECT itself fails', async () => {
    withPrivilegedClientMock.mockRejectedValueOnce(new Error('db down'));

    const result = await runRouteExportArchiveCleanupCycle({ storage: makeStorage() });

    expect(result).toEqual({ scanned: 0, deleted: 0, alreadyGone: 0, failed: 0 });
    expect(deletePrivateObjectMock).not.toHaveBeenCalled();
  });

  it('does not throw if the audit write fails', async () => {
    const expired = [
      {
        id: 'exp-6',
        tenant_id: 'tenant-f',
        archive_object_path: '/bucket/z.zip',
        archive_filename: null,
        download_expires_at: new Date('2026-04-22T00:00:00Z'),
      },
    ];
    configurePrivilegedClient([expired, []]);
    deletePrivateObjectMock.mockResolvedValue(true);
    writeAuditLogMock.mockRejectedValueOnce(new Error('audit table missing'));

    const result = await runRouteExportArchiveCleanupCycle({ storage: makeStorage() });

    // The cleanup itself succeeded — the audit failure is logged but
    // does not flip the row to failed.
    expect(result.deleted).toBe(1);
    expect(result.failed).toBe(0);
  });

  it('start/stop is idempotent and does not leak timers', () => {
    vi.useFakeTimers();
    startRouteExportArchiveCleanupScheduler(60_000);
    startRouteExportArchiveCleanupScheduler(60_000); // no-op second call
    stopRouteExportArchiveCleanupScheduler();
    stopRouteExportArchiveCleanupScheduler(); // no-op second call
  });
});
