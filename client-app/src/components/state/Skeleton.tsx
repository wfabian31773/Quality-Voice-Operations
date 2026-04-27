import { type CSSProperties } from 'react';

interface SkeletonProps {
  className?: string;
  style?: CSSProperties;
  rounded?: 'sm' | 'md' | 'lg' | 'xl' | 'full';
  /**
   * When true, the skeleton block declares its own a11y status/live region.
   * Default false — caller is expected to wrap multiple skeletons in a single
   * status container (SkeletonRows / SkeletonGrid / page-level wrapper) so
   * screen readers don't announce every block individually.
   */
  standalone?: boolean;
  'data-testid'?: string;
}

const ROUNDED_MAP: Record<NonNullable<SkeletonProps['rounded']>, string> = {
  sm: 'rounded-sm',
  md: 'rounded-md',
  lg: 'rounded-lg',
  xl: 'rounded-xl',
  full: 'rounded-full',
};

export default function Skeleton({
  className = '',
  style,
  rounded = 'md',
  standalone = false,
  'data-testid': testId = 'skeleton',
}: SkeletonProps) {
  const a11yProps = standalone
    ? {
        role: 'status' as const,
        'aria-busy': true,
        'aria-live': 'polite' as const,
        'aria-label': 'Loading',
      }
    : { 'aria-hidden': true };

  return (
    <div
      {...a11yProps}
      data-testid={testId}
      className={`animate-pulse bg-surface-hover ${ROUNDED_MAP[rounded]} ${className}`}
      style={style}
    />
  );
}

interface SkeletonRowsProps {
  count?: number;
  className?: string;
  rowClassName?: string;
  gap?: 'sm' | 'md' | 'lg';
}

const GAP_MAP: Record<NonNullable<SkeletonRowsProps['gap']>, string> = {
  sm: 'gap-2',
  md: 'gap-3',
  lg: 'gap-4',
};

export function SkeletonRows({
  count = 4,
  className = '',
  rowClassName = 'h-12',
  gap = 'md',
}: SkeletonRowsProps) {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-live="polite"
      aria-label="Loading"
      className={`flex flex-col ${GAP_MAP[gap]} ${className}`}
      data-testid="skeleton-rows"
    >
      {Array.from({ length: count }).map((_, i) => (
        <Skeleton key={i} className={rowClassName} rounded="lg" />
      ))}
    </div>
  );
}

interface SkeletonGridProps {
  count?: number;
  className?: string;
  cardClassName?: string;
}

export function SkeletonGrid({
  count = 6,
  className = 'grid gap-4 sm:grid-cols-2 lg:grid-cols-3',
  cardClassName = 'h-36',
}: SkeletonGridProps) {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-live="polite"
      aria-label="Loading"
      className={className}
      data-testid="skeleton-grid"
    >
      {Array.from({ length: count }).map((_, i) => (
        <Skeleton key={i} className={cardClassName} rounded="xl" />
      ))}
    </div>
  );
}
