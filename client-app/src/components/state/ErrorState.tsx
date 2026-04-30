import { AlertCircle, RotateCw, type LucideIcon } from 'lucide-react';

export interface ErrorStateProps {
  title?: string;
  description?: string;
  error?: unknown;
  icon?: LucideIcon;
  onRetry?: () => void;
  retryLabel?: string;
  secondaryAction?: { label: string; onClick: () => void };
  variant?: 'default' | 'compact' | 'inline';
}

function extractMessage(error: unknown): string | undefined {
  if (!error) return undefined;
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  if (typeof error === 'object' && 'message' in error) {
    const m = (error as { message?: unknown }).message;
    if (typeof m === 'string') return m;
  }
  return undefined;
}

export default function ErrorState({
  title = 'Something went wrong',
  description,
  error,
  icon: Icon = AlertCircle,
  onRetry,
  retryLabel = 'Try again',
  secondaryAction,
  variant = 'default',
}: ErrorStateProps) {
  const errorMessage = extractMessage(error);
  const body = description ?? errorMessage;

  if (variant === 'inline') {
    return (
      <div
        role="alert"
        data-testid="error-state-inline"
        className="bg-danger/10 border border-danger/30 text-danger text-sm px-4 py-3 rounded-lg flex items-start gap-2"
      >
        <Icon className="h-4 w-4 mt-0.5 shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="font-medium">{title}</div>
          {body && <div className="text-danger/80 mt-0.5 break-words">{body}</div>}
        </div>
        {onRetry && (
          <button
            onClick={onRetry}
            className="inline-flex items-center gap-1 text-xs font-medium text-danger hover:underline shrink-0"
          >
            <RotateCw className="h-3 w-3" />
            {retryLabel}
          </button>
        )}
      </div>
    );
  }

  const padY = variant === 'compact' ? 'py-8' : 'py-14';
  return (
    <div
      role="alert"
      data-testid="error-state"
      className={`bg-surface border border-danger/30 rounded-xl flex flex-col items-center justify-center text-center px-6 ${padY}`}
    >
      <div className="h-14 w-14 rounded-full bg-danger/10 flex items-center justify-center mb-4">
        <Icon className="h-7 w-7 text-danger" />
      </div>
      <h3 className="text-base font-semibold text-text-primary">{title}</h3>
      {body && (
        <p className="mt-1.5 text-sm text-text-secondary max-w-md break-words">{body}</p>
      )}
      {(onRetry || secondaryAction) && (
        <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
          {onRetry && (
            <button
              onClick={onRetry}
              className="inline-flex items-center gap-1.5 bg-primary hover:bg-primary-hover text-on-primary text-sm font-medium px-4 py-2 rounded-lg transition-colors"
            >
              <RotateCw className="h-4 w-4" />
              {retryLabel}
            </button>
          )}
          {secondaryAction && (
            <button
              onClick={secondaryAction.onClick}
              className="inline-flex items-center text-sm font-medium text-text-secondary hover:text-text-primary px-3 py-2 rounded-lg border border-border hover:bg-surface-hover transition-colors"
            >
              {secondaryAction.label}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
