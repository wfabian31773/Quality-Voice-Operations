import type { SimAgent } from './scriptedAgent';

/**
 * Real-LLM mode is local/nightly only. This scaffold never calls xAI, Twilio,
 * Stripe, or email. Plug in the PR-01 agent-tool adapter behind QUALITY_SIM_LLM=1.
 */
export function assertLlmModeAllowed(env: NodeJS.ProcessEnv = process.env): void {
  if (env.QUALITY_SIM_LLM !== '1') {
    throw new Error(
      'Refusing LLM mode. Set QUALITY_SIM_LLM=1 for local/nightly use after the PR-01 agent adapter lands. CI must use --mode=scripted.',
    );
  }
}

export class LlmAgent implements SimAgent {
  async handleTurn(): Promise<never> {
    throw new Error(
      'LLM agent is a reserved plug-in point. This harness does not call xAI; run --mode=scripted in CI.',
    );
  }
}

export function createLlmAgent(env: NodeJS.ProcessEnv = process.env): LlmAgent {
  assertLlmModeAllowed(env);
  return new LlmAgent();
}
