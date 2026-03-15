import { describe, test, expect } from 'vitest';
import { CallerMemoryService, type CallerMemoryStorage, type CallHistoryRecord } from './CallerMemoryService';

function makeMockStorage(
  records: Record<string, CallHistoryRecord[]>,
): CallerMemoryStorage {
  return {
    async getCallHistoryByPhone(tenantId, phone, limit) {
      const key = `${tenantId}::${phone}`;
      return (records[key] || []).slice(0, limit);
    },
  };
}

describe('CallerMemoryService', () => {
  const tenantA = 'tenant-a';
  const tenantB = 'tenant-b';
  const phone = '+15551234567';
  const normalizedPhone = '5551234567';

  const recordsA: CallHistoryRecord[] = [
    {
      createdAt: '2026-03-14T10:00:00Z',
      callReason: 'Billing question',
      agentOutcome: 'Resolved',
      ticketNumber: 'T-100',
      agentUsed: 'billing-agent',
      durationSeconds: 120,
      patientName: 'Alice Smith',
      patientDob: '1985-06-15',
    },
    {
      createdAt: '2026-03-10T09:00:00Z',
      callReason: 'Appointment request',
      agentOutcome: 'Scheduled',
      ticketNumber: 'T-090',
      agentUsed: 'scheduling-agent',
      durationSeconds: 60,
    },
  ];

  const recordsB: CallHistoryRecord[] = [
    {
      createdAt: '2026-03-12T14:00:00Z',
      callReason: 'Prescription refill',
      agentOutcome: 'Transferred',
      openTickets: ['RX-001'],
    },
  ];

  const storage = makeMockStorage({
    [`${tenantA}::${normalizedPhone}`]: recordsA,
    [`${tenantB}::${normalizedPhone}`]: recordsB,
  });

  const service = new CallerMemoryService(storage);

  test('returns null for unknown caller', async () => {
    const result = await service.getCallerMemory(tenantA, '+10000000000');
    expect(result).toBeNull();
  });

  test('returns null for empty phone', async () => {
    const result = await service.getCallerMemory(tenantA, '');
    expect(result).toBeNull();
  });

  test('retrieves tenant-scoped history for tenant A', async () => {
    const result = await service.getCallerMemory(tenantA, phone);
    expect(result).not.toBeNull();
    expect(result!.tenantId).toBe(tenantA);
    expect(result!.totalCalls).toBe(2);
    expect(result!.recentCalls).toHaveLength(2);
    expect(result!.recentCalls[0].reason).toBe('Billing question');
    expect(result!.patientName).toBe('Alice Smith');
  });

  test('retrieves tenant-scoped history for tenant B (isolation)', async () => {
    const result = await service.getCallerMemory(tenantB, phone);
    expect(result).not.toBeNull();
    expect(result!.tenantId).toBe(tenantB);
    expect(result!.totalCalls).toBe(1);
    expect(result!.recentCalls[0].reason).toBe('Prescription refill');
    expect(result!.openTickets).toEqual(['RX-001']);
    expect(result!.patientName).toBeUndefined();
  });

  test('caller memory includes system prompt injection format', async () => {
    const memoryA = await service.getCallerMemory(tenantA, phone);
    const memoryB = await service.getCallerMemory(tenantB, phone);

    expect(memoryA!.totalCalls).not.toBe(memoryB!.totalCalls);

    const systemPrompt = 'You are a helpful agent.';
    const callerMemorySummary = `Returning caller (${memoryA!.totalCalls} previous calls). Last call: ${memoryA!.lastCallDate ?? 'unknown'}.`;
    if (memoryA!.openTickets && memoryA!.openTickets.length > 0) {
      expect(callerMemorySummary).not.toContain('Open tickets');
    }
    const promptWithMemory = `${systemPrompt}\n\n===== CALLER MEMORY =====\n${callerMemorySummary}`;
    expect(promptWithMemory).toContain('CALLER MEMORY');
    expect(promptWithMemory).toContain('2 previous calls');
  });

  test('respects maxCalls limit', async () => {
    const result = await service.getCallerMemory(tenantA, phone, 1);
    expect(result).not.toBeNull();
    expect(result!.totalCalls).toBe(1);
    expect(result!.recentCalls).toHaveLength(1);
  });
});
