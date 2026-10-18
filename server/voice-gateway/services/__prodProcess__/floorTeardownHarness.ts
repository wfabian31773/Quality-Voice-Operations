/**
 * RT-12 production-process harness for the hangup floor.
 *
 * Run exactly the way render.yaml starts qvo-voice:
 *   node --import tsx server/voice-gateway/services/__prodProcess__/floorTeardownHarness.ts
 * (cwd = repo root). floorTeardown.prodProcess.test.ts spawns it and parses the
 * line starting with RESULT_MARKER from stdout.
 *
 * Only the edges are fake:
 * - the database: the `pg` module resolves to a pg-mem database (pg-mem's
 *   drop-in `require('pg')` replacement), so platform/db, callPersistence, the
 *   action executor, the idempotency store and the SQL tickets repo all run
 *   their real queries;
 * - the realtime transport: the `ws` module resolves to an in-process socket
 *   that plays the xAI server, sending the real wire events (caller
 *   transcripts, function calls, agent transcripts).
 * Everything above them is the production code the live server loads:
 * createRealtimeSession (tool bridge, transcripts, invariants) and the phone
 * teardown step finalizeStream runs (closeRealtimeForPhoneTeardown), which
 * runs the real tickets.file_floor through platform/actions. The harness
 * itself never files anything.
 */
import { EventEmitter } from 'node:events';
import Module, { createRequire } from 'node:module';
import path from 'node:path';

export const RESULT_MARKER = 'RT12_PROD_PROCESS_RESULT ';

const repoRoot = process.cwd();
const req = createRequire(path.join(repoRoot, 'package.json'));

// The production process has a database URL; nothing dials it (pg is faked below).
process.env.APP_ENV ??= 'development';
process.env.DATABASE_URL ??= 'postgres://pg-mem.invalid/qvo';

// ---------------------------------------------------------------- database edge
interface PgMemFunctionSpec {
  name: string;
  args?: unknown[];
  returns: unknown;
  implementation: (...args: never[]) => unknown;
  impure?: boolean;
}
interface PgMemSchema {
  none(sql: string): void;
  many(sql: string): Array<Record<string, unknown>>;
  registerFunction(spec: PgMemFunctionSpec): void;
}
interface PgMemDb {
  public: PgMemSchema;
  adapters: { createPg(): { Pool: new (...args: unknown[]) => object; Client: new (...args: unknown[]) => object } };
}
interface PgMemModule {
  newDb(): PgMemDb;
  DataType: { text: unknown; bool: unknown; uuid: unknown; integer: unknown };
}

const SCHEMA = `
  CREATE TABLE tenants (id TEXT PRIMARY KEY, name TEXT NOT NULL, settings JSONB DEFAULT '{}');
  CREATE TABLE users (id TEXT PRIMARY KEY);
  CREATE TABLE encryption_keys (
    id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
    tenant_id TEXT NOT NULL, key_alias TEXT NOT NULL, encrypted_dek TEXT NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT TRUE, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE TABLE call_sessions (
    id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, agent_id TEXT, call_sid TEXT, session_id TEXT,
    direction TEXT, caller_number TEXT, caller_lookup_hash TEXT, caller_lookup_key_version TEXT,
    called_number TEXT, lifecycle_state TEXT, start_time TIMESTAMPTZ, end_time TIMESTAMPTZ,
    environment TEXT, language TEXT, context JSONB DEFAULT '{}', escalation_target TEXT,
    escalation_reason TEXT, workflow_id TEXT, duration_seconds INT, total_cost_cents INT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE TABLE call_events (
    id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, call_session_id TEXT, event_type TEXT,
    from_state TEXT, to_state TEXT, payload JSONB DEFAULT '{}', occurred_at TIMESTAMPTZ
  );
  CREATE TABLE tool_invocations (
    id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, call_session_id TEXT, agent_id TEXT, agent_slug TEXT,
    tool_name TEXT, input JSONB, parameters_redacted JSONB, status TEXT, output JSONB, result JSONB,
    error_message TEXT, recovery_action TEXT, duration_ms INT, invoked_at TIMESTAMPTZ, completed_at TIMESTAMPTZ
  );
  CREATE TABLE ticket_sla_policies (
    id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
    tenant_id TEXT NOT NULL, name TEXT NOT NULL, priority TEXT NOT NULL, category_id TEXT,
    first_response_minutes INT NOT NULL DEFAULT 480, resolution_minutes INT NOT NULL DEFAULT 2880,
    is_active BOOLEAN DEFAULT true, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE TABLE ticket_sla_instances (
    id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid()::text,
    tenant_id VARCHAR NOT NULL, ticket_id VARCHAR NOT NULL, policy_id VARCHAR NOT NULL,
    response_due_at TIMESTAMPTZ, resolution_due_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE TABLE tickets (
    id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
    tenant_id TEXT NOT NULL, call_id TEXT REFERENCES call_sessions(id), subject TEXT NOT NULL,
    description TEXT DEFAULT '', status TEXT NOT NULL DEFAULT 'open', priority TEXT NOT NULL DEFAULT 'medium',
    assignee_user_id TEXT, source TEXT DEFAULT 'manual', ticket_number SERIAL,
    contact_name TEXT DEFAULT '', contact_phone TEXT DEFAULT '', created_by_user_id TEXT REFERENCES users(id),
    kind TEXT NOT NULL DEFAULT 'message', callback_due_at TIMESTAMPTZ, intake JSONB NOT NULL DEFAULT '{}',
    urgency TEXT NOT NULL DEFAULT 'normal', source_call_ref VARCHAR(128),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE TABLE ticket_activity_log (
    id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text, tenant_id TEXT NOT NULL,
    ticket_id TEXT NOT NULL REFERENCES tickets(id), user_id TEXT REFERENCES users(id),
    activity_type TEXT NOT NULL, content TEXT DEFAULT '', old_value TEXT DEFAULT '', new_value TEXT DEFAULT '',
    field_name TEXT DEFAULT '', metadata JSONB DEFAULT '{}', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE TABLE ticket_outbox (
    id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid()::text, tenant_id VARCHAR,
    event_type VARCHAR(100) NOT NULL, payload JSONB NOT NULL DEFAULT '{}', status VARCHAR(20) NOT NULL DEFAULT 'pending'
  );
  CREATE TABLE bookings (
    id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text, tenant_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'confirmed', cancellation_reason TEXT DEFAULT '', intake_data JSONB DEFAULT '{}'
  );
  CREATE TABLE action_idempotency (
    tenant_id VARCHAR NOT NULL, action VARCHAR(128) NOT NULL, key VARCHAR(256) NOT NULL,
    request_hash CHAR(64) NOT NULL, status VARCHAR(20) NOT NULL, response JSONB,
    expires_at TIMESTAMPTZ NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY (tenant_id, action, key)
  );
  CREATE TABLE action_proposals (
    id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text, tenant_id VARCHAR NOT NULL, action VARCHAR(128) NOT NULL,
    call_id VARCHAR(128), payload_hash CHAR(64) NOT NULL, payload JSONB NOT NULL, readback TEXT NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL, consumed_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE TABLE action_audit_log (
    id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text, tenant_id VARCHAR NOT NULL, action VARCHAR(128) NOT NULL,
    actor JSONB NOT NULL, input_redacted JSONB NOT NULL, result_code VARCHAR(64) NOT NULL,
    latency_ms INTEGER NOT NULL, call_id VARCHAR(128), created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
`;

const pgMem = req('pg-mem') as PgMemModule;
const { randomUUID } = req('node:crypto') as typeof import('node:crypto');
const mem = pgMem.newDb();
mem.public.registerFunction({
  name: 'gen_random_uuid',
  returns: pgMem.DataType.uuid,
  implementation: () => randomUUID(),
  impure: true,
});
// platform/db binds every tenant transaction with set_config('app.tenant_id', $1, true).
mem.public.registerFunction({
  name: 'set_config',
  args: [pgMem.DataType.text, pgMem.DataType.text, pgMem.DataType.bool],
  returns: pgMem.DataType.text,
  implementation: (_name: never, value: never) => value,
  impure: true,
});
mem.public.none(SCHEMA);

const memPg = mem.adapters.createPg();
const BasePool = memPg.Pool;
/** pg-mem's Pool, plus the `on('error')` listener platform/db attaches to every pool. */
class HarnessPool extends BasePool {
  on(): this {
    return this;
  }
}

function replaceModule(specifier: string, exports: unknown): void {
  const resolved = req.resolve(specifier);
  const fake = new Module(resolved);
  fake.filename = resolved;
  fake.loaded = true;
  fake.exports = exports;
  req.cache[resolved] = fake;
}

const realPg = req('pg') as { types: unknown; defaults: unknown; DatabaseError: unknown };
replaceModule('pg', {
  Pool: HarnessPool,
  Client: memPg.Client,
  types: realPg.types,
  defaults: realPg.defaults,
  DatabaseError: realPg.DatabaseError,
});

// ------------------------------------------------------- realtime transport edge
/** Plays the xAI realtime server on the other end of XaiRealtimeTransport's socket. */
class FakeXaiSocket extends EventEmitter {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static readonly instances: FakeXaiSocket[] = [];

  readyState = FakeXaiSocket.CONNECTING;
  readonly sent: Array<Record<string, unknown>> = [];
  private readonly sentWaiters: Array<() => void> = [];

  constructor(readonly url: string) {
    super();
    FakeXaiSocket.instances.push(this);
    setImmediate(() => {
      this.readyState = FakeXaiSocket.OPEN;
      this.emit('open');
    });
  }

  send(data: string): void {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
    for (const wake of this.sentWaiters.splice(0)) wake();
  }

  close(): void {
    if (this.readyState === FakeXaiSocket.CLOSED) return;
    this.readyState = FakeXaiSocket.CLOSED;
    setImmediate(() => this.emit('close'));
  }

  /** A server event on the wire. */
  deliver(event: Record<string, unknown>): void {
    this.emit('message', Buffer.from(JSON.stringify(event)));
  }

  /** Resolves once the client has sent an event matching `match`. */
  async waitForSent(match: (event: Record<string, unknown>) => boolean, timeoutMs = 10_000): Promise<Record<string, unknown>> {
    const started = Date.now();
    for (;;) {
      const hit = this.sent.find(match);
      if (hit) return hit;
      if (Date.now() - started > timeoutMs) throw new Error('fake xAI socket: expected client event never arrived');
      await new Promise<void>((resolve) => {
        this.sentWaiters.push(resolve);
        setTimeout(resolve, 50);
      });
    }
  }
}

class UnusedWebSocketServer extends EventEmitter {}

replaceModule('ws', Object.assign(FakeXaiSocket, { WebSocket: FakeXaiSocket, WebSocketServer: UnusedWebSocketServer }));

// ----------------------------------------------------------------- the call script
type Step =
  | { caller: string }
  | { agent: string }
  | { tool: string; args: Record<string, unknown> };

interface CaseSpec {
  name: string;
  tenantId: string;
  steps: Step[];
  /** How many times the phone teardown runs (finalizeStream twice). */
  teardowns: number;
}

const CASES: CaseSpec[] = [
  {
    name: 'request_then_hangup',
    tenantId: 'tenant-sharp-line',
    steps: [
      { agent: 'Thanks for calling Sharp Line, how can I help?' },
      { caller: 'Hi, this is Dana, I need a fade Friday at nine' },
      { agent: 'Sure, let me check Friday at nine for you.' },
      { caller: 'You can reach me at 555 010 0142 if it gets cut off' },
    ],
    teardowns: 1,
  },
  {
    name: 'teardown_twice',
    tenantId: 'tenant-sharp-line',
    steps: [
      { agent: 'Thanks for calling Sharp Line, how can I help?' },
      { caller: 'Hi, this is Dana, I need a fade Friday at nine' },
    ],
    teardowns: 2,
  },
  {
    name: 'name_only',
    tenantId: 'tenant-sharp-line',
    steps: [{ agent: 'Thanks for calling Sharp Line, how can I help?' }, { caller: "Hi, it's Dana" }],
    teardowns: 1,
  },
  {
    // The demo tenant answers createServiceTicket with a canned success and
    // writes nothing hasCallArtifact can see: only the runtime guard stops a floor.
    name: 'write_tool_ok',
    tenantId: 'demo',
    steps: [
      { agent: 'Thanks for calling Sharp Line, how can I help?' },
      { caller: 'Hi, this is Dana, I need a fade Friday at nine' },
      { tool: 'createServiceTicket', args: { callerName: 'Dana', reason: 'Wants a fade Friday at nine' } },
      { agent: 'I have passed that to the shop.' },
    ],
    teardowns: 1,
  },
  {
    name: 'never_heard',
    tenantId: 'tenant-sharp-line',
    steps: [{ agent: 'Thanks for calling Sharp Line, how can I help?' }],
    teardowns: 1,
  },
];

interface FloorTicketRow {
  description: string;
  contactName: string;
  contactPhone: string;
  kind: string;
  source: string;
  callId: string | null;
}

interface CaseResult {
  name: string;
  callId: string;
  outcomes: string[];
  floorTickets: FloorTicketRow[];
  floorIdempotencyKeys: string[];
  floorAuditResultCodes: string[];
  toolOutputs: Array<{ tool: string; success: unknown }>;
}

const log = {
  info: () => {},
  error: () => {},
};

async function main(): Promise<void> {
  // Production modules, imported only after both edges are in place.
  const { createRealtimeSession } = await import('../openaiSession');
  const { closeRealtimeForPhoneTeardown } = await import('../phoneCallTeardown');
  const { createPlatformPersistenceAdapter } = await import('../callPersistence');
  const { CallLifecycleCoordinator } = await import('../../../../platform/runtime/lifecycle/CallLifecycleCoordinator');
  const { FILE_FLOOR, FLOOR_SUBJECT, floorIdempotencyKey } = await import('../../../../platform/actions/tickets');
  // The route module finalizeStream lives in: proves its whole graph loads under this loader.
  const stream = await import('../../routes/stream');

  for (const id of new Set(CASES.map((c) => c.tenantId))) {
    mem.public.none(`INSERT INTO tenants (id, name) VALUES ('${id}', 'Sharp Line Barbers')`);
  }

  const results: CaseResult[] = [];
  for (const spec of CASES) {
    const coordinator = new CallLifecycleCoordinator(spec.tenantId, createPlatformPersistenceAdapter(spec.tenantId));
    const session = await createRealtimeSession({
      tenantId: spec.tenantId,
      agentConfig: {
        agentId: 'agent-sharp-line',
        tenantId: spec.tenantId,
        coreVersion: '2.0.0',
        rolePackageId: 'barbershop',
        rolePackageVersion: '1.0.0',
        rolePrompt: 'You answer the phone for Sharp Line Barbers.',
        systemPrompt: 'You answer the phone for Sharp Line Barbers.',
        greeting: 'Thanks for calling Sharp Line, how can I help?',
        voice: 'ara',
        model: 'grok-voice-3.0',
        language: 'en',
        preferredLanguage: 'en',
        timeZone: 'America/New_York',
        tools: [
          {
            name: 'createServiceTicket',
            description: 'Take a message for the shop.',
            parameters: {
              type: 'object',
              properties: { callerName: { type: 'string' }, reason: { type: 'string' } },
              required: [],
            },
          },
        ],
        guardrails: [],
        metadata: { businessName: 'Sharp Line Barbers' },
      },
      callerNumber: '+15550100142',
      calledNumber: '+15550199999',
      callSid: `CA-harness-${spec.name}`,
      direction: 'inbound',
      templateKey: 'barbershop',
      lifecycleCoordinator: coordinator,
      playbackConfirm: 'twilio_mark',
    });
    await session.session.connect({ apiKey: 'harness-no-network' });
    const xai = FakeXaiSocket.instances[FakeXaiSocket.instances.length - 1];
    const toolOutputs: CaseResult['toolOutputs'] = [];

    let callN = 0;
    for (const step of spec.steps) {
      if ('caller' in step) {
        xai.deliver({ type: 'conversation.item.input_audio_transcription.completed', transcript: step.caller });
      } else if ('agent' in step) {
        xai.deliver({ type: 'response.created' });
        xai.deliver({ type: 'response.output_audio_transcript.done', transcript: step.agent });
        xai.deliver({ type: 'response.done', response: {} });
      } else {
        callN += 1;
        const callId = `fc-${callN}`;
        xai.deliver({
          type: 'response.function_call_arguments.done',
          call_id: callId,
          name: step.tool,
          arguments: JSON.stringify(step.args),
        });
        const sent = await xai.waitForSent(
          (e) => e.type === 'conversation.item.create' && (e.item as { call_id?: string } | undefined)?.call_id === callId,
        );
        const output = JSON.parse(String((sent.item as { output?: unknown }).output)) as { success?: unknown };
        toolOutputs.push({ tool: step.tool, success: output.success });
      }
    }
    // Let the transport's event handlers run before the caller hangs up.
    await new Promise((resolve) => setImmediate(resolve));

    const outcomes: string[] = [];
    for (let i = 0; i < spec.teardowns; i += 1) {
      const { floor } = await closeRealtimeForPhoneTeardown(session, 'caller_hangup', log);
      outcomes.push(await floor);
    }

    const callId = session.callSessionId;
    const tickets = mem.public.many(
      `SELECT t.description, t.contact_name, t.contact_phone, t.kind, t.source, t.call_id
         FROM tickets t
        WHERE t.tenant_id = '${spec.tenantId}' AND t.source_call_ref = '${callId}' AND t.subject = '${FLOOR_SUBJECT.replace(/'/g, "''")}'`,
    );
    const keys = mem.public.many(
      `SELECT key FROM action_idempotency WHERE tenant_id = '${spec.tenantId}' AND action = '${FILE_FLOOR}' AND key = '${floorIdempotencyKey(callId)}'`,
    );
    const audits = mem.public.many(
      `SELECT result_code FROM action_audit_log WHERE tenant_id = '${spec.tenantId}' AND action = '${FILE_FLOOR}' AND call_id = '${callId}'`,
    );
    results.push({
      name: spec.name,
      callId,
      outcomes,
      floorTickets: tickets.map((row) => ({
        description: String(row.description ?? ''),
        contactName: String(row.contact_name ?? ''),
        contactPhone: String(row.contact_phone ?? ''),
        kind: String(row.kind ?? ''),
        source: String(row.source ?? ''),
        callId: row.call_id === null || row.call_id === undefined ? null : String(row.call_id),
      })),
      floorIdempotencyKeys: keys.map((row) => String(row.key)),
      floorAuditResultCodes: audits.map((row) => String(row.result_code)),
      toolOutputs,
    });
  }

  const report = {
    runtime: {
      node: process.versions.node,
      execArgv: process.execArgv,
      entry: path.relative(repoRoot, process.argv[1] ?? ''),
      vitest: Boolean(process.env.VITEST) || 'vitest' in globalThis || '__vitest_worker__' in globalThis,
      cjsRequire: typeof require === 'function',
      streamRouteLoaded: typeof stream.attachWebSocket === 'function',
      fakeSockets: FakeXaiSocket.instances.length,
    },
    cases: results,
  };
  process.stdout.write(`\n${RESULT_MARKER}${JSON.stringify(report)}\n`, () => process.exit(0));
}

main().catch((err: unknown) => {
  process.stdout.write(`\n${RESULT_MARKER}${JSON.stringify({ error: String(err instanceof Error ? err.stack : err) })}\n`, () =>
    process.exit(1),
  );
});
