import { describe, expect, it } from 'vitest';
import { parseCallerLookupBackfillArgs } from './backfill-caller-lookup-hashes';

describe('caller lookup HMAC backfill CLI', () => {
  it('defaults to dry-run with a bounded batch', () => {
    expect(parseCallerLookupBackfillArgs([])).toEqual({ mode: 'dry-run', batchSize: 100 });
  });

  it('requires the exact acknowledgement for apply mode', () => {
    expect(() => parseCallerLookupBackfillArgs(['--apply'])).toThrow('APPLY CALLER LOOKUP HASH BACKFILL');
    expect(parseCallerLookupBackfillArgs([
      '--apply', '--ack=APPLY CALLER LOOKUP HASH BACKFILL', '--batch-size=25', '--cursor=abc',
    ])).toEqual({
      mode: 'apply', acknowledgement: 'APPLY CALLER LOOKUP HASH BACKFILL',
      batchSize: 25, cursor: 'abc',
    });
  });

  it('rejects unknown, conflicting, and unbounded arguments', () => {
    expect(() => parseCallerLookupBackfillArgs(['--unknown'])).toThrow('Unknown argument');
    expect(() => parseCallerLookupBackfillArgs(['--apply', '--dry-run'])).toThrow('Choose one mode');
    expect(() => parseCallerLookupBackfillArgs(['--batch-size=501'])).toThrow('1 to 500');
  });
});
