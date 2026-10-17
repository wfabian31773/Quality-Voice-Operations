/**
 * Test fixture: the real `sms.send` action over an in-memory store and a
 * mocked Twilio transport. Callers' tests route their chokepoint calls here
 * (pass `options` as the `SystemSmsOptions`) to prove opt-out, the messaging
 * flag and failure handling end to end without a database or Twilio.
 */
import { vi } from 'vitest';
import { createMemoryStore } from '../../core';
import type { ClaimedSmsRecord, OutboundSmsPatch, OutboundSmsRecord, SmsSendDeps, SmsSendStore } from '../deps';
import { createSmsSendAction, type SystemSmsOptions } from '../send';

export type FakeSmsRow = OutboundSmsRecord & { twilioSid?: string; errorMessage?: string; sentAt?: Date };

export function createFakeSmsChokepoint(opts: { from?: string; senders?: string[] } = {}) {
  const from = opts.from ?? '+13125550100';
  const state = {
    smsEnabled: true,
    tenantEnabled: true,
    quietHoursAllowed: true,
    optedOut: new Set<string>(),
    /** Thrown by the next Twilio send(s) while set. */
    sendError: null as Error | null,
  };
  const rows = new Map<string, FakeSmsRow>();
  let seq = 0;

  const upsert = (record: OutboundSmsRecord) => {
    const { existing, ...fields } = record;
    const row = rows.get(record.id);
    if (existing) {
      if (!row) throw new Error('Stored SMS is no longer sendable');
      Object.assign(row, { status: fields.status, scheduledAt: fields.scheduledAt ?? row.scheduledAt });
      row.metadata = { ...row.metadata, ...fields.metadata };
      return;
    }
    rows.set(record.id, { ...fields });
  };

  const store: SmsSendStore = {
    isTenantMessagingEnabled: vi.fn(async () => state.tenantEnabled),
    isTenantSender: vi.fn(
      async (_tx: unknown, _tenant: string, number: string) => number === from || (opts.senders ?? []).includes(number),
    ),
    latestConsentAction: vi.fn(async (_tx: unknown, _tenant: string, phone: string) =>
      state.optedOut.has(phone) ? ('opt_out' as const) : null,
    ),
    loadStoredOutbound: vi.fn(async (_tx: unknown, _tenant: string, id: string) => {
      const r = rows.get(id);
      if (!r || r.twilioSid || !['scheduled', 'sending'].includes(r.status) || r.metadata.source === 'sms.send') {
        return null;
      }
      return { ...r };
    }),
    reserveOutbound: vi.fn(async (record: OutboundSmsRecord) => {
      upsert(record);
      return { reserved: true as const };
    }),
    reserveDeferredSend: vi.fn(async () => ({ reserved: true as const })),
    insertOutbound: vi.fn(async (record: OutboundSmsRecord) => upsert(record)),
    updateOutbound: vi.fn(async (_tenant: string, id: string, patch: OutboundSmsPatch) => {
      const row = rows.get(id);
      if (!row) return;
      const { metadata, ...rest } = patch;
      Object.assign(row, rest);
      if (metadata) row.metadata = { ...row.metadata, ...metadata };
    }),
    claimDueDeferred: vi.fn(async () => [] as ClaimedSmsRecord[]),
  };
  const transport = {
    defaultFromNumber: vi.fn(async () => from),
    send: vi.fn(async (_req: { tenantId: string; from: string; to: string; body: string; statusCallback: string | null }) => {
      if (state.sendError) throw state.sendError;
      return { sid: `SM${++seq}`, status: 'queued' };
    }),
  };
  const deps: SmsSendDeps = {
    store,
    transport,
    quietHours: {
      isAllowed: async () => state.quietHoursAllowed,
      nextWindowStart: async (_tenant, _to, now) => new Date(now.getTime() + 8 * 3_600_000),
    },
    config: {
      smsEnabled: () => state.smsEnabled,
      liveCallExemptSeconds: () => 60,
      rateLimit: () => ({ max: 0, windowMs: 0 }),
      statusCallbackUrl: () => 'https://voice.example.com/twilio/sms-status',
    },
    newId: () => `sms-${rows.size + 1}`,
  };
  const memory = createMemoryStore();
  const options: SystemSmsOptions = {
    action: createSmsSendAction(deps),
    runtime: { store: memory, withTenantTx: memory.withTenantTx.bind(memory) },
  };
  return { state, rows, store, transport, options };
}

export type FakeSmsChokepoint = ReturnType<typeof createFakeSmsChokepoint>;
