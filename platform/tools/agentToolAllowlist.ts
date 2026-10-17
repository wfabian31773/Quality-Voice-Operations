/**
 * Deterministic agent tool allowlist. A tool the agent's config does not list
 * never runs, whatever the reasoning mode: the default dispatch branch would
 * otherwise execute any tool registered in the global registry.
 */
export interface AgentToolAllowlistResult {
  allowed: boolean;
  reason?: 'unauthorized_tool';
}

export function checkAgentToolAllowlist(
  toolName: string,
  allowedToolNames: Iterable<string>,
  exemptToolNames: Iterable<string> = [],
): AgentToolAllowlistResult {
  for (const name of exemptToolNames) if (name === toolName) return { allowed: true };
  for (const name of allowedToolNames) if (name === toolName) return { allowed: true };
  return { allowed: false, reason: 'unauthorized_tool' };
}
