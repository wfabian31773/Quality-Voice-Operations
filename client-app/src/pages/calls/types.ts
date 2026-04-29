export const EMPTY_FILTERS = {
  agent_id: '',
  direction: '',
  lifecycle_state: '',
  dateRange: '',
  has_transcript: '',
  has_events: '',
  has_tool_executions: '',
  tool_failures_only: '',
  q: '',
};

export type FiltersState = typeof EMPTY_FILTERS;

export interface SavedView {
  id: string;
  name: string;
  filters: Partial<FiltersState>;
  is_shared: boolean;
  is_pinned: boolean;
  pin_order: number;
  created_by: string | null;
  digest_enabled?: boolean;
  digest_subscribers?: string[];
  digest_last_run_at?: string | null;
  digest_last_match_count?: number | null;
}
