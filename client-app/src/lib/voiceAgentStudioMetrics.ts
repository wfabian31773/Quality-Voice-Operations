export interface StudioCallRow {
  id: string;
  start_time?: string;
  caller_number?: string | null;
  called_number?: string | null;
  lifecycle_state?: string;
  duration_seconds?: number | null;
  total_cost_cents?: number | null;
  tool_count?: number | null;
  failed_tool_count?: number | null;
  outcome_type?: string | null;
  next_action?: string | null;
}

export interface StudioPhoneNumber {
  id: string;
  phone_number: string;
  friendly_name?: string | null;
  routed_agent_id?: string | null;
  routing_active?: boolean;
  status?: string;
}

export interface AgentInsights {
  conversationCount: number;
  liveCallCount: number;
  totalMinutes: number;
  totalCostCents: number;
  toolCallCount: number;
  durationP50Seconds: number | null;
  timeToFirstAudioP50: null;
  errorRate: number | null;
  transferRate: number | null;
}

export type InsightRange = '7d' | '30d' | '100';

export const LIVE_CALL_STATES = new Set([
  'in_progress',
  'active',
  'CALL_CONNECTED',
  'CALL_STARTED',
  'AGENT_CONNECTED',
]);

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isLiveCallState(state?: string | null): boolean {
  return Boolean(state && LIVE_CALL_STATES.has(state));
}

export function isFailedCall(row: StudioCallRow): boolean {
  if (row.lifecycle_state === 'CALL_FAILED') return true;
  return (row.failed_tool_count ?? 0) > 0;
}

export function isTransferredCall(row: StudioCallRow): boolean {
  if (row.lifecycle_state === 'CALL_ESCALATED') return true;
  const outcome = row.outcome_type ?? '';
  const next = row.next_action ?? '';
  return /transfer/i.test(outcome) || /transfer/i.test(next);
}

export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 1) return sorted[0];
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  const weight = idx - lo;
  return sorted[lo] * (1 - weight) + sorted[hi] * weight;
}

export function formatCallDuration(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return '—';
  const whole = Math.round(seconds);
  if (whole < 60) return `${whole}s`;
  const minutes = Math.floor(whole / 60);
  const remainder = whole % 60;
  return remainder > 0 ? `${minutes}m ${remainder}s` : `${minutes}m`;
}

export function formatRate(rate: number | null): string {
  if (rate == null || !Number.isFinite(rate)) return '—';
  return `${(rate * 100).toFixed(1)}%`;
}

export function computeAgentInsights(rows: StudioCallRow[]): AgentInsights {
  const conversationCount = rows.length;
  const liveCallCount = rows.filter((row) => isLiveCallState(row.lifecycle_state)).length;
  const totalSeconds = rows.reduce((sum, row) => sum + (row.duration_seconds ?? 0), 0);
  const totalCostCents = rows.reduce((sum, row) => sum + (Number(row.total_cost_cents) || 0), 0);
  const toolCallCount = rows.reduce((sum, row) => sum + (row.tool_count ?? 0), 0);
  const durations = rows
    .map((row) => row.duration_seconds)
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0);

  return {
    conversationCount,
    liveCallCount,
    totalMinutes: totalSeconds / 60,
    totalCostCents,
    toolCallCount,
    durationP50Seconds: percentile(durations, 50),
    timeToFirstAudioP50: null,
    errorRate: conversationCount === 0 ? null : rows.filter(isFailedCall).length / conversationCount,
    transferRate: conversationCount === 0 ? null : rows.filter(isTransferredCall).length / conversationCount,
  };
}

export function phonesRoutedToAgent(
  phones: StudioPhoneNumber[],
  agentId: string,
): StudioPhoneNumber[] {
  return phones.filter((phone) => phone.routed_agent_id === agentId && phone.routing_active !== false);
}

export function phonesAvailableToAssign(phones: StudioPhoneNumber[]): StudioPhoneNumber[] {
  return phones.filter((phone) => !phone.routed_agent_id);
}

export function formatAssignedNumbers(phones: StudioPhoneNumber[]): string {
  return phones.map((phone) => phone.friendly_name || phone.phone_number).join(', ');
}

export function readPostCallPreference(metadata: Record<string, unknown> | null | undefined): {
  enabled: boolean;
  email: string;
} {
  const email = typeof metadata?.postCallEmail === 'string' ? metadata.postCallEmail.trim() : '';
  return {
    enabled: metadata?.postCallNotify === true,
    email,
  };
}

export function isValidPostCallEmail(email: string): boolean {
  const trimmed = email.trim();
  return trimmed.length === 0 || EMAIL_RE.test(trimmed);
}

export function insightSinceIso(range: InsightRange, now = new Date()): string | undefined {
  if (range === '100') return undefined;
  const days = range === '7d' ? 7 : 30;
  return new Date(now.getTime() - days * 86_400_000).toISOString();
}

export function buildAgentCallsQuery(params: {
  agentId: string;
  limit?: number;
  page?: number;
  q?: string;
  lifecycleState?: string;
  since?: string;
}): string {
  const search = new URLSearchParams();
  search.set('agent_id', params.agentId);
  if (params.limit != null) search.set('limit', String(params.limit));
  if (params.page != null) search.set('page', String(params.page));
  if (params.q?.trim()) search.set('q', params.q.trim());
  if (params.lifecycleState) search.set('lifecycle_state', params.lifecycleState);
  if (params.since) search.set('since', params.since);
  return search.toString();
}
