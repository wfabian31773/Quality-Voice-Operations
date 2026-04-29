/**
 * Integration coverage for migration 082 + the voice-gateway call creation
 * path. Asserts that when a call is created via the same code path the
 * voice gateway uses (loadAgentConfig -> createCallSession), the agent's
 * configured language is snapshotted onto the `call_sessions.language`
 * column.
 *
 * The voice gateway invokes this path in `openaiSession.ts`:
 *
 *   const callSessionId = await createCallSession({
 *     ...
 *     language: agentConfig.language,
 *   });
 *
 * If a future change to either `createCallSession` or to the agent config
 * flow stops populating this column, the call list, call detail page, and
 * analytics language breakdown all silently lose data — this test guards
 * that boundary.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { TenantId } from '../../platform/core/types';

const queryMock = vi.fn();
const releaseMock = vi.fn();
const connectMock = vi.fn(async () => ({
  query: queryMock,
  release: releaseMock,
}));

vi.mock('../../platform/db', () => ({
  getPlatformPool: () => ({ connect: connectMock, query: queryMock }),
  withTenantContext: vi.fn(
    async (
      _client: unknown,
      _tenantId: string,
      fn: () => Promise<void>,
    ) => fn(),
  ),
  withPrivilegedClient: vi.fn(),
}));

vi.mock('../../platform/core/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('../../platform/security/FieldEncryption', () => ({
  encryptSensitiveField: vi.fn(async (_tid: string, v: string) => `enc:${v}`),
  decryptSensitiveField: vi.fn(async (_tid: string, v: string) => v),
  encryptTranscript: vi.fn(async (_tid: string, v: string) => v),
}));

vi.mock('../../platform/analytics/ConversionFunnelService', () => ({
  recordConversionStage: vi.fn(async () => undefined),
}));

beforeEach(() => {
  queryMock.mockReset();
  queryMock.mockResolvedValue({ rows: [] });
  releaseMock.mockReset();
  connectMock.mockClear();
});

interface CapturedInsert {
  sql: string;
  values: unknown[];
}

function findInsertCall(): CapturedInsert {
  const call = queryMock.mock.calls.find(
    (c) =>
      typeof c[0] === 'string' && (c[0] as string).includes('INSERT INTO call_sessions'),
  );
  if (!call) {
    throw new Error('No INSERT INTO call_sessions call captured');
  }
  return { sql: call[0] as string, values: (call[1] as unknown[]) ?? [] };
}

describe('voice gateway call creation snapshots agent language onto call_sessions', () => {
  it('writes the loaded agent config language into the language column', async () => {
    const { loadAgentConfig } = await import(
      '../../server/voice-gateway/services/agentLoader'
    );
    const { createCallSession } = await import(
      '../../server/voice-gateway/services/callPersistence'
    );

    const tenantId = randomUUID() as TenantId;
    const agentConfig = loadAgentConfig({
      tenantId,
      agentId: 'agent-es-1',
      agentType: 'customer-support',
      dbAgent: {
        name: 'Recepción',
        system_prompt: 'You are a helpful assistant.',
        voice: 'sage',
        model: 'gpt-4o-realtime-preview',
        language: 'es',
        metadata: {},
      },
    });

    expect(agentConfig.language).toBe('es');

    const callSessionId = await createCallSession({
      tenantId,
      agentId: agentConfig.agentId,
      callSid: 'CA-test-es',
      direction: 'inbound',
      callerNumber: '+15551112222',
      calledNumber: '+15553334444',
      language: agentConfig.language,
    });

    expect(callSessionId).toMatch(/^[0-9a-f-]{36}$/i);

    const insert = findInsertCall();
    // The 11th positional parameter ($11) on the INSERT is `language`.
    expect(insert.sql).toMatch(/INSERT INTO call_sessions[\s\S]*language[\s\S]*VALUES/);
    expect(insert.values[10]).toBe('es');
  });

  it('persists null when the agent has no configured language', async () => {
    const { loadAgentConfig } = await import(
      '../../server/voice-gateway/services/agentLoader'
    );
    const { createCallSession } = await import(
      '../../server/voice-gateway/services/callPersistence'
    );

    const tenantId = randomUUID() as TenantId;
    const agentConfig = loadAgentConfig({
      tenantId,
      agentId: 'agent-default-1',
      agentType: 'customer-support',
      dbAgent: {
        name: 'Default Agent',
        system_prompt: 'Hello.',
        voice: 'sage',
        model: 'gpt-4o-realtime-preview',
        // no language configured
        metadata: {},
      },
    });

    expect(agentConfig.language).toBe('en');

    await createCallSession({
      tenantId,
      agentId: agentConfig.agentId,
      callSid: 'CA-test-en',
      direction: 'inbound',
      callerNumber: '+15551112222',
      calledNumber: '+15553334444',
      language: agentConfig.language,
    });

    const insert = findInsertCall();
    expect(insert.values[10]).toBe('en');
  });

  it('coerces the language value to NULL when the column is intentionally absent', async () => {
    const { createCallSession } = await import(
      '../../server/voice-gateway/services/callPersistence'
    );

    await createCallSession({
      tenantId: randomUUID(),
      agentId: 'agent-legacy',
      callSid: 'CA-test-null',
      direction: 'inbound',
      callerNumber: '+15551112222',
      calledNumber: '+15553334444',
      // language deliberately not set: simulates legacy callers that do not
      // know about the column. The DB column is nullable on purpose so
      // analytics can render those calls as "Unknown".
    });

    const insert = findInsertCall();
    expect(insert.values[10]).toBeNull();
  });

  it('trims and length-caps oversized language inputs to fit VARCHAR(8)', async () => {
    const { createCallSession } = await import(
      '../../server/voice-gateway/services/callPersistence'
    );

    await createCallSession({
      tenantId: randomUUID(),
      agentId: 'agent-edge',
      callSid: 'CA-test-edge',
      direction: 'inbound',
      callerNumber: '+15551112222',
      calledNumber: '+15553334444',
      language: '  pt-BR-extra-long-tag  ',
    });

    const insert = findInsertCall();
    expect(typeof insert.values[10]).toBe('string');
    const v = insert.values[10] as string;
    expect(v.length).toBeLessThanOrEqual(8);
    expect(v.startsWith('pt-BR')).toBe(true);
  });
});
