import { describe, expect, it, vi } from 'vitest';
import { resolveHumanEscalationRoute } from './openaiSession';

describe('resolveHumanEscalationRoute', () => {
  it('hands a workforce-only human request to onHandoff and never calls onEscalation', async () => {
    const onEscalation = vi.fn(async () => {});
    const onHandoff = vi.fn(async () => ({ success: true, message: 'Transferring you now.' }));

    const resolved = await resolveHumanEscalationRoute({
      hasOnCallNumber: false,
      onEscalation,
      onHandoff,
      callSessionId: 'cs-1',
      callSid: 'CA1',
      reason: 'Caller asked for a person',
    });

    expect(resolved.route).toBe('handoff');
    expect(resolved.handoff?.message).toBe('Transferring you now.');
    expect(onHandoff).toHaveBeenCalledWith('cs-1', 'human_request', 'Caller asked for a person');
    expect(onEscalation).not.toHaveBeenCalled();
  });

  it('offers a ticket when the workforce handoff fails so the caller is not left in silence', async () => {
    const resolved = await resolveHumanEscalationRoute({
      hasOnCallNumber: false,
      onEscalation: vi.fn(async () => {}),
      onHandoff: vi.fn(async () => ({ success: false, message: 'No teammate available.' })),
      callSessionId: 'cs-1',
      callSid: 'CA1',
      reason: 'Caller asked for a person',
    });

    expect(resolved.route).toBe('ticket');
  });

  it('offers a ticket when there is no handoff and no on-call number', async () => {
    const onEscalation = vi.fn(async () => {});
    const resolved = await resolveHumanEscalationRoute({
      hasOnCallNumber: false,
      onEscalation,
      callSessionId: 'cs-1',
      callSid: 'CA1',
      reason: 'Caller asked for a person',
    });

    expect(resolved.route).toBe('ticket');
    expect(onEscalation).not.toHaveBeenCalled();
  });

  it('uses the on-call phone path when a transfer number exists', async () => {
    const onEscalation = vi.fn(async () => {});
    const onHandoff = vi.fn(async () => ({ success: true, message: 'unused' }));
    const resolved = await resolveHumanEscalationRoute({
      hasOnCallNumber: true,
      onEscalation,
      onHandoff,
      callSessionId: 'cs-1',
      callSid: 'CA1',
      reason: 'Caller asked for a person',
    });

    expect(resolved.route).toBe('phone');
    expect(onEscalation).toHaveBeenCalledTimes(1);
    expect(onHandoff).not.toHaveBeenCalled();
  });
});
