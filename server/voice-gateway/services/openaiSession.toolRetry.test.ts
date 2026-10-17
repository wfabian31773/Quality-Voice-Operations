import { describe, expect, it } from 'vitest';
import { executeWithRetry } from '../../../platform/tools/RetryOrchestrator';
import { assertToolResultSucceeded } from './openaiSession';

const fast = { baseDelayMs: 1, maxDelayMs: 2, timeoutMs: 1000, maxRetries: 2 };

async function attemptsFor(result: Record<string, unknown>): Promise<number> {
  let calls = 0;
  const res = await executeWithRetry(async () => {
    calls += 1;
    return assertToolResultSucceeded(JSON.stringify(result));
  }, { tenantId: 't', toolName: 'create_booking', callSessionId: 'cs', retryConfig: fast });
  expect(res.success).toBe(false);
  expect(res.attempts).toBe(calls);
  return calls;
}

describe('tool result → retry classification (live tool path)', () => {
  it('passes a successful result through unchanged', () => {
    const raw = JSON.stringify({ success: true, bookingId: 'b1' });
    expect(assertToolResultSucceeded(raw)).toBe(raw);
    expect(assertToolResultSucceeded('not json')).toBe('not json');
  });

  it('fails fast on a handler result marked retryable:false (deterministic SQL error, validation)', async () => {
    expect(await attemptsFor({
      success: false,
      retryable: false,
      message: 'Failed to store the booking request. Offer to try again or escalate.',
    })).toBe(1);
    expect(await attemptsFor({ success: false, retryable: false, message: 'startTime must be a valid ISO-8601 timestamp.' })).toBe(1);
  });

  it('keeps the retries for a failure the handler could not classify', async () => {
    expect(await attemptsFor({ success: false, message: 'Failed to create the ticket.' })).toBe(3);
    expect(await attemptsFor({ success: false, retryable: true, message: 'Upstream timed out.' })).toBe(3);
  });
});
