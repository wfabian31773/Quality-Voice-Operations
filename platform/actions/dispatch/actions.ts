import {
  actionFail,
  actionOk,
  consumeProposal,
  createProposal,
  defineAction,
  isActionFailure,
  isConfirmationToken,
  type ActionContext,
  type ActionResult,
  type AnyActionDefinition,
  type ProposalRecord,
  type TenantTx,
} from '../core';
import { getActionStore } from '../core/runtime';
import { callerIdMatches, namesMatch } from '../scheduling/identity';
import { createJobReadback, spokenWindow } from './readback';
import {
  formattedAndNormalized,
  sqlDispatchRepo,
  type DispatchJobRecord,
  type DispatchRepoFactory,
} from './repo';
import {
  createJobCommitInput,
  createJobCommitOutput,
  createJobPrepareInput,
  createJobPrepareOutput,
  getJobStatusInput,
  getJobStatusOutput,
  updateStatusInput,
  updateStatusOutput,
  type CreateJobPrepareInput,
} from './schemas';
import { canTransition, isDispatchJobStatus, type DispatchJobStatus } from './transitions';

export const CREATE_JOB_PREPARE = 'dispatch.create_job.prepare';
export const CREATE_JOB_COMMIT = 'dispatch.create_job.commit';
export const UPDATE_STATUS = 'dispatch.update_status';
export const GET_JOB_STATUS = 'dispatch.get_job_status';

/** Same roles as requireMiniSystemWrite on the dispatch routes. */
export const DISPATCH_WRITE_ROLES = ['tenant_owner', 'operations_manager'];

const NOT_FOUND_SAFE = "I couldn't find a job for that name and number.";

export interface DispatchActionDeps {
  repo?: DispatchRepoFactory;
  /** Tests inject a fake; production uses scheduling's caller-ID match. */
  callerIdMatches?: typeof callerIdMatches;
}

function performedBy(ctx: ActionContext): string | null {
  return ctx.actor.type === 'user' || ctx.actor.type === 'system' ? ctx.actor.id : null;
}

function windowOf(job: DispatchJobRecord, ctx: ActionContext): { start: string; end: string; spoken: string } {
  const start = job.etaStart ?? job.scheduledAt ?? job.createdAt;
  const end = job.etaEnd ?? new Date(start.getTime() + 4 * 60 * 60_000);
  const window = { start: start.toISOString(), end: end.toISOString() };
  return {
    ...window,
    spoken: spokenWindow(window, ctx.now.getTime(), ctx.tenantTimezone, ctx.locale),
  };
}

/**
 * Consume a proposal from its token alone. Commit inputs carry only the
 * token (same as scheduling), so the stored payload hash is read back first.
 */
async function consumeToken(
  tx: TenantTx,
  ctx: ActionContext,
  token: string,
  action: string,
): Promise<ProposalRecord | ActionResult<never>> {
  if (!isConfirmationToken(token)) return actionFail('CONFIRMATION_INVALID', 'Unknown or expired confirmation token');
  const existing = await getActionStore().inspectProposal(tx, ctx, token);
  if (!existing) return actionFail('CONFIRMATION_INVALID', 'Unknown or expired confirmation token');
  return consumeProposal(tx, ctx, {
    confirmationToken: token,
    action,
    payloadHash: existing.payloadHash,
    callId: ctx.callId,
  });
}

function hiddenNotFound(): ActionResult<never> {
  return actionFail('NOT_FOUND', 'No matching job', { callerSafeMessage: NOT_FOUND_SAFE });
}

export function createDispatchActions(deps: DispatchActionDeps = {}): AnyActionDefinition[] {
  const repoFor = deps.repo ?? sqlDispatchRepo;
  const matchCaller = deps.callerIdMatches ?? callerIdMatches;

  const createJobPrepareAction = defineAction({
    name: CREATE_JOB_PREPARE,
    tool: 'dispatch',
    kind: 'prepare',
    input: createJobPrepareInput,
    output: createJobPrepareOutput,
    permissions: { roles: DISPATCH_WRITE_ROLES, agent: true, mcpScope: 'qvo:admin' },
    agentDescription:
      'Prepare a field-service job. Read the returned readback to the caller word for word, including the unit, '
      + 'and quote the arrival window, never an exact time. Call dispatch.create_job.commit only after an explicit yes. '
      + 'If the caller changes anything, call prepare again.',
    async run(ctx, input, tx) {
      const readback = createJobReadback(input, ctx.now.getTime(), ctx.tenantTimezone, ctx.locale);
      const proposal = await createProposal(tx, ctx, {
        action: CREATE_JOB_PREPARE,
        payload: input,
        readback,
        callId: ctx.callId,
      });
      return actionOk(
        {
          confirmationToken: proposal.confirmationToken,
          expiresAt: proposal.expiresAt.toISOString(),
          readback: proposal.readback,
          payloadHash: proposal.payloadHash,
        },
        { readback: proposal.readback },
      );
    },
  });

  const createJobCommitAction = defineAction({
    name: CREATE_JOB_COMMIT,
    tool: 'dispatch',
    kind: 'commit',
    input: createJobCommitInput,
    output: createJobCommitOutput,
    permissions: { roles: DISPATCH_WRITE_ROLES, agent: true, mcpScope: 'qvo:admin' },
    agentDescription:
      'Commit a prepared dispatch job after the caller explicitly said yes to the readback. '
      + 'A repeat of the same token returns the same job.',
    async run(ctx, input, tx) {
      const consumed = await consumeToken(tx, ctx, input.confirmationToken, CREATE_JOB_PREPARE);
      if (isActionFailure(consumed)) return consumed;
      const parsed = createJobPrepareInput.safeParse(consumed.payload);
      if (!parsed.success) return actionFail('CONFIRMATION_INVALID', 'Stored proposal payload is not a dispatch job');
      const payload: CreateJobPrepareInput = parsed.data;
      const { formattedAddress, normalizedAddress } = formattedAndNormalized(payload);
      const repo = repoFor(tx, ctx.tenantId);
      await repo.lockAddress(normalizedAddress);
      const windowStart = new Date(payload.window.start);
      const windowEnd = new Date(payload.window.end);
      const existing = await repo.findDuplicate(normalizedAddress, windowStart, windowEnd);
      if (existing) {
        return actionOk({
          jobId: existing.id,
          window: windowOf(existing, ctx),
          duplicate: true,
        });
      }
      const job = await repo.insertJob({
        input: payload,
        formattedAddress,
        normalizedAddress,
        callId: ctx.callId ?? null,
        now: ctx.now,
      });
      await repo.insertEvent({
        jobId: job.id,
        eventType: 'created',
        toStatus: 'pending',
        performedBy: performedBy(ctx),
        notes: 'Job created',
        metadata: { source: CREATE_JOB_COMMIT, actor: ctx.actor.type },
        now: ctx.now,
      });
      return actionOk({
        jobId: job.id,
        window: windowOf(job, ctx),
        duplicate: false,
      });
    },
  });

  const updateStatusAction = defineAction({
    name: UPDATE_STATUS,
    tool: 'dispatch',
    kind: 'write',
    input: updateStatusInput,
    output: updateStatusOutput,
    permissions: { roles: DISPATCH_WRITE_ROLES, mcpScope: 'qvo:admin' },
    async run(ctx, input, tx) {
      const repo = repoFor(tx, ctx.tenantId);
      const job = await repo.getForUpdate(input.jobId);
      if (!job) return actionFail('NOT_FOUND', 'Job not found', { callerSafeMessage: NOT_FOUND_SAFE });
      if (!canTransition(job.status, input.status)) {
        return actionFail('CONFLICT', `Cannot transition from '${job.status}' to '${input.status}'`, {
          field: 'status',
          callerSafeMessage: "That status change isn't allowed.",
        });
      }
      const updated = await repo.updateStatus({
        jobId: job.id,
        fromStatus: job.status,
        toStatus: input.status,
        etaEnd: input.eta ? new Date(input.eta) : undefined,
        now: ctx.now,
      });
      if (!updated) {
        return actionFail('CONFLICT', `Cannot transition from '${job.status}' to '${input.status}'`, {
          field: 'status',
          callerSafeMessage: "That status change isn't allowed.",
        });
      }
      await repo.insertEvent({
        jobId: updated.id,
        eventType: 'status_change',
        fromStatus: job.status,
        toStatus: updated.status,
        performedBy: performedBy(ctx),
        notes: `Status changed to ${updated.status}`,
        metadata: input.eta ? { eta: input.eta } : {},
        now: ctx.now,
      });
      return actionOk({
        jobId: updated.id,
        status: updated.status,
        fromStatus: job.status,
      });
    },
  });

  const getJobStatusAction = defineAction({
    name: GET_JOB_STATUS,
    tool: 'dispatch',
    kind: 'read',
    input: getJobStatusInput,
    output: getJobStatusOutput,
    permissions: { agent: true, mcpScope: 'qvo:read' },
    agentDescription:
      "Look up the caller's field-service job. Send the phone the caller gives (or their caller ID) and the name "
      + 'on the job. Caller ID is checked on the server; a phone match alone returns nothing. Quote the status and '
      + 'arrival window, never an exact time, and never a job id.',
    async run(ctx, input, tx) {
      if (ctx.actor.type === 'agent') {
        const callerMatch = await matchCaller(tx, ctx, input.phone);
        if (!callerMatch) return hiddenNotFound();
      }
      const jobs = await repoFor(tx, ctx.tenantId).findByPhone(input.phone);
      const match = jobs.find((job) => namesMatch(input.name, job.contactName));
      if (!match) return hiddenNotFound();
      if (!isDispatchJobStatus(match.status)) return hiddenNotFound();
      return actionOk({
        status: match.status,
        window: windowOf(match, ctx),
      });
    },
  });

  return [createJobPrepareAction, createJobCommitAction, updateStatusAction, getJobStatusAction];
}

const defaults = createDispatchActions();

export const createJobPrepareAction = defaults[0];
export const createJobCommitAction = defaults[1];
export const updateStatusAction = defaults[2];
export const getJobStatusAction = defaults[3];
