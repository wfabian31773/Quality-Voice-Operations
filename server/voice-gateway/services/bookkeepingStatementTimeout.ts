/**
 * The bookkeeping statement timeout for the queued writes that don't go
 * through callPersistence. ToolExecutionService's tool_invocations rows,
 * UsageRecorder's meter and TrialGuard's check open their own transactions on
 * the platform pool, so callPersistence's SET LOCAL never reaches them, and a
 * lock wait there used to hold the call's later writes (and the finalize
 * drain) until it ended.
 *
 * withBookkeepingStatementTimeout runs such a write so that, inside a queue
 * write (isBookkeepingWrite()), a client it checks out from the platform pool
 * runs BOOKKEEPING_STATEMENT_TIMEOUT_SQL right after its BEGIN: the same
 * timeout, in the same transaction. Postgres cancels a stuck statement
 * (57014), the writer rolls back and handles it as any DB error, and the write
 * settles; the queue moves on. Outside the scope the pool is untouched.
 */
import { AsyncLocalStorage } from 'async_hooks';
import type { Pool, PoolClient } from 'pg';
import { getPlatformPool } from '../../../platform/db';
import { BOOKKEEPING_STATEMENT_TIMEOUT_SQL, isBookkeepingWrite } from './bookkeepingQueue';

type AnyQuery = (...args: unknown[]) => Promise<unknown>;

const TX_BEGIN = /^\s*(BEGIN|START\s+TRANSACTION)\b/i;
const statementTimeoutScope = new AsyncLocalStorage<true>();
const hookedPools = new WeakSet<object>();

/** Until it is released, the client sets the statement timeout right after each BEGIN. */
function withTimeoutAfterBegin(client: PoolClient): PoolClient {
  const hadOwnQuery = Object.prototype.hasOwnProperty.call(client, 'query');
  const ownQuery = client.query;
  const raw = client.query.bind(client) as AnyQuery;
  const release = client.release;

  client.query = (async (...args: unknown[]) => {
    if (args.some((a) => typeof a === 'function')) return raw(...args);
    const result = await raw(...args);
    if (typeof args[0] === 'string' && TX_BEGIN.test(args[0])) await raw(BOOKKEEPING_STATEMENT_TIMEOUT_SQL);
    return result;
  }) as PoolClient['query'];
  client.release = ((err?: Error | boolean) => {
    if (hadOwnQuery) client.query = ownQuery;
    else delete (client as { query?: unknown }).query;
    client.release = release;
    return release(err);
  }) as PoolClient['release'];
  return client;
}

function hookPool(pool: Pool): void {
  if (hookedPools.has(pool)) return;
  hookedPools.add(pool);
  const connect = pool.connect.bind(pool) as (...args: unknown[]) => unknown;
  Object.assign(pool, {
    connect: (...args: unknown[]): unknown => {
      if (args.length > 0 || !statementTimeoutScope.getStore() || !isBookkeepingWrite()) return connect(...args);
      return (connect() as Promise<PoolClient>).then(withTimeoutAfterBegin);
    },
  });
}

/** Runs a queued platform write with the bookkeeping statement timeout on its transactions. */
export function withBookkeepingStatementTimeout<T>(write: () => Promise<T>): Promise<T> {
  try {
    hookPool(getPlatformPool());
  } catch {
    // No pool (no DATABASE_URL): the write fails on its own getPlatformPool(), like any other.
  }
  return statementTimeoutScope.run(true, write);
}
