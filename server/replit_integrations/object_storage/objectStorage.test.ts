import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { fileMock, deleteMock } = vi.hoisted(() => ({
  fileMock: vi.fn(),
  deleteMock: vi.fn(),
}));

// Mock the @google-cloud/storage Storage class so we never touch the
// network. The test exercises only the not-found / success / unknown-
// error branches of `deletePrivateObject`, which is enough to lock in
// the telemetry contract the dispatch route-export cleanup sweeper
// depends on.
vi.mock('@google-cloud/storage', () => {
  class Storage {
    bucket() {
      return { file: fileMock };
    }
  }
  class File {}
  return { Storage, File };
});

import { ObjectStorageService } from './objectStorage';

describe('ObjectStorageService.deletePrivateObject', () => {
  beforeEach(() => {
    fileMock.mockReset();
    deleteMock.mockReset();
    fileMock.mockReturnValue({ delete: deleteMock });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('returns true when the object was deleted', async () => {
    deleteMock.mockResolvedValue(undefined);
    const svc = new ObjectStorageService();
    await expect(
      svc.deletePrivateObject('/bucket/dispatch-route-exports/t/x.zip'),
    ).resolves.toBe(true);
    expect(deleteMock).toHaveBeenCalledTimes(1);
  });

  it('returns false on a 404 so already-gone is reported accurately', async () => {
    const err: Error & { code?: number } = new Error('No such object');
    err.code = 404;
    deleteMock.mockRejectedValue(err);
    const svc = new ObjectStorageService();
    await expect(
      svc.deletePrivateObject('/bucket/dispatch-route-exports/t/missing.zip'),
    ).resolves.toBe(false);
  });

  it('rethrows non-404 errors so callers can surface real failures', async () => {
    const err: Error & { code?: number } = new Error('boom');
    err.code = 500;
    deleteMock.mockRejectedValue(err);
    const svc = new ObjectStorageService();
    await expect(
      svc.deletePrivateObject('/bucket/dispatch-route-exports/t/y.zip'),
    ).rejects.toThrow(/boom/);
  });
});
