import Skeleton from './Skeleton';

export default function PageSkeleton() {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-live="polite"
      aria-label="Loading"
      className="w-full space-y-4 p-4"
      data-testid="page-skeleton"
    >
      <div className="flex items-center justify-between gap-4">
        <Skeleton className="h-8 w-48" rounded="md" />
        <Skeleton className="h-8 w-28" rounded="md" />
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Skeleton className="h-20" rounded="xl" />
        <Skeleton className="h-20" rounded="xl" />
        <Skeleton className="h-20" rounded="xl" />
        <Skeleton className="h-20" rounded="xl" />
      </div>
      <div className="flex flex-col gap-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-12" rounded="lg" />
        ))}
      </div>
    </div>
  );
}
