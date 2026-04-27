export default function PageSkeleton() {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-live="polite"
      className="flex min-h-[60vh] w-full items-center justify-center"
      data-testid="page-skeleton"
    >
      <div className="flex flex-col items-center gap-4 text-slate-400">
        <div className="h-10 w-10 animate-spin rounded-full border-2 border-slate-200 border-t-slate-500" />
        <span className="text-sm font-medium">Loading…</span>
      </div>
    </div>
  );
}
