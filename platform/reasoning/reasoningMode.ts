/**
 * Per-call reasoning mode for the voice ReasoningEngine (VA-01).
 *
 * - `enforce`: today's behavior. The engine injects guidance, can block
 *   tools, and drives escalations.
 * - `shadow`: the engine still processes every turn and logs what it would
 *   have done (`reasoning_shadow`), but nothing it decides reaches the model
 *   or the tool layer. Only agents running the salon template can run in
 *   shadow.
 *
 * Resolution for salon / barbershop agents, first valid value wins:
 *   1. agent config: `agents.metadata.reasoningMode`
 *   2. tenant settings: `tenants.settings.reasoningMode`
 *   3. vertical default: `shadow`.
 * Every other agent always resolves to `enforce`, whatever agent metadata or
 * tenant settings say (medical guardrails are never bypassed). Unknown
 * values are ignored. No env var is read.
 */

export const REASONING_MODES = ['enforce', 'shadow'] as const;
export type ReasoningMode = (typeof REASONING_MODES)[number];

export type ReasoningModeSource = 'agent' | 'tenant' | 'vertical_default';

export interface ResolvedReasoningMode {
  mode: ReasoningMode;
  source: ReasoningModeSource;
}

export interface ReasoningModeInput {
  /** agents.type, or the resolved template key (salon / barbershop map to `salon`). */
  agentType?: string | null;
  /** agents.metadata JSON (may carry `reasoningMode`). */
  agentMetadata?: Record<string, unknown> | null;
  /** tenants.settings JSON (may carry `reasoningMode`). */
  tenantSettings?: Record<string, unknown> | null;
}

export const REASONING_MODE_SETTING_KEY = 'reasoningMode';

const SHADOW_DEFAULT_VERTICALS = new Set(['salon', 'barbershop']);

function normalize(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase().replace(/_/g, '-') : '';
}

export function parseReasoningMode(value: unknown): ReasoningMode | null {
  const normalized = normalize(value);
  return (REASONING_MODES as readonly string[]).includes(normalized) ? (normalized as ReasoningMode) : null;
}

/**
 * Agent type salon / barbershop, or resolved template key `salon`. Agent
 * metadata (e.g. `vertical`) is never consulted: only the template that
 * actually runs decides.
 */
export function isSalonVerticalAgent(input: Pick<ReasoningModeInput, 'agentType'>): boolean {
  return SHADOW_DEFAULT_VERTICALS.has(normalize(input.agentType));
}

export function resolveReasoningMode(input: ReasoningModeInput): ResolvedReasoningMode {
  if (!isSalonVerticalAgent(input)) return { mode: 'enforce', source: 'vertical_default' };
  const fromAgent = parseReasoningMode(input.agentMetadata?.[REASONING_MODE_SETTING_KEY]);
  if (fromAgent) return { mode: fromAgent, source: 'agent' };
  const fromTenant = parseReasoningMode(input.tenantSettings?.[REASONING_MODE_SETTING_KEY]);
  if (fromTenant) return { mode: fromTenant, source: 'tenant' };
  return { mode: 'shadow', source: 'vertical_default' };
}
