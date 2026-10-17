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
  'scheduling.find_bookings',
];

const SCHEDULING_WRITES = [
  'scheduling.book.prepare',
  'scheduling.book.commit',
  'scheduling.reschedule.prepare',
  'scheduling.reschedule.commit',
  'scheduling.cancel.prepare',
  'scheduling.cancel.commit',
];

describe('action registry', () => {
  it('imports each tool folder; scheduling reads/writes, sms.send and tickets are registered', () => {
    expect(schedulingActions.map((a) => a.name)).toEqual([...SCHEDULING_READS, ...SCHEDULING_WRITES]);
    expect(smsActions.map((def) => def.name)).toEqual(['sms.send']);
    expect(businessActions).toEqual([]);
    expect(callsActions).toEqual([]);
    expect(dispatchActions).toEqual([]);
    expect(ordersActions).toEqual([]);
    expect(ACTION_REGISTRY.map((a) => a.name)).toEqual([
      ...SCHEDULING_READS,
      ...SCHEDULING_WRITES,
      'sms.send',
      ...ticketsActions.map((a) => a.name),
    ]);
    expect(listActions().map((a) => a.name)).toEqual(ACTION_REGISTRY.map((a) => a.name));
    expect(getAction('scheduling.check_availability')?.kind).toBe('read');
    expect(getAction('sms.send')?.permissions.agent).toBe(false);
    expect(getAction('scheduling.find_bookings')?.permissions).toEqual({ agent: true, mcpScope: 'qvo:read' });
  });

  it('registers the scheduling writes as two-phase qvo:admin actions open to the agent', () => {
    for (const name of SCHEDULING_WRITES) {
      const def = getAction(name)!;
      expect(def.tool).toBe('scheduling');
      expect(def.kind).toBe(name.endsWith('.prepare') ? 'prepare' : 'commit');
      expect(def.permissions.mcpScope).toBe('qvo:admin');
      expect(def.permissions.roles).toEqual(['tenant_owner', 'operations_manager']);
      // Agent reschedule/cancel are bound to a verified find_bookings in the same call (PR-14).
      expect(def.permissions.agent).toBe(true);
      expect(def.agentDescription).toBeTruthy();
    }
  });

  it('registers the ticket actions with unique names', () => {
    expect(ticketsActions.length).toBeGreaterThan(0);
    expect(ACTION_REGISTRY).toEqual(expect.arrayContaining([...schedulingActions, ...smsActions, ...ticketsActions]));
    expect(ACTION_REGISTRY).toHaveLength(schedulingActions.length + smsActions.length + ticketsActions.length);
    expect(listActions()).toEqual(ACTION_REGISTRY);
    expect(getAction('tickets.open.commit')?.tool).toBe('tickets');
    const names = ACTION_REGISTRY.map((def) => def.name);
    expect(new Set(names).size).toBe(names.length);
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
      'scheduling.block_time',
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
