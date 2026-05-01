import { useMemo, useRef, useState } from 'react';
import {
  Upload, FileJson, FileText, ShieldCheck, AlertTriangle,
  CheckCircle2, XCircle, Repeat, Plus, ArrowRight, Loader2, Eye,
  StopCircle, RefreshCw,
} from 'lucide-react';
import { useAuth } from '../../lib/auth';
import { api } from '../../lib/api';
import { StatCard, PageHeader, OperationStatusPanel, type OperationStatus } from '../../components/ui';
import {
  CallBackfillEventV1Schema,
  INGEST_FRESH_WINDOW_DAYS,
  INGEST_BACKFILL_WINDOW_DAYS,
  type CallBackfillEventV1,
} from '../../../../shared/ingest/eventTypes';

type SourceMode = 'json' | 'csv';

interface ParsedRow {
  index: number;
  raw: Record<string, unknown>;
  externalId?: string;
  idempotencyKey?: string;
  startTime?: string;
  parseError?: string;
}

interface PreviewRow extends ParsedRow {
  validation: 'ok' | 'invalid';
  validationErrors?: string[];
  willCorrect?: boolean;
}

interface SubmitRow extends PreviewRow {
  status: 'pending' | 'success' | 'duplicate' | 'error';
  responseBody?: unknown;
  httpStatus?: number;
  errorMessage?: string;
}

interface PreviewExistingResponse {
  tenant_id: string;
  checked: number;
  existing: string[];
}

interface BackfillSubmitResponse {
  status?: string;
  call_session_id?: string;
  idempotency_key?: string;
  backfill?: boolean;
  age_days?: number;
  error?: string;
  details?: unknown;
}

// ---------------------------------------------------------------------------
// CSV parsing — minimal RFC-4180-ish parser. Supports quoted fields with
// embedded commas, escaped double-quotes (""), and trailing newlines. CSV is
// only one of the two input modes and is intentionally narrow: operators
// pasting JSON should always prefer that path.
// ---------------------------------------------------------------------------
function parseCsv(text: string): { headers: string[]; rows: Record<string, string>[] } {
  const lines: string[][] = [];
  let cur: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else { inQuotes = false; }
      } else {
        field += c;
      }
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ',') { cur.push(field); field = ''; }
      else if (c === '\r') { /* skip */ }
      else if (c === '\n') {
        cur.push(field); field = '';
        if (cur.length > 1 || cur[0] !== '') lines.push(cur);
        cur = [];
      } else field += c;
    }
  }
  if (field !== '' || cur.length > 0) {
    cur.push(field);
    if (cur.length > 1 || cur[0] !== '') lines.push(cur);
  }

  if (lines.length === 0) return { headers: [], rows: [] };
  const headers = lines[0].map((h) => h.trim());
  const rows = lines.slice(1).map((cells) => {
    const obj: Record<string, string> = {};
    headers.forEach((h, idx) => { obj[h] = (cells[idx] ?? '').trim(); });
    return obj;
  });
  return { headers, rows };
}

function coerceBool(v: string | undefined): boolean | undefined {
  if (v == null || v === '') return undefined;
  if (v.toLowerCase() === 'true' || v === '1') return true;
  if (v.toLowerCase() === 'false' || v === '0') return false;
  return undefined;
}

function coerceNum(v: string | undefined): number | undefined {
  if (v == null || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Convert a flat CSV row into a partial CallCompletionEventV1 object.
 * tenant_id, version, event_type, and timestamp are filled in by
 * `materializeEvent` from the authenticated session and current time.
 */
function csvRowToEvent(row: Record<string, string>): Record<string, unknown> {
  const event: Record<string, unknown> = {
    external_id: row.external_id,
    idempotency_key: row.idempotency_key,
    agent_remote_id: row.agent_remote_id,
    direction: row.direction,
    from_number: row.from_number,
    to_number: row.to_number,
    status: row.status || 'completed',
    start_time: row.start_time,
    end_time: row.end_time,
    duration_seconds: coerceNum(row.duration_seconds) ?? 0,
    transferred_to_human: coerceBool(row.transferred_to_human) ?? false,
    transcript: row.transcript ?? '',
    costs: {
      twilio_cents: coerceNum(row.twilio_cents) ?? 0,
      openai_cents: coerceNum(row.openai_cents) ?? 0,
      total_cents: coerceNum(row.total_cents) ?? 0,
      is_estimated: coerceBool(row.is_estimated) ?? false,
    },
  };
  if (row.twilio_sid) event.twilio_sid = row.twilio_sid;
  if (row.escalation_reason) event.escalation_reason = row.escalation_reason;
  if (row.summary) event.summary = row.summary;
  if (row.recording_url) event.recording_url = row.recording_url;

  const quality: Record<string, unknown> = {};
  if (row.sentiment) quality.sentiment = row.sentiment;
  if (row.agent_outcome) quality.agent_outcome = row.agent_outcome;
  const score = coerceNum(row.quality_score);
  if (score !== undefined) quality.score = score;
  if (row.analysis) quality.analysis = row.analysis;
  if (Object.keys(quality).length > 0) event.quality = quality;

  return event;
}

/**
 * Fill in the implicit fields (tenant_id, version, event_type, timestamp) and
 * attach the attestation block. We do this just before validation so that the
 * operator never has to type these into JSON or CSV.
 */
function materializeEvent(
  raw: Record<string, unknown>,
  tenantId: string,
  attestation: { reason: string; attested_by: string; original_system?: string },
): Record<string, unknown> {
  return {
    version: raw.version ?? 'v1',
    event_type: raw.event_type ?? 'call.completed',
    timestamp: raw.timestamp ?? new Date().toISOString(),
    tenant_id: raw.tenant_id ?? tenantId,
    ...raw,
    // Force these even if the paste contained different values — the form is
    // the source of truth so the attestation is consistent across the batch.
    backfill_attestation: {
      reason: attestation.reason,
      attested_by: attestation.attested_by,
      ...(attestation.original_system ? { original_system: attestation.original_system } : {}),
      attested_at: new Date().toISOString(),
    },
  };
}

function parseJsonInput(text: string): ParsedRow[] {
  const trimmed = text.trim();
  if (!trimmed) return [];

  // Try to parse as a whole first (single object or array).
  try {
    const parsed = JSON.parse(trimmed);
    const arr = Array.isArray(parsed) ? parsed : [parsed];
    return arr.map((entry, index) => ({
      index,
      raw: entry as Record<string, unknown>,
      externalId: typeof entry?.external_id === 'string' ? entry.external_id : undefined,
      idempotencyKey: typeof entry?.idempotency_key === 'string' ? entry.idempotency_key : undefined,
      startTime: typeof entry?.start_time === 'string' ? entry.start_time : undefined,
    }));
  } catch {
    // Fall back to NDJSON: one JSON object per line.
  }

  const lines = trimmed.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const out: ParsedRow[] = [];
  lines.forEach((line, index) => {
    try {
      const entry = JSON.parse(line);
      out.push({
        index,
        raw: entry as Record<string, unknown>,
        externalId: typeof entry?.external_id === 'string' ? entry.external_id : undefined,
        idempotencyKey: typeof entry?.idempotency_key === 'string' ? entry.idempotency_key : undefined,
        startTime: typeof entry?.start_time === 'string' ? entry.start_time : undefined,
      });
    } catch (err) {
      out.push({
        index,
        raw: {},
        parseError: err instanceof Error ? err.message : 'Invalid JSON',
      });
    }
  });
  return out;
}

function parseCsvInput(text: string): ParsedRow[] {
  const { rows } = parseCsv(text);
  return rows.map((row, index) => {
    const event = csvRowToEvent(row);
    return {
      index,
      raw: event,
      externalId: typeof event.external_id === 'string' ? event.external_id : undefined,
      idempotencyKey: typeof event.idempotency_key === 'string' ? event.idempotency_key : undefined,
      startTime: typeof event.start_time === 'string' ? event.start_time : undefined,
    };
  });
}

const CSV_TEMPLATE = [
  'external_id,idempotency_key,agent_remote_id,direction,from_number,to_number,status,start_time,end_time,duration_seconds,twilio_cents,openai_cents,total_cents,is_estimated,twilio_sid,transferred_to_human,escalation_reason,transcript,summary,sentiment,quality_score',
  'call-001,backfill-001-v1,agent-abc,inbound,+15555550100,+15555550111,completed,2026-04-10T15:30:00Z,2026-04-10T15:34:00Z,240,12,18,30,false,CA1234,false,,,Resolved on first call,positive,8.5',
].join('\n');

const JSON_TEMPLATE = JSON.stringify([
  {
    external_id: 'call-001',
    idempotency_key: 'backfill-001-v1',
    agent_remote_id: 'agent-abc',
    direction: 'inbound',
    from_number: '+15555550100',
    to_number: '+15555550111',
    status: 'completed',
    start_time: '2026-04-10T15:30:00Z',
    end_time: '2026-04-10T15:34:00Z',
    duration_seconds: 240,
    transferred_to_human: false,
    transcript: '',
    costs: { twilio_cents: 12, openai_cents: 18, total_cents: 30, is_estimated: false },
  },
], null, 2);

export default function BackfillCalls() {
  const { user } = useAuth();
  const tenantId = user?.tenantId ?? '';

  const [mode, setMode] = useState<SourceMode>('json');
  const [text, setText] = useState('');
  const [reason, setReason] = useState('');
  const [attestedBy, setAttestedBy] = useState(user?.email ?? '');
  const [originalSystem, setOriginalSystem] = useState('');
  const [previewRows, setPreviewRows] = useState<PreviewRow[] | null>(null);
  const [submitRows, setSubmitRows] = useState<SubmitRow[] | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [pageError, setPageError] = useState<string | null>(null);
  const cancelledRef = useRef(false);
  const [cancelled, setCancelled] = useState(false);

  const reasonValid = reason.trim().length >= 8;
  const attestedByValid = attestedBy.trim().length > 0;
  const inputValid = text.trim().length > 0;
  const canPreview = reasonValid && attestedByValid && inputValid && !previewing;

  const parsedRows = useMemo<ParsedRow[]>(() => {
    if (!text.trim()) return [];
    return mode === 'json' ? parseJsonInput(text) : parseCsvInput(text);
  }, [mode, text]);

  const summary = useMemo(() => {
    if (!previewRows) return null;
    const total = previewRows.length;
    const valid = previewRows.filter((r) => r.validation === 'ok').length;
    const invalid = total - valid;
    const corrections = previewRows.filter((r) => r.validation === 'ok' && r.willCorrect).length;
    const inserts = valid - corrections;
    return { total, valid, invalid, corrections, inserts };
  }, [previewRows]);

  const submitSummary = useMemo(() => {
    if (!submitRows) return null;
    return {
      total: submitRows.length,
      success: submitRows.filter((r) => r.status === 'success').length,
      duplicate: submitRows.filter((r) => r.status === 'duplicate').length,
      error: submitRows.filter((r) => r.status === 'error').length,
      pending: submitRows.filter((r) => r.status === 'pending').length,
    };
  }, [submitRows]);

  const onFile = async (file: File) => {
    const buf = await file.text();
    setText(buf);
    setPreviewRows(null);
    setSubmitRows(null);
    setPageError(null);
    if (file.name.endsWith('.json') || file.name.endsWith('.ndjson')) setMode('json');
    else if (file.name.endsWith('.csv')) setMode('csv');
  };

  const handlePreview = async () => {
    setPageError(null);
    setSubmitRows(null);
    if (parsedRows.length === 0) {
      setPageError('No events parsed from the input.');
      setPreviewRows([]);
      return;
    }
    setPreviewing(true);

    const attestation = {
      reason: reason.trim(),
      attested_by: attestedBy.trim(),
      original_system: originalSystem.trim() || undefined,
    };

    const validated: PreviewRow[] = parsedRows.map((row) => {
      if (row.parseError) {
        return { ...row, validation: 'invalid', validationErrors: [row.parseError] };
      }
      const merged = materializeEvent(row.raw, tenantId, attestation);
      const result = CallBackfillEventV1Schema.safeParse(merged);
      if (!result.success) {
        const flat = result.error.flatten();
        const messages: string[] = [];
        for (const [k, v] of Object.entries(flat.fieldErrors)) {
          for (const msg of v ?? []) messages.push(`${k}: ${msg}`);
        }
        for (const msg of flat.formErrors) messages.push(msg);
        return { ...row, validation: 'invalid', validationErrors: messages };
      }
      return {
        ...row,
        externalId: result.data.external_id,
        idempotencyKey: result.data.idempotency_key,
        startTime: result.data.start_time,
        validation: 'ok',
        willCorrect: false,
      };
    });

    // Look up which external_ids already exist for this tenant so we can mark
    // rows as "would correct" vs "would insert" before submission.
    const idsToCheck = Array.from(new Set(
      validated
        .filter((r) => r.validation === 'ok' && r.externalId)
        .map((r) => r.externalId as string),
    ));

    if (idsToCheck.length > 0) {
      try {
        const res = await api.post<PreviewExistingResponse>(
          '/v1/ingest/calls/preview-existing',
          { external_ids: idsToCheck },
        );
        const existingSet = new Set(res.existing);
        validated.forEach((r) => {
          if (r.validation === 'ok' && r.externalId && existingSet.has(r.externalId)) {
            r.willCorrect = true;
          }
        });
      } catch (err) {
        setPageError(
          `Could not look up existing call sessions: ${err instanceof Error ? err.message : String(err)}. Insert vs correction counts may be inaccurate.`,
        );
      }
    }

    setPreviewRows(validated);
    setPreviewing(false);
  };

  const submitRowsLoop = async (rowsToSubmit: SubmitRow[]) => {
    cancelledRef.current = false;
    setCancelled(false);
    setPageError(null);
    setSubmitting(true);

    const attestation = {
      reason: reason.trim(),
      attested_by: attestedBy.trim(),
      original_system: originalSystem.trim() || undefined,
    };

    const working = rowsToSubmit.slice();
    setSubmitRows(working);

    for (let i = 0; i < working.length; i++) {
      if (cancelledRef.current) {
        for (let j = i; j < working.length; j++) {
          if (working[j].status === 'pending') {
            working[j] = {
              ...working[j],
              status: 'error',
              errorMessage: 'Cancelled by operator before submission.',
            };
          }
        }
        setSubmitRows([...working]);
        break;
      }

      const row = working[i];
      if (row.status !== 'pending') continue;
      const merged = materializeEvent(row.raw, tenantId, attestation) as CallBackfillEventV1;
      try {
        const res = await api.post<BackfillSubmitResponse>(
          '/v1/ingest/calls/backfill',
          merged,
        );
        working[i] = { ...row, status: 'success', responseBody: res, httpStatus: 201 };
      } catch (err: unknown) {
        const errObj = err as { status?: number; body?: BackfillSubmitResponse; message?: string };
        const httpStatus = errObj.status;
        const body = errObj.body;
        if (httpStatus === 409) {
          working[i] = {
            ...row,
            status: 'duplicate',
            httpStatus,
            responseBody: body,
            errorMessage: body?.error ?? 'Duplicate idempotency key',
          };
        } else {
          working[i] = {
            ...row,
            status: 'error',
            httpStatus,
            responseBody: body,
            errorMessage: body?.error ?? errObj.message ?? 'Unknown error',
          };
        }
      }
      setSubmitRows([...working]);
    }

    setSubmitting(false);
  };

  const handleSubmit = async () => {
    if (!previewRows) return;
    const initial: SubmitRow[] = previewRows.map((p) => ({
      ...p,
      status: p.validation === 'invalid' ? 'error' : 'pending',
      errorMessage: p.validation === 'invalid' ? 'Skipped: validation failed' : undefined,
    }));
    await submitRowsLoop(initial);
  };

  const handleCancel = () => {
    cancelledRef.current = true;
    setCancelled(true);
  };

  const handleRetryFailed = async () => {
    if (!submitRows) return;
    const next = submitRows.map((r) =>
      r.status === 'error' && r.errorMessage !== 'Skipped: validation failed' && r.validation === 'ok'
        ? { ...r, status: 'pending' as const, errorMessage: undefined, httpStatus: undefined, responseBody: undefined }
        : r,
    );
    if (!next.some((r) => r.status === 'pending')) return;
    await submitRowsLoop(next);
  };

  const loadJsonTemplate = () => { setMode('json'); setText(JSON_TEMPLATE); };
  const loadCsvTemplate = () => { setMode('csv'); setText(CSV_TEMPLATE); };

  const opStatus: OperationStatus = submitting
    ? 'running'
    : cancelled && submitSummary
      ? 'cancelled'
      : submitSummary
        ? submitSummary.error > 0
          ? 'failed'
          : 'success'
        : previewing
          ? 'queued'
          : 'idle';
  const canRetry = !submitting && !!submitSummary && submitSummary.error > 0;
  const opProcessed = submitSummary
    ? submitSummary.success + submitSummary.duplicate + submitSummary.error
    : undefined;
  const opTotal = submitSummary?.total ?? previewRows?.length ?? undefined;
  const opProgress = opTotal && opProcessed !== undefined && opTotal > 0
    ? opProcessed / opTotal
    : submitting ? 0.05 : undefined;

  return (
    <div className="p-6 max-w-7xl mx-auto space-y-6">
      <PageHeader
        title="Backfill calls"
        description="Replay historical call events through the federated ingest endpoint without writing one-off scripts. Paste JSON or upload CSV, attest who authorized the late ingest and why, then preview the diff before submitting per-row."
        icon={<Repeat className="h-5 w-5" />}
        actions={
          <div className="flex items-center gap-2 text-xs text-text-secondary px-3 py-1.5 rounded-md border border-border bg-surface-hover">
            <ShieldCheck className="h-4 w-4" />
            Tenant: <span className="font-mono text-text-primary">{tenantId || '—'}</span>
          </div>
        }
      />

      {(submitting || submitSummary || previewing) && (
        <OperationStatusPanel
          title="Backfill submission"
          description={previewing
            ? 'Validating events against the ingest schema and existing call IDs.'
            : submitting
              ? 'Submitting events one-by-one through /v1/ingest/calls/backfill.'
              : cancelled
                ? 'Submission cancelled — pending rows were not sent.'
                : 'Run finished — review per-row results below.'}
          status={opStatus}
          progress={opProgress}
          processed={opProcessed}
          total={opTotal}
          actions={
            <>
              {submitting && (
                <button
                  type="button"
                  onClick={handleCancel}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-warning/40 bg-warning-light text-warning text-xs font-medium hover:bg-warning/10 transition-colors"
                >
                  <StopCircle className="h-3.5 w-3.5" /> Cancel
                </button>
              )}
              {canRetry && (
                <button
                  type="button"
                  onClick={handleRetryFailed}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-primary/40 bg-primary-light text-primary text-xs font-medium hover:bg-primary/10 transition-colors"
                >
                  <RefreshCw className="h-3.5 w-3.5" /> Retry failed ({submitSummary?.error ?? 0})
                </button>
              )}
            </>
          }
          meta={submitSummary ? [
            { label: 'Submitted', value: submitSummary.success },
            { label: 'Duplicates', value: submitSummary.duplicate },
            { label: 'Errors', value: submitSummary.error },
            { label: 'Pending', value: submitSummary.pending },
          ] : undefined}
          error={pageError ?? undefined}
        />
      )}

      <section
        className="bg-surface border border-border rounded-xl p-5 space-y-4"
        data-testid="backfill-attestation-form"
      >
        <h2 className="text-sm font-semibold text-foreground flex items-center gap-2">
          <ShieldCheck className="w-4 h-4 text-primary" />
          Attestation
        </h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <label className="flex flex-col gap-1 text-sm md:col-span-2">
            <span className="text-muted text-xs">Reason (≥ 8 characters)</span>
            <input
              type="text"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. Remix outage 2026-04-10 — replaying 12 calls dropped during failover"
              className="bg-background border border-border rounded-md px-3 py-2 text-foreground placeholder:text-muted/60 focus:outline-none focus:ring-2 focus:ring-primary"
            />
            {!reasonValid && reason.length > 0 && (
              <span className="text-danger text-xs">Must be at least 8 characters.</span>
            )}
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-muted text-xs">Attested by</span>
            <input
              type="text"
              value={attestedBy}
              onChange={(e) => setAttestedBy(e.target.value)}
              placeholder="ops-engineer@company.com"
              className="bg-background border border-border rounded-md px-3 py-2 text-foreground placeholder:text-muted/60 focus:outline-none focus:ring-2 focus:ring-primary"
            />
            {!attestedByValid && attestedBy.length > 0 && (
              <span className="text-danger text-xs">Required.</span>
            )}
          </label>
          <label className="flex flex-col gap-1 text-sm md:col-span-3">
            <span className="text-muted text-xs">Original system (optional)</span>
            <input
              type="text"
              value={originalSystem}
              onChange={(e) => setOriginalSystem(e.target.value)}
              placeholder="e.g. remix-prod-us-east"
              className="bg-background border border-border rounded-md px-3 py-2 text-foreground placeholder:text-muted/60 focus:outline-none focus:ring-2 focus:ring-primary"
            />
          </label>
        </div>
      </section>

      <section className="bg-surface border border-border rounded-xl p-5 space-y-4">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div className="flex gap-2">
            <button
              onClick={() => { setMode('json'); }}
              className={`px-3 py-1.5 rounded-md text-sm font-medium border transition-colors flex items-center gap-2 ${mode === 'json' ? 'bg-primary text-white border-primary' : 'bg-background border-border text-muted hover:text-foreground'}`}
            >
              <FileJson className="w-4 h-4" /> JSON / NDJSON
            </button>
            <button
              onClick={() => { setMode('csv'); }}
              className={`px-3 py-1.5 rounded-md text-sm font-medium border transition-colors flex items-center gap-2 ${mode === 'csv' ? 'bg-primary text-white border-primary' : 'bg-background border-border text-muted hover:text-foreground'}`}
            >
              <FileText className="w-4 h-4" /> CSV
            </button>
          </div>
          <div className="flex gap-2 text-xs">
            <label className="px-3 py-1.5 rounded-md border border-border text-muted hover:text-foreground hover:bg-surface-hover cursor-pointer flex items-center gap-2">
              <Upload className="w-3.5 h-3.5" />
              Upload file
              <input
                type="file"
                accept=".json,.ndjson,.csv"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) onFile(f);
                  e.target.value = '';
                }}
              />
            </label>
            <button
              onClick={mode === 'json' ? loadJsonTemplate : loadCsvTemplate}
              className="px-3 py-1.5 rounded-md border border-border text-muted hover:text-foreground hover:bg-surface-hover"
            >
              Load template
            </button>
            <button
              onClick={() => { setText(''); setPreviewRows(null); setSubmitRows(null); setPageError(null); }}
              className="px-3 py-1.5 rounded-md border border-border text-muted hover:text-foreground hover:bg-surface-hover"
            >
              Clear
            </button>
          </div>
        </div>

        <div>
          <textarea
            value={text}
            onChange={(e) => { setText(e.target.value); setPreviewRows(null); setSubmitRows(null); }}
            spellCheck={false}
            placeholder={
              mode === 'json'
                ? 'Paste a JSON object, a JSON array of events, or one event per line (NDJSON). The form will inject tenant_id, version, event_type, timestamp, and the attestation block.'
                : 'Paste CSV with the columns shown in the template (use Load template).'
            }
            className="w-full h-64 bg-background border border-border rounded-md p-3 font-mono text-xs text-foreground focus:outline-none focus:ring-2 focus:ring-primary resize-y"
          />
          <div className="text-xs text-muted mt-1">
            Parsed rows: <span className="font-semibold text-foreground">{parsedRows.length}</span>
            {parsedRows.some((r) => r.parseError) && (
              <span className="ml-3 text-danger">
                {parsedRows.filter((r) => r.parseError).length} unparseable
              </span>
            )}
          </div>
        </div>

        <div className="flex items-center gap-3 flex-wrap">
          <button
            onClick={handlePreview}
            disabled={!canPreview}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-md bg-primary text-white font-medium disabled:opacity-50 disabled:cursor-not-allowed hover:bg-primary/90"
          >
            {previewing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Eye className="w-4 h-4" />}
            Preview diff
          </button>
          <button
            onClick={handleSubmit}
            disabled={!previewRows || (summary?.valid ?? 0) === 0 || submitting || !reasonValid || !attestedByValid}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-md bg-success text-white font-medium disabled:opacity-50 disabled:cursor-not-allowed hover:bg-success"
          >
            {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <ArrowRight className="w-4 h-4" />}
            Submit {summary ? `${summary.valid} event${summary.valid === 1 ? '' : 's'}` : ''}
          </button>
          {pageError && (
            <span className="text-danger text-xs flex items-center gap-1">
              <AlertTriangle className="w-3.5 h-3.5" /> {pageError}
            </span>
          )}
        </div>
      </section>

      {summary && (
        <section className="bg-surface border border-border rounded-xl p-5 space-y-4">
          <h2 className="text-sm font-semibold text-foreground flex items-center gap-2">
            <Eye className="w-4 h-4 text-primary" />
            Preview ({summary.total} row{summary.total === 1 ? '' : 's'})
          </h2>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <StatCard icon={Plus} label="Would insert" value={summary.inserts} tone="success" />
            <StatCard icon={Repeat} label="Would correct" value={summary.corrections} tone="warning" />
            <StatCard icon={CheckCircle2} label="Valid" value={summary.valid} tone="success" />
            <StatCard icon={XCircle} label="Invalid" value={summary.invalid} tone="danger" />
          </div>

          <RowTable rows={previewRows!} mode="preview" />
        </section>
      )}

      {submitSummary && (
        <section className="bg-surface border border-border rounded-xl p-5 space-y-4">
          <h2 className="text-sm font-semibold text-foreground flex items-center gap-2">
            <ArrowRight className="w-4 h-4 text-primary" />
            Submission results
          </h2>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <StatCard icon={CheckCircle2} label="Success" value={submitSummary.success} tone="success" />
            <StatCard icon={Repeat} label="Duplicate" value={submitSummary.duplicate} tone="warning" />
            <StatCard icon={XCircle} label="Error" value={submitSummary.error} tone="danger" />
            <StatCard icon={Loader2} label="Pending" value={submitSummary.pending} tone="neutral" />
          </div>
          <RowTable rows={submitRows!} mode="submit" />
        </section>
      )}

      <section className="bg-surface border border-border rounded-xl p-5 text-xs text-muted space-y-2">
        <h3 className="text-sm font-semibold text-foreground">How this works</h3>
        <ul className="list-disc list-inside space-y-1">
          <li>
            Each event is sent to <code className="text-foreground">POST /v1/ingest/calls/backfill</code> one at a time so per-row status is visible.
          </li>
          <li>
            We accept <code>start_time</code> values from <code>{INGEST_FRESH_WINDOW_DAYS}</code> to <code>{INGEST_BACKFILL_WINDOW_DAYS}</code> days ago. Newer events should go through the live <code>/v1/ingest/calls</code> endpoint instead.
          </li>
          <li>
            Idempotency is keyed on <code>(tenant, idempotency_key)</code>. To restate a previously submitted call, re-issue the same <code>external_id</code> with a fresh <code>idempotency_key</code>.
          </li>
          <li>
            CSV-only callers should fill the columns shown in <em>Load template</em>; nested fields like <code>costs.*</code> are flattened to columns named <code>twilio_cents</code>, <code>openai_cents</code>, <code>total_cents</code>, etc.
          </li>
        </ul>
      </section>
    </div>
  );
}

interface RowTableProps {
  rows: PreviewRow[] | SubmitRow[];
  mode: 'preview' | 'submit';
}
function RowTable({ rows, mode }: RowTableProps) {
  return (
    <div className="overflow-x-auto -mx-1">
      <table className="w-full text-xs">
        <thead>
          <tr className="text-muted text-left">
            <th className="px-2 py-2 font-medium">#</th>
            <th className="px-2 py-2 font-medium">external_id</th>
            <th className="px-2 py-2 font-medium">idempotency_key</th>
            <th className="px-2 py-2 font-medium">start_time</th>
            <th className="px-2 py-2 font-medium">{mode === 'preview' ? 'Diff' : 'Status'}</th>
            <th className="px-2 py-2 font-medium">Notes</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.index} className="border-t border-border align-top">
              <td className="px-2 py-2 text-muted font-mono">{row.index + 1}</td>
              <td className="px-2 py-2 font-mono text-foreground break-all">{row.externalId ?? '—'}</td>
              <td className="px-2 py-2 font-mono text-foreground break-all">{row.idempotencyKey ?? '—'}</td>
              <td className="px-2 py-2 font-mono text-muted whitespace-nowrap">{row.startTime ?? '—'}</td>
              <td className="px-2 py-2">
                {mode === 'preview' ? (
                  row.validation === 'invalid' ? (
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-danger/10 text-danger">
                      <XCircle className="w-3 h-3" /> Invalid
                    </span>
                  ) : (row as PreviewRow).willCorrect ? (
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-warning/10 text-warning">
                      <Repeat className="w-3 h-3" /> Correct existing
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-success/10 text-success">
                      <Plus className="w-3 h-3" /> New insert
                    </span>
                  )
                ) : (
                  <SubmitBadge status={(row as SubmitRow).status} />
                )}
              </td>
              <td className="px-2 py-2 text-muted">
                {mode === 'preview'
                  ? (row.validationErrors?.join('; ') ?? '')
                  : ((row as SubmitRow).errorMessage ?? '')}
              </td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr>
              <td colSpan={6} className="px-2 py-6 text-center text-muted">No rows.</td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

function SubmitBadge({ status }: { status: SubmitRow['status'] }) {
  switch (status) {
    case 'success':
      return (
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-success/10 text-success">
          <CheckCircle2 className="w-3 h-3" /> Submitted
        </span>
      );
    case 'duplicate':
      return (
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-warning/10 text-warning">
          <Repeat className="w-3 h-3" /> Duplicate
        </span>
      );
    case 'error':
      return (
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-danger/10 text-danger">
          <XCircle className="w-3 h-3" /> Error
        </span>
      );
    default:
      return (
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-muted/10 text-muted">
          <Loader2 className="w-3 h-3 animate-spin" /> Pending
        </span>
      );
  }
}
