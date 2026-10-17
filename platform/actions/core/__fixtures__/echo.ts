import { z } from 'zod';
import { defineAction } from '../defineAction';
import { actionOk, isActionFailure } from '../errors';
import { consumeProposal, createProposal } from '../proposals';

export const echoInput = z.object({
  message: z.string().min(1),
  phone: z.string().optional(),
});

export const echoOutput = z.object({
  echoed: z.string(),
});

export interface EchoSideEffect {
  count: number;
}

export function createEchoReadAction() {
  return defineAction({
    name: 'core.echo.read',
    tool: 'business',
    kind: 'read',
    input: echoInput,
    output: echoOutput,
    permissions: { roles: ['owner', 'manager'], agent: true, mcpScope: 'qvo:read' },
    agentDescription: 'Echo a message. Fixture used only in tests.',
    async run(_ctx, input) {
      return actionOk({ echoed: input.message });
    },
  });
}

export function createEchoWriteAction(sideEffect: EchoSideEffect) {
  return defineAction({
    name: 'core.echo.write',
    tool: 'business',
    kind: 'write',
    input: echoInput,
    output: echoOutput,
    permissions: { roles: ['owner', 'manager'], agent: true, mcpScope: 'qvo:admin' },
    agentDescription: 'Echo a message as a write. Fixture used only in tests.',
    async run(_ctx, input) {
      sideEffect.count += 1;
      return actionOk({ echoed: input.message });
    },
  });
}

const prepareOutput = z.object({
  confirmationToken: z.string(),
  expiresAt: z.string(),
  readback: z.string(),
  payloadHash: z.string(),
});

export function createEchoPrepareAction() {
  return defineAction({
    name: 'core.echo.prepare',
    tool: 'business',
    kind: 'prepare',
    input: echoInput,
    output: prepareOutput,
    permissions: { roles: ['owner', 'manager'], agent: true, mcpScope: 'qvo:admin' },
    agentDescription: 'Prepare an echo confirmation. Fixture used only in tests.',
    async run(ctx, input, tx) {
      const readback = `I'll echo "${input.message}"${input.phone ? `, and call the number ending ${input.phone.slice(-4)}` : ''}.`;
      const proposal = await createProposal(tx, ctx, {
        action: 'core.echo.prepare',
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
}

const commitInput = z.object({
  confirmationToken: z.string().uuid(),
  payloadHash: z.string().length(64),
});

export function createEchoCommitAction(sideEffect: EchoSideEffect) {
  return defineAction({
    name: 'core.echo.commit',
    tool: 'business',
    kind: 'commit',
    input: commitInput,
    output: echoOutput,
    permissions: { roles: ['owner', 'manager'], agent: true, mcpScope: 'qvo:admin' },
    agentDescription: 'Commit an echo confirmation. Fixture used only in tests.',
    async run(ctx, input, tx) {
      const consumed = await consumeProposal(tx, ctx, {
        confirmationToken: input.confirmationToken,
        action: 'core.echo.prepare',
        payloadHash: input.payloadHash,
        callId: ctx.callId,
      });
      if (isActionFailure(consumed)) return consumed;
      const payload = consumed.payload as { message: string };
      sideEffect.count += 1;
      return actionOk({ echoed: payload.message });
    },
  });
}
