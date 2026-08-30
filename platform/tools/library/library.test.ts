import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  TOOL_LIBRARY_NAMES,
  getToolLibraryEntry,
  listToolLibrary,
  toRolePackageTools,
} from './catalog';
import { executeSendEmail } from './handlers/sendEmail';
import { executeCreateTicket } from './handlers/createTicket';
import { executeCreateBooking } from './handlers/createBooking';
import { executeCreateDispatchJob } from './handlers/createDispatchJob';
import { registerToolLibrary, listRegisteredLibraryTools } from './registerToolLibrary';
import { globalToolRegistry } from '../registry';
import { unifiedToolRegistry } from '../ToolRegistry';

vi.mock('../../email/EmailService', () => ({
  sendEmail: vi.fn(async () => ({ success: true, messageId: 'msg-1' })),
}));

vi.mock('../../db', () => {
  const query = vi.fn(async (sql: string) => {
    if (sql.includes('INSERT INTO tickets')) return { rows: [{ id: 'tk-1', ticket_number: 42 }] };
    if (sql.includes('INSERT INTO bookings')) return { rows: [{ id: 'bk-1' }] };
    if (sql.includes('INSERT INTO dispatch_jobs')) return { rows: [{ id: 'dj-1' }] };
    return { rows: [] };
  });
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
  const ctx = { tenantId: 't-lib', callLogId: 'cs-1', callSid: 'CA1' };

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
      'create_dispatch_job',
    ]));
    expect(globalToolRegistry.get('create_ticket')).toBeDefined();
    expect(unifiedToolRegistry.getEnhanced('send_sms')).toBeDefined();
  });
});
