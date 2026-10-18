/**
 * Audio scenario format (RT-11). One YAML file per scenario, in the RT-10
 * style: id + tags (`core`, `flow:<name>`) + what the caller does + what is
 * graded at the end. Graded on end state: the call outcome, the floor and
 * the database writes, plus what Twilio was sent and what the caller heard.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { loadYaml } from '../yaml';
import type { CallerLang } from './callerVoice';

export type Transcription = 'ok' | 'empty' | 'none';

export type CallerStep =
  /** Speak a line (synthetic voice). The provider transcribes it per `transcription` (default ok). */
  | { say: string; transcription?: Transcription }
  /** Digital silence. */
  | { silence: number }
  /** Faint open-line hiss, under any speech VAD. */
  | { lineNoise: number }
  /** Stay quiet until the agent's current turn has been audible this long (a barge-in point). */
  | { waitAgentPlaying: number }
  /** Stay quiet until the agent is done talking (nothing generating or left to play), then this long. */
  | { waitAgentIdle: number }
  | { hangup: true };

export interface AgentReply {
  /** What the agent says when it answers this caller utterance (server VAD auto-response). */
  say: string;
  /** A function call the model makes in the same response, after its audio. */
  tool?: { name: string; args?: Record<string, unknown> };
  /** What it says once the tool output comes back (the client's response.create). */
  afterTool?: string;
}

export interface Range {
  min: number;
  max: number;
}

export interface AudioExpect {
  /** Caller utterances the provider's VAD must detect (proves the synthetic audio reached it). */
  utterances?: number;
  outcome?: string;
  endedBy?: 'agent' | 'caller';
  neverHeardPrompts?: number;
  /** Each never-heard prompt and the goodbye: quiet since the previous agent audio finished playing. */
  promptSpacingMs?: Range;
  goodbyePlayed?: boolean;
  heardChecks?: number;
  /** Each heard-caller check: quiet since the last caller speech / agent audio. */
  heardCheckAfterMs?: Range;
  /** The call is still up at this elapsed time (not cut for silence). */
  stillUpAtMs?: number;
  /** none = the floor filed nothing (never heard / nothing substantive / already filed). */
  floor?: 'none' | 'filed';
  bookings?: number;
  tickets?: number;
  /** Function calls the runtime ran. */
  toolCalls?: number;
  bargeIn?: {
    /** Twilio `clear` sent within this long of the provider's speech_started. */
    clearWithinMs: number;
    /** Interrupted-turn audio the caller still hears after speech_started + clearWithinMs. */
    staleAudioMs: number;
    /** Agent responses that answer the barge-in utterance. */
    answers: number;
  };
  /** A tool result that comes back after the caller barged in starts no response of its own. */
  lateToolResultDropped?: boolean;
}

export interface AudioScenario {
  id: string;
  /** Plan scenario id (S03, S12, S17). */
  plan: string;
  title: string;
  tags: string[];
  lang: CallerLang;
  greeting?: string;
  /** Longest call the run allows; the caller hangs up then if the call is still up. */
  windowMs: number;
  /** Per-run timing jitter: run r starts each caller step (r - 1) * jitterMs later. */
  jitterMs?: number;
  caller: CallerStep[];
  /**
   * replies: the scripted model. interruptLatencyMs: the provider's barge-in
   * cancel lands this long after speech_started (audio keeps streaming until then).
   */
  agent?: { replies?: AgentReply[]; interruptLatencyMs?: number };
  /** Database edge: statements matching `match` (regex) take `latencyMs`. */
  db?: { slow?: Array<{ match: string; latencyMs: number }> };
  expect: AudioExpect;
  /** Known red on main because the runtime lacks the guard; names the follow-up. */
  expectedFail?: string;
  /** With expectedFail: exactly these check keys must fail, nothing else. */
  pinned?: string[];
}

const SCENARIO_KEYS = new Set([
  'id', 'plan', 'title', 'tags', 'lang', 'greeting', 'windowMs', 'jitterMs', 'caller', 'agent', 'db', 'expect', 'expectedFail', 'pinned',
]);
const EXPECT_KEYS = new Set([
  'utterances', 'outcome', 'endedBy', 'neverHeardPrompts', 'promptSpacingMs', 'goodbyePlayed', 'heardChecks',
  'heardCheckAfterMs', 'stillUpAtMs', 'floor', 'bookings', 'tickets', 'toolCalls', 'bargeIn', 'lateToolResultDropped',
]);
const STEP_KEYS = ['say', 'silence', 'lineNoise', 'waitAgentPlaying', 'waitAgentIdle', 'hangup'];

function fail(source: string, message: string): never {
  throw new Error(`${source}: ${message}`);
}

function checkKeys(source: string, where: string, value: Record<string, unknown>, allowed: Set<string>): void {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) fail(source, `unknown ${where} key(s): ${unknown.join(', ')}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function checkStep(source: string, index: number, step: unknown): CallerStep {
  if (!isRecord(step)) fail(source, `caller[${index}] must be a map`);
  const kinds = STEP_KEYS.filter((key) => key in step);
  if (kinds.length !== 1) fail(source, `caller[${index}] needs exactly one of ${STEP_KEYS.join(', ')}`);
  const kind = kinds[0];
  const extra = Object.keys(step).filter((key) => key !== kind && !(kind === 'say' && key === 'transcription'));
  if (extra.length > 0) fail(source, `caller[${index}] unknown key(s): ${extra.join(', ')}`);
  if (kind === 'say') {
    if (typeof step.say !== 'string' || !step.say.trim()) fail(source, `caller[${index}].say must be text`);
    if (step.transcription !== undefined && !['ok', 'empty', 'none'].includes(String(step.transcription))) {
      fail(source, `caller[${index}].transcription must be ok, empty or none`);
    }
  } else if (kind === 'hangup') {
    if (step.hangup !== true) fail(source, `caller[${index}].hangup must be true`);
  } else if (typeof step[kind] !== 'number' || (step[kind] as number) < 0) {
    fail(source, `caller[${index}].${kind} must be milliseconds >= 0`);
  }
  return step as CallerStep;
}

export function parseAudioScenario(raw: unknown, source: string): AudioScenario {
  if (!isRecord(raw)) fail(source, 'scenario must be a map');
  checkKeys(source, 'scenario', raw, SCENARIO_KEYS);
  for (const key of ['id', 'plan', 'title']) {
    if (typeof raw[key] !== 'string' || !(raw[key] as string).trim()) fail(source, `${key} is required`);
  }
  if (!Array.isArray(raw.tags) || raw.tags.some((tag) => typeof tag !== 'string')) fail(source, 'tags must be a list of strings');
  if (raw.lang !== 'en' && raw.lang !== 'es') fail(source, 'lang must be en or es');
  if (typeof raw.windowMs !== 'number' || raw.windowMs <= 0) fail(source, 'windowMs must be > 0');
  if (!Array.isArray(raw.caller) || raw.caller.length === 0) fail(source, 'caller must be a non-empty list');
  if (!isRecord(raw.expect)) fail(source, 'expect is required');
  checkKeys(source, 'expect', raw.expect, EXPECT_KEYS);
  if (raw.pinned !== undefined && !raw.expectedFail) fail(source, 'pinned needs expectedFail');
  if (raw.expectedFail !== undefined && (!Array.isArray(raw.pinned) || raw.pinned.length === 0)) {
    fail(source, 'expectedFail needs the pinned check keys that must fail');
  }
  const caller = raw.caller.map((step, index) => checkStep(source, index, step));
  return { ...(raw as unknown as AudioScenario), caller };
}

export function loadAudioScenarioFile(file: string): AudioScenario {
  const scenario = parseAudioScenario(loadYaml(readFileSync(file, 'utf8')), path.basename(file));
  if (`${scenario.id}.yaml` !== path.basename(file)) fail(path.basename(file), `id ${scenario.id} must match the file name`);
  return scenario;
}

export function loadAudioScenarioDir(dir: string): AudioScenario[] {
  return readdirSync(dir)
    .filter((name) => name.endsWith('.yaml'))
    .sort()
    .map((name) => loadAudioScenarioFile(path.join(dir, name)));
}
