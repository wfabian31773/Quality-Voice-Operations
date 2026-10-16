import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  TOOL_LIBRARY_NAMES,
  getToolLibraryEntry,
  listToolLibrary,
  toRolePackageTools,
} from './catalog';
import { executeSendEmail } from './handlers/sendEmail';
import { executeCreateTicket } from './handlers/createTicket';
import { executeCreateBooking, executeUpdateBooking, isPendingBookingChallenge } from './handlers/createBooking';
import { resetBookingConfirmations } from './handlers/bookingConfirmation';
import { executeCreateDispatchJob } from './handlers/createDispatchJob';
import { registerToolLibrary, listRegisteredLibraryTools } from './registerToolLibrary';
import { globalToolRegistry } from '../registry';
import { unifiedToolRegistry } from '../ToolRegistry';
import { ReasoningEngine } from '../../reasoning/ReasoningEngine';

function assertGatewayDeliversToModel(jsonResult: string): Record<string, unknown> {
  const parsed = JSON.parse(jsonResult) as { success?: boolean; message?: string };
  if (parsed && typeof parsed === 'object' && parsed.success === false) {
    throw new Error(`ToolExecutionFailed: ${parsed.message || 'Tool returned success: false'}`);
  }
  return parsed as Record<string, unknown>;
}

vi.mock('../../email/EmailService', () => ({
  sendEmail: vi.fn(async () => ({ success: true, messageId: 'msg-1' })),
}));

const { query, upcomingRows, transitionBooking, defaultQuery } = vi.hoisted(() => {
  const upcomingRows: Array<Record<string, unknown>> = [];
  const transitionBooking = vi.fn(async () => ({
    ok: true,
    httpStatus: 200,
    body: { booking: { id: 'bk-existing' } },
  }));
  const defaultQuery = async (sql: string) => {
    if (sql.includes('INSERT INTO tickets')) return { rows: [{ id: 'tk-1', ticket_number: 42 }] };
    if (sql.includes('INSERT INTO bookings')) return { rows: [{ id: 'bk-1' }] };
    if (sql.includes('INSERT INTO dispatch_jobs')) return { rows: [{ id: 'dj-1' }] };
    if (sql.includes('SELECT id, start_time, end_time, status, title')) {
      return { rows: upcomingRows };
    }
    if (sql.includes('UPDATE bookings')) return { rows: [{ id: 'bk-existing' }] };
    return { rows: [] };
  };
  const query = vi.fn(defaultQuery);
  return { query, upcomingRows, transitionBooking, defaultQuery };
});

vi.mock('../../scheduling/bookingLifecycle', () => ({
  transitionBooking,
}));

vi.mock('../../../server/admin-api/routes/scheduling', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../server/admin-api/routes/scheduling')>();
  return {
    ...actual,
    getTenantTimezone: vi.fn(async () => 'America/New_York'),
    buildOverrideConflictResponse: vi.fn(async () => null),
  };
});

vi.mock('../../db', () => {
  return {
    getPlatformPool: () => ({
      connect: async () => ({
        query,
        release: () => {},
      }),
    }),
    withTenantContext: async (_client: unknown, _tenantId: string, fn: () => Promise<unknown>) => fn(),
  };
});

describe('tool library catalog', () => {
  it('exposes the day-to-day operations chest', () => {
    expect(TOOL_LIBRARY_NAMES).toEqual(expect.arrayContaining([
      'send_sms',
      'send_email',
      'create_ticket',
      'create_booking',
      'update_booking',
      'create_dispatch_job',
      'lookup_customer',
      'retrieve_knowledge',
      'escalate_to_human',
    ]));
    expect(listToolLibrary('sms').map((tool) => tool.name)).toEqual(['send_sms']);
    expect(getToolLibraryEntry('create_ticket')?.category).toBe('tickets');
  });

  it('projects selected tools into role-package shape', () => {
    const tools = toRolePackageTools(['send_sms', 'create_ticket']);
    expect(tools).toHaveLength(2);
    expect(tools[0]).toMatchObject({ name: 'send_sms' });
    expect(tools[1].parameters.required).toEqual(expect.arrayContaining(['subject', 'description']));
  });
});

describe('tool library handlers', () => {
  const ctx = { tenantId: 't-lib', callLogId: 'cs-1', callSid: 'CA1', callerNumber: '+15551230000' };

  beforeEach(() => {
    query.mockReset();
    query.mockImplementation(defaultQuery);
    transitionBooking.mockClear();
    resetBookingConfirmations();
    upcomingRows.splice(0, upcomingRows.length, {
      id: 'bk-existing',
      start_time: '2026-10-20T15:00:00.000Z',
      end_time: '2026-10-20T15:30:00.000Z',
      status: 'pending',
      title: 'Haircut',
    });
  });

  it('sends email through the platform email service', async () => {
    const result = await executeSendEmail({
      to: 'owner@example.com',
      subject: 'Missed call',
      body: 'Please call the shop back.',
    }, ctx);
    expect(result.success).toBe(true);
    expect(result.messageId).toBe('msg-1');
  });

  it('creates a ticket, booking, and dispatch job', async () => {
    await expect(executeCreateTicket({
      subject: 'Lockout',
      description: 'Customer locked out of storefront',
      contactName: 'Ada Cole',
      contactPhone: '+15551230000',
    }, ctx)).resolves.toMatchObject({ success: true, ticketId: 'tk-1' });

    await expect(executeCreateBooking({
      title: 'Estimate',
      startTime: '2026-09-01T15:00:00.000Z',
      contactName: 'Ada Cole',
      contactPhone: '+15551230000',
    }, ctx)).resolves.toMatchObject({ success: true, bookingId: 'bk-1' });

    await expect(executeCreateDispatchJob({
      title: 'Emergency unlock',
      description: 'Front door will not open',
      contactName: 'Ada Cole',
      contactPhone: '+15551230000',
      address: '100 Main St',
    }, ctx)).resolves.toMatchObject({ success: true, jobId: 'dj-1' });
  });

  it('rejects incomplete booking input', async () => {
    const result = await executeCreateBooking({
      title: 'Estimate',
      contactName: 'Ada',
      contactPhone: '+15551230000',
    }, ctx);
    expect(result.success).toBe(false);
  });

  it('lists every upcoming booking when more than one matches and does not change anything', async () => {
    upcomingRows.push({
      id: 'bk-later',
      start_time: '2026-10-22T18:00:00.000Z',
      end_time: '2026-10-22T18:30:00.000Z',
      status: 'confirmed',
      title: 'Color',
    });

    const result = await executeUpdateBooking({
      action: 'cancel',
      confirmed: true,
    }, ctx);

    expect(result.success).toBe(true);
    expect(result.pending).toBe(true);
    expect(result.status).toBe('needs_selection');
    expect(result.needsSelection).toBe(true);
    expect(result.candidates).toHaveLength(2);
    expect(result.candidates?.map((row) => row.title)).toEqual(['Haircut', 'Color']);
    expect(transitionBooking).not.toHaveBeenCalled();
  });

  it('asks the caller to confirm a single match before applying a change', async () => {
    const result = await executeUpdateBooking({ action: 'cancel' }, ctx);
    expect(result.success).toBe(true);
    expect(result.pending).toBe(true);
    expect(result.status).toBe('needs_confirmation');
    expect(result.needsConfirmation).toBe(true);
    expect(result.bookingId).toBe('bk-existing');
    expect(result.confirmationToken).toEqual(expect.any(String));
    expect(transitionBooking).not.toHaveBeenCalled();
  });

  it('does not apply when the model sends confirmed:true on the first call', async () => {
    const result = await executeUpdateBooking({
      action: 'cancel',
      confirmed: true,
      notes: 'Caller cannot make it',
    }, ctx);
    expect(result.success).toBe(true);
    expect(result.needsConfirmation).toBe(true);
    expect(result.status).toBe('needs_confirmation');
    expect(transitionBooking).not.toHaveBeenCalled();
  });

  it('delivers the confirmation challenge to the model without treating it as a tool error', async () => {
    const result = await executeUpdateBooking({ action: 'cancel' }, ctx);
    const delivered = assertGatewayDeliversToModel(JSON.stringify(result));
    expect(delivered.success).toBe(true);
    expect(delivered.needsConfirmation).toBe(true);
    expect(delivered.confirmationToken).toEqual(expect.any(String));
    expect(delivered.candidates).toEqual([
      expect.objectContaining({ bookingId: 'bk-existing', title: 'Haircut' }),
    ]);
    expect(String(delivered.message)).toMatch(/confirm/i);
    expect(String(delivered.message)).toContain(String(delivered.confirmationToken));
    expect(transitionBooking).not.toHaveBeenCalled();
  });

  it('applies cancel only after a later call presents the server-issued token', async () => {
    const challenge = await executeUpdateBooking({ action: 'cancel' }, ctx);
    expect(challenge.confirmationToken).toBeTruthy();
    expect(transitionBooking).not.toHaveBeenCalled();

    const sideEffect = vi.fn();
    transitionBooking.mockResolvedValueOnce({
      ok: true,
      httpStatus: 200,
      body: { booking: { id: 'bk-existing' } },
      afterCommit: [sideEffect],
    });

    await expect(executeUpdateBooking({
      action: 'cancel',
      bookingId: challenge.bookingId,
      confirmationToken: challenge.confirmationToken,
      notes: 'Caller cannot make it',
    }, ctx)).resolves.toMatchObject({
      success: true,
      action: 'cancel',
      status: 'updated',
      bookingId: 'bk-existing',
    });

    expect(transitionBooking).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        tenantId: 't-lib',
        bookingId: 'bk-existing',
        action: 'cancel',
      }),
      expect.anything(),
    );
    expect(sideEffect).toHaveBeenCalledTimes(1);
    const sql = query.mock.calls.map((call) => String(call[0]));
    expect(sql.some((statement) => statement.includes('INSERT INTO bookings'))).toBe(false);
    const begin = sql.findIndex((statement) => statement === 'BEGIN');
    const select = sql.findIndex((statement) => statement.includes('SELECT id, start_time, end_time, status, title'));
    const commit = sql.findIndex((statement) => statement === 'COMMIT');
    expect(begin).toBeGreaterThanOrEqual(0);
    expect(select).toBeGreaterThan(begin);
    expect(commit).toBeGreaterThan(select);
  });

  it('does not fire deferred side effects when COMMIT rolls back', async () => {
    const sideEffect = vi.fn();
    transitionBooking.mockResolvedValueOnce({
      ok: true,
      httpStatus: 200,
      body: { booking: { id: 'bk-existing' } },
      afterCommit: [sideEffect],
    });
    const challenge = await executeUpdateBooking({ action: 'cancel' }, ctx);
    query.mockImplementation(async (sql: string) => {
      if (sql === 'COMMIT') throw new Error('commit failed');
      if (sql.includes('SELECT id, start_time, end_time, status, title')) return { rows: upcomingRows };
      return { rows: [] };
    });

    const result = await executeUpdateBooking({
      action: 'cancel',
      bookingId: challenge.bookingId,
      confirmationToken: challenge.confirmationToken,
    }, ctx);

    expect(result.success).toBe(false);
    expect(sideEffect).not.toHaveBeenCalled();
    expect(query.mock.calls.some(([sql]) => String(sql) === 'ROLLBACK')).toBe(true);
  });

  it('interprets an offset-less reschedule time in the tenant timezone', async () => {
    const challenge = await executeUpdateBooking({
      action: 'reschedule',
      startTime: '2026-10-20T14:00:00',
    }, ctx);
    expect(challenge.pending).toBe(true);

    await expect(executeUpdateBooking({
      action: 'reschedule',
      startTime: '2026-10-20T14:00:00',
      bookingId: challenge.bookingId,
      confirmationToken: challenge.confirmationToken,
    }, ctx)).resolves.toMatchObject({ success: true, status: 'updated' });

    expect(transitionBooking).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'reschedule',
        newStartTime: '2026-10-20T18:00:00.000Z',
        newEndTime: '2026-10-20T18:30:00.000Z',
      }),
      expect.objectContaining({ deferSideEffects: true }),
    );
  });

  it('keeps the confirm-token call authorized after a pending challenge', async () => {
    const engine = new ReasoningEngine({
      tenantId: 't-lib',
      callSessionId: 'cs-1',
      callSid: 'CA1',
      agentSlug: 'salon-agent',
      vertical: 'salon',
      callerNumber: '+15551230000',
      toolsAvailable: ['create_booking', 'update_booking', 'create_ticket'],
      humanTransferAvailable: false,
      memoryStorage: null,
    });
    const classified = engine.classifyIntent('I need to cancel my appointment, this is Jordan');
    const firstDecision = engine.processUtterance(
      'I need to cancel my appointment, this is Jordan',
      classified.intent,
      classified.confidence,
    );
    expect(firstDecision.toolToExecute).toBe('update_booking');

    const firstArgs = { action: 'cancel', contactName: 'Jordan' };
    expect(engine.authorizeToolRequest('update_booking', firstArgs).allowed).toBe(true);

    const challenge = await executeUpdateBooking(firstArgs, ctx);
    expect(isPendingBookingChallenge(challenge)).toBe(true);
    expect(challenge.pending).toBe(true);
    expect(engine.getCurrentWorkflowStepTool()).toBe('update_booking');
    expect(engine.getWorkflowPlan()?.status).toBe('active');

    const confirmArgs = {
      action: 'cancel',
      bookingId: challenge.bookingId,
      confirmationToken: challenge.confirmationToken,
      contactName: 'Jordan',
    };
    expect(engine.authorizeToolRequest('update_booking', confirmArgs).allowed).toBe(true);

    const applied = await executeUpdateBooking(confirmArgs, ctx);
    expect(applied.status).toBe('updated');
    expect(applied.success).toBe(true);
    expect(isPendingBookingChallenge(applied)).toBe(false);

    const finished = new ReasoningEngine({
      tenantId: 't-lib',
      callSessionId: 'cs-finished',
      callSid: 'CA-finished',
      agentSlug: 'salon-agent',
      vertical: 'salon',
      callerNumber: '+15551230000',
      toolsAvailable: ['create_booking', 'update_booking', 'create_ticket'],
      humanTransferAvailable: false,
      memoryStorage: null,
    });
    finished.processUtterance(
      'I need to cancel my appointment, this is Jordan',
      'reschedule_cancel',
      'high',
    );
    finished.handleToolSuccess('update_booking');
    const afterChallengeTreatedAsDone = finished.processUtterance(
      'yes, cancel that haircut',
      'reschedule_cancel',
      'high',
    );
    expect(afterChallengeTreatedAsDone.action).toBe('complete_interaction');
    expect(finished.authorizeToolRequest('update_booking', confirmArgs).allowed).toBe(false);
  });
});

describe('registerToolLibrary', () => {
  beforeEach(() => {
    registerToolLibrary();
  });

  it('registers executable handlers on both registries', () => {
    expect(listRegisteredLibraryTools()).toEqual(expect.arrayContaining([
      'send_sms',
      'send_email',
      'create_ticket',
      'create_booking',
      'update_booking',
      'create_dispatch_job',
    ]));
    expect(globalToolRegistry.get('create_ticket')).toBeDefined();
    expect(globalToolRegistry.get('update_booking')).toBeDefined();
    expect(unifiedToolRegistry.getEnhanced('send_sms')).toBeDefined();
  });
});
