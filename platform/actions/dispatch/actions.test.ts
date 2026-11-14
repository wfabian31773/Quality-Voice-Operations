import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createMemoryStore, runAction, type ActionContext, type ActionResult } from '../core';
import {
  CREATE_JOB_COMMIT,
  CREATE_JOB_PREPARE,
  createDispatchActions,
  GET_JOB_STATUS,
  UPDATE_STATUS,
} from './actions';
import { createMemoryDispatchRepo } from './__fixtures__/memoryRepo';
import { dispatchActions } from './index';

const NOW = new Date('2026-10-19T12:00:00.000Z');
const TENANT = 'tenant-a';
const OTHER = 'tenant-b';
const PHONE = '+15555550142';

const ADDRESS = {
  line1: '123 Main St',
  unit: 'Apt 4B',
  city: 'Springfield',
  region: 'IL',
  postal: '62701',
};

const WINDOW = {
  start: '2026-10-20T13:00:00-04:00',
  end: '2026-10-20T17:00:00-04:00',
};

function jobInput(overrides: Record<string, unknown> = {}) {
  return {
    jobType: 'plumbing',
    window: WINDOW,
    address: ADDRESS,
    contact: { name: 'Luis Garcia', phone: '(555) 555-0142' },
    problem: 'The kitchen sink is leaking under the cabinet.',
    urgency: 'normal' as const,
    accessNotes: 'Gate code 4B',
    ...overrides,
  };
}

function agentCtx(overrides: Partial<ActionContext> = {}): ActionContext {
  return {
    tenantId: TENANT,
    actor: { type: 'agent', id: 'agent-1' },
    now: NOW,
    tenantTimezone: 'America/New_York',
    callId: 'call-1',
    ...overrides,
  };
}

function ownerCtx(overrides: Partial<ActionContext> = {}): ActionContext {
  return agentCtx({ actor: { type: 'user', id: 'owner-1', role: 'tenant_owner' }, callId: undefined, ...overrides });
}

function setup(opts: { callerMatch?: boolean } = {}) {
  const store = createMemoryStore();
  const dispatch = createMemoryDispatchRepo();
  const callerMatch = opts.callerMatch ?? true;
  const registry = createDispatchActions({
    repo: dispatch.repo,
    callerIdMatches: async () => callerMatch,
  });
  const deps = { store, registry, withTenantTx: store.withTenantTx.bind(store) };
  let seq = 0;
  const run = (name: string, ctx: ActionContext, input: unknown) =>
    runAction(
      name,
      {
        ...ctx,
        idempotencyKey: ctx.idempotencyKey ?? (name.endsWith('.commit') ? undefined : `key-${++seq}`),
      },
      input,
      deps,
    );
  return { store, dispatch, run };
}

function data<T = Record<string, unknown>>(result: ActionResult): T {
  if (!result.ok) throw new Error(`expected ok, got ${result.error.code}: ${result.error.message}`);
  return result.data as T;
}

function expectFail(result: ActionResult, code: string, field?: string) {
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.error.code).toBe(code);
  if (field) expect(result.error.field).toBe(field);
}

type Prepared = { confirmationToken: string; payloadHash: string; readback: string };
type Committed = { jobId: string; window: { start: string; end: string; spoken: string }; duplicate: boolean };

async function prepareAndCommit(
  run: ReturnType<typeof setup>['run'],
  input: Record<string, unknown> = jobInput(),
  ctx: ActionContext = agentCtx(),
) {
  const prepared = data<Prepared>(await run(CREATE_JOB_PREPARE, ctx, input));
  const committed = await run(CREATE_JOB_COMMIT, ctx, { confirmationToken: prepared.confirmationToken });
  return { prepared, committed };
}

describe('dispatch action exports', () => {
  it('does not register dispatch actions for agents yet', () => {
    expect(dispatchActions).toEqual([]);
    expect(createDispatchActions().map((a) => a.name)).toEqual([
      CREATE_JOB_PREPARE,
      CREATE_JOB_COMMIT,
      UPDATE_STATUS,
      GET_JOB_STATUS,
    ]);
  });
});

describe('dispatch.create_job.prepare / commit', () => {
  it('prepares a readback that includes the unit and a spoken window, then inserts the job and a created event', async () => {
    const { dispatch, run } = setup();
    const { prepared, committed } = await prepareAndCommit(run);
    expect(prepared.readback).toContain('Apt 4B');
    expect(prepared.readback).toMatch(/between/i);
    expect(prepared.readback).toContain('0142');
    const result = data<Committed>(committed);
    expect(result.duplicate).toBe(false);
    expect(dispatch.state.jobs).toHaveLength(1);
    expect(dispatch.state.jobs[0]).toMatchObject({
      status: 'pending',
      contactName: 'Luis Garcia',
      contactPhone: PHONE,
      address: '123 Main St, Apt 4B, Springfield, IL 62701',
    });
    expect(dispatch.state.events).toEqual([
      expect.objectContaining({ jobId: result.jobId, eventType: 'created', toStatus: 'pending' }),
    ]);
  });

  it('reads back in Spanish when the call carries locale es', async () => {
    const { run } = setup();
    const prepared = data<Prepared>(await run(CREATE_JOB_PREPARE, agentCtx({ locale: 'es' }), jobInput()));
    expect(prepared.readback).toMatch(/un trabajo de plumbing en .+Apt 4B/);
    expect(prepared.readback).toContain('teléfono que termina en 0142');
  });

  it('replays an idempotent commit retry: one job, one created event', async () => {
    const { dispatch, run } = setup();
    const { prepared, committed } = await prepareAndCommit(run);
    const retry = await run(CREATE_JOB_COMMIT, agentCtx(), { confirmationToken: prepared.confirmationToken });
    expect(retry).toEqual(committed);
    expect(dispatch.state.jobs).toHaveLength(1);
    expect(dispatch.state.events).toHaveLength(1);
  });

  it('returns the existing job with duplicate: true for the same tenant, address and overlapping window', async () => {
    const { dispatch, run } = setup();
    const first = data<Committed>((await prepareAndCommit(run)).committed);
    const second = data<Committed>(
      (await prepareAndCommit(run, jobInput({ problem: 'Same leak, calling again' }), agentCtx({ callId: 'call-2' })))
        .committed,
    );
    expect(second).toMatchObject({ jobId: first.jobId, duplicate: true });
    expect(dispatch.state.jobs).toHaveLength(1);
    expect(dispatch.state.events.filter((e) => e.eventType === 'created')).toHaveLength(1);
  });

  it('does not treat a different unit, a non-overlapping window, or another tenant as a duplicate', async () => {
    const { dispatch, run } = setup();
    data((await prepareAndCommit(run)).committed);
    data(
      (
        await prepareAndCommit(
          run,
          jobInput({ address: { ...ADDRESS, unit: 'Apt 3A' }, problem: 'Other unit' }),
          agentCtx({ callId: 'call-2' }),
        )
      ).committed,
    );
    data(
      (
        await prepareAndCommit(
          run,
          jobInput({
            window: { start: '2026-10-21T13:00:00-04:00', end: '2026-10-21T17:00:00-04:00' },
            problem: 'Next day',
          }),
          agentCtx({ callId: 'call-3' }),
        )
      ).committed,
    );
    data((await prepareAndCommit(run, jobInput(), agentCtx({ tenantId: OTHER, callId: 'call-4' }))).committed);
    expect(dispatch.state.jobs).toHaveLength(4);
  });

  it('rejects out-of-range input before writing', async () => {
    const { dispatch, run } = setup();
    expectFail(await run(CREATE_JOB_PREPARE, agentCtx(), jobInput({ problem: 'x'.repeat(2001) })), 'VALIDATION_FAILED');
    expectFail(
      await run(CREATE_JOB_PREPARE, agentCtx(), jobInput({ window: { start: WINDOW.end, end: WINDOW.start } })),
      'VALIDATION_FAILED',
      'window.end',
    );
    expect(dispatch.state.jobs).toHaveLength(0);
  });

  it("does not let one tenant commit another tenant's token", async () => {
    const { dispatch, run } = setup();
    const prepared = data<Prepared>(await run(CREATE_JOB_PREPARE, agentCtx(), jobInput()));
    expectFail(
      await run(CREATE_JOB_COMMIT, agentCtx({ tenantId: OTHER }), { confirmationToken: prepared.confirmationToken }),
      'CONFIRMATION_INVALID',
    );
    expect(dispatch.state.jobs).toHaveLength(0);
  });
});

describe('dispatch.update_status', () => {
  async function opened() {
    const env = setup();
    const { jobId } = data<Committed>((await prepareAndCommit(env.run)).committed);
    let key = 0;
    const update = (input: Record<string, unknown>, ctx: Partial<ActionContext> = {}) =>
      env.run(UPDATE_STATUS, ownerCtx({ idempotencyKey: `u${++key}`, ...ctx }), { jobId, ...input });
    return { ...env, jobId, update };
  }

  it('walks pending → assigned → en_route and records each event', async () => {
    const { dispatch, update } = await opened();
    expect(data(await update({ status: 'assigned' }))).toMatchObject({ status: 'assigned', fromStatus: 'pending' });
    expect(data(await update({ status: 'en_route', eta: '2026-10-20T14:30:00-04:00' }))).toMatchObject({
      status: 'en_route',
      fromStatus: 'assigned',
    });
    expect(dispatch.state.events.filter((e) => e.eventType === 'status_change').map((e) => `${e.fromStatus}->${e.toStatus}`)).toEqual([
      'pending->assigned',
      'assigned->en_route',
    ]);
  });

  it('rejects a disallowed transition with CONFLICT', async () => {
    const { update } = await opened();
    expectFail(await update({ status: 'done' }), 'CONFLICT', 'status');
    expectFail(await update({ status: 'en_route' }), 'CONFLICT', 'status');
  });

  it('returns NOT_FOUND for a missing or foreign job', async () => {
    const { jobId, run } = await opened();
    expectFail(
      await run(UPDATE_STATUS, ownerCtx({ idempotencyKey: 'missing' }), { jobId: 'nope', status: 'assigned' }),
      'NOT_FOUND',
    );
    expectFail(
      await run(UPDATE_STATUS, ownerCtx({ tenantId: OTHER, idempotencyKey: 'x' }), { jobId, status: 'assigned' }),
      'NOT_FOUND',
    );
  });

  it('is staff/system only', async () => {
    const { jobId, run } = await opened();
    expectFail(
      await run(UPDATE_STATUS, agentCtx({ idempotencyKey: 'a1' }), { jobId, status: 'assigned' }),
      'FORBIDDEN',
    );
    const system = await run(
      UPDATE_STATUS,
      agentCtx({ actor: { type: 'system', id: 'cron' }, idempotencyKey: 's1' }),
      { jobId, status: 'assigned' },
    );
    expect(data(system).status).toBe('assigned');
  });
});

describe('dispatch.get_job_status', () => {
  it('returns status and window for a verified caller, never a job id', async () => {
    const { run } = setup({ callerMatch: true });
    const { committed } = await prepareAndCommit(run);
    const jobId = data<Committed>(committed).jobId;
    const found = data<{ status: string; window: { spoken: string } }>(
      await run(GET_JOB_STATUS, agentCtx(), { phone: PHONE, name: 'Luis' }),
    );
    expect(found).toMatchObject({ status: 'pending' });
    expect(found.window.spoken).toMatch(/between/i);
    expect(JSON.stringify(found)).not.toContain(jobId);
  });

  it('returns the same NOT_FOUND whether the name is wrong, the caller ID does not match, or there is no job', async () => {
    const matched = setup({ callerMatch: true });
    await prepareAndCommit(matched.run);
    const wrongName = await matched.run(GET_JOB_STATUS, agentCtx(), { phone: PHONE, name: 'Ana' });
    const missedCaller = setup({ callerMatch: false });
    await prepareAndCommit(missedCaller.run);
    const wrongCaller = await missedCaller.run(GET_JOB_STATUS, agentCtx(), { phone: PHONE, name: 'Luis' });
    const empty = setup({ callerMatch: true });
    const missing = await empty.run(GET_JOB_STATUS, agentCtx(), { phone: PHONE, name: 'Luis' });
    expectFail(wrongName, 'NOT_FOUND');
    expectFail(wrongCaller, 'NOT_FOUND');
    expectFail(missing, 'NOT_FOUND');
    expect(wrongName).toEqual(wrongCaller);
    expect(wrongName).toEqual(missing);
    if (!wrongName.ok) expect(wrongName.error.callerSafeMessage).toBe("I couldn't find a job for that name and number.");
  });

  it('does not reveal another tenant’s job', async () => {
    const { run } = setup({ callerMatch: true });
    await prepareAndCommit(run);
    expectFail(await run(GET_JOB_STATUS, agentCtx({ tenantId: OTHER }), { phone: PHONE, name: 'Luis' }), 'NOT_FOUND');
  });

  it('lets staff look up by phone and name without a caller-ID check', async () => {
    const { run } = setup({ callerMatch: false });
    await prepareAndCommit(run);
    const found = data(await run(GET_JOB_STATUS, ownerCtx(), { phone: PHONE, name: 'Luis Garcia' }));
    expect(found.status).toBe('pending');
  });
});
