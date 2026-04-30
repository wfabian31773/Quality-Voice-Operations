import { describe, expect, it } from 'vitest';

import {
  INDUSTRY_TEMPLATE_KEYS,
  getIndustryTemplateCopy,
  type IndustryTemplateKey,
} from './agentBuilderI18n';
import { AGENT_TYPE_TO_TEMPLATE } from './agentTypeTemplate';
import {
  INDUSTRY_TEMPLATES_RAW,
  buildIndustryTemplateDefinition,
} from './industryTemplates';

const NEW_STARTER_TEMPLATES: ReadonlyArray<[string, IndustryTemplateKey]> = [
  ['customer-support', 'customer-support'],
  ['outbound-sales', 'outbound-sales'],
  ['technical-support', 'technical-support'],
  ['collections', 'collections'],
];

describe('AGENT_TYPE_TO_TEMPLATE', () => {
  it.each(NEW_STARTER_TEMPLATES)(
    'maps the %s agent type to the matching starter template',
    (agentType, expectedTemplateKey) => {
      expect(AGENT_TYPE_TO_TEMPLATE[agentType]).toBe(expectedTemplateKey);
    },
  );

  it('only maps to known IndustryTemplateKeys', () => {
    for (const [agentType, templateKey] of Object.entries(AGENT_TYPE_TO_TEMPLATE)) {
      expect(
        INDUSTRY_TEMPLATE_KEYS,
        `template key for agent type ${agentType} should be a known IndustryTemplateKey`,
      ).toContain(templateKey);
    }
  });

  it('every new starter resolves to non-empty English copy', () => {
    for (const [, templateKey] of NEW_STARTER_TEMPLATES) {
      const copy = getIndustryTemplateCopy('en', templateKey);
      expect(copy.welcomeGreeting).toBeTruthy();
      expect(copy.systemPrompt).toBeTruthy();
    }
  });

  it.each(NEW_STARTER_TEMPLATES)(
    'scaffolds the matching starter graph for %s',
    (_agentType, templateKey) => {
      const shape = INDUSTRY_TEMPLATES_RAW.find((t) => t.key === templateKey);
      expect(shape, `template shape for ${templateKey}`).toBeDefined();
      const def = buildIndustryTemplateDefinition('en', templateKey);
      expect(def).not.toBeNull();
      expect(def!.nodes).toHaveLength(shape!.nodes.length);
      expect(def!.edges).toHaveLength(shape!.edges.length);
      // Node ids/types/positions must match the shape so downstream
      // workflow execution gets the exact starter graph the visual
      // builder would have produced.
      expect(def!.nodes.map((n) => n.id)).toEqual(shape!.nodes.map((n) => n.id));
      expect(def!.nodes.map((n) => n.type)).toEqual(shape!.nodes.map((n) => n.type));
      for (const node of def!.nodes) {
        expect(node.data.nodeType).toBeTruthy();
        expect(node.data.label).toBeTruthy();
      }
      expect(def!.edges.map((e) => `${e.source}->${e.target}`)).toEqual(
        shape!.edges.map((e) => `${e.source}->${e.target}`),
      );
    },
  );
});
