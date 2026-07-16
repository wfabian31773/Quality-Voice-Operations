import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runCallerLookupHashBackfill } from './CallerLookupHashBackfill';

const originalEnv = { ...process.env };

beforeEach(() => {
  process.env.QVO_PII_LOOKUP_HMAC_KEY = 'current-lookup-key-with-at-least-32-characters';
  process.env.QVO_PII_LOOKUP_HMAC_KEY_VERSION = 'v2';
  delete process.env.QVO_PII_LOOKUP_HMAC_PREVIOUS_KEY;
  delete process.env.QVO_PII_LOOKUP_HMAC_PREVIOUS_VERSION;
});

afterEach(() => {
  process.env = { ...originalEnv };
});

describe('caller lookup HMAC backfill', () => {
  it('defaults to a non-writing dry run and returns counts without plaintext', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [
      { id: '01', tenant_id: 'tenant-1', caller_number: 'encrypted-a' },
      { id: '02', tenant_id: 'tenant-2', caller_number: 'encrypted-b' },
    ] });
    const decrypt = vi.fn()
      .mockResolvedValueOnce('+15551230001')
      .mockResolvedValueOnce('+15551230002');

    const result = await runCallerLookupHashBackfill(
      { query },
      { mode: 'dry-run', batchSize: 100 },
      { decrypt },
    );

    expect(result).toEqual({
      mode: 'dry-run', keyVersion: 'v2', scanned: 2, eligible: 2,
      updated: 0, skipped: 0, failed: 0, nextCursor: '02', batchComplete: true,
    });
    expect(query).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result)).not.toContain('555123');
  });

  it('refuses apply mode without the exact destructive-action acknowledgement', async () => {
    const query = vi.fn();
    await expect(runCallerLookupHashBackfill(
      { query },
      { mode: 'apply', acknowledgement: 'yes' },
    )).rejects.toThrow('APPLY CALLER LOOKUP HASH BACKFILL');
    expect(query).not.toHaveBeenCalled();
  });

  it('applies a resumable batch with parameterized hashes and no plaintext SQL values', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [
        { id: '02', tenant_id: 'tenant-1', caller_number: 'encrypted-a' },
      ] })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });
    const decrypt = vi.fn().mockResolvedValue('+15551230001');

    const result = await runCallerLookupHashBackfill(
      { query },
      {
        mode: 'apply', acknowledgement: 'APPLY CALLER LOOKUP HASH BACKFILL',
        cursor: '01', batchSize: 25,
      },
      { decrypt },
    );

    expect(result.updated).toBe(1);
    expect(result.nextCursor).toBe('02');
    expect(String(query.mock.calls[0]?.[0])).toMatch(/id::text > \$2[\s\S]*LIMIT \$3/);
    expect(query.mock.calls[0]?.[1]).toEqual(['v2', '01', 25]);
    expect(String(query.mock.calls[1]?.[0])).toContain('caller_lookup_key_version = $4');
    expect(query.mock.calls[1]?.[1]).toEqual([
      '02', 'tenant-1', expect.stringMatching(/^[a-f0-9]{64}$/), 'v2', 'encrypted-a',
    ]);
    expect(JSON.stringify(query.mock.calls)).not.toContain('5551230001');
  });

  it('counts row-level decrypt failures without returning ciphertext or exception text', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [
      { id: '01', tenant_id: 'tenant-1', caller_number: 'sensitive-ciphertext' },
    ] });
    const decrypt = vi.fn().mockRejectedValue(new Error('decrypt failed for sensitive-ciphertext'));
    const result = await runCallerLookupHashBackfill(
      { query },
      { mode: 'dry-run' },
      { decrypt },
    );
    expect(result).toMatchObject({ scanned: 1, eligible: 0, failed: 1 });
    expect(JSON.stringify(result)).not.toMatch(/sensitive-ciphertext|decrypt failed/);
  });

  it('rejects unsafe bounds and invalid keyrings before querying', async () => {
    const query = vi.fn();
    await expect(runCallerLookupHashBackfill({ query }, { batchSize: 0 })).rejects.toThrow('1 to 500');
    await expect(runCallerLookupHashBackfill({ query }, { cursor: 'bad\nvalue' })).rejects.toThrow('Cursor');
    delete process.env.QVO_PII_LOOKUP_HMAC_KEY;
    await expect(runCallerLookupHashBackfill({ query })).rejects.toThrow('keyring');
    expect(query).not.toHaveBeenCalled();
  });

  it('counts malformed and non-phone rows and a concurrent no-op update without leaking values', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [
        { id: '', tenant_id: 'tenant-1', caller_number: 'cipher-a' },
        { id: '02', tenant_id: 'tenant-1', caller_number: 'cipher-b' },
        { id: '03', tenant_id: 'tenant-1', caller_number: 'cipher-c' },
      ] })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const decrypt = vi.fn()
      .mockResolvedValueOnce('not-a-phone')
      .mockResolvedValueOnce('+15551230003');
    const result = await runCallerLookupHashBackfill(
      { query },
      { mode: 'apply', acknowledgement: 'APPLY CALLER LOOKUP HASH BACKFILL' },
      { decrypt },
    );
    expect(result).toMatchObject({ scanned: 3, eligible: 1, updated: 0, skipped: 2, failed: 1 });
  });
});
