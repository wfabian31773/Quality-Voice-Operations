/**
 * Everything one synthetic call touches outside the runtime code: the fake
 * Twilio side, the fake xAI server, and recorders for the edges the harness
 * replaces (database, call persistence, lifecycle coordinator). The module
 * edges are installed once per process (edges.ts) and route to the current
 * world, so every run starts from nothing.
 */
import { EventEmitter } from 'node:events';
import { settle, type VirtualClock } from './clock';
import { FakeTwilioCall } from './fakeTwilio';
import { FakeXaiServer, type FakeXaiScript } from './fakeXai';

export interface DbStatement {
  at: number;
  sql: string;
}

export interface CallEventRecord {
  at: number;
  type: string;
  payload?: Record<string, unknown>;
}

export interface SlowQuery {
  match: RegExp;
  latencyMs: number;
}

/** The pg Pool the database edge hands out: records every statement, returns no rows. */
export class FakePool {
  constructor(private readonly world: () => CallWorld | null) {}

  async query(text: unknown, _values?: unknown[]): Promise<{ rows: Array<Record<string, unknown>>; rowCount: number; fields: unknown[]; command: string }> {
    const sql = typeof text === 'string' ? text : String((text as { text?: unknown } | null)?.text ?? '');
    const world = this.world();
    if (world) {
      world.db.push({ at: world.elapsed, sql: sql.replace(/\s+/g, ' ').trim() });
      const slow = world.slowQueries.find((q) => q.match.test(sql));
      if (slow) await new Promise<void>((resolve) => setTimeout(resolve, slow.latencyMs));
    }
    return { rows: [], rowCount: 0, fields: [], command: '' };
  }

  async connect(): Promise<{ query: FakePool['query']; release: () => void }> {
    return { query: (text, values) => this.query(text, values), release: () => {} };
  }

  on(): this {
    return this;
  }

  async end(): Promise<void> {}
}

/** Lifecycle coordinator stand-in (routes/twilio getCoordinator): accepts every call, keeps nothing. */
export function fakeCoordinator(): EventEmitter {
  const target = new EventEmitter();
  return new Proxy(target, {
    get(obj, prop, receiver) {
      if (prop in obj) {
        const value = Reflect.get(obj, prop, receiver);
        return typeof value === 'function' ? value.bind(obj) : value;
      }
      return () => undefined;
    },
  });
}

let current: CallWorld | null = null;

export function currentWorld(): CallWorld | null {
  return current;
}

export function setCurrentWorld(world: CallWorld | null): void {
  current = world;
}

export class CallWorld {
  readonly twilio: FakeTwilioCall;
  readonly xai: FakeXaiServer;
  readonly db: DbStatement[] = [];
  readonly events: CallEventRecord[] = [];
  readonly states: Array<{ at: number; state: string }> = [];
  readonly outcomes: Array<{ at: number; outcome: string }> = [];
  readonly floorOutcomes: string[] = [];
  readonly finalized: Array<{ at: number; status: string }> = [];
  readonly logs: string[] = [];
  readonly coordinator = fakeCoordinator();
  readonly floorSettled: Array<Promise<unknown>> = [];
  readonly slowQueries: SlowQuery[];
  private readonly agentFrames = new Map<string, number>();

  constructor(
    readonly clock: VirtualClock,
    readonly callSid: string,
    /** What agentLoader.loadAgentConfig returns for this call (edges.ts). */
    readonly agentConfig: Record<string, unknown>,
    script: FakeXaiScript,
    slow: Array<{ match: string; latencyMs: number }> = [],
  ) {
    this.slowQueries = slow.map((q) => ({ match: new RegExp(q.match, 'i'), latencyMs: q.latencyMs }));
    this.twilio = new FakeTwilioCall(() => this.elapsed, (b64) => this.agentFrames.get(b64), callSid);
    this.xai = new FakeXaiServer(
      {
        now: () => this.elapsed,
        deliver: (event) => this.xaiSocket?.deliver(event),
        tagAgentFrame: (b64, response) => this.agentFrames.set(b64, response),
      },
      script,
    );
  }

  /** Set by the fake `ws` client when the transport dials xAI. */
  xaiSocket: { deliver(event: Record<string, unknown>): void } | null = null;

  get elapsed(): number {
    return this.clock.elapsed;
  }

  private readonly realWork = new Set<Promise<unknown>>();
  /** Tracked real work settled since the last drainReal; what it unblocked hasn't been given its turns yet. */
  private realSettled = false;

  /**
   * Real (non-virtual) async work an edge awaits, e.g. real I/O. The clock
   * doesn't advance until it settles (drainReal), so how long it takes in
   * real time can't move it on the virtual timeline.
   */
  trackReal<T>(work: Promise<T>): Promise<T> {
    this.realWork.add(work);
    const done = () => {
      this.realWork.delete(work);
      this.realSettled = true;
    };
    work.then(done, done);
    return work;
  }

  /**
   * Wait until no tracked real work is pending, letting what it unblocks run
   * too. That includes work that settled just before this call: its
   * continuation may still be an event-loop turn away (e.g. the fake xAI
   * socket's open after the last call-setup query), and it gets the same
   * turns as work that settles in here, wherever the real time put it.
   */
  async drainReal(): Promise<void> {
    while (this.realWork.size > 0 || this.realSettled) {
      this.realSettled = false;
      await Promise.allSettled([...this.realWork]);
      await settle(2);
    }
  }

  event(type: string): CallEventRecord[] {
    return this.events.filter((e) => e.type === type);
  }
}
