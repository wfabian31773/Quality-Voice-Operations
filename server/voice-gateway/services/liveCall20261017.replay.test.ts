// @vitest-environment node
/**
 * Voice-gateway side of the Oct 17 2026 test-call replay: the salon prompt
 * the call loads, and create_booking through the same retry + result-check
 * path openaiSession uses, against the scratch Postgres. Fake caller number.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { createScratchDatabase, probePostgres, type ScratchDatabase } from '../../../platform/tools/testing/scratchPostgres';

const h = vi.hoisted(() => ({ pool: null as Pool | null }));
vi.mock('../../../platform/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../platform/db')>()),
  getPlatformPool: () => {
    if (!h.pool) throw new Error('scratch pool not ready');
    return h.pool;
  },
}));

const { loadAgentConfig } = await import('./agentLoader');
const { assertToolResultSucceeded } = await import('./openaiSession');
const { buildMessageFallbackInstruction } = await import('./messageFallbackInstruction');
const { executeWithRetry } = await import('../../../platform/tools/RetryOrchestrator');
const { buildFallbackResponse } = await import('../../../platform/tools/ConversationFallbackService');
const { createBookingTool } = await import('../../../platform/tools/library/handlers/createBooking');
const { bindSessionToolArgs } = await import('../../../platform/reasoning/sessionBinding');

const CALLER = '+15555550100';
const fast = { baseDelayMs: 1, maxDelayMs: 2, timeoutMs: 5000, maxRetries: 2 };

describe('Oct 17 replay: the salon prompt the call loads', () => {
  it('(b) offers the caller ID by its last four digits only, on top of the tenant prompt', () => {
    const cfg = loadAgentConfig({
      tenantId: 'demo' as never,
      agentId: 'sharp-line-front-desk',
      agentType: 'salon',
      callerPhone: CALLER,
      dbAgent: {
        name: 'Sharp Line Barbers - Front Desk',
        system_prompt: 'You are the front desk at Sharp Line Barbers. Fade 45 min. Offer to use the number they are calling from.',
        metadata: { businessName: 'Sharp Line Barbers' },
      },
    });
    expect(cfg.systemPrompt).toContain('Fade 45 min');
    expect(cfg.systemPrompt).toContain('number ending in 0100');
    expect(cfg.systemPrompt).not.toMatch(/555.?555.?0100/);
    expect(cfg.systemPrompt).toContain('Call create_ticket only after the caller says yes');
  });
});

const dbReachable = await probePostgres();

describe.skipIf(!dbReachable)('Oct 17 replay: create_booking on the live tool path (real Postgres)', () => {
  let db: ScratchDatabase;
  let tenantId: string;

  beforeAll(async () => {
    db = await createScratchDatabase('qvo_callfix_replay');
    h.pool = db.app;
    tenantId = randomUUID();
    await db.admin.query(
      `INSERT INTO tenants (id, name, slug, status, timezone) VALUES ($1, 'Demo Organization', $2, 'active', 'America/New_York')`,
      [tenantId, `demo-${tenantId.slice(0, 8)}`],
    );
  }, 600_000);

  afterAll(async () => {
    h.pool = null;
    await db?.drop();
  }, 60_000);

  /** openaiSession's default branch: bind args, run the handler, check the result, retry per policy. */
  async function runCreateBooking(forTenant: string, rawArgs: Record<string, unknown>) {
    const bound = bindSessionToolArgs(rawArgs, { tenantId: forTenant, agentId: 'agent', callerNumber: CALLER, transcript: '' });
    expect(bound.ok).toBe(true);
    let calls = 0;
    const res = await executeWithRetry(async () => {
      calls += 1;
      const result = await createBookingTool.handler(bound.args, { tenantId: forTenant, callLogId: 'cs-replay', callerNumber: CALLER });
      return assertToolResultSucceeded(JSON.stringify(result));
    }, { tenantId: forTenant, toolName: 'create_booking', callSessionId: 'cs-replay', retryConfig: fast });
    return { res, calls };
  }

  it('(d) after the readback, create_booking stores a pending request in one attempt with the caller ID', async () => {
    const { res, calls } = await runCreateBooking(tenantId, {
      title: 'Fade',
      startTime: '2026-10-24T09:00:00-04:00',
      durationMinutes: 45,
      contactName: 'Wayne',
      contactPhone: '',
    });
    expect(res.success).toBe(true);
    expect(calls).toBe(1);
    const result = JSON.parse(res.result!);
    expect(result.success).toBe(true);
    expect(result.message).toMatch(/pending/i);
    const { rows } = await db.admin.query(`SELECT status, contact_phone, end_time - start_time AS len FROM bookings WHERE id = $1`, [result.bookingId]);
    expect(rows[0]).toMatchObject({ status: 'pending', contact_phone: CALLER });
    expect(rows[0].len).toMatchObject({ minutes: 45 });
  });

  it('(e) a deterministic DB failure fails fast, and the fallback offers a message with no time promise', async () => {
    // A tenant id with no tenants row: the insert hits a foreign-key
    // violation (SQLSTATE 23503), deterministic like Oct 17's 42P18.
    const { res, calls } = await runCreateBooking(randomUUID(), {
      title: 'Fade', startTime: '2026-10-24T09:00:00-04:00', contactName: 'Wayne', contactPhone: '',
    });
    expect(res.success).toBe(false);
    expect(calls).toBe(1);
    expect(res.attempts).toBe(1);

    const fallback = buildFallbackResponse(tenantId, 'create_booking', 'cs-replay', res.error ?? '');
    expect(fallback.message).toBe("I wasn't able to finish that right now. I can leave a message for the team so they can follow up.");
    expect(fallback.message).not.toMatch(/within the hour/i);
    const instruction = buildMessageFallbackInstruction('create_ticket');
    expect(instruction).toContain('Only if the caller says yes, call create_ticket');
  });
});
