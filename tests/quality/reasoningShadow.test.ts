import { describe, expect, it } from 'vitest';
import { DEFAULT_SCENARIO_DIR } from '../../scripts/quality/run-scenarios';
import { loadScenarioDir, runScenario } from '../../scripts/quality/runner';

const scenarios = loadScenarioDir(DEFAULT_SCENARIO_DIR);
const byId = (id: string) => {
  const scenario = scenarios.find((s) => s.id === id);
  if (!scenario) throw new Error(`missing scenario ${id}`);
  return scenario;
};

describe('Oct 17 replay scenarios with the salon ReasoningEngine in shadow', () => {
  it('fade → availability → "if nine is available" → caller ID → readback → yes → booked', async () => {
    const result = await runScenario(byId('oct17-fade-shadow-books'));
    expect(result.diff).toBe('');
    expect(result.status).toBe('passed');
    expect(result.reasoning?.mode).toBe('shadow');
    expect(result.reasoning?.injections).toEqual([]);
    expect(result.reasoning?.blocked).toEqual([]);
    const lines = result.reasoning?.shadowLines ?? [];
    expect(lines).toHaveLength(10);
    expect(lines.filter((line) => line.kind === 'turn')).toHaveLength(6);
    for (const line of lines) {
      expect(line).toMatchObject({ event: 'reasoning_shadow', mode: 'shadow', callId: 'call-oct17-fade-shadow-books' });
    }
    // The engine still decides what it would have done: on the real call it
    // asked "Which service…?" and wanted to block a tool.
    expect(lines.some((line) => line.would_inject === true)).toBe(true);
    expect(lines.some((line) => line.would_block_tool !== null)).toBe(true);
  });

  it('booking tool fails 3x: TOOL_STOPPED on the 4th call without running, plain message + callback', async () => {
    const result = await runScenario(byId('oct17-booking-tool-stops-after-3-failures'));
    expect(result.diff).toBe('');
    expect(result.status).toBe('passed');
    expect(result.toolAttempts?.['scheduling.book.prepare']).toBe(3);
    const prepares = result.trace.filter((event) => event.type === 'tool' && event.name === 'scheduling.book.prepare');
    const codes = prepares.map((event) => (event.type === 'tool' && !event.result.ok ? event.result.error.code : 'ok'));
    expect(codes).toEqual(['INTERNAL', 'INTERNAL', 'TOOL_STOPPED', 'TOOL_STOPPED']);
    const stopped = prepares[3];
    expect(stopped.type === 'tool' && !stopped.result.ok && stopped.result.error.retryable).toBe(false);
    expect(result.reasoning?.injections).toEqual([]);
    expect(result.reasoning?.blocked).toEqual([]);
  });

  it('the same call in enforce mode is blocked and steered by the engine (the gate is live in the harness)', async () => {
    const result = await runScenario(byId('oct17-fade-shadow-books'), { reasoningMode: 'enforce' });
    expect(result.status).toBe('failed');
    expect(result.reasoning?.mode).toBe('enforce');
    expect(result.reasoning?.injections.length).toBeGreaterThan(0);
    expect(result.reasoning?.blocked.length).toBeGreaterThan(0);
    expect(result.reasoning?.shadowLines).toEqual([]);
    expect(result.snapshot.bookings).toHaveLength(0);
  });

  it('agent config / tenant settings resolve the scenario mode like a live call', async () => {
    const scenario = byId('oct17-fade-shadow-books');
    const enforced = await runScenario({ ...scenario, reasoning: { ...scenario.reasoning!, tenantSettings: { reasoningMode: 'enforce' } } });
    expect(enforced.reasoning?.mode).toBe('enforce');
    const agentWins = await runScenario({
      ...scenario,
      reasoning: { ...scenario.reasoning!, agentMetadata: { vertical: 'barbershop', reasoningMode: 'shadow' }, tenantSettings: { reasoningMode: 'enforce' } },
    });
    expect(agentWins.reasoning?.mode).toBe('shadow');
    expect(agentWins.status).toBe('passed');
  });

  it('flags PII in a shadow line', async () => {
    const result = await runScenario(byId('oct17-fade-shadow-books'));
    const { matchReasoning } = await import('../../scripts/quality/matcher');
    const leaky = { ...result.reasoning!, shadowLines: [...result.reasoning!.shadowLines, { note: 'caller Wayne at +15555550100' }] };
    const failures = matchReasoning({ mode: 'shadow' }, leaky, result.trace, byId('oct17-fade-shadow-books'));
    expect(failures.map((f) => f.message)).toEqual(['reasoning_shadow lines contain caller data']);
    expect(JSON.stringify(failures[0].actual)).toMatch(/wayne/);
  });
});
