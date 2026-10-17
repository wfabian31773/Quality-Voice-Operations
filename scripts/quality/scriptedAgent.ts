import { captureVars, interpolate } from './interpolate';
import type { Scenario, ScriptTurn, ToolCallContext, ToolProvider, TraceEvent } from './types';

export type AgentHandleResult = {
  events: TraceEvent[];
};

export interface SimAgent {
  handleTurn(
    turnIndex: number,
    tools: ToolProvider,
    ctx: ToolCallContext,
  ): Promise<AgentHandleResult>;
}

function turnPlan(script: ScriptTurn[] | undefined, turnIndex: number): ScriptTurn | undefined {
  if (!script) return undefined;
  return script.find((entry, index) => (entry.on ?? index) === turnIndex);
}

export class ScriptedAgent implements SimAgent {
  private vars: Record<string, string> = {};

  constructor(private readonly scenario: Scenario) {}

  async handleTurn(turnIndex: number, tools: ToolProvider, ctx: ToolCallContext): Promise<AgentHandleResult> {
    const plan = turnPlan(this.scenario.script, turnIndex);
    if (!plan) {
      return { events: [{ type: 'say', text: "I didn't catch that. Could you say it again?" }] };
    }
    const events: TraceEvent[] = [];
    for (const step of plan.steps) {
      if ('say' in step) {
        const text = String(interpolate(step.say, this.vars));
        events.push({ type: 'say', text });
        continue;
      }
      const name = String(interpolate(step.call.name, this.vars));
      const input = (interpolate(step.call.input ?? {}, this.vars) ?? {}) as Record<string, unknown>;
      const result = await tools.invoke(name, input, ctx);
      Object.assign(this.vars, captureVars(result));
      events.push({ type: 'tool', name, input, result });
    }
    return { events };
  }
}
