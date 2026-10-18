/**
 * The `ws` module as the runtime sees it inside the harness: the wire, and
 * only the wire, is fake. routes/stream.ts gets a WebSocketServer whose
 * upgrades hand it the fake Twilio side of the call; XaiRealtimeTransport
 * gets a client WebSocket that reaches the fake xAI server. Any other URL
 * throws, so a harness run can't open a real socket.
 */
import { EventEmitter } from 'node:events';
import { CLOSED, OPEN } from './fakeTwilio';
import { currentWorld } from './world';

/** The bearer token the harness puts in the runtime's env (never a real key; edges.ts). */
export const HARNESS_XAI_KEY = 'rt11-offline-no-network';
export const XAI_URL_PREFIX = 'wss://api.x.ai/';

export class FakeXaiClientSocket extends EventEmitter {
  static readonly CONNECTING = 0;
  static readonly OPEN = OPEN;
  static readonly CLOSING = 2;
  static readonly CLOSED = CLOSED;
  readyState = 0;

  constructor(readonly url: string, opts?: { headers?: Record<string, string> }) {
    super();
    if (!url.startsWith(XAI_URL_PREFIX)) throw new Error(`RT-11 harness: no network (refused ${url})`);
    const world = currentWorld();
    if (!world) throw new Error('RT-11 harness: xAI socket opened outside a run');
    const authorization = opts?.headers?.Authorization;
    world.xai.authorization = authorization;
    if (authorization !== `Bearer ${HARNESS_XAI_KEY}`) throw new Error('RT-11 harness: unexpected xAI credentials');
    world.xaiSocket = this;
    setImmediate(() => {
      if (this.readyState !== 0) return;
      this.readyState = OPEN;
      this.emit('open');
    });
  }

  send(data: string): void {
    if (this.readyState !== OPEN) throw new Error('fake xAI socket is not open');
    currentWorld()?.xai.onClientEvent(JSON.parse(data) as Record<string, unknown>);
  }

  close(): void {
    if (this.readyState === CLOSED) return;
    this.readyState = CLOSED;
    setImmediate(() => this.emit('close'));
  }

  /** A server event on the wire. */
  deliver(event: Record<string, unknown>): void {
    if (this.readyState !== OPEN) return;
    this.emit('message', Buffer.from(JSON.stringify(event)));
  }
}

export class FakeWebSocketServer extends EventEmitter {
  constructor(_opts?: unknown) {
    super();
  }

  handleUpgrade(_req: unknown, _socket: unknown, _head: unknown, done: (ws: unknown) => void): void {
    const world = currentWorld();
    if (!world) throw new Error('RT-11 harness: stream upgrade outside a run');
    done(world.twilio.attach());
  }

  close(): void {}
}

/** Module exports for `require('ws')`: default/`WebSocket` = client, plus the server. */
export const fakeWsModule = Object.assign(FakeXaiClientSocket, {
  WebSocket: FakeXaiClientSocket,
  WebSocketServer: FakeWebSocketServer,
  Server: FakeWebSocketServer,
});
