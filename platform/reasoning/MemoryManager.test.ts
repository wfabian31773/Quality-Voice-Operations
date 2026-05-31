import { describe, it, expect, vi } from 'vitest';
import { MemoryManager, type MemoryStorage } from './MemoryManager';
import type { CallerMemory } from '../infra/memory/types';
import type { CallerContext } from './types';

function memory(overrides: Partial<CallerMemory> = {}): CallerMemory {
  return {
    tenantId: 'tenant-1',
    phoneNumber: '+15551234567',
    totalCalls: 3,
    recentCalls: [
      { date: '2026-05-01', reason: 'AC not cooling', outcome: 'ticket created', ticketNumber: 'T-1' },
    ],
    openTickets: [],
    notes: '',
    ...overrides,
  };
}

function storageReturning(value: CallerMemory | null): MemoryStorage {
  return { getCallerMemory: vi.fn().mockResolvedValue(value) };
}

const EMPTY: CallerContext = {
  memory: null,
  isReturningCaller: false,
  hasOpenTickets: false,
  openTicketIds: [],
};

describe('MemoryManager.buildCallerContext', () => {
  it('returns an empty context when there is no storage', async () => {
    expect(await new MemoryManager(null).buildCallerContext('t', '+1555')).toEqual(EMPTY);
  });

  it('returns an empty context when the caller number is blank', async () => {
    const storage = storageReturning(memory());
    expect(await new MemoryManager(storage).buildCallerContext('t', '')).toEqual(EMPTY);
    expect(storage.getCallerMemory).not.toHaveBeenCalled();
  });

  it('returns an empty context when no memory exists', async () => {
    expect(await new MemoryManager(storageReturning(null)).buildCallerContext('t', '+1555')).toEqual(EMPTY);
  });

  it('treats a record with zero total calls as a new caller', async () => {
    const ctx = await new MemoryManager(storageReturning(memory({ totalCalls: 0 }))).buildCallerContext('t', '+1555');
    expect(ctx.isReturningCaller).toBe(false);
  });

  it('builds a returning-caller context with open tickets and a last-call summary', async () => {
    const mgr = new MemoryManager(
      storageReturning(
        memory({
          totalCalls: 4,
          openTickets: ['T-9'],
          preferredContactMethod: 'sms',
          recentCalls: [{ date: '2026-05-02', reason: 'furnace', outcome: 'resolved' }],
        }),
      ),
    );
    const ctx = await mgr.buildCallerContext('t', '+15551234567');
    expect(ctx.isReturningCaller).toBe(true);
    expect(ctx.hasOpenTickets).toBe(true);
    expect(ctx.openTicketIds).toEqual(['T-9']);
    expect(ctx.preferredContactMethod).toBe('sms');
    expect(ctx.lastCallSummary).toBe('Last call on 2026-05-02: furnace — resolved');
  });

  it('falls back to an empty context if storage throws', async () => {
    const storage: MemoryStorage = {
      getCallerMemory: vi.fn().mockRejectedValue(new Error('db down')),
    };
    expect(await new MemoryManager(storage).buildCallerContext('t', '+1555')).toEqual(EMPTY);
  });
});

describe('MemoryManager.buildCallerContextPrompt', () => {
  it('returns an empty string for a non-returning caller', () => {
    expect(new MemoryManager(null).buildCallerContextPrompt(EMPTY)).toBe('');
  });

  it('renders a full caller-history prompt with all available fields', () => {
    const context: CallerContext = {
      memory: memory({
        totalCalls: 5,
        patientName: 'Ada Lovelace',
        lastProviderSeen: 'Dr. Smith',
        preferredContactMethod: 'phone',
        notes: 'VIP',
        recentCalls: [
          { date: '2026-04-01', reason: 'appointment booking', outcome: 'scheduled', ticketNumber: 'T-7' },
        ],
      }),
      isReturningCaller: true,
      hasOpenTickets: true,
      openTicketIds: ['T-7', 'T-8'],
      lastCallSummary: 'Last call on 2026-04-01: appointment booking — scheduled',
      preferredContactMethod: 'phone',
    };
    const prompt = new MemoryManager(null).buildCallerContextPrompt(context);
    expect(prompt).toContain('CALLER HISTORY');
    expect(prompt).toContain('5 previous calls');
    expect(prompt).toContain('Name on file: Ada Lovelace');
    expect(prompt).toContain('Open tickets: T-7, T-8');
    expect(prompt).toContain('existing ticket before creating a new one');
    expect(prompt).toContain('Preferred contact method: phone');
    expect(prompt).toContain('Last provider seen: Dr. Smith');
    expect(prompt).toContain('Recent appointments:');
    expect(prompt).toContain('Notes: VIP');
  });

  it('omits the appointments block when no recent call looks like an appointment', () => {
    const context: CallerContext = {
      memory: memory({
        totalCalls: 2,
        recentCalls: [{ date: '2026-04-01', reason: 'billing question', outcome: 'answered' }],
      }),
      isReturningCaller: true,
      hasOpenTickets: false,
      openTicketIds: [],
    };
    const prompt = new MemoryManager(null).buildCallerContextPrompt(context);
    expect(prompt).not.toContain('Recent appointments:');
    expect(prompt).not.toContain('Open tickets:');
  });
});
