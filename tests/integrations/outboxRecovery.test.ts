/**
 * End-to-end recovery test for the integration outbox.
 *
 * Simulates the production failure path that BL-014 / Task #248 was built for:
 *   1. A CRM adapter (HubSpot) is offline.
 *   2. A customer-originated `appointment.booked` event fires through
 *      `connectorService.dispatchEvent`.
 *   3. The inline dispatch fails — the outbox row is left `pending` instead
 *      of being silently dropped.
 *   4. The CRM adapter comes back online.
 *   5. One drain cycle later, the previously-pending row is delivered.
 *
 * The DB layer is replaced with an in-memory fake so the test exercises the
 * real buffer SQL semantics (uniqueness, claim, mark-delivered) without
 * needing a live Postgres.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface FakeOutboxRow {
  id: string;
  tenant_id: string;
  idempotency_key: string;
  event_type: string;
  payload: unknown;
  status: 'pending' | 'processing' | 'delivered' | 'failed' | 'dead_letter';
  attempts: number;
  max_attempts: number;
  last_error: string | null;
  next_attempt_at: number;
  delivered_at: number | null;
  created_at: number;
  updated_at: number;
}

interface FakeDbState {
  outbox: Map<string, FakeOutboxRow>;
  rowSeq: number;
}

const state: FakeDbState = { outbox: new Map(), rowSeq: 0 };

function findByIdempotency(tenantId: string, key: string): FakeOutboxRow | undefined {
  for (const row of state.outbox.values()) {
    if (row.tenant_id === tenantId && row.idempotency_key === key) return row;
  }
  return undefined;
}

const fakeQuery = vi.fn(async (sql: string, values: unknown[] = []) => {
  const trimmed = sql.trim();

  // Outbox buffer insert
  if (trimmed.startsWith('INSERT INTO outbox_events')) {
    const [tenantId, idempotencyKey, eventType, payloadJson] = values as [
      string, string, string, string,
    ];
    if (findByIdempotency(tenantId, idempotencyKey)) {
      return { rows: [] };
    }
    state.rowSeq += 1;
    const id = `outbox-${state.rowSeq}`;
    const now = Date.now();
    state.outbox.set(id, {
      id,
      tenant_id: tenantId,
      idempotency_key: idempotencyKey,
      event_type: eventType,
      payload: JSON.parse(payloadJson),
      status: 'pending',
      attempts: 0,
      max_attempts: 5,
      last_error: null,
      // Inline dispatch grace window — drain skips the row until inline
      // either marks it delivered or resets next_attempt_at to NOW().
      next_attempt_at: now + 60_000,
      delivered_at: null,
      created_at: now,
      updated_at: now,
    });
    return { rows: [{ id }] };
  }

  // SELECT existing row by idempotency
  if (trimmed.startsWith('SELECT id, status::text AS status')) {
    const [tenantId, idempotencyKey] = values as [string, string];
    const row = findByIdempotency(tenantId, idempotencyKey);
    if (!row) return { rows: [] };
    return { rows: [{ id: row.id, status: row.status }] };
  }

  // Mark delivered
  if (trimmed.startsWith("UPDATE outbox_events") && trimmed.includes("status = 'delivered'")) {
    const [id] = values as [string];
    const row = state.outbox.get(id);
    if (row && ['pending', 'processing', 'failed'].includes(row.status)) {
      row.status = 'delivered';
      row.delivered_at = Date.now();
      row.last_error = null;
      row.attempts += 1;
      row.updated_at = Date.now();
    }
    return { rows: [] };
  }

  // Mark pending after inline failure
  if (trimmed.startsWith("UPDATE outbox_events") && trimmed.includes("status = 'pending'")
      && trimmed.includes('next_attempt_at = NOW()')
      && trimmed.includes("status NOT IN ('delivered', 'dead_letter')")) {
    const [id, errorMessage] = values as [string, string];
    const row = state.outbox.get(id);
    if (row && row.status !== 'delivered' && row.status !== 'dead_letter') {
      row.status = 'pending';
      row.last_error = errorMessage;
      row.next_attempt_at = Date.now();
      row.attempts += 1;
      row.updated_at = Date.now();
    }
    return { rows: [] };
  }

  // Drain claim CTE
  if (trimmed.startsWith('WITH claimed AS') && trimmed.includes('outbox_events')) {
    const [limit] = values as [number];
    const now = Date.now();
    const claimable = Array.from(state.outbox.values())
      .filter((r) =>
        (r.status === 'pending' || r.status === 'failed')
        && r.attempts < r.max_attempts
        && r.next_attempt_at <= now,
      )
      .sort((a, b) => a.next_attempt_at - b.next_attempt_at || a.created_at - b.created_at)
      .slice(0, limit);
    for (const row of claimable) {
      row.status = 'processing';
      row.attempts += 1;
      row.updated_at = Date.now();
    }
    return {
      rows: claimable.map((r) => ({
        id: r.id,
        tenant_id: r.tenant_id,
        event_type: r.event_type,
        payload: r.payload,
        attempts: r.attempts,
        max_attempts: r.max_attempts,
      })),
    };
  }

  // Drain markDelivered (no row-id filter on status)
  if (trimmed.startsWith("UPDATE outbox_events") && trimmed.includes("status = 'delivered'")
      && trimmed.includes('delivered_at = NOW()')) {
    const [id] = values as [string];
    const row = state.outbox.get(id);
    if (row) {
      row.status = 'delivered';
      row.delivered_at = Date.now();
      row.last_error = null;
      row.updated_at = Date.now();
    }
    return { rows: [] };
  }

  // Drain markFailure (failed)
  if (trimmed.startsWith("UPDATE outbox_events") && trimmed.includes("status = 'failed'")) {
    const [id, error] = values as [string, string];
    const row = state.outbox.get(id);
    if (row) {
      row.status = 'failed';
      row.last_error = error;
      row.next_attempt_at = Date.now() + 60_000;
      row.updated_at = Date.now();
    }
    return { rows: [] };
  }

  // Drain markFailure (dead_letter)
  if (trimmed.startsWith("UPDATE outbox_events") && trimmed.includes("status = 'dead_letter'")) {
    const [id, error] = values as [string, string];
    const row = state.outbox.get(id);
    if (row) {
      row.status = 'dead_letter';
      row.last_error = error;
      row.updated_at = Date.now();
    }
    return { rows: [] };
  }

  // Transaction control
  if (trimmed.startsWith('BEGIN') || trimmed.startsWith('COMMIT') || trimmed.startsWith('ROLLBACK')) {
    return { rows: [] };
  }

  return { rows: [] };
});

const fakeRelease = vi.fn();
const fakeConnect = vi.fn(async () => ({ query: fakeQuery, release: fakeRelease }));

vi.mock('../../platform/db', () => ({
  withPrivilegedClient: vi.fn(async (fn: (c: unknown) => unknown) =>
    fn({ query: fakeQuery }),
  ),
  getPlatformPool: () => ({
    query: fakeQuery,
    connect: fakeConnect,
  }),
  withTenantContext: vi.fn(async (_client: unknown, _t: string, fn: () => Promise<unknown>) => fn()),
}));

// Adapter outage simulation: a single mutable flag flips the HubSpot CRM
// adapter between "down" (returns failure) and "up" (returns success).
const adapterState = { hubspotOnline: false };

vi.mock('../../platform/integrations/connectors/db', () => ({
  getConnectorConfig: vi.fn(),
  listEnabledConnectorConfigs: vi.fn(async () => [{
    tenantId: 'tenant-recover',
    integrationId: 'int-hubspot',
    connectorType: 'crm',
    provider: 'hubspot',
    isEnabled: true,
    config: {},
    credentials: {},
  }]),
  updateConnectorSyncStatus: vi.fn(async () => []),
  getPreferredSchedulingProvider: vi.fn(async () => null),
  recordAppointmentSchedulingDispatch: vi.fn(async () => undefined),
  getAppointmentSchedulingProvider: vi.fn(async () => null),
}));

vi.mock('../../platform/audit/AuditService', () => ({
  writeAuditLog: vi.fn(async () => undefined),
}));

vi.mock('../../platform/integrations/connectors/SyncErrorAlerter', () => ({
  notifyConnectorSyncError: vi.fn(async () => undefined),
  notifySustainedConnectorFailure: vi.fn(async () => undefined),
  notifyConnectorRecovery: vi.fn(async () => undefined),
  isRevenueCriticalProvider: () => false,
}));

vi.mock('../../platform/core/observability/traceLogger', () => ({
  recordIntegrationEvent: vi.fn(async () => null),
  recordConnectorDispatchEvent: vi.fn(async () => null),
}));

vi.mock('../../platform/integrations/connectors/crmCallerIdentity', () => ({
  lookupCrmCallerIdentity: vi.fn(async () => null),
  upsertCrmCallerIdentity: vi.fn(async () => undefined),
  clearCrmCallerIdentity: vi.fn(async () => undefined),
  extractIdentityFromMeta: vi.fn(() => ({ extras: {} })),
}));

import { connectorService } from '../../platform/integrations/connectors/ConnectorService';
import { runConnectorOutboxDrainCycle } from '../../platform/integrations/connectors/ConnectorOutboxDrainScheduler';

const TENANT = 'tenant-recover' as never;

describe('Integration outbox end-to-end recovery', () => {
  beforeEach(() => {
    state.outbox.clear();
    state.rowSeq = 0;
    adapterState.hubspotOnline = false;
    fakeQuery.mockClear();
    fakeRelease.mockClear();
    fakeConnect.mockClear();

    // Patch executeWithConfig on the singleton to simulate the HubSpot adapter
    // being offline / online based on `adapterState.hubspotOnline`.
    vi.spyOn(
      connectorService as unknown as { executeWithConfig: (...args: unknown[]) => Promise<unknown> },
      'executeWithConfig',
    ).mockImplementation(async () => {
      if (!adapterState.hubspotOnline) {
        return { success: false, error: 'HubSpot API: connection refused' };
      }
      return { success: true, externalId: 'hs-contact-1' };
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('buffers pending when adapter is offline and delivers within one drain cycle once it recovers', async () => {
    // 1. Adapter is offline. Fire the customer-originated event.
    const inlineResult = await connectorService.dispatchEvent(
      TENANT,
      'appointment.booked',
      {
        type: 'appointment.booked',
        appointmentId: 'appt-recovery-1',
        callerPhone: '+15555550100',
      },
    );

    expect(inlineResult.dispatched).toBe(1);
    expect(inlineResult.results[0]).toMatchObject({ success: false, provider: 'hubspot' });

    // 2. The outbox row is durably staged in `pending` status with
    //    next_attempt_at moved up so the drain picks it up immediately.
    const rows = Array.from(state.outbox.values());
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      tenant_id: 'tenant-recover',
      event_type: 'appointment.booked',
      status: 'pending',
    });
    expect(rows[0].last_error).toContain('HubSpot');
    // Inline failure resets next_attempt_at to NOW(), so the drain can claim
    // it on its very next pass (within the test we treat <=now as eligible).
    expect(rows[0].next_attempt_at).toBeLessThanOrEqual(Date.now() + 1);

    // 3. Bring the adapter back online.
    adapterState.hubspotOnline = true;

    // 4. Run one drain cycle.
    const drainResult = await runConnectorOutboxDrainCycle();

    // 5. Confirm the drain delivered the row in this single cycle.
    expect(drainResult.claimed).toBe(1);
    expect(drainResult.delivered).toBe(1);
    expect(drainResult.failed).toBe(0);
    expect(drainResult.deadLettered).toBe(0);

    const finalRow = state.outbox.get(rows[0].id);
    expect(finalRow?.status).toBe('delivered');
    expect(finalRow?.delivered_at).not.toBeNull();
    expect(finalRow?.last_error).toBeNull();
  });

  it('marks the row delivered inline (no drain work needed) when the adapter is online', async () => {
    adapterState.hubspotOnline = true;

    const result = await connectorService.dispatchEvent(
      TENANT,
      'appointment.booked',
      {
        type: 'appointment.booked',
        appointmentId: 'appt-fresh',
      },
    );
    expect(result.results[0]).toMatchObject({ success: true });

    const rows = Array.from(state.outbox.values());
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('delivered');

    // The drain finds nothing to do because the row is delivered.
    const drain = await runConnectorOutboxDrainCycle();
    expect(drain.claimed).toBe(0);
  });

  it('re-firing the same event while the row is still pending re-attempts inline (no premature short-circuit)', async () => {
    // First fire with adapter offline → row stays pending.
    await connectorService.dispatchEvent(TENANT, 'appointment.booked', {
      type: 'appointment.booked',
      appointmentId: 'appt-pending-retry',
    });

    const rowsAfterFirst = Array.from(state.outbox.values()).filter(
      (r) => r.idempotency_key.includes('appt-pending-retry'),
    );
    expect(rowsAfterFirst).toHaveLength(1);
    expect(rowsAfterFirst[0].status).toBe('pending');
    const firstAttempts = rowsAfterFirst[0].attempts;

    // Bring adapter online and re-fire the same event. The row is still
    // pending (not delivered) so the dedupe short-circuit must NOT fire —
    // the caller's retry should actually attempt inline dispatch again.
    adapterState.hubspotOnline = true;
    const second = await connectorService.dispatchEvent(TENANT, 'appointment.booked', {
      type: 'appointment.booked',
      appointmentId: 'appt-pending-retry',
    });

    expect(second.dispatched).toBe(1);
    expect(second.results[0]).toMatchObject({ success: true });

    // Still the same single row (idempotency key collapsed onto it), now delivered.
    const rowsAfterSecond = Array.from(state.outbox.values()).filter(
      (r) => r.idempotency_key.includes('appt-pending-retry'),
    );
    expect(rowsAfterSecond).toHaveLength(1);
    expect(rowsAfterSecond[0].id).toBe(rowsAfterFirst[0].id);
    expect(rowsAfterSecond[0].status).toBe('delivered');
    expect(rowsAfterSecond[0].attempts).toBeGreaterThan(firstAttempts);
  });

  it('does not double-deliver: re-firing the same event short-circuits when the row is delivered', async () => {
    adapterState.hubspotOnline = true;

    await connectorService.dispatchEvent(TENANT, 'appointment.booked', {
      type: 'appointment.booked',
      appointmentId: 'appt-dedupe',
    });

    const second = await connectorService.dispatchEvent(TENANT, 'appointment.booked', {
      type: 'appointment.booked',
      appointmentId: 'appt-dedupe',
    });

    // Second call short-circuits — no inline dispatch was made.
    expect(second.dispatched).toBe(0);
    expect(second.results).toEqual([]);

    // Only one outbox row exists for the dedupe key.
    const rows = Array.from(state.outbox.values()).filter(
      (r) => r.idempotency_key.includes('appt-dedupe'),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('delivered');
  });
});
