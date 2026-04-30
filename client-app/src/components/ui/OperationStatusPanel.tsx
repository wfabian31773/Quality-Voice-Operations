import { type ReactNode } from 'react';
import { Loader2, CheckCircle2, AlertTriangle, Clock, XCircle, RefreshCw } from 'lucide-react';
import clsx from 'clsx';

export type OperationStatus = 'idle' | 'queued' | 'running' | 'success' | 'failed' | 'cancelled';

export interface OperationStatusPanelProps {
  title: ReactNode;
  description?: ReactNode;
  status: OperationStatus;
  progress?: number;
  processed?: number;
  total?: number;
  eta?: string;
  updatedAt?: string;
  actions?: ReactNode;
  meta?: { label: string; value: ReactNode }[];
  error?: string | null;
  className?: string;
  testId?: string;
}

const STATUS_TONE: Record<OperationStatus, { label: string; bar: string; pill: string; icon: ReactNode }> = {
  idle: {
    label: 'Idle',
    bar: 'bg-text-muted/40',
    pill: 'bg-surface-hover text-text-secondary border-border',
    icon: <Clock className="h-3.5 w-3.5" />,
  },
  queued: {
    label: 'Queued',
    bar: 'bg-info/60',
    pill: 'bg-info-light text-info border-info/30',
    icon: <Clock className="h-3.5 w-3.5" />,
  },
  running: {
    label: 'Running',
    bar: 'bg-primary',
    pill: 'bg-primary-light text-primary border-primary/30',
    icon: <Loader2 className="h-3.5 w-3.5 animate-spin" />,
  },
  success: {
    label: 'Completed',
    bar: 'bg-success',
    pill: 'bg-success-light text-success border-success/30',
    icon: <CheckCircle2 className="h-3.5 w-3.5" />,
  },
  failed: {
    label: 'Failed',
    bar: 'bg-danger',
    pill: 'bg-danger-light text-danger border-danger/30',
    icon: <AlertTriangle className="h-3.5 w-3.5" />,
  },
  cancelled: {
    label: 'Cancelled',
    bar: 'bg-text-muted/60',
    pill: 'bg-surface-hover text-text-secondary border-border',
    icon: <XCircle className="h-3.5 w-3.5" />,
  },
};

export default function OperationStatusPanel({
  title,
  description,
  status,
  progress,
  processed,
  total,
  eta,
  updatedAt,
  actions,
  meta,
  error,
  className,
  testId,
}: OperationStatusPanelProps) {
  const tone = STATUS_TONE[status];
  const showBar = progress !== undefined || status === 'running';
  const pct = progress !== undefined
    ? Math.max(0, Math.min(1, progress)) * 100
    : status === 'running'
      ? null
      : 100;
  const indeterminate = pct === null;

  return (
    <section
      className={clsx(
        'bg-surface border border-border rounded-xl p-5 shadow-[var(--elevation-1)]',
        className,
      )}
      aria-live="polite"
      data-testid={testId ?? 'operation-status-panel'}
    >
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="text-sm font-semibold text-text-primary">{title}</h3>
            <span
              className={clsx(
                'inline-flex items-center gap-1 text-[11px] font-medium uppercase tracking-wider px-2 py-0.5 rounded-full border',
                tone.pill,
              )}
            >
              {tone.icon}
              {tone.label}
            </span>
          </div>
          {description && (
            <p className="text-xs text-text-secondary mt-1">{description}</p>
          )}
        </div>
        {actions && <div className="flex items-center gap-2 shrink-0">{actions}</div>}
      </header>

      {showBar && (
        <div className="mt-4">
          <div className="flex items-baseline justify-between text-xs text-text-secondary mb-1.5">
            <span>
              {processed !== undefined && total !== undefined
                ? <><span className="tabular-nums font-medium text-text-primary">{processed.toLocaleString()}</span> / {total.toLocaleString()} processed</>
                : indeterminate
                  ? 'Working…'
                  : `${Math.round(pct ?? 0)}%`}
            </span>
            {eta && <span className="text-text-muted">{eta}</span>}
          </div>
          <div className="h-1.5 w-full rounded-full bg-surface-hover overflow-hidden">
            {indeterminate ? (
              <div className={clsx('h-full w-1/3 rounded-full animate-pulse', tone.bar)} />
            ) : (
              <div
                className={clsx('h-full rounded-full transition-all duration-500 ease-out', tone.bar)}
                style={{ width: `${pct}%` }}
              />
            )}
          </div>
        </div>
      )}

      {meta && meta.length > 0 && (
        <dl className="mt-4 grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
          {meta.map((m, idx) => (
            <div key={idx} className="min-w-0">
              <dt className="text-text-muted uppercase tracking-wider text-[10px] font-medium">{m.label}</dt>
              <dd className="text-text-primary font-medium tabular-nums truncate">{m.value}</dd>
            </div>
          ))}
        </dl>
      )}

      {error && (
        <div className="mt-4 flex items-start gap-2 rounded-md border border-danger/30 bg-danger-light px-3 py-2 text-xs text-danger">
          <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" aria-hidden="true" />
          <p className="min-w-0 break-words">{error}</p>
        </div>
      )}

      {updatedAt && (
        <p className="mt-3 text-[11px] text-text-muted flex items-center gap-1.5">
          <RefreshCw className="h-3 w-3" aria-hidden="true" /> Updated {updatedAt}
        </p>
      )}
    </section>
  );
}
