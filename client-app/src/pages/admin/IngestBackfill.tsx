import { useMemo, useRef, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import {
  Upload, FileText, AlertTriangle, CheckCircle2, RefreshCw,
  Download, ShieldAlert, Info, Trash2, FileWarning, History,
} from 'lucide-react';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { EmptyState } from '../../components/state';

interface BatchAttestation {
  reason: string;
  attested_by: string;
  original_system?: string;
  attested_at?: string;
}

interface BatchRowResult {
  row_index: number;
  idempotency_key: string | null;
  external_id: string | null;
  status: 'inserted' | 'duplicate' | 'window_rejected' | 'validation_failed' | 'failed';
  age_days?: number;
  error?: string;
}

interface BatchSummary {
  total: number;
  inserted: number;
  duplicate: number;
  window_rejected: number;
  validation_failed: number;
  failed: number;
}

interface BatchResponse {
  tenant_id: string;
  summary: BatchSummary;
  results: BatchRowResult[];
}

interface ParseError {
  message: string;
}

const SAMPLE_CSV_HEADER = [
  'idempotency_key',
  'external_id',
  'agent_remote_id',
  'direction',
  'from_number',
  'to_number',
  'status',
  'start_time',
  'end_time',
  'duration_seconds',
  'twilio_cents',
  'openai_cents',
  'total_cents',
  'is_estimated',
  'transcript',
  'summary',
  'recording_url',
  'transferred_to_human',
  'escalation_reason',
];

/**
 * Minimal RFC-4180-ish CSV parser. Handles quoted fields, escaped quotes,
 * commas inside quotes, CRLF line endings, and trailing newlines. We avoid
 * pulling in a CSV library to keep the admin bundle small.
 */
function parseCsv(text: string): { header: string[]; rows: string[][] } {
  const out: string[][] = [];
  let cur: string[] = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (ch === ',') {
      cur.push(field);
      field = '';
      i += 1;
      continue;
    }
    if (ch === '\n' || ch === '\r') {
      cur.push(field);
      field = '';
      out.push(cur);
      cur = [];
      if (ch === '\r' && text[i + 1] === '\n') i += 2;
      else i += 1;
      continue;
    }
    field += ch;
    i += 1;
  }
  if (field.length > 0 || cur.length > 0) {
    cur.push(field);
    out.push(cur);
  }
  // Drop fully-empty trailing lines
  while (out.length > 0 && out[out.length - 1].every((v) => v === '')) out.pop();
  if (out.length === 0) return { header: [], rows: [] };
  return { header: out[0].map((h) => h.trim()), rows: out.slice(1) };
}

function coerceNumber(v: string | undefined): number | undefined {
  if (v === undefined || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function coerceBool(v: string | undefined): boolean | undefined {
  if (v === undefined || v === '') return undefined;
  const lower = v.toLowerCase().trim();
  if (lower === 'true' || lower === '1' || lower === 'yes' || lower === 'y') return true;
  if (lower === 'false' || lower === '0' || lower === 'no' || lower === 'n') return false;
  return undefined;
}

/**
 * Build a partial-event row from a CSV record. The server fills in
 * `tenant_id`, `version`, `event_type`, `backfill_attestation`, and a
 * default `timestamp`, so we only need to package the per-call fields.
 */
function csvRowToEvent(header: string[], values: string[]): Record<string, unknown> {
  const map: Record<string, string> = {};
  header.forEach((h, idx) => {
    map[h] = values[idx] ?? '';
  });

  const event: Record<string, unknown> = {};
  const passthrough = [
    'idempotency_key',
    'external_id',
    'agent_remote_id',
    'direction',
    'from_number',
    'to_number',
    'status',
    'start_time',
    'end_time',
    'transcript',
    'summary',
    'recording_url',
    'escalation_reason',
    'twilio_sid',
  ];
  for (const k of passthrough) {
    if (map[k] !== undefined && map[k] !== '') event[k] = map[k];
  }

  const duration = coerceNumber(map.duration_seconds);
  if (duration !== undefined) event.duration_seconds = duration;

  const twilio = coerceNumber(map.twilio_cents);
  const openai = coerceNumber(map.openai_cents);
  const total = coerceNumber(map.total_cents);
  const isEst = coerceBool(map.is_estimated);
  if (twilio !== undefined || openai !== undefined || total !== undefined || isEst !== undefined) {
    event.costs = {
      twilio_cents: twilio ?? 0,
      openai_cents: openai ?? 0,
      total_cents: total ?? (twilio ?? 0) + (openai ?? 0),
      is_estimated: isEst ?? true,
    };
  }

  const transferred = coerceBool(map.transferred_to_human);
  if (transferred !== undefined) event.transferred_to_human = transferred;

  return event;
}

function downloadFile(filename: string, content: string, mime: string): void {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function escapeCsvField(v: unknown): string {
  if (v === undefined || v === null) return '';
  const s = String(v);
  if (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

const STATUS_TONE: Record<BatchRowResult['status'], string> = {
  inserted: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300',
  duplicate: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300',
  window_rejected: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300',
  validation_failed: 'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-300',
  failed: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300',
};

const STATUS_LABEL: Record<BatchRowResult['status'], string> = {
  inserted: 'Inserted',
  duplicate: 'Duplicate (already replayed)',
  window_rejected: 'Outside backfill window',
  validation_failed: 'Validation failed',
  failed: 'Persist failed',
};

export default function IngestBackfill() {
  const { user } = useAuth();
  const isPlatformAdmin = !!user?.isPlatformAdmin;

  const [tenantOverride, setTenantOverride] = useState('');
  const [reason, setReason] = useState('');
  const [attestedBy, setAttestedBy] = useState(user?.email ?? '');
  const [originalSystem, setOriginalSystem] = useState('');

  const [rawRows, setRawRows] = useState<Record<string, unknown>[]>([]);
  const [filename, setFilename] = useState<string | null>(null);
  const [parseError, setParseError] = useState<ParseError | null>(null);
  const [response, setResponse] = useState<BatchResponse | null>(null);
  const [filterStatus, setFilterStatus] = useState<BatchRowResult['status'] | 'all'>('all');

  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const submit = useMutation({
    mutationFn: async (): Promise<BatchResponse> => {
      const attestation: BatchAttestation = {
        reason: reason.trim(),
        attested_by: attestedBy.trim(),
      };
      if (originalSystem.trim()) attestation.original_system = originalSystem.trim();
      attestation.attested_at = new Date().toISOString();

      const body: Record<string, unknown> = {
        attestation,
        rows: rawRows,
      };
      if (isPlatformAdmin && tenantOverride.trim()) {
        body.tenant_id = tenantOverride.trim();
      }
      return api.post<BatchResponse>('/v1/ingest/calls/backfill/batch', body);
    },
    onSuccess: (data) => {
      setResponse(data);
      setFilterStatus('all');
    },
  });

  const handleFile = async (file: File) => {
    setParseError(null);
    setResponse(null);
    setFilename(file.name);

    try {
      const text = await file.text();
      const lower = file.name.toLowerCase();
      let parsed: Record<string, unknown>[] = [];

      if (lower.endsWith('.ndjson') || lower.endsWith('.jsonl')) {
        parsed = text
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter(Boolean)
          .map((line, idx) => {
            try {
              return JSON.parse(line) as Record<string, unknown>;
            } catch (err) {
              throw new Error(`Line ${idx + 1}: invalid JSON (${String(err)})`);
            }
          });
      } else if (lower.endsWith('.json')) {
        const data = JSON.parse(text);
        if (!Array.isArray(data)) {
          throw new Error('JSON file must be an array of call objects.');
        }
        parsed = data as Record<string, unknown>[];
      } else {
        const { header, rows } = parseCsv(text);
        if (header.length === 0) {
          throw new Error('CSV is empty.');
        }
        if (!header.includes('idempotency_key')) {
          throw new Error('CSV header is missing the required `idempotency_key` column.');
        }
        parsed = rows.map((r) => csvRowToEvent(header, r));
      }

      if (parsed.length === 0) {
        throw new Error('File contained no rows.');
      }
      if (parsed.length > 500) {
        throw new Error(
          `Batches are capped at 500 rows; this file has ${parsed.length}. Split it into multiple uploads.`,
        );
      }
      setRawRows(parsed);
    } catch (err) {
      setParseError({ message: err instanceof Error ? err.message : String(err) });
      setRawRows([]);
    }
  };

  const reset = () => {
    setRawRows([]);
    setFilename(null);
    setResponse(null);
    setParseError(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const downloadSample = () => {
    const sample = [
      SAMPLE_CSV_HEADER.join(','),
      [
        'replay-2026-04-19-001',
        'remix-call-9821',
        'agent-emergency-line',
        'inbound',
        '+15551112222',
        '+15553334444',
        'completed',
        '2026-04-19T08:14:00Z',
        '2026-04-19T08:16:34Z',
        '154',
        '7',
        '21',
        '28',
        'true',
        'Patient called about same-day appointment availability.',
        'Caller booked Tuesday 9:30am.',
        '',
        'false',
        '',
      ].join(','),
    ].join('\n');
    downloadFile('backfill-template.csv', sample, 'text/csv');
  };

  const downloadFailedRows = () => {
    if (!response) return;
    const failedIndexes = new Set(
      response.results
        .filter((r) => r.status === 'validation_failed' || r.status === 'failed' || r.status === 'window_rejected')
        .map((r) => r.row_index),
    );
    if (failedIndexes.size === 0) return;
    const failedRows = rawRows
      .map((row, idx) => ({ row, idx }))
      .filter(({ idx }) => failedIndexes.has(idx))
      .map(({ row }) => row);

    const allKeys = new Set<string>();
    for (const r of failedRows) {
      for (const k of Object.keys(r)) {
        if (k !== 'costs') allKeys.add(k);
      }
    }
    const flatHeader = [
      ...Array.from(allKeys),
      'twilio_cents', 'openai_cents', 'total_cents', 'is_estimated',
    ];
    const lines = [flatHeader.join(',')];
    for (const r of failedRows) {
      const cost = (r.costs as { twilio_cents?: number; openai_cents?: number; total_cents?: number; is_estimated?: boolean } | undefined) ?? {};
      const fields = flatHeader.map((h) => {
        if (h === 'twilio_cents') return escapeCsvField(cost.twilio_cents);
        if (h === 'openai_cents') return escapeCsvField(cost.openai_cents);
        if (h === 'total_cents') return escapeCsvField(cost.total_cents);
        if (h === 'is_estimated') return escapeCsvField(cost.is_estimated);
        return escapeCsvField((r as Record<string, unknown>)[h]);
      });
      lines.push(fields.join(','));
    }
    downloadFile('backfill-failed-rows.csv', lines.join('\n'), 'text/csv');
  };

  const downloadReport = () => {
    if (!response) return;
    const lines = [
      'row_index,idempotency_key,external_id,status,age_days,error',
      ...response.results.map((r) =>
        [
          r.row_index,
          escapeCsvField(r.idempotency_key),
          escapeCsvField(r.external_id),
          r.status,
          r.age_days ?? '',
          escapeCsvField(r.error),
        ].join(','),
      ),
    ];
    downloadFile('backfill-report.csv', lines.join('\n'), 'text/csv');
  };

  const canSubmit = useMemo(() => {
    return (
      rawRows.length > 0 &&
      reason.trim().length >= 8 &&
      attestedBy.trim().length >= 1 &&
      !submit.isPending
    );
  }, [rawRows.length, reason, attestedBy, submit.isPending]);

  const filteredResults = useMemo(() => {
    if (!response) return [];
    if (filterStatus === 'all') return response.results;
    return response.results.filter((r) => r.status === filterStatus);
  }, [response, filterStatus]);

  return (
    <div className="space-y-6 max-w-6xl">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <History className="h-6 w-6 text-primary" />
            Backfill calls from a CSV
          </h1>
          <p className="text-sm text-muted mt-1 max-w-2xl">
            Replay historical call events through the federated ingest backfill endpoint.
            Upload a CSV (or NDJSON) of dropped calls plus a single attestation block —
            the tool fans out per-row, preserving idempotency keys so partial failures
            are safely resumable.
          </p>
        </div>
        <button
          onClick={downloadSample}
          className="flex items-center gap-2 px-3 py-2 border border-border rounded-lg text-sm hover:bg-surface-secondary"
        >
          <Download className="h-4 w-4" />
          CSV template
        </button>
      </div>

      <div className="bg-surface border border-border rounded-xl p-5 space-y-4">
        <h2 className="text-sm font-semibold flex items-center gap-2">
          <ShieldAlert className="h-4 w-4 text-amber-500" />
          Attestation
        </h2>
        <p className="text-xs text-muted">
          Required by the backfill endpoint — recorded with every event so finance can
          audit retroactive billing adjustments. The reason should describe the
          incident or backlog being replayed.
        </p>
        <div className="grid gap-4 md:grid-cols-2">
          <label className="block">
            <span className="block text-xs font-medium text-muted mb-1">
              Reason (8–500 chars)
            </span>
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Remix outage 2026-04-19; replaying 11 dropped calls."
              rows={3}
              className="w-full px-3 py-2 rounded-lg border border-border bg-surface-secondary text-sm"
            />
            <span className="text-[10px] text-muted">{reason.length}/500</span>
          </label>
          <div className="space-y-3">
            <label className="block">
              <span className="block text-xs font-medium text-muted mb-1">Attested by</span>
              <input
                type="text"
                value={attestedBy}
                onChange={(e) => setAttestedBy(e.target.value)}
                placeholder="ops@acme.test"
                className="w-full px-3 py-2 rounded-lg border border-border bg-surface-secondary text-sm"
              />
            </label>
            <label className="block">
              <span className="block text-xs font-medium text-muted mb-1">
                Original system <span className="text-muted/60">(optional)</span>
              </span>
              <input
                type="text"
                value={originalSystem}
                onChange={(e) => setOriginalSystem(e.target.value)}
                placeholder="remix-prod-eu"
                className="w-full px-3 py-2 rounded-lg border border-border bg-surface-secondary text-sm"
              />
            </label>
          </div>
        </div>

        {isPlatformAdmin && (
          <label className="block">
            <span className="block text-xs font-medium text-muted mb-1">
              Tenant ID <span className="text-muted/60">(platform admin override — leave blank to target your own tenant)</span>
            </span>
            <input
              type="text"
              value={tenantOverride}
              onChange={(e) => setTenantOverride(e.target.value)}
              placeholder="00000000-0000-0000-0000-000000000000"
              className="w-full md:w-1/2 px-3 py-2 rounded-lg border border-border bg-surface-secondary text-sm font-mono"
            />
          </label>
        )}
      </div>

      <div className="bg-surface border border-border rounded-xl p-5 space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold flex items-center gap-2">
            <FileText className="h-4 w-4 text-primary" />
            Calls file
          </h2>
          {filename && (
            <button onClick={reset} className="text-xs text-muted hover:text-foreground flex items-center gap-1">
              <Trash2 className="h-3 w-3" /> Clear
            </button>
          )}
        </div>

        <label
          htmlFor="ingest-backfill-file"
          className="flex flex-col items-center justify-center gap-2 border-2 border-dashed border-border rounded-lg py-8 cursor-pointer hover:bg-surface-secondary"
        >
          <Upload className="h-6 w-6 text-muted" />
          <span className="text-sm font-medium">
            {filename ? filename : 'Click to choose a CSV, NDJSON, or JSON file'}
          </span>
          <span className="text-xs text-muted">Up to 500 rows per batch.</span>
          <input
            id="ingest-backfill-file"
            ref={fileInputRef}
            type="file"
            accept=".csv,.ndjson,.jsonl,.json,text/csv,application/json,application/x-ndjson"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void handleFile(f);
            }}
          />
        </label>

        {parseError && (
          <div className="flex items-start gap-2 text-sm text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/10 border border-red-200 dark:border-red-900/30 rounded-lg px-3 py-2">
            <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
            <div>
              <div className="font-medium">Could not read file</div>
              <div className="text-xs mt-0.5">{parseError.message}</div>
            </div>
          </div>
        )}

        {rawRows.length > 0 && !parseError && (
          <div className="text-sm text-muted flex items-center gap-2">
            <Info className="h-4 w-4" />
            {rawRows.length} row{rawRows.length === 1 ? '' : 's'} ready to replay.
          </div>
        )}
      </div>

      <div className="flex items-center justify-end gap-3">
        {submit.isError && (
          <div className="text-sm text-red-600 dark:text-red-400 mr-auto flex items-center gap-2">
            <AlertTriangle className="h-4 w-4" />
            {(submit.error as Error)?.message ?? 'Batch submission failed'}
          </div>
        )}
        <button
          onClick={() => submit.mutate()}
          disabled={!canSubmit}
          className="flex items-center gap-2 px-5 py-2.5 bg-primary text-white rounded-lg text-sm font-medium hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {submit.isPending ? (
            <RefreshCw className="h-4 w-4 animate-spin" />
          ) : (
            <Upload className="h-4 w-4" />
          )}
          {submit.isPending ? 'Replaying…' : `Replay ${rawRows.length || ''} call${rawRows.length === 1 ? '' : 's'}`.trim()}
        </button>
      </div>

      {response && (
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
            <SummaryTile label="Total" value={response.summary.total} icon={FileText} />
            <SummaryTile label="Inserted" value={response.summary.inserted} tone="success" icon={CheckCircle2} />
            <SummaryTile label="Duplicates" value={response.summary.duplicate} tone="info" icon={History} />
            <SummaryTile label="Outside window" value={response.summary.window_rejected} tone="warn" icon={ShieldAlert} />
            <SummaryTile label="Invalid rows" value={response.summary.validation_failed} tone="warn" icon={FileWarning} />
            <SummaryTile label="Failed" value={response.summary.failed} tone="danger" icon={AlertTriangle} />
          </div>

          <div className="bg-surface border border-border rounded-xl overflow-hidden">
            <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 border-b border-border">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium">Per-row results</span>
                <span className="text-xs text-muted">tenant <code className="font-mono">{response.tenant_id}</code></span>
              </div>
              <div className="flex items-center gap-2">
                <select
                  value={filterStatus}
                  onChange={(e) => setFilterStatus(e.target.value as BatchRowResult['status'] | 'all')}
                  className="px-3 py-1.5 text-xs rounded-lg border border-border bg-surface"
                >
                  <option value="all">All ({response.summary.total})</option>
                  <option value="inserted">Inserted ({response.summary.inserted})</option>
                  <option value="duplicate">Duplicates ({response.summary.duplicate})</option>
                  <option value="window_rejected">Window-rejected ({response.summary.window_rejected})</option>
                  <option value="validation_failed">Invalid ({response.summary.validation_failed})</option>
                  <option value="failed">Failed ({response.summary.failed})</option>
                </select>
                <button
                  onClick={downloadReport}
                  className="flex items-center gap-1 px-3 py-1.5 text-xs border border-border rounded-lg hover:bg-surface-secondary"
                >
                  <Download className="h-3 w-3" /> Report CSV
                </button>
                <button
                  onClick={downloadFailedRows}
                  disabled={
                    response.summary.validation_failed +
                      response.summary.failed +
                      response.summary.window_rejected ===
                    0
                  }
                  className="flex items-center gap-1 px-3 py-1.5 text-xs border border-border rounded-lg hover:bg-surface-secondary disabled:opacity-50"
                >
                  <Download className="h-3 w-3" /> Failed rows CSV
                </button>
              </div>
            </div>
            {filteredResults.length === 0 ? (
              <EmptyState icon={FileText} title="No matching rows" variant="compact" />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border bg-surface-secondary text-xs">
                      <th className="text-left px-4 py-2 font-medium text-muted">#</th>
                      <th className="text-left px-4 py-2 font-medium text-muted">Status</th>
                      <th className="text-left px-4 py-2 font-medium text-muted">Idempotency key</th>
                      <th className="text-left px-4 py-2 font-medium text-muted">External ID</th>
                      <th className="text-left px-4 py-2 font-medium text-muted">Age (days)</th>
                      <th className="text-left px-4 py-2 font-medium text-muted">Notes</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredResults.map((r) => (
                      <tr key={r.row_index} className="border-b border-border last:border-0 hover:bg-surface-secondary/50">
                        <td className="px-4 py-2 text-xs text-muted">{r.row_index + 1}</td>
                        <td className="px-4 py-2">
                          <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_TONE[r.status]}`}>
                            {STATUS_LABEL[r.status]}
                          </span>
                        </td>
                        <td className="px-4 py-2 text-xs font-mono break-all">{r.idempotency_key ?? '—'}</td>
                        <td className="px-4 py-2 text-xs font-mono break-all">{r.external_id ?? '—'}</td>
                        <td className="px-4 py-2 text-xs text-muted">{r.age_days ?? '—'}</td>
                        <td className="px-4 py-2 text-xs text-muted max-w-md break-words">{r.error ?? ''}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {(response.summary.failed > 0 || response.summary.validation_failed > 0) && (
            <div className="bg-amber-50 dark:bg-amber-900/10 border border-amber-200 dark:border-amber-900/30 rounded-lg p-4 text-sm">
              <div className="font-medium flex items-center gap-2">
                <AlertTriangle className="h-4 w-4 text-amber-600" />
                Some rows did not land
              </div>
              <p className="text-xs text-muted mt-1">
                Download the failed-rows CSV, fix the problems, and re-upload. Idempotency keys
                are preserved, so any rows that did succeed will return as <code>duplicate</code>
                on the next run instead of being processed twice.
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function SummaryTile({
  label,
  value,
  icon: Icon,
  tone = 'default',
}: {
  label: string;
  value: number;
  icon: typeof History;
  tone?: 'default' | 'success' | 'info' | 'warn' | 'danger';
}) {
  const toneClasses = {
    default: 'bg-surface',
    success: 'bg-green-50 dark:bg-green-900/10',
    info: 'bg-blue-50 dark:bg-blue-900/10',
    warn: 'bg-amber-50 dark:bg-amber-900/10',
    danger: 'bg-red-50 dark:bg-red-900/10',
  }[tone];
  return (
    <div className={`rounded-xl border border-border p-3 ${toneClasses}`}>
      <div className="flex items-center gap-2 text-muted text-[11px] font-medium uppercase tracking-wide">
        <Icon className="h-3.5 w-3.5" />
        {label}
      </div>
      <div className="mt-1 text-xl font-semibold">{value.toLocaleString()}</div>
    </div>
  );
}
