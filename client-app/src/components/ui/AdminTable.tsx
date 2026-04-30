import { type ReactNode, type ThHTMLAttributes } from 'react';
import clsx from 'clsx';

export interface AdminTableProps {
  children: ReactNode;
  maxHeight?: string;
  className?: string;
  density?: 'comfy' | 'dense';
}

export default function AdminTable({
  children,
  maxHeight,
  className,
  density = 'comfy',
}: AdminTableProps) {
  const cellPad = density === 'dense' ? '[&_td]:py-2 [&_th]:py-2' : '[&_td]:py-3 [&_th]:py-3';
  return (
    <div
      className={clsx(
        'bg-surface border border-border rounded-xl overflow-hidden shadow-[var(--elevation-1)]',
        className,
      )}
    >
      <div
        className={clsx('overflow-auto', maxHeight && 'overflow-y-auto')}
        style={maxHeight ? { maxHeight } : undefined}
      >
        <table
          className={clsx(
            'w-full text-sm tabular-nums',
            cellPad,
            '[&_thead]:sticky [&_thead]:top-0 [&_thead]:z-10',
            '[&_thead_tr]:bg-surface-secondary [&_thead_tr]:border-b [&_thead_tr]:border-border',
            '[&_th]:px-4 [&_th]:font-medium [&_th]:text-text-secondary [&_th]:text-left [&_th]:text-xs [&_th]:uppercase [&_th]:tracking-wider',
            '[&_td]:px-4 [&_td]:text-text-primary [&_td]:align-middle',
            '[&_tbody_tr]:border-b [&_tbody_tr]:border-border/50 [&_tbody_tr:last-child]:border-b-0',
            '[&_tbody_tr]:transition-colors [&_tbody_tr:hover]:bg-surface-hover [&_tbody_tr:focus-within]:bg-surface-hover',
          )}
        >
          {children}
        </table>
      </div>
    </div>
  );
}

export interface AdminThProps extends ThHTMLAttributes<HTMLTableCellElement> {
  align?: 'left' | 'right' | 'center';
  children: ReactNode;
}

export function AdminTh({ align = 'left', className, children, ...rest }: AdminThProps) {
  return (
    <th
      {...rest}
      className={clsx(
        align === 'right' && 'text-right',
        align === 'center' && 'text-center',
        className,
      )}
    >
      {children}
    </th>
  );
}

export interface AdminToolbarProps {
  selectionLabel?: ReactNode;
  bulkActions?: ReactNode;
  filters?: ReactNode;
  trailing?: ReactNode;
  className?: string;
}

export function AdminToolbar({
  selectionLabel,
  bulkActions,
  filters,
  trailing,
  className,
}: AdminToolbarProps) {
  const hasSelection = !!selectionLabel;
  return (
    <div
      className={clsx(
        'flex flex-wrap items-center gap-3 px-4 py-2.5 border border-border rounded-xl bg-surface',
        hasSelection && 'border-primary/40 bg-primary-light/30',
        className,
      )}
    >
      {hasSelection && (
        <div className="flex items-center gap-3">
          <span className="text-xs font-medium text-primary">{selectionLabel}</span>
          {bulkActions && (
            <div className="flex items-center gap-1.5">{bulkActions}</div>
          )}
        </div>
      )}
      {!hasSelection && filters && (
        <div className="flex flex-wrap items-center gap-2">{filters}</div>
      )}
      {trailing && <div className="ml-auto flex items-center gap-2">{trailing}</div>}
    </div>
  );
}

export interface AdminPaginationProps {
  page: number;
  totalPages: number;
  onPageChange: (next: number) => void;
  pageSize?: number;
  total?: number;
  className?: string;
}

export function AdminPagination({
  page,
  totalPages,
  onPageChange,
  pageSize,
  total,
  className,
}: AdminPaginationProps) {
  const hasRange = pageSize !== undefined && total !== undefined && total > 0;
  const start = hasRange ? (page - 1) * (pageSize ?? 0) + 1 : null;
  const end = hasRange ? Math.min(total ?? 0, page * (pageSize ?? 0)) : null;
  return (
    <nav
      aria-label="Pagination"
      className={clsx('flex items-center justify-between px-4 py-3 text-xs text-text-secondary', className)}
    >
      <span>
        {hasRange && (
          <>
            <span className="font-medium text-text-primary tabular-nums">{start}</span>
            –<span className="font-medium text-text-primary tabular-nums">{end}</span>
            {' of '}
            <span className="font-medium text-text-primary tabular-nums">{total?.toLocaleString()}</span>
          </>
        )}
        {!hasRange && (
          <>Page <span className="font-medium text-text-primary tabular-nums">{page}</span> of <span className="tabular-nums">{totalPages}</span></>
        )}
      </span>
      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={() => onPageChange(Math.max(1, page - 1))}
          disabled={page <= 1}
          className="px-2.5 py-1 rounded border border-border bg-surface text-text-secondary hover:bg-surface-hover hover:text-text-primary disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          Prev
        </button>
        <button
          type="button"
          onClick={() => onPageChange(Math.min(totalPages, page + 1))}
          disabled={page >= totalPages}
          className="px-2.5 py-1 rounded border border-border bg-surface text-text-secondary hover:bg-surface-hover hover:text-text-primary disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          Next
        </button>
      </div>
    </nav>
  );
}
