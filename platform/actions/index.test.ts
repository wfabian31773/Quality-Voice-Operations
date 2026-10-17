import { describe, expect, it } from 'vitest';
import { ACTION_REGISTRY, createMemoryStore, getAction, listActions, runAction } from './index';
import { businessActions } from './business';
import { callsActions } from './calls';
import { dispatchActions } from './dispatch';
import { ordersActions } from './orders';
import { schedulingActions } from './scheduling';
import { smsActions } from './sms';
import { ticketsActions } from './tickets';

describe('action registry', () => {
  it('imports each tool folder and starts empty', () => {
    expect(schedulingActions).toEqual([]);
    expect(smsActions).toEqual([]);
    expect(ticketsActions).toEqual([]);
    expect(businessActions).toEqual([]);
    expect(callsActions).toEqual([]);
    expect(dispatchActions).toEqual([]);
    expect(ordersActions).toEqual([]);
    expect(ACTION_REGISTRY).toEqual([]);
    expect(listActions()).toEqual([]);
    expect(getAction('scheduling.book.commit')).toBeUndefined();
  });

  it('runAction uses the empty registry by default', async () => {
    const store = createMemoryStore();
    const result = await runAction(
      'scheduling.book.commit',
      {
        tenantId: 't1',
        actor: { type: 'system', id: 'sys' },
        now: new Date('2026-10-17T00:00:00.000Z'),
        tenantTimezone: 'UTC',
      },
      {},
      { store, withTenantTx: store.withTenantTx.bind(store) },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('NOT_FOUND');
  });
});
