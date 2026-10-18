/**
 * Module edges for the audio harness, installed once per process before the
 * runtime is loaded. The harness runs in a plain Node process with tsx's CJS
 * loader (the same module loading production uses: `node --import tsx`), so
 * an edge is a require-cache entry, exactly like RT-12's prod-process floor
 * harness. Everything not listed here is the production code:
 * routes/stream.ts (Twilio media-stream handling, finalizeStream),
 * openaiSession.ts (silence watchdog, marks, invariants, floor),
 * xaiRealtimeTransport.ts, phoneCallTeardown.ts, callInvariants.ts.
 *
 * Edges:
 * - `ws`: fake wire to the fake Twilio side and the fake xAI server (wire.ts);
 * - platform/db: a pool that records statements and returns no rows;
 * - callPersistence: records call events, states, outcomes (the call row);
 * - numberLookup / checkBudget: the tenant's agent row and an open budget;
 * - agentLoader.loadAgentConfig: a fixed barbershop agent (see AGENT);
 * - routes/twilio: a no-op lifecycle coordinator, no Twilio REST adapter;
 * - phoneCallTeardown: the real function, wrapped to record the floor outcome.
 *
 * The runtime reads XAI_API_KEY and VOICE_GATEWAY_STREAM_TOKEN; the harness
 * sets both to fixed dummies (it never reads env) so stream.ts takes its
 * production path. The fake xAI socket refuses any other bearer.
 */
import Module, { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HARNESS_XAI_KEY, fakeWsModule } from './wire';
import { currentWorld, FakePool } from './world';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
export const HARNESS_STREAM_TOKEN = 'rt11-offline-stream-token';
export const TENANT_ID = 'tenant-rt11-sharp-line';
export const AGENT_ID = 'agent-rt11-sharp-line';
export const CALLER_NUMBER = '+15550100142';
export const CALLED_NUMBER = '+15550199999';
export const DEFAULT_GREETING = 'Thanks for calling Sharp Line Barbers, this is Ara. How can I help you today?';

const req = createRequire(path.join(REPO_ROOT, 'package.json'));

function abs(rel: string): string {
  return path.join(REPO_ROOT, rel);
}

function replaceModule(specifier: string, exports: unknown): void {
  const resolved = req.resolve(specifier);
  const fake = new Module(resolved);
  fake.filename = resolved;
  fake.loaded = true;
  fake.exports = exports;
  req.cache[resolved] = fake;
}

function load<T>(rel: string): T {
  return req(abs(rel)) as T;
}

/** The barbershop agent every synthetic call talks to (shape of LoadedAgentConfig). */
export function agentConfig(greeting: string): Record<string, unknown> {
  return {
    agentId: AGENT_ID,
    tenantId: TENANT_ID,
    coreVersion: '2.0.0',
    rolePackageId: 'barbershop',
    rolePackageVersion: '1.0.0',
    rolePrompt: 'You answer the phone for Sharp Line Barbers.',
    systemPrompt: 'You answer the phone for Sharp Line Barbers.',
    greeting,
    voice: 'ara',
    model: 'grok-voice-3.0',
    language: 'en',
    preferredLanguage: 'en',
    timeZone: 'America/New_York',
    tools: [
      // A runtime built-in read tool (no tenant data needed), so a scenario can make one tool call.
      {
        name: 'get_current_tenant_time',
        description: "The shop's current local date and time.",
        parameters: { type: 'object', properties: {}, required: [] },
      },
    ],
    guardrails: [],
    metadata: { businessName: 'Sharp Line Barbers' },
  };
}

type Recorded = (...args: unknown[]) => Promise<unknown>;

export interface RuntimeModules {
  attachWebSocket: (server: unknown) => void;
  /** For in-memory overrides in mutation tests only. */
  silenceWatchdog: typeof import('../../../server/voice-gateway/services/silenceWatchdog');
  xaiRealtimeTransport: typeof import('../../../server/voice-gateway/services/xaiRealtimeTransport');
}

let installed: RuntimeModules | null = null;

export function installEdges(): RuntimeModules {
  if (installed) return installed;
  process.env.XAI_API_KEY = HARNESS_XAI_KEY;
  process.env.VOICE_GATEWAY_STREAM_TOKEN = HARNESS_STREAM_TOKEN;

  replaceModule('ws', fakeWsModule);

  const pool = new FakePool(currentWorld);
  const realDb = load<Record<string, unknown>>('platform/db');
  type Client = Awaited<ReturnType<FakePool['connect']>>;
  const inTransaction = async <T>(fn: (client: Client) => Promise<T>): Promise<T> => {
    const client = await pool.connect();
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  };
  replaceModule(abs('platform/db'), {
    ...realDb,
    getPlatformPool: () => pool,
    getPrivilegedPool: () => pool,
    getPlatformDb: () => {
      throw new Error('RT-11 harness: drizzle is not wired to the fake database');
    },
    withTenantClient: (_tenantId: string, fn: (client: Client) => Promise<unknown>) => inTransaction(fn),
    withPrivilegedClient: (fn: (client: Client) => Promise<unknown>) => inTransaction(fn),
    pingDatabasePools: async () => ({ rows: [] }),
  });

  const realPersistence = load<Record<string, unknown>>('server/voice-gateway/services/callPersistence');
  const record = (fn: (world: NonNullable<ReturnType<typeof currentWorld>>, ...args: unknown[]) => unknown): Recorded =>
    async (...args: unknown[]) => {
      const world = currentWorld();
      return world ? fn(world, ...args) : undefined;
    };
  replaceModule(abs('server/voice-gateway/services/callPersistence'), {
    ...realPersistence,
    createCallSession: record((world) => `cs-${world.callSid}`),
    writeCallEvent: record((world, _tenant, _call, type, _from, _to, payload) => {
      world.events.push({ at: world.elapsed, type: String(type), payload: payload as Record<string, unknown> | undefined });
    }),
    updateCallState: record((world, _tenant, _call, state) => {
      world.states.push({ at: world.elapsed, state: String(state) });
    }),
    finalizeCallSession: record((world, _tenant, _call, status) => {
      world.finalized.push({ at: world.elapsed, status: String(status) });
    }),
    persistCallOutcome: record((world, _tenant, _call, outcome) => {
      world.outcomes.push({ at: world.elapsed, outcome: String(outcome) });
    }),
    createPlatformPersistenceAdapter: () => new Proxy({}, { get: () => async () => undefined }),
  });

  const realLookup = load<Record<string, unknown>>('server/voice-gateway/services/numberLookup');
  replaceModule(abs('server/voice-gateway/services/numberLookup'), {
    ...realLookup,
    getAgentConfig: async (tenantId: string, agentId: string) => ({
      id: agentId,
      name: 'Ara',
      type: 'barbershop',
      tenant_id: tenantId,
      metadata: {},
      tenant_settings: {},
      tenant_timezone: 'America/New_York',
      language: 'en',
    }),
    getAgentToolOverrides: async () => [],
  });

  const realBudget = load<Record<string, unknown>>('platform/billing/budget/checkBudget');
  replaceModule(abs('platform/billing/budget/checkBudget'), {
    ...realBudget,
    checkBudget: async () => ({
      allowed: true,
      plan: 'pro',
      status: 'active',
      isTrial: false,
      usage: { callsUsed: 0, callLimit: 1_000, aiMinutesUsed: 0, aiMinuteLimit: 1_000 },
    }),
  });

  const realLoader = load<Record<string, unknown>>('server/voice-gateway/services/agentLoader');
  replaceModule(abs('server/voice-gateway/services/agentLoader'), {
    ...realLoader,
    loadAgentConfig: () => currentWorld()?.agentConfig ?? agentConfig(DEFAULT_GREETING),
  });

  replaceModule(abs('server/voice-gateway/routes/twilio'), {
    getCoordinator: () => currentWorld()?.coordinator,
    getTwilioAdapter: () => undefined,
    tenantCoordinators: new Map(),
  });

  const teardown = load<typeof import('../../../server/voice-gateway/services/phoneCallTeardown')>(
    'server/voice-gateway/services/phoneCallTeardown',
  );
  replaceModule(abs('server/voice-gateway/services/phoneCallTeardown'), {
    ...teardown,
    closeRealtimeForPhoneTeardown: async (...args: Parameters<typeof teardown.closeRealtimeForPhoneTeardown>) => {
      const result = await teardown.closeRealtimeForPhoneTeardown(...args);
      const world = currentWorld();
      if (world) world.floorSettled.push(result.floor.then((outcome) => world.floorOutcomes.push(String(outcome))));
      return result;
    },
  });

  const stream = load<{ attachWebSocket: RuntimeModules['attachWebSocket'] }>('server/voice-gateway/routes/stream');
  installed = {
    attachWebSocket: stream.attachWebSocket,
    silenceWatchdog: load<RuntimeModules['silenceWatchdog']>('server/voice-gateway/services/silenceWatchdog'),
    xaiRealtimeTransport: load<RuntimeModules['xaiRealtimeTransport']>('server/voice-gateway/services/xaiRealtimeTransport'),
  };
  return installed;
}
