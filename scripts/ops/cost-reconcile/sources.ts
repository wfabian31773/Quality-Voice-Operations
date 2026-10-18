// Thin fetch adapters for the cost reconciler. Each one turns a provider's
// rows into the normalized records in ./types; all attribution and money
// math lives in ./reconcile. Credentials are passed in by the CLI (read from
// env by name there) and are never logged or put in error messages.

import { readFile } from 'node:fs/promises';

import { type DayWindow, utcDatesCovering } from './dayWindow';
import { centsStringToMicros, usdStringToMicros } from './money';
import type { DbCallRow, TwilioCallRow, TwilioRecordingRow, XaiUsageRow } from './types';

export interface XaiUsageSource {
  fetchUsage(window: DayWindow): Promise<XaiUsageRow[]>;
}

export interface TwilioSource {
  /** Parent calls and child legs whose start time falls on the UTC dates the window touches. */
  fetchCalls(window: DayWindow): Promise<TwilioCallRow[]>;
  fetchRecordings(window: DayWindow): Promise<TwilioRecordingRow[]>;
}

export interface DbCallSource {
  fetchCalls(window: DayWindow): Promise<DbCallRow[]>;
}

// ---------------------------------------------------------------------------
// Twilio REST (2010-04-01 Calls + Recordings list resources)
// ---------------------------------------------------------------------------

type FetchLike = (url: string, init: { headers: Record<string, string> }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

export interface TwilioSourceOptions {
  accountSid: string;
  authToken: string;
  fetchImpl?: FetchLike;
  baseUrl?: string;
}

const TWILIO_API = 'https://api.twilio.com';

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function toIso(rfc2822: unknown): string | null {
  const text = str(rfc2822);
  if (!text) return null;
  const ms = Date.parse(text);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function seconds(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(str(value) ?? '0');
  return Number.isInteger(n) && n >= 0 ? n : 0;
}

function priceMicros(value: unknown): number | null {
  const text = str(value);
  return text === null ? null : usdStringToMicros(text);
}

export function mapTwilioCall(raw: unknown): TwilioCallRow | null {
  const row = record(raw);
  const callSid = str(row.sid);
  const startTime = toIso(row.start_time);
  // Calls that never started (queued, canceled before ringing) carry no cost.
  if (!callSid || !startTime) return null;
  return {
    callSid,
    parentCallSid: str(row.parent_call_sid),
    startTime,
    durationSeconds: seconds(row.duration),
    priceMicros: priceMicros(row.price),
    priceUnit: str(row.price_unit),
    status: str(row.status) ?? 'unknown',
  };
}

export function mapTwilioRecording(raw: unknown): TwilioRecordingRow | null {
  const row = record(raw);
  const recordingSid = str(row.sid);
  const callSid = str(row.call_sid);
  const createdAt = toIso(row.date_created);
  if (!recordingSid || !callSid || !createdAt) return null;
  return {
    recordingSid,
    callSid,
    createdAt,
    durationSeconds: seconds(row.duration),
    priceMicros: priceMicros(row.price),
    priceUnit: str(row.price_unit),
  };
}

export function createTwilioSource(options: TwilioSourceOptions): TwilioSource {
  const fetchImpl = options.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  const baseUrl = options.baseUrl ?? TWILIO_API;
  const auth = `Basic ${Buffer.from(`${options.accountSid}:${options.authToken}`).toString('base64')}`;
  const accountPath = `/2010-04-01/Accounts/${encodeURIComponent(options.accountSid)}`;

  async function listAll(firstPath: string, key: 'calls' | 'recordings'): Promise<unknown[]> {
    const rows: unknown[] = [];
    let next: string | null = firstPath;
    while (next) {
      const response = await fetchImpl(`${baseUrl}${next}`, { headers: { Authorization: auth, Accept: 'application/json' } });
      if (!response.ok) throw new Error(`Twilio ${key} list failed with HTTP ${response.status}`);
      const page = record(await response.json());
      const items = page[key];
      if (Array.isArray(items)) rows.push(...items);
      next = str(page.next_page_uri);
    }
    return rows;
  }

  // Twilio's date filters are date-only, in UTC. Ask for every UTC date the
  // local day touches, padded by a day each side so either reading of
  // `>`/`<` (strict or inclusive) covers it; ./reconcile applies the exact
  // local-day boundary, so over-fetching is harmless.
  function dateRange(window: DayWindow, field: 'StartTime' | 'DateCreated'): string {
    const dates = utcDatesCovering(window);
    const params = new URLSearchParams();
    params.set(`${field}>`, previousDate(dates[0]));
    params.set(`${field}<`, nextDate(dates[dates.length - 1]));
    params.set('PageSize', '1000');
    return params.toString();
  }

  return {
    async fetchCalls(window) {
      const raw = await listAll(`${accountPath}/Calls.json?${dateRange(window, 'StartTime')}`, 'calls');
      return raw.map(mapTwilioCall).filter((row): row is TwilioCallRow => row !== null);
    },
    async fetchRecordings(window) {
      const raw = await listAll(`${accountPath}/Recordings.json?${dateRange(window, 'DateCreated')}`, 'recordings');
      return raw.map(mapTwilioRecording).filter((row): row is TwilioRecordingRow => row !== null);
    },
  };
}

function shiftDate(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
const previousDate = (date: string): string => shiftDate(date, -1);
const nextDate = (date: string): string => shiftDate(date, 1);

// ---------------------------------------------------------------------------
// Our DB: call_sessions LEFT JOIN conversation_costs, keyed by Twilio CallSid
// ---------------------------------------------------------------------------

export type QueryFn = (sql: string, values: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;

// call_sessions.start_time is TIMESTAMP (no zone) written by NOW() in a UTC
// session, so it is compared and rendered as UTC here. Rendering in SQL keeps
// node-postgres from reinterpreting it in the process time zone.
export const DB_CALLS_SQL = `
SELECT cs.call_sid,
       cs.id AS call_session_id,
       cs.tenant_id,
       to_char(cs.start_time, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS started_at,
       cs.duration_seconds,
       cc.id IS NOT NULL AS has_cost_row,
       cc.llm_cost_cents,
       cc.twilio_price_cents::text AS twilio_price_cents
  FROM call_sessions cs
  LEFT JOIN conversation_costs cc
    ON cc.tenant_id = cs.tenant_id AND cc.call_session_id = cs.id
 WHERE cs.call_sid IS NOT NULL
   AND cs.start_time >= $1::timestamp
   AND cs.start_time <  $2::timestamp`;

function toDbTimestamp(iso: string): string {
  return iso.replace('T', ' ').replace('Z', '');
}

export function mapDbCall(row: Record<string, unknown>): DbCallRow | null {
  const callSid = str(row.call_sid);
  const callSessionId = str(row.call_session_id);
  const tenantId = str(row.tenant_id);
  const startedAt = str(row.started_at);
  if (!callSid || !callSessionId || !tenantId || !startedAt) return null;
  const duration = row.duration_seconds === null || row.duration_seconds === undefined ? null : seconds(row.duration_seconds);
  const twilioPrice = str(row.twilio_price_cents);
  return {
    callSid,
    callSessionId,
    tenantId,
    startedAt,
    durationSeconds: duration,
    estimate: row.has_cost_row === true
      ? {
          xaiCents: seconds(row.llm_cost_cents),
          twilioMicros: twilioPrice === null ? null : centsStringToMicros(twilioPrice),
        }
      : null,
  };
}

export function createDbCallSource(query: QueryFn): DbCallSource {
  return {
    async fetchCalls(window) {
      // Read the local day plus an hour each side; ./reconcile owns the cut.
      const from = new Date(window.startMs - 3_600_000).toISOString();
      const to = new Date(window.endMs + 3_600_000).toISOString();
      const { rows } = await query(DB_CALLS_SQL, [toDbTimestamp(from), toDbTimestamp(to)]);
      return rows.map(mapDbCall).filter((row): row is DbCallRow => row !== null);
    },
  };
}

// ---------------------------------------------------------------------------
// xAI usage
// ---------------------------------------------------------------------------

/**
 * xAI usage API adapter: NOT IMPLEMENTED.
 *
 * TODO(RT-05 follow-up): the endpoint, auth scheme and row shape of xAI's
 * usage/billing API are not confirmed in this repo, so no endpoint is
 * invented here. To implement, map each provider row onto XaiUsageRow:
 *   usageId      ← provider record id (or a stable hash of its fields)
 *   callSid      ← whatever per-call key xAI echoes back. Today the voice
 *                  gateway sends none, so this is null until the gateway
 *                  tags sessions with the Twilio CallSid (rows with a null
 *                  key are reported as `no_call_key`, never dropped)
 *   occurredAt   ← record timestamp (ISO-8601)
 *   model        ← model name, e.g. grok-voice-3.0
 *   audioSeconds ← billed audio duration, if reported
 *   costMicros   ← billed cost in micro-USD, if reported (preferred)
 * Proposed credential env names: XAI_MANAGEMENT_API_KEY, XAI_TEAM_ID.
 * Until then use createXaiUsageFileSource with an exported file.
 */
export function createXaiUsageApiSource(): XaiUsageSource {
  return {
    async fetchUsage() {
      throw new Error('xAI usage API adapter is not implemented yet; pass --xai-usage-file (see sources.ts TODO)');
    },
  };
}

function nullableInt(value: unknown, label: string): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a non-negative integer or null`);
  return value;
}

export function parseXaiUsageRows(raw: unknown): XaiUsageRow[] {
  if (!Array.isArray(raw)) throw new Error('xAI usage file must be a JSON array');
  return raw.map((item, index) => {
    const row = record(item);
    const label = `xAI usage row ${index}`;
    const usageId = str(row.usageId);
    const occurredAt = str(row.occurredAt);
    const model = str(row.model);
    if (!usageId || !occurredAt || !model || !Number.isFinite(Date.parse(occurredAt))) {
      throw new Error(`${label} needs usageId, model and an ISO occurredAt`);
    }
    if (row.callSid !== null && row.callSid !== undefined && typeof row.callSid !== 'string') {
      throw new Error(`${label} callSid must be a string or null`);
    }
    const parsed: XaiUsageRow = {
      usageId,
      callSid: str(row.callSid),
      occurredAt: new Date(Date.parse(occurredAt)).toISOString(),
      model,
      audioSeconds: nullableInt(row.audioSeconds, `${label} audioSeconds`),
      costMicros: nullableInt(row.costMicros, `${label} costMicros`),
    };
    const inputTokens = nullableInt(row.inputTokens, `${label} inputTokens`);
    const outputTokens = nullableInt(row.outputTokens, `${label} outputTokens`);
    if (inputTokens !== null) parsed.inputTokens = inputTokens;
    if (outputTokens !== null) parsed.outputTokens = outputTokens;
    return parsed;
  });
}

/** Normalized xAI usage rows (JSON array of XaiUsageRow) from a local file. */
export function createXaiUsageFileSource(
  path: string,
  readText: (path: string) => Promise<string> = (p) => readFile(p, 'utf8'),
): XaiUsageSource {
  return {
    async fetchUsage() {
      return parseXaiUsageRows(JSON.parse(await readText(path)) as unknown);
    },
  };
}
