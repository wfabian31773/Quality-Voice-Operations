export function formatDateTime(input: string | null | undefined): string {
  if (!input) return '—';
  const d = new Date(input);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

export function formatTimeRange(
  start: string | null | undefined,
  end: string | null | undefined,
): string {
  if (!start) return '—';
  const startDate = new Date(start);
  if (Number.isNaN(startDate.getTime())) return '—';
  const startStr = startDate.toLocaleString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
  if (!end) return startStr;
  const endDate = new Date(end);
  if (Number.isNaN(endDate.getTime())) return startStr;
  const sameDay =
    startDate.toDateString() === endDate.toDateString();
  const endStr = endDate.toLocaleString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
    ...(sameDay
      ? {}
      : { month: 'short', day: 'numeric', weekday: 'short' }),
  });
  return `${startStr} – ${endStr}`;
}

export function formatStatus(status: string | null | undefined): string {
  if (!status) return '';
  return status
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

export function relativeTime(input: string | null | undefined): string {
  if (!input) return '';
  const d = new Date(input);
  if (Number.isNaN(d.getTime())) return '';
  const diffMs = d.getTime() - Date.now();
  const minutes = Math.round(diffMs / 60_000);
  const abs = Math.abs(minutes);
  if (abs < 1) return 'just now';
  if (abs < 60) return minutes >= 0 ? `in ${abs}m` : `${abs}m ago`;
  const hours = Math.round(minutes / 60);
  const absH = Math.abs(hours);
  if (absH < 24) return hours >= 0 ? `in ${absH}h` : `${absH}h ago`;
  const days = Math.round(hours / 24);
  return days >= 0 ? `in ${Math.abs(days)}d` : `${Math.abs(days)}d ago`;
}
