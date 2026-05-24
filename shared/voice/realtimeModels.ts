/**
 * Canonical list of OpenAI Realtime API speech-to-speech models that QVO
 * supports for voice agents.
 *
 * This is the single source of truth for both the admin UI (model dropdowns in
 * Agents, Agent Studio, and Settings → Defaults) and the Admin API server-side
 * validation in routes/agents.ts. The runtime model router in
 * platform/billing/cost/providerRates.ts also keys off these IDs for cost
 * tracking and tier-based routing.
 *
 * Sourced from the official OpenAI changelog
 *   https://platform.openai.com/docs/changelog
 * and developer blog
 *   https://developers.openai.com/blog/updates-audio-models
 * (verified May 2026).
 *
 * IMPORTANT: only realtime-capable speech-to-speech model IDs are valid here.
 * The OpenAI Realtime API rejects non-realtime SKUs (e.g. "gpt-4o",
 * "gpt-4o-mini") with an `invalid_model` error — the call connects but
 * produces no audio. Specialized realtime models for translation
 * (`gpt-realtime-translate`) and streaming transcription
 * (`gpt-realtime-whisper`) are deliberately NOT listed here because they are
 * not drop-in replacements for a conversational voice agent.
 *
 * Adding a new realtime model OpenAI releases:
 *   1. Add an entry to REALTIME_MODELS below (keep newest first within each
 *      family; group GA → preview).
 *   2. Add the per-1k-token pricing to MODEL_RATES in
 *      platform/billing/cost/providerRates.ts so cost tracking is accurate.
 *   3. (Optional) Update TIER_MODEL_MAP in the same file if the new model
 *      should be the default for a tier.
 */

export type RealtimeModelFamily =
  | 'gpt-realtime-2'
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
  /** True for the recommended snapshot in the family (shown above dated snapshots). */
  recommended?: boolean;
}

export const REALTIME_MODELS: ReadonlyArray<RealtimeModelOption> = [
  // ── gpt-realtime-2 family (flagship, May 2026 — GPT-5-class reasoning, 128K ctx) ──
  {
    id: 'gpt-realtime-2',
    label: 'GPT Realtime 2 (flagship)',
    description: 'Latest flagship voice model. GPT-5-class reasoning, configurable reasoning levels, 128K context. Best quality and tool use.',
    family: 'gpt-realtime-2',
    ga: true,
    recommended: true,
  },

  // ── gpt-realtime family (GA speech-to-speech) ──
  {
    id: 'gpt-realtime',
    label: 'GPT Realtime (latest)',
    description: 'GA speech-to-speech alias — automatically tracks the latest snapshot.',
    family: 'gpt-realtime',
    ga: true,
    recommended: true,
  },
  {
    id: 'gpt-realtime-1.5',
    label: 'GPT Realtime 1.5',
    description: 'Interim GA snapshot between the original gpt-realtime and gpt-realtime-2.',
    family: 'gpt-realtime',
    ga: true,
  },

  // ── gpt-realtime-mini family (cost-efficient GA) ──
  {
    id: 'gpt-realtime-mini',
    label: 'GPT Realtime Mini (latest)',
    description: 'Cost-efficient GA realtime model. Currently points to the 2025-12-15 snapshot.',
    family: 'gpt-realtime-mini',
    ga: true,
    recommended: true,
  },
  {
    id: 'gpt-realtime-mini-2025-12-15',
    label: 'GPT Realtime Mini · 2025-12-15',
    family: 'gpt-realtime-mini',
    ga: true,
  },
  {
    id: 'gpt-realtime-mini-2025-10-06',
    label: 'GPT Realtime Mini · 2025-10-06',
    family: 'gpt-realtime-mini',
    ga: true,
  },

  // ── Legacy gpt-4o-realtime preview family ──
  {
    id: 'gpt-4o-realtime-preview',
    label: 'GPT-4o Realtime (preview, legacy)',
    description: 'Legacy preview alias — kept for agents created before gpt-realtime went GA.',
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

  // ── Legacy gpt-4o-mini-realtime preview family ──
  {
    id: 'gpt-4o-mini-realtime-preview',
    label: 'GPT-4o Mini Realtime (preview, legacy)',
    description: 'Legacy preview alias — kept for agents created before gpt-realtime-mini went GA.',
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
export const DEFAULT_REALTIME_MODEL = 'gpt-realtime';

/** Returns true when the given string is a known realtime-capable model ID. */
export function isRealtimeModel(modelId: string | null | undefined): boolean {
  if (!modelId || typeof modelId !== 'string') return false;
  return REALTIME_MODEL_IDS.has(modelId);
}

/** Find option metadata for a model ID, or undefined if unknown. */
export function getRealtimeModel(modelId: string): RealtimeModelOption | undefined {
  return REALTIME_MODELS.find((m) => m.id === modelId);
}
