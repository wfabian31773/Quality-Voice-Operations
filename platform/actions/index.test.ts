import { describe, expect, it } from 'vitest';
import { ACTION_REGISTRY, createMemoryStore, getAction, listActions, runAction } from './index';
import { businessActions } from './business';
import { callsActions } from './calls';
import { dispatchActions } from './dispatch';
import { ordersActions } from './orders';
import { schedulingActions } from './scheduling';
import { smsActions } from './sms';
import { ticketsActions } from './tickets';

const SCHEDULING_READS = [
  'scheduling.list_services',
  'scheduling.list_staff',
  'scheduling.check_availability',
];

describe('action registry', () => {
  it('imports each tool folder; scheduling reads and sms.send are registered', () => {
    expect(schedulingActions.map((a) => a.name)).toEqual(SCHEDULING_READS);
    expect(smsActions.map((def) => def.name)).toEqual(['sms.send']);
    expect(ticketsActions).toEqual([]);
    expect(businessActions).toEqual([]);
    expect(callsActions).toEqual([]);
    expect(dispatchActions).toEqual([]);
    expect(ordersActions).toEqual([]);
    expect(ACTION_REGISTRY.map((a) => a.name)).toEqual([...SCHEDULING_READS, 'sms.send']);
    expect(listActions().map((a) => a.name)).toEqual([...SCHEDULING_READS, 'sms.send']);
    expect(getAction('scheduling.check_availability')?.kind).toBe('read');
    expect(getAction('sms.send')?.permissions.agent).toBe(false);
    expect(getAction('scheduling.book.commit')).toBeUndefined();
  });

  it('registers the scheduling reads as agent-allowed read actions', () => {
    for (const name of SCHEDULING_READS) {
      const def = getAction(name)!;
      expect(def.tool).toBe('scheduling');
      expect(def.kind).toBe('read');
      expect(def.permissions.agent).toBe(true);
      expect(def.agentDescription).toBeTruthy();
    }
  });

  it('runAction returns NOT_FOUND for an action that is not registered', async () => {
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
