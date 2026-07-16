import { pathToFileURL } from 'node:url';
import { withPrivilegedClient } from '../platform/db';
import {
  CALLER_LOOKUP_BACKFILL_ACKNOWLEDGEMENT,
  runCallerLookupHashBackfill,
  type CallerLookupHashBackfillInput,
} from '../platform/compliance/CallerLookupHashBackfill';

export function parseCallerLookupBackfillArgs(args: string[]): CallerLookupHashBackfillInput {
  const apply = args.includes('--apply');
  const dryRun = args.includes('--dry-run');
  if (apply && dryRun) throw new Error('Choose one mode: --dry-run or --apply');

  const allowed = args.every((arg) => (
    arg === '--apply'
    || arg === '--dry-run'
    || arg.startsWith('--ack=')
    || arg.startsWith('--batch-size=')
    || arg.startsWith('--cursor=')
  ));
  if (!allowed) {
    const unknown = args.find((arg) => !(
      arg === '--apply'
      || arg === '--dry-run'
      || arg.startsWith('--ack=')
      || arg.startsWith('--batch-size=')
      || arg.startsWith('--cursor=')
    ));
    throw new Error(`Unknown argument: ${unknown}`);
  }

  const acknowledgement = args.find((arg) => arg.startsWith('--ack='))?.slice('--ack='.length);
  if (apply && acknowledgement !== CALLER_LOOKUP_BACKFILL_ACKNOWLEDGEMENT) {
    throw new Error(`Apply mode requires --ack=${CALLER_LOOKUP_BACKFILL_ACKNOWLEDGEMENT}`);
  }
  if (!apply && acknowledgement) throw new Error('--ack is valid only with --apply');

  const batchRaw = args.find((arg) => arg.startsWith('--batch-size='))?.slice('--batch-size='.length);
  const batchSize = batchRaw === undefined ? 100 : Number(batchRaw);
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 500) {
    throw new Error('Batch size must be an integer from 1 to 500');
  }

  const cursor = args.find((arg) => arg.startsWith('--cursor='))?.slice('--cursor='.length);
  if (cursor !== undefined && (!cursor || cursor.length > 100 || /[\u0000-\u001f]/.test(cursor))) {
    throw new Error('Cursor is invalid');
  }

  return {
    mode: apply ? 'apply' : 'dry-run',
    ...(apply ? { acknowledgement } : {}),
    batchSize,
    ...(cursor ? { cursor } : {}),
  };
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  const input = parseCallerLookupBackfillArgs(args);
  const result = await withPrivilegedClient((client) => runCallerLookupHashBackfill(client, input));
  console.log(JSON.stringify(result));
}

const invokedDirectly = process.argv[1]
  ? import.meta.url === pathToFileURL(process.argv[1]).href
  : false;

if (invokedDirectly) {
  main().catch(() => {
    console.error('Caller lookup HMAC backfill failed; no row details were emitted');
    process.exitCode = 1;
  });
}
