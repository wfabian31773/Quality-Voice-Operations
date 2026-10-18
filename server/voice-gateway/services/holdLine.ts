/**
 * Runtime-owned hold line (RT-HOLD-LINE). Runs on every call, for every
 * agent and every tool: while a tool call is in flight and no agent audio has
 * played for HOLD_LINE_DELAY_MS, she says one short line ("One moment while
 * I check that.") in the call's current language.
 *
 * - At most once per wait. A wait starts at the first tool call of the
 *   agent's turn and covers the whole chain of back-to-back tool calls the
 *   model makes (one hold line, not one per call). It ends when the caller
 *   starts a new turn with no tool running.
 * - "No agent audio" is counted from when the agent's last audio finished
 *   playing, on the same signal the VA-15 silence watchdog uses: the Twilio
 *   `mark` echo in 'twilio_mark' mode, response.done in 'response_done' mode.
 *   Audio that started before the tool call (her own "let me check") only
 *   moves the deadline: the line comes HOLD_LINE_DELAY_MS after it stops.
 * - Never while the caller is speaking (server VAD speech_started without
 *   speech_stopped): if they are at the deadline, that tool call gets none.
 * - Never once every tool has returned (the result arrived first).
 * - Never in a wait where the agent has already spoken after the tool call
 *   started (a reply to "hello?", a line between chained calls).
 * - Never in a call language the phrase table has no row for (at the start
 *   or after record_language_change): silence during the tool, never English.
 *
 * Pure: no I/O, timers injectable, effects go through callbacks. The phrase
 * table is runtime-owned and vertical-neutral; a new locale is one row.
 */
import type { PlaybackConfirmMode } from './silenceWatchdog';

export const HOLD_LINE_DELAY_MS = 800;
/** A configured delay is clamped into this range ("about two heartbeats"). */
export const HOLD_LINE_DELAY_MIN_MS = 700;
export const HOLD_LINE_DELAY_MAX_MS = 1_000;

/** One line per language (base code). Fixed text only; never caller data. */
export const HOLD_LINE_PHRASES: Readonly<Record<string, string>> = {
  en: 'One moment while I check that.',
  es: 'Un momento mientras lo reviso.',
};
export const HOLD_LINE_DEFAULT_LANGUAGE = 'en';

const LANGUAGE_ALIASES: Readonly<Record<string, string>> = {
  english: 'en',
  ingles: 'en',
  inglés: 'en',
  spanish: 'es',
  espanol: 'es',
  español: 'es',
};

/**
 * The phrase-table key for a language tag or name ("es-US", "Spanish", "en"),
 * or undefined when the table has no row for it.
 */
export function holdLineLanguage(language: unknown): string | undefined {
  if (typeof language !== 'string') return undefined;
  const lower = language.trim().toLowerCase();
  if (!lower) return undefined;
  const base = LANGUAGE_ALIASES[lower] ?? lower.split(/[-_\s]/)[0];
  return base in HOLD_LINE_PHRASES ? base : undefined;
}

/** The line for a language, or undefined when the table has no row (no hold line: never English to a non-English caller). */
export function holdLinePhrase(language: unknown): string | undefined {
  const row = holdLineLanguage(language);
  return row === undefined ? undefined : HOLD_LINE_PHRASES[row];
}

/**
 * The call's phrase-table row: `fallback` when no language is given (missing
 * or empty), null for any other language without a row (fr, de, an
 * unrecognised code): that call gets no hold line.
 */
function callLanguage(language: unknown, fallback: string | null): string | null {
  if (typeof language !== 'string' || !language.trim()) return fallback;
  return holdLineLanguage(language) ?? null;
}

/** The one-response instruction that speaks a hold line and nothing else. */
export function holdLineInstruction(phrase: string): string {
  return `Say exactly: "${phrase}". Nothing else.`;
}

export function isHoldLineInstruction(instructions: unknown): boolean {
  return typeof instructions === 'string'
    && Object.values(HOLD_LINE_PHRASES).some((phrase) => instructions === holdLineInstruction(phrase));
}

function delayFrom(source: unknown): number | undefined {
  if (!source || typeof source !== 'object') return undefined;
  const raw = (source as Record<string, unknown>).holdLineDelayMs;
  const value = typeof raw === 'string' && raw.trim() ? Number(raw) : raw;
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * The hold-line delay for a call: `holdLineDelayMs` from the agent's
 * metadata, else from the tenant's settings, else HOLD_LINE_DELAY_MS;
 * clamped to HOLD_LINE_DELAY_MIN_MS..HOLD_LINE_DELAY_MAX_MS.
 */
export function resolveHoldLineDelayMs(input: { agentMetadata?: unknown; tenantSettings?: unknown } = {}): number {
  const configured = delayFrom(input.agentMetadata) ?? delayFrom(input.tenantSettings) ?? HOLD_LINE_DELAY_MS;
  return Math.min(HOLD_LINE_DELAY_MAX_MS, Math.max(HOLD_LINE_DELAY_MIN_MS, Math.round(configured)));
}

export interface HoldLineSaid {
  /** The tool call in flight when the line was asked for (the latest in the chain). */
  tool: string;
  language: string;
  /** The configured delay. */
  delayMs: number;
  /** Since the wait's first tool call started. */
  waitedMs: number;
}

export interface HoldLineTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface HoldLineDeps {
  /** Default HOLD_LINE_DELAY_MS. */
  delayMs?: number;
  /** Default 'response_done'. */
  playbackConfirm?: PlaybackConfirmMode;
  /** The call's language at the start (agent config); record_language_change moves it. */
  language?: string;
  /**
   * Speak the line now. Returns false when it could not start without
   * overlapping another response (one in flight, requested or due).
   */
  say(phrase: string, language: string): boolean;
  /** One log line + call event per hold line spoken. */
  onSaid?(said: HoldLineSaid): void;
  timers?: HoldLineTimers;
  /** Default Date.now. */
  now?(): number;
}

interface Wait {
  startedAt: number;
  /** Latest tool call in the wait (the one the line covers). */
  tool: string;
  said: boolean;
  /** The agent spoke after the wait started: no hold line in this wait. */
  agentSpoke: boolean;
}

const defaultTimers: HoldLineTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export class HoldLine {
  readonly delayMs: number;
  private readonly playbackConfirm: PlaybackConfirmMode;
  private readonly timers: HoldLineTimers;
  private readonly now: () => number;
  /** The call's phrase-table row; null: a language with no row, so no hold line (silence, as before RT-HOLD-LINE). */
  private language: string | null;
  /** The agent's configured language's row (English when none is configured). */
  private readonly configuredLanguage: string | null;
  private toolsRunning = 0;
  /** Tool calls started so far; a call the caller talked over at its deadline is skipped. */
  private toolSeq = 0;
  private skippedThroughToolSeq = 0;
  private wait: Wait | null = null;
  /** A response is being generated (any kind, the hold line included). */
  private responding = false;
  /** The response being generated has produced audio. */
  private responseHadAudio = false;
  /** 'twilio_mark': the last response's audio may still be playing. */
  private awaitingPlayback = false;
  /** When agent audio last finished playing (0: never). */
  private quietSince = 0;
  private callerSpeaking = false;
  private stopped = false;
  private timer: unknown = null;

  constructor(private readonly deps: HoldLineDeps) {
    this.delayMs = deps.delayMs ?? HOLD_LINE_DELAY_MS;
    this.playbackConfirm = deps.playbackConfirm ?? 'response_done';
    this.timers = deps.timers ?? defaultTimers;
    this.now = deps.now ?? Date.now;
    this.configuredLanguage = callLanguage(deps.language, HOLD_LINE_DEFAULT_LANGUAGE);
    this.language = this.configuredLanguage;
  }

  get currentLanguage(): string | null {
    return this.language;
  }

  /**
   * The call switched language (record_language_change). One without a row
   * turns the hold line off; an empty one goes back to the agent's language.
   */
  setLanguage(language: unknown): void {
    this.language = callLanguage(language, this.configuredLanguage);
  }

  toolStarted(tool: string): void {
    this.toolsRunning += 1;
    this.toolSeq += 1;
    if (this.wait) this.wait.tool = tool;
    else this.wait = { startedAt: this.now(), tool, said: false, agentSpoke: false };
    this.arm();
  }

  toolEnded(): void {
    this.toolsRunning = Math.max(0, this.toolsRunning - 1);
    // The result arrived first: nothing to cover until another call starts.
    if (this.toolsRunning === 0) this.clearTimer();
  }

  /** A response was created (the hold line's own included): agent audio may follow. */
  agentResponseStarted(): void {
    this.responding = true;
    this.responseHadAudio = false;
    this.clearTimer();
  }

  /**
   * The current response produced audio. Anything but the hold line is the
   * agent speaking (the answer, a line between chained calls, a reply to
   * "hello?"): no hold line for the rest of the wait.
   */
  agentAudioStarted(holdLine: boolean): void {
    this.responseHadAudio = true;
    if (holdLine || !this.wait) return;
    this.wait.agentSpoke = true;
  }

  /**
   * The response finished (done or cancelled). One with audio: quiet from
   * now ('response_done') or from its playback echo ('twilio_mark'). One
   * without (a function call only) leaves the quiet where it was.
   */
  agentResponseEnded(): void {
    this.responding = false;
    if (!this.responseHadAudio) {
      this.arm();
      return;
    }
    if (this.playbackConfirm === 'response_done') {
      this.playbackFinished();
      return;
    }
    this.awaitingPlayback = true;
  }

  /** 'twilio_mark' mode: Twilio echoed the latest turn's mark (all audio before it played), or a barge-in cleared it. */
  agentPlaybackDone(): void {
    if (!this.awaitingPlayback) return;
    this.playbackFinished();
  }

  callerSpeechStarted(): void {
    this.callerSpeaking = true;
    this.callerTurnStarted();
  }

  /**
   * A new caller turn (speech, or widget typed text): with nothing running,
   * the next tool call is a new wait.
   */
  callerTurnStarted(): void {
    if (this.toolsRunning === 0) this.wait = null;
  }

  callerSpeechStopped(): void {
    this.callerSpeaking = false;
  }

  /** Session closed: clear the timer, never speak again. */
  stop(): void {
    this.stopped = true;
    this.clearTimer();
  }

  private playbackFinished(): void {
    this.awaitingPlayback = false;
    this.quietSince = this.now();
    this.arm();
  }

  private arm(): void {
    this.clearTimer();
    const wait = this.wait;
    if (this.stopped || !wait || wait.said || wait.agentSpoke) return;
    if (this.toolsRunning === 0 || this.toolSeq <= this.skippedThroughToolSeq) return;
    if (this.responding || this.awaitingPlayback) return;
    const dueAt = Math.max(wait.startedAt, this.quietSince) + this.delayMs;
    this.timer = this.timers.setTimeout(() => this.onDeadline(), Math.max(0, dueAt - this.now()));
  }

  private onDeadline(): void {
    this.timer = null;
    const wait = this.wait;
    if (this.stopped || !wait || wait.said || wait.agentSpoke || this.toolsRunning === 0) return;
    if (this.responding || this.awaitingPlayback) return;
    if (this.callerSpeaking) {
      // Talked over at the deadline: this tool call gets none.
      this.skippedThroughToolSeq = this.toolSeq;
      return;
    }
    const language = this.language;
    // No row for the call's language: silence, never English.
    if (language === null) return;
    if (!this.deps.say(HOLD_LINE_PHRASES[language], language)) return;
    wait.said = true;
    this.deps.onSaid?.({ tool: wait.tool, language, delayMs: this.delayMs, waitedMs: this.now() - wait.startedAt });
  }

  private clearTimer(): void {
    if (this.timer !== null) this.timers.clearTimeout(this.timer);
    this.timer = null;
  }
}
