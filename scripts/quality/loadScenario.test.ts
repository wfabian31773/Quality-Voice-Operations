import { describe, expect, it } from 'vitest';
import { loadScenarioYaml, parseScenario } from './loadScenario';

const minimal = {
  id: 'x',
  template: 'barbershop',
  tools: ['scheduling'],
  seed: 'barbershop-marco',
  caller: [{ text: 'hi' }],
  expect: {},
};

describe('parseScenario', () => {
  it('accepts the sample shape including silence and interrupt markers', () => {
    const scenario = parseScenario({
      ...minimal,
      tags: ['sample'],
      caller: [{ text: 'hi', silence: 4 }, { text: 'yes', interrupt: true }],
      script: [{ on: 0, steps: [{ say: 'hello' }] }],
      expect: { readbackRequired: true, mustNotSay: ["you're booked"] },
    });
    expect(scenario.caller[0].silence).toBe(4);
    expect(scenario.caller[1].interrupt).toBe(true);
    expect(scenario.expect.readbackRequired).toBe(true);
  });

  it('rejects an unknown template and an empty caller list', () => {
    expect(() => parseScenario({ ...minimal, template: 'law_office' })).toThrow(/template/i);
    expect(() => parseScenario({ ...minimal, caller: [] })).toThrow(/caller/i);
  });

  it('loads YAML text', () => {
    const scenario = loadScenarioYaml(
      `
id: y
template: nail_salon
tools: [calls]
seed: nail-salon-front-desk
caller:
  - text: "Can I talk to Dana?"
expect:
  actions:
    - name: calls.transfer_to_human.prepare
`,
      'inline.yaml',
    );
    expect(scenario.id).toBe('y');
    expect(scenario.template).toBe('nail_salon');
  });
});
