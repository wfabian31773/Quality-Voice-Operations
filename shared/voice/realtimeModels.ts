/**
 * Canonical list of OpenAI Realtime API models that QVO supports for voice agents.
 *
 * This is the single source of truth for both the admin UI (model dropdowns in
 * Agents, Agent Studio, and Settings → Defaults) and the Admin API server-side
 * validation in routes/agents.ts. The runtime model router in
 * platform/billing/cost/providerRates.ts also keys off these IDs for cost
 * tracking and tier-based routing.
 *
 * IMPORTANT: only realtime-capable model IDs are valid here. The OpenAI
 * Realtime API rejects non-realtime SKUs (e.g. "gpt-4o", "gpt-4o-mini") with
 * an `invalid_model` error and the call connects but produces no audio.
 *
 * Adding a new realtime model OpenAI releases:
 *   1. Add an entry to REALTIME_MODELS below (keep the order: newest first
 *      within a family, families grouped GA → preview).
 *   2. Add the per-1k-token pricing to MODEL_RATES in
 *      platform/billing/cost/providerRates.ts so cost tracking is accurate.
 *   3. (Optional) Update TIER_MODEL_MAP in the same file if the new model
 *      should be the default for a tier.
 */

export type RealtimeModelFamily =
  | 'gpt-realtime'
  | 'gpt-realtime-mini'
  | 'gpt-4o-realtime'
  | 'gpt-4o-mini-realtime';

export interface RealtimeModelOption {
  /** OpenAI model identifier — sent verbatim to the Realtime API. */
  id: string;
  /** Human-friendly label shown in admin dropdowns. */
  label: string;
  /** Short description for picker UIs / tooltips. */
  description?: string;
  /** Coarse family grouping for ordering and pricing fallbacks. */
  family: RealtimeModelFamily;
  /** True for generally-available (non-preview) snapshots. */
  ga?: boolean;
}

export const REALTIME_MODELS: ReadonlyArray<RealtimeModelOption> = [
  {
    id: 'gpt-realtime',
    label: 'GPT Realtime (GA)',
    description: 'Latest generally-available realtime model. Best voice quality and instruction-following.',
    family: 'gpt-realtime',
    ga: true,
  },
  {
    id: 'gpt-realtime-mini',
    label: 'GPT Realtime Mini (GA)',
    description: 'Lower-cost GA realtime model. Good quality for high-volume / cost-sensitive workloads.',
    family: 'gpt-realtime-mini',
    ga: true,
  },
  {
    id: 'gpt-4o-realtime-preview',
    label: 'GPT-4o Realtime (preview)',
    description: 'Legacy preview alias — points at the latest gpt-4o-realtime-preview snapshot.',
    family: 'gpt-4o-realtime',
  },
  {
    id: 'gpt-4o-realtime-preview-2025-06-03',
    label: 'GPT-4o Realtime · 2025-06-03',
    family: 'gpt-4o-realtime',
  },
  {
    id: 'gpt-4o-realtime-preview-2024-12-17',
    label: 'GPT-4o Realtime · 2024-12-17',
    family: 'gpt-4o-realtime',
  },
  {
    id: 'gpt-4o-realtime-preview-2024-10-01',
    label: 'GPT-4o Realtime · 2024-10-01',
    family: 'gpt-4o-realtime',
  },
  {
    id: 'gpt-4o-mini-realtime-preview',
    label: 'GPT-4o Mini Realtime (preview)',
    description: 'Legacy preview alias — points at the latest gpt-4o-mini-realtime-preview snapshot.',
    family: 'gpt-4o-mini-realtime',
  },
  {
    id: 'gpt-4o-mini-realtime-preview-2024-12-17',
    label: 'GPT-4o Mini Realtime · 2024-12-17',
    family: 'gpt-4o-mini-realtime',
  },
];

/** Allowlist of valid model IDs for server-side validation. */
export const REALTIME_MODEL_IDS: ReadonlySet<string> = new Set(REALTIME_MODELS.map((m) => m.id));

/** Default model used when an agent / tenant default is unset. */
export const DEFAULT_REALTIME_MODEL = 'gpt-4o-realtime-preview';

/** Returns true when the given string is a known realtime-capable model ID. */
export function isRealtimeModel(modelId: string | null | undefined): boolean {
  if (!modelId || typeof modelId !== 'string') return false;
  return REALTIME_MODEL_IDS.has(modelId);
}

/** Find option metadata for a model ID, or undefined if unknown. */
export function getRealtimeModel(modelId: string): RealtimeModelOption | undefined {
  return REALTIME_MODELS.find((m) => m.id === modelId);
}
