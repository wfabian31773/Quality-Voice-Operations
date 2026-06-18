import { describe, it, expect, vi, beforeEach } from 'vitest';

const a = vi.hoisted(() => ({ poolQueryMock: vi.fn(), getSalesAlertSettingsMock: vi.fn() }));

vi.mock('../../../platform/db', () => ({ getPlatformPool: () => ({ query: a.poolQueryMock }) }));
vi.mock('../../../platform/core/logger', () => ({ createLogger: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn() }) }));
vi.mock('../../../platform/messaging/SlackWebhookNotifier', () => ({ postToOpsSlackWebhook: vi.fn().mockResolvedValue(undefined), getOpsSlackWebhookUrl: () => null }));
vi.mock('../../../platform/email/EmailService', () => ({ sendEmail: vi.fn().mockResolvedValue({ success: true }) }));
vi.mock('./sales-alert-settings', () => ({
  getSalesAlertSettings: a.getSalesAlertSettingsMock,
  getSalesInboxDeepLink: () => 'https://admin/sales-inbox',
}));

import {
  listLeadEventAuthors, listLeadEvents, listLeads, updateLeadStatus, recordLead, findLeadById,
} from './marketing-leads';

// Default query handler: DDL + event inserts are no-ops; specific SELECT/UPDATE
// branches are layered per test via mockImplementation.
function baseQuery(sql: string): { rows: unknown[]; rowCount: number } | null {
  if (/CREATE TABLE|ALTER TABLE|CREATE INDEX/i.test(sql)) return { rows: [], rowCount: 0 };
  if (/INSERT INTO marketing_lead_events/i.test(sql)) return { rows: [{ id: '1' }], rowCount: 1 };
  return null;
}

beforeEach(() => {
  a.poolQueryMock.mockReset().mockImplementation(async (sql: string) => baseQuery(sql) ?? { rows: [], rowCount: 0 });
  a.getSalesAlertSettingsMock.mockReset().mockResolvedValue({
    channels: { email: false, slack: false }, emailRecipients: [], slackWebhookUrl: null,
    notifyOnNewLead: false, notifyOnBookingCreated: false, notifyOnBookingRescheduled: false, notifyOnBookingCancelled: false,
  });
});

describe('listLeadEventAuthors', () => {
  it('returns the distinct author list', async () => {
    a.poolQueryMock.mockImplementation(async (sql: string) =>
      baseQuery(sql) ?? (sql.includes('DISTINCT author') ? { rows: [{ author: 'alice' }, { author: 'bob' }], rowCount: 2 } : { rows: [], rowCount: 0 }),
    );
    expect(await listLeadEventAuthors()).toEqual(['alice', 'bob']);
  });
});

describe('listLeadEvents', () => {
  it('maps event rows and normalises dates', async () => {
    a.poolQueryMock.mockImplementation(async (sql: string) =>
      baseQuery(sql) ?? (sql.includes('FROM marketing_lead_events') ? {
        rows: [{ id: '7', lead_id: '3', event_type: 'status_change', previous_status: 'new', new_status: 'contacted', notes: 'called', author: 'alice', created_at: '2026-01-01T00:00:00Z' }],
        rowCount: 1,
      } : { rows: [], rowCount: 0 }),
    );
    const events = await listLeadEvents(3);
    expect(events[0]).toMatchObject({ id: 7, lead_id: 3, event_type: 'status_change', new_status: 'contacted' });
    expect(events[0].created_at).toBe('2026-01-01T00:00:00.000Z');
  });
});

describe('listLeads', () => {
  it('returns leads, total, and aggregated counts', async () => {
    a.poolQueryMock.mockImplementation(async (sql: string) => {
      const base = baseQuery(sql);
      if (base) return base;
      if (sql.includes('LEFT JOIN LATERAL')) return { rows: [{ id: '1', source: 'book_demo', name: 'Ada', email: 'ada@x.com', company: 'X', phone: null, payload: {}, notified: false, status: 'new', status_notes: null, status_updated_at: null, status_updated_by: null, created_at: '2026-01-01T00:00:00Z', event_authors: [], last_event_at: null, last_event_author: null }], rowCount: 1 };
      if (sql.includes('COUNT(*)::int AS total FROM marketing_leads')) return { rows: [{ total: 1 }], rowCount: 1 };
      if (sql.includes('status_new')) return { rows: [{ total: 1, status_new: 1, status_contacted: 0, status_closed: 0, source_book_demo: 1, source_roi_calculator: 0, source_contact: 0, booked: 0, cancelled: 0, no_booking: 1 }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });
    const res = await listLeads({ limit: 10 });
    expect(res.total).toBe(1);
    expect(res.leads[0]).toMatchObject({ id: 1, email: 'ada@x.com', source: 'book_demo' });
    expect(res.counts.by_status.new).toBe(1);
    expect(res.counts.by_source.book_demo).toBe(1);
  });
});

describe('updateLeadStatus', () => {
  it('returns null when the lead does not exist', async () => {
    a.poolQueryMock.mockImplementation(async (sql: string) =>
      baseQuery(sql) ?? (sql.includes('SELECT status, status_notes') ? { rows: [], rowCount: 0 } : { rows: [], rowCount: 0 }),
    );
    expect(await updateLeadStatus(99, 'contacted')).toBeNull();
  });
  it('updates the status and returns the lead', async () => {
    a.poolQueryMock.mockImplementation(async (sql: string) => {
      const base = baseQuery(sql);
      if (base) return base;
      if (sql.includes('SELECT status, status_notes')) return { rows: [{ status: 'new', status_notes: null }], rowCount: 1 };
      if (sql.includes('UPDATE marketing_leads')) return { rows: [{ id: '5', source: 'contact', name: 'B', email: 'b@x.com', company: null, phone: null, payload: {}, notified: false, status: 'contacted', status_notes: 'reached out', status_updated_at: '2026-01-02T00:00:00Z', status_updated_by: 'admin', created_at: '2026-01-01T00:00:00Z' }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });
    const lead = await updateLeadStatus(5, 'contacted', { notes: 'reached out', updatedBy: 'admin' });
    expect(lead).toMatchObject({ id: 5, status: 'contacted', status_updated_by: 'admin' });
  });
});

describe('recordLead', () => {
  it('inserts and returns the new id', async () => {
    a.poolQueryMock.mockImplementation(async (sql: string) => {
      const base = baseQuery(sql);
      if (base) return base;
      if (sql.includes('INSERT INTO marketing_leads')) return { rows: [{ id: '11' }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });
    expect(await recordLead({ source: 'contact', name: 'C', email: 'c@x.com', company: null, phone: null, payload: {} } as never)).toEqual({ id: 11 });
  });
  it('returns id null when the insert fails', async () => {
    a.poolQueryMock.mockImplementation(async (sql: string) => {
      const base = baseQuery(sql);
      if (base) return base;
      throw new Error('db down');
    });
    expect(await recordLead({ source: 'contact', name: 'C', email: 'c@x.com', company: null, phone: null, payload: {} } as never)).toEqual({ id: null });
  });
});

describe('findLeadById', () => {
  it('returns the lead when found', async () => {
    a.poolQueryMock.mockImplementation(async (sql: string) =>
      baseQuery(sql) ?? (sql.includes('SELECT id, email, payload') ? { rows: [{ id: '4', email: 'd@x.com', payload: { a: 1 }, name: 'D', company: null, notified: true }], rowCount: 1 } : { rows: [], rowCount: 0 }),
    );
    expect(await findLeadById(4)).toMatchObject({ id: 4, email: 'd@x.com', notified: true });
  });
  it('returns null when not found', async () => {
    expect(await findLeadById(404)).toBeNull();
  });
});
