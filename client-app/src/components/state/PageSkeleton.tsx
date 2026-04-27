export default function PageSkeleton() {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-live="polite"
      className="flex min-h-[60vh] w-full items-center justify-center"
      data-testid="page-skeleton"
    >
      <div className="flex flex-col items-center gap-4 text-text-secondary">
        <div className="h-10 w-10 animate-spin rounded-full border-2 border-border border-t-primary" />
        <span className="text-sm font-medium">Loading…</span>
      </div>
    </div>
  );
}
