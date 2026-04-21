import { Wrench, RefreshCw } from 'lucide-react';

interface MaintenanceProps {
  message?: string | null;
  scheduledFor?: string | null;
}

export default function Maintenance({ message, scheduledFor }: MaintenanceProps) {
  return (
    <div className="min-h-screen flex items-center justify-center bg-surface-secondary px-6">
      <div className="max-w-md w-full text-center">
        <div className="inline-flex items-center justify-center h-20 w-20 rounded-2xl bg-amber-50 text-warning mb-6">
          <Wrench className="h-10 w-10" />
        </div>
        <p className="text-sm font-semibold text-warning uppercase tracking-wider mb-2">Scheduled Maintenance</p>
        <h1 className="text-3xl font-bold text-text-primary font-display mb-3">QVO is briefly offline for an upgrade</h1>
        <p className="text-text-secondary mb-2">
          {message || "We're rolling out improvements right now. Service will resume shortly."}
        </p>
        {scheduledFor && (
          <p className="text-sm text-text-muted mb-6">
            Estimated completion: {new Date(scheduledFor).toLocaleString()}
          </p>
        )}
        <button
          onClick={() => window.location.reload()}
          className="inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-lg bg-primary text-white font-medium hover:bg-primary-hover transition-colors mt-4"
        >
          <RefreshCw className="h-4 w-4" /> Check again
        </button>
      </div>
    </div>
  );
}
