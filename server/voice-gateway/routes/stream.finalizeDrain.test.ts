// @vitest-environment node
//
// Codex P1 on #135: a tool run still open at hangup queued its last writes
// (tool_end -> ACTIVE_CONVERSATION) after the call's CALL_COMPLETED, so the
// call never ended in a terminal state; and releaseBookkeeping() (up to 60 s)
// sat in front of usage / cost writes.
//
// As in production, session.close() queues call_state.session_closed
// (CALL_COMPLETED) at the start of teardown, before the drain: the row is
// final before the run's tool_end lands, so the final state is the terminal
// guard's job (KEEP_TERMINAL_STATE_SQL). The drain's job is order: the run's
// rows and events (tool_invocations complete, tool_end, meter) land before
// finalize and the call_completed event, bounded by
// BOOKKEEPING_FINALIZE_DRAIN_MAX_MS.
//
// Drives the real phone and widget finalizers over a loopback WebSocket with
// the real BookkeepingQueue, the real callPersistence and the real
// beginToolRun / finishToolRun; only the pool is a fake that keeps
// call_sessions.lifecycle_state in memory and applies the state SQL the way
// Postgres would (checked on a real Postgres in
// callPersistence.terminalGuard.realDb.test.ts).
import { createServer, type Server as HTTPServer } from 'http';
import type { AddressInfo } from 'net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import type { BookkeepingQueue } from '../services/bookkeepingQueue';

const h = vi.hoisted(() => {
  const TERMINAL = ['CALL_COMPLETED', 'CALL_FAILED'];
  const db = {
    state: new Map<string, string>(),
    /** Every state the row took, in order. */
    history: [] as string[],
    /** Every row written, in order: `state:<X>`, `event:<type>`, `finalize`, `tool_invocations.complete`, `meter`. */
    writes: [] as string[],
    /** When finalizeCallSession's UPDATE ran (Date.now(), faked or not). */
    finalizedAt: undefined as number | undefined,
  };
  const query = vi.fn(async (sql: string, values: unknown[] = []) => {
    if (sql.startsWith('UPDATE call_sessions SET')) {
      const id = String(values[1]);
      const current = db.state.get(id) ?? '';
      // 5ac743e0's whole-row guard, so the old code can be run against this test.
      if (sql.includes(`lifecycle_state NOT IN ('CALL_COMPLETED', 'CALL_FAILED')`) && TERMINAL.includes(current)) return { rows: [], rowCount: 0 };
      const keepsTerminal = sql.includes(`lifecycle_state = CASE WHEN lifecycle_state IN ('CALL_COMPLETED', 'CALL_FAILED') THEN lifecycle_state ELSE $3 END`);
      const next = keepsTerminal && TERMINAL.includes(current) ? current : String(values[2]);
      if (sql.includes('end_time = NOW()')) {
        db.finalizedAt = Date.now();
        db.writes.push('finalize');
      } else {
        db.writes.push(`state:${next}`);
      }
      if (next !== current || sql.includes('end_time = NOW()')) db.history.push(next);
      db.state.set(id, next);
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith('INSERT INTO call_events')) db.writes.push(`event:${String(values[3])}`);
    return { rows: [], rowCount: 1 };
  });
  return {
    db,
    query,
    queue: undefined as BookkeepingQueue | undefined,
    estimateCostMock: vi.fn(async (..._args: unknown[]) => ({ totalCostCents: 0 })),
    recordCallUsageMock: vi.fn(async (..._args: unknown[]) => {}),
    recordConversationCostMock: vi.fn(async (..._args: unknown[]) => {}),
    callSessionId: 'cs-finalize-drain',
  };
});

vi.mock('../services/openaiSession', () => ({
  createRealtimeSession: vi.fn(async () => {
    const { BookkeepingQueue } = await import('../services/bookkeepingQueue');
    const { updateCallStateWithEvent } = await import('../services/callPersistence');
    const queue = new BookkeepingQueue({ log: { info: () => {}, warn: () => {}, error: () => {} } });
    h.queue = queue;
    // What openaiSession's 'close' handler queues (the transport emits 'close'
    // synchronously inside session.close()): session_closed, behind every
    // write already queued, before the finalizer's drain.
    const close = vi.fn(async () => {
      void queue.enqueue('call_state.session_closed', () => updateCallStateWithEvent('t-1', h.callSessionId, 'CALL_COMPLETED', {
        type: 'session_closed', from: 'ACTIVE_CONVERSATION', to: 'CALL_COMPLETED',
      }));
    });
    return {
      session: { connect: vi.fn(async () => {}), close },
      callSessionId: h.callSessionId,
      onOpenAIAudio: vi.fn(),
      triggerGreeting: vi.fn(),
      sendAudioToOpenAI: vi.fn(),
      sendSystemMessage: vi.fn(),
      rebuildForHandoff: vi.fn(),
      recordCallOutcome: vi.fn(() => true),
      onSessionClosed: vi.fn(),
      noteCallerText: vi.fn(),
      sendCallerText: vi.fn(),
      onAgentAudioDone: vi.fn(),
      agentPlaybackDone: vi.fn(() => true),
      onBargeIn: vi.fn(),
      evaluateFloor: vi.fn(async () => 'not_needed' as const),
      // What openaiSession.ts exposes (old code calls flush, new code drain).
      flushBookkeeping: (reason = 'teardown') => queue.flush(reason),
      drainBookkeeping: (reason = 'teardown') => queue.drain(reason),
      releaseBookkeeping: () => queue.release(),
      costTracker: {
        inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, captureSource: 'estimate' as const,
        ttsCharacters: 0, cacheHits: 0, cacheMisses: 0, promptTokensSaved: 0, routingDecisions: [],
      },
      routedModel: 'grok-voice-think-fast-2.0',
      routedTier: 'standard',
    };
  }),
}));

vi.mock('../../../platform/db', () => ({
  getPlatformPool: vi.fn(() => ({
    connect: vi.fn(async () => ({ query: h.query, release: vi.fn() })),
  })),
  withTenantContext: vi.fn(async (_client: unknown, _tenantId: string, fn: () => unknown) => fn()),
}));
vi.mock('../../../platform/analytics/ConversionFunnelService', () => ({ recordConversionStage: vi.fn(async () => {}) }));
vi.mock('../../../platform/security/FieldEncryption', () => ({
  encryptTranscript: vi.fn(async (_t: string, v: string) => v),
  encryptSensitiveField: vi.fn(async (_t: string, v: string) => v),
  decryptSensitiveField: vi.fn(async (_t: string, v: string) => v),
}));
vi.mock('../services/numberLookup', () => ({
  getAgentConfig: vi.fn(async () => ({ type: 'general' })),
  getAgentToolOverrides: vi.fn(async () => []),
}));
vi.mock('../../../platform/compliance/HealthcareDeploymentApprovalService', () => ({
  authorizeHealthcareDeployment: vi.fn(async () => ({ allowed: true, code: 'not_healthcare' })),
}));
vi.mock('../services/agentLoader', () => ({
  loadAgentConfig: vi.fn(() => ({
    agentId: 'a-1', tenantId: 't-1', systemPrompt: '', greeting: 'Hello', voice: 'alloy',
    model: 'grok-voice-think-fast-2.0', language: 'en', tools: [], guardrails: [], metadata: {},
  })),
}));
vi.mock('../services/escalation', () => ({
  EscalationController: class { escalateCall = vi.fn(async () => ({ success: true, message: 'ok' })); },
}));
vi.mock('./twilio', () => ({
  getCoordinator: vi.fn(() => ({
    getCallRecord: vi.fn(() => undefined),
    handleTwilioStatusCallback: vi.fn(),
    on: vi.fn(),
    removeListener: vi.fn(),
  })),
  getTwilioAdapter: vi.fn(() => undefined),
}));
vi.mock('../../../platform/workflow/engine/WorkflowEngine', () => ({
  WorkflowEngine: class {
    setTraceContext = vi.fn();
    classifyIntent = vi.fn(() => ({ intent: 'unknown', confidence: 'low' }));
    recordTransition = vi.fn();
  },
}));
vi.mock('../../../platform/billing/budget/BudgetGuardService', () => ({
  BudgetGuardService: class { getStatus = vi.fn(async () => ({ isWarning: false, percentUsed: 0 })); },
}));
vi.mock('../../../platform/billing/budget/checkBudget', () => ({
  checkBudget: vi.fn(async () => ({ allowed: true, isTrial: false })),
}));
vi.mock('../../../platform/infra/memory/CallerMemoryService', () => ({
  CallerMemoryService: class { getCallerMemory = vi.fn(async () => null); },
}));
vi.mock('../../../platform/integrations/outbox/OutboxService', () => ({ OutboxService: class {} }));
vi.mock('../services/platformAdapters', () => ({
  createCallerMemoryStorage: vi.fn(() => ({})),
  createOutboxAdapters: vi.fn(() => ({ persistence: {}, integration: {} })),
}));
vi.mock('../../../platform/analytics/CsatSurveyService', () => ({
  dispatchSmsCsatSurvey: vi.fn(async () => {}),
  getTenantCsatSettings: vi.fn(async () => ({ enabled: false, channel: 'sms', minDurationSeconds: 0, scale: 5, smsTemplate: '' })),
}));
vi.mock('../../../platform/integrations/twilio/sender', () => ({ sendTwilioSms: vi.fn(async () => {}) }));
vi.mock('../../../platform/campaigns', () => ({
  classifyCallOutcome: vi.fn(() => 'completed'),
  updateContactStatus: vi.fn(async () => {}),
  addToDnc: vi.fn(async () => {}),
  getCampaign: vi.fn(async () => null),
  getContact: vi.fn(async () => null),
  buildCampaignTypePromptAugmentation: vi.fn(() => ''),
  classifyTypeDisposition: vi.fn(() => 'no_response'),
  updateContactTypeDisposition: vi.fn(async () => {}),
}));
vi.mock('../../../platform/core/observability', () => ({
  writeCallMetric: vi.fn(async () => {}),
  recordStreamObservation: vi.fn(),
}));
vi.mock('../../../platform/analytics/QualityScorerService', () => ({ scoreCall: vi.fn(async () => {}) }));
vi.mock('../../../platform/analytics/SentimentAnalysisService', () => ({ analyzeCallSentiment: vi.fn(async () => {}) }));
vi.mock('../../../platform/analytics/TopicClusteringService', () => ({ classifyCallTopic: vi.fn(async () => {}) }));
vi.mock('../../../platform/billing/usage/UsageRecorder', () => ({
  recordCallUsage: h.recordCallUsageMock,
  estimateCallCostWithLiveRate: h.estimateCostMock,
  recordToolExecution: vi.fn(async () => { h.db.writes.push('meter'); }),
}));
vi.mock('../../../platform/tools/ToolExecutionService', () => ({
  createToolExecution: vi.fn(async () => 'exec-1'),
  completeToolExecution: vi.fn(async () => { h.db.writes.push('tool_invocations.complete'); }),
}));
vi.mock('../../../platform/billing/cost', () => ({
  recordConversationCost: h.recordConversationCostMock,
  logRoutingDecision: vi.fn(async () => {}),
}));
vi.mock('../../../platform/widget/WidgetTokenService', () => ({
  validateWidgetToken: vi.fn(async () => null),
  getWidgetConfig: vi.fn(async () => null),
  getPublicWidgetConfig: vi.fn(async () => null),
}));
vi.mock('../../../platform/workforce/HandoffEngine', () => ({ HandoffEngine: class {} }));

import { attachWebSocket } from './stream';
import { beginToolRun, finishToolRun, type ToolRunCall } from '../services/toolBookkeeping';
import { BOOKKEEPING_FINALIZE_DRAIN_MAX_MS } from '../services/bookkeepingQueue';
import { getWidgetConfig, validateWidgetToken } from '../../../platform/widget/WidgetTokenService';

/** Real I/O turns (setImmediate is never faked here), so sockets move under fake timers. */
async function waitFor(predicate: () => boolean, turns = 2_000): Promise<void> {
  for (let i = 0; i < turns; i += 1) {
    if (predicate()) return;
    await new Promise<void>((r) => setImmediate(r));
  }
  throw new Error('waitFor: condition not met');
}

/**
 * The finalizer has closed the session and priced the call: what it waits on
 * next (the drain on new code) has armed its timers before the clock moves.
 */
async function teardownReachedDrain(): Promise<void> {
  await waitFor(() => h.estimateCostMock.mock.calls.length > 0);
  for (let i = 0; i < 5; i += 1) await new Promise<void>((r) => setImmediate(r));
}

/** Every client socket, terminated after each test so the server can close. */
const sockets: WebSocket[] = [];

const FAKE: Parameters<typeof vi.useFakeTimers>[0] = { toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] };

/** A tool run the way openaiSession's trackToolRun drives toolBookkeeping on the queue. */
function openToolRun(queue: BookkeepingQueue) {
  const closeRun = queue.openRun();
  const call: ToolRunCall = { tenantId: 't-1',callSessionId: h.callSessionId, agentId: 'a-1', toolName: 'book_appointment', args: {} };
  const run = beginToolRun(call, queue);
  const startTime = Date.now();
  return {
    /** finishToolRun's writes (complete, tool_end, meter), then the run closes. */
    end() {
      void finishToolRun(call, { run, startTime, result: { success: true }, status: 'success' }, queue);
      closeRun();
    },
  };
}

const before = (a: string, b: string) => {
  const ia = h.db.writes.indexOf(a);
  const ib = h.db.writes.indexOf(b);
  return ia >= 0 && ib >= 0 && ia < ib;
};

/** Once the row is final, no write moved it out (only CALL_COMPLETED after the first). */
function neverLeftCallCompleted(): void {
  const first = h.db.history.indexOf('CALL_COMPLETED');
  expect(first).toBeGreaterThanOrEqual(0);
  expect(h.db.history.slice(first).every((s) => s === 'CALL_COMPLETED')).toBe(true);
  expect(h.db.state.get(h.callSessionId)).toBe('CALL_COMPLETED');
}

async function openPhoneCall(port: number): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/twilio/stream`);
  sockets.push(ws);
  await new Promise<void>((resolve, reject) => { ws.on('open', () => resolve()); ws.on('error', reject); });
  ws.send(JSON.stringify({
    event: 'start',
    start: {
      streamSid: 'MZ-finalize-drain',
      customParameters: {
        tenantId: 't-1', agentId: 'a-1', agentType: 'general', callSid: 'CA-finalize-drain',
        callerNumber: '+15551234567', calledNumber: '+15557654321',
      },
    },
  }));
  await waitFor(() => h.db.history.includes('ACTIVE_CONVERSATION'));
  return ws;
}

async function openWidgetCall(port: number): Promise<WebSocket> {
  vi.mocked(validateWidgetToken).mockResolvedValueOnce({ tenantId: 't-1', tokenId: 'tok-1' });
  const widgetCfg = {
    id: 'w-1', tenant_id: 't-1', agent_id: 'a-1', enabled: true, greeting: 'Hi', lead_capture_fields: [],
    primary_color: '#000000', allowed_domains: [], text_chat_enabled: true, voice_enabled: true,
    created_at: '2026-10-17T00:00:00Z', updated_at: '2026-10-17T00:00:00Z',
  };
  vi.mocked(getWidgetConfig).mockClear().mockResolvedValueOnce(widgetCfg).mockResolvedValueOnce(widgetCfg);
  const ws = new WebSocket(`ws://127.0.0.1:${port}/widget/stream?token=widget-test`);
  sockets.push(ws);
  const ready = new Promise<void>((resolve) => ws.on('message', (raw) => {
    if (JSON.parse(raw.toString()).type === 'ready') resolve();
  }));
  await new Promise<void>((resolve, reject) => { ws.on('open', () => resolve()); ws.on('error', reject); });
  await waitFor(() => vi.mocked(getWidgetConfig).mock.calls.length === 1);
  ws.send(JSON.stringify({ type: 'start' }));
  await ready;
  return ws;
}

const finalized = () => h.db.finalizedAt !== undefined;

describe('stream finalizers: open tool runs land their rows before finalize (bounded); the call ends CALL_COMPLETED', () => {
  let server: HTTPServer;
  let port: number;
  const prevApiKey = process.env.OPENAI_API_KEY;
  const prevStreamToken = process.env.VOICE_GATEWAY_STREAM_TOKEN;

  beforeAll(async () => {
    process.env.OPENAI_API_KEY = 'test-key';
    delete process.env.VOICE_GATEWAY_STREAM_TOKEN;
    server = createServer();
    attachWebSocket(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (prevApiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = prevApiKey;
    if (prevStreamToken === undefined) delete process.env.VOICE_GATEWAY_STREAM_TOKEN;
    else process.env.VOICE_GATEWAY_STREAM_TOKEN = prevStreamToken;
  });

  beforeEach(() => {
    h.db.state.clear();
    h.db.history.length = 0;
    h.db.writes.length = 0;
    h.db.finalizedAt = undefined;
    h.queue = undefined;
    h.query.mockClear();
    h.estimateCostMock.mockClear();
    h.recordCallUsageMock.mockClear();
    h.recordConversationCostMock.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
    for (const ws of sockets.splice(0)) ws.terminate();
  });

  it('phone: a tool run open at hangup lands tool_invocations complete, tool_end and its meter before finalize and call_completed; the call ends CALL_COMPLETED', async () => {
    const ws = await openPhoneCall(port);
    const run = openToolRun(h.queue!);
    await h.queue!.flush();
    vi.useFakeTimers(FAKE);

    ws.send(JSON.stringify({ event: 'stop' }));
    await teardownReachedDrain();
    await vi.advanceTimersByTimeAsync(500);
    // The action is still in flight: the call is not finalized under it.
    expect(finalized()).toBe(false);
    // session_closed was queued at the start of teardown: the row is already final.
    expect(h.db.state.get(h.callSessionId)).toBe('CALL_COMPLETED');
    run.end();
    await waitFor(finalized);
    await vi.advanceTimersByTimeAsync(0);
    await waitFor(() => h.queue!.isReleased);

    for (const write of ['tool_invocations.complete', 'event:tool_end', 'meter']) {
      expect(before(write, 'finalize'), `${write} before finalize`).toBe(true);
      expect(before(write, 'event:call_completed'), `${write} before call_completed`).toBe(true);
    }
    // The tool_end's ACTIVE_CONVERSATION was kept off the final row.
    expect(h.db.history).toEqual(['ACTIVE_CONVERSATION', 'TOOL_EXECUTION', 'CALL_COMPLETED', 'CALL_COMPLETED']);
    neverLeftCallCompleted();
    ws.close();
  });

  it('phone: a run that never closes delays finalize at most BOOKKEEPING_FINALIZE_DRAIN_MAX_MS, usage is not held behind release, and its late tool_end leaves CALL_COMPLETED', async () => {
    const ws = await openPhoneCall(port);
    const run = openToolRun(h.queue!);
    await h.queue!.flush();
    vi.useFakeTimers(FAKE);
    const hangupAt = Date.now();

    ws.send(JSON.stringify({ event: 'stop' }));
    await teardownReachedDrain();
    await vi.advanceTimersByTimeAsync(BOOKKEEPING_FINALIZE_DRAIN_MAX_MS - 1);
    expect(finalized()).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await waitFor(finalized);
    expect(h.db.finalizedAt! - hangupAt).toBeLessThanOrEqual(BOOKKEEPING_FINALIZE_DRAIN_MAX_MS);

    // Usage and cost go out right after finalize; release is still waiting on the open run.
    await waitFor(() => h.recordCallUsageMock.mock.calls.length > 0 && h.recordConversationCostMock.mock.calls.length > 0);
    expect(h.queue!.isReleased).toBe(false);

    // The run ends late (before release's bound): its writes land after the final state.
    await vi.advanceTimersByTimeAsync(10_000);
    run.end();
    await vi.advanceTimersByTimeAsync(0);
    await waitFor(() => h.queue!.isReleased);
    // Its rows still land (after the final rows), and never move the state.
    expect(before('event:call_completed', 'event:tool_end')).toBe(true);
    expect(before('finalize', 'tool_invocations.complete')).toBe(true);
    neverLeftCallCompleted();
    ws.close();
  });

  it('widget: a tool run open at hangup lands tool_invocations complete, tool_end and its meter before finalize; the call ends CALL_COMPLETED', async () => {
    const ws = await openWidgetCall(port);
    const run = openToolRun(h.queue!);
    await h.queue!.flush();
    vi.useFakeTimers(FAKE);

    ws.send(JSON.stringify({ type: 'stop' }));
    await teardownReachedDrain();
    await vi.advanceTimersByTimeAsync(500);
    expect(finalized()).toBe(false);
    expect(h.db.state.get(h.callSessionId)).toBe('CALL_COMPLETED');
    run.end();
    await waitFor(finalized);
    await vi.advanceTimersByTimeAsync(0);
    await waitFor(() => h.queue!.isReleased);

    // The widget finalizer writes no call_completed event: finalize is the line.
    for (const write of ['tool_invocations.complete', 'event:tool_end', 'meter']) {
      expect(before(write, 'finalize'), `${write} before finalize`).toBe(true);
    }
    expect(h.db.history).toEqual(['TOOL_EXECUTION', 'CALL_COMPLETED', 'CALL_COMPLETED']);
    neverLeftCallCompleted();
    ws.close();
  });

  it('widget: a run that never closes delays finalize at most BOOKKEEPING_FINALIZE_DRAIN_MAX_MS, usage is not held behind release, and its late tool_end leaves CALL_COMPLETED', async () => {
    const ws = await openWidgetCall(port);
    const run = openToolRun(h.queue!);
    await h.queue!.flush();
    vi.useFakeTimers(FAKE);
    const hangupAt = Date.now();

    ws.send(JSON.stringify({ type: 'stop' }));
    await teardownReachedDrain();
    await vi.advanceTimersByTimeAsync(BOOKKEEPING_FINALIZE_DRAIN_MAX_MS - 1);
    expect(finalized()).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await waitFor(finalized);
    expect(h.db.finalizedAt! - hangupAt).toBeLessThanOrEqual(BOOKKEEPING_FINALIZE_DRAIN_MAX_MS);
    await waitFor(() => h.recordCallUsageMock.mock.calls.length > 0 && h.recordConversationCostMock.mock.calls.length > 0);
    expect(h.queue!.isReleased).toBe(false);

    await vi.advanceTimersByTimeAsync(10_000);
    run.end();
    await vi.advanceTimersByTimeAsync(0);
    await waitFor(() => h.queue!.isReleased);
    expect(before('finalize', 'event:tool_end')).toBe(true);
    neverLeftCallCompleted();
    ws.close();
  });
});
