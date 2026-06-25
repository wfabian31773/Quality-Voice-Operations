import { describe, it, expect, vi } from 'vitest';
import { EscalationController, type EscalationContext, type TwilioTransferAdapter } from './escalation';

const ctx: EscalationContext = {
  tenantId: 'tenant-1',
  callSessionId: 'cs-1',
  callSid: 'CA1',
  targetNumber: '+15559876543',
  reason: 'caller requested a human',
  patientName: 'Ada',
};

function adapter(result: { success: boolean; error?: string } | Error): TwilioTransferAdapter {
  return {
    initiateTransfer: vi.fn(async () => {
      if (result instanceof Error) throw result;
      return result;
    }),
  };
}

describe('EscalationController.escalateCall', () => {
  it('returns a connecting message when the transfer succeeds', async () => {
    const result = await new EscalationController(adapter({ success: true })).escalateCall(ctx);
    expect(result.success).toBe(true);
    expect(result.message).toContain('connecting you');
  });

  it('enqueues an escalation notification to the outbox on success', async () => {
    const outbox = { writeToOutbox: vi.fn(async (_msg: { tenantId: string; callSid: string; callLogId: string; payload: { type: string } }) => {}) };
    const result = await new EscalationController(
      adapter({ success: true }),
      outbox as unknown as ConstructorParameters<typeof EscalationController>[1],
    ).escalateCall(ctx);
    expect(result.success).toBe(true);
    expect(outbox.writeToOutbox).toHaveBeenCalledTimes(1);
    const payload = outbox.writeToOutbox.mock.calls[0][0];
    expect(payload).toMatchObject({ tenantId: 'tenant-1', callSid: 'CA1', callLogId: 'cs-1' });
    expect((payload.payload as { type: string }).type).toBe('escalation_notification');
  });

  it('still succeeds when the outbox write throws', async () => {
    const outbox = { writeToOutbox: vi.fn(async () => { throw new Error('outbox down'); }) };
    const result = await new EscalationController(
      adapter({ success: true }),
      outbox as unknown as ConstructorParameters<typeof EscalationController>[1],
    ).escalateCall(ctx);
    expect(result.success).toBe(true);
  });

  it('returns a graceful fallback when the transfer reports failure', async () => {
    const result = await new EscalationController(adapter({ success: false })).escalateCall(ctx);
    expect(result.success).toBe(false);
    expect(result.message).toContain('unable to reach');
  });

  it('returns a graceful fallback when the transfer throws', async () => {
    const result = await new EscalationController(adapter(new Error('twilio exploded'))).escalateCall(ctx);
    expect(result.success).toBe(false);
    expect(result.message).toContain('issue connecting');
  });
});
