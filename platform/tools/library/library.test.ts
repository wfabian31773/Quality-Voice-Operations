import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  TOOL_LIBRARY_NAMES,
  getToolLibraryEntry,
  listToolLibrary,
  toRolePackageTools,
} from './catalog';
import { executeSendEmail } from './handlers/sendEmail';
import { executeCreateTicket } from './handlers/createTicket';
import { executeCreateBooking, executeUpdateBooking } from './handlers/createBooking';
import { executeCreateDispatchJob } from './handlers/createDispatchJob';
import { registerToolLibrary, listRegisteredLibraryTools } from './registerToolLibrary';
import { globalToolRegistry } from '../registry';
import { unifiedToolRegistry } from '../ToolRegistry';

vi.mock('../../email/EmailService', () => ({
  sendEmail: vi.fn(async () => ({ success: true, messageId: 'msg-1' })),
}));

const { query, upcomingRows, transitionBooking } = vi.hoisted(() => {
  const upcomingRows: Array<Record<string, unknown>> = [];
  const transitionBooking = vi.fn(async () => ({
    ok: true,
    httpStatus: 200,
    body: { booking: { id: 'bk-existing' } },
  }));
  const query = vi.fn(async (sql: string) => {
    if (sql.includes('INSERT INTO tickets')) return { rows: [{ id: 'tk-1', ticket_number: 42 }] };
    if (sql.includes('INSERT INTO bookings')) return { rows: [{ id: 'bk-1' }] };
    if (sql.includes('INSERT INTO dispatch_jobs')) return { rows: [{ id: 'dj-1' }] };
    if (sql.includes('SELECT id, start_time, end_time, status, title')) {
      return { rows: upcomingRows };
    }
    if (sql.includes('UPDATE bookings')) return { rows: [{ id: 'bk-existing' }] };
    return { rows: [] };
  });
  return { query, upcomingRows, transitionBooking };
});

vi.mock('../../scheduling/bookingLifecycle', () => ({
  transitionBooking,
}));

vi.mock('../../../server/admin-api/routes/scheduling', () => ({
  getTenantTimezone: vi.fn(async () => 'America/New_York'),
  buildOverrideConflictResponse: vi.fn(async () => null),
}));

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
    query.mockClear();
    transitionBooking.mockClear();
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

    expect(result.success).toBe(false);
    expect(result.needsSelection).toBe(true);
    expect(result.candidates).toHaveLength(2);
    expect(result.candidates?.map((row) => row.title)).toEqual(['Haircut', 'Color']);
    expect(transitionBooking).not.toHaveBeenCalled();
  });

  it('asks the caller to confirm a single match before applying a change', async () => {
    const result = await executeUpdateBooking({ action: 'cancel' }, ctx);
    expect(result.success).toBe(false);
    expect(result.needsConfirmation).toBe(true);
    expect(result.bookingId).toBe('bk-existing');
    expect(transitionBooking).not.toHaveBeenCalled();
  });

  it('applies a confirmed cancel through the scheduling lifecycle, not a raw booking insert', async () => {
    await expect(executeUpdateBooking({
      action: 'cancel',
      confirmed: true,
      notes: 'Caller cannot make it',
    }, ctx)).resolves.toMatchObject({
      success: true,
      action: 'cancel',
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
    const sql = query.mock.calls.map((call) => String(call[0]));
    expect(sql.some((statement) => statement.includes('INSERT INTO bookings'))).toBe(false);
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
