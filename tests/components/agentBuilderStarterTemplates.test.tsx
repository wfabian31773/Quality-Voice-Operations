// @vitest-environment happy-dom

import * as React from 'react';
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react';

import { IndustryTemplateMenuList } from '../../client-app/src/components/IndustryTemplateMenuList';
import { TemplateHoverPreview } from '../../client-app/src/components/TemplateHoverPreview';
import {
  type IndustryTemplate,
  INDUSTRY_TEMPLATES_RAW,
  buildIndustryTemplates,
} from '../../client-app/src/lib/industryTemplates';
import {
  type IndustryTemplateKey,
  FALLBACK_MARKER,
  makeBuilderT,
} from '../../client-app/src/lib/agentBuilderI18n';

void React;

afterEach(() => {
  cleanup();
});

const NEW_STARTER_KEYS = [
  'customer-support',
  'outbound-sales',
  'technical-support',
  'collections',
] as const satisfies readonly IndustryTemplateKey[];

interface ExpectedConditionalLabels {
  yes: 'edgeLabelTicket' | 'edgeLabelYes';
  no: 'edgeLabelCallback' | 'edgeLabelNo';
}

const EXPECTED_CONDITIONAL_LABELS: Record<(typeof NEW_STARTER_KEYS)[number], ExpectedConditionalLabels> = {
  'customer-support': { yes: 'edgeLabelTicket', no: 'edgeLabelCallback' },
  'outbound-sales': { yes: 'edgeLabelYes', no: 'edgeLabelNo' },
  'technical-support': { yes: 'edgeLabelTicket', no: 'edgeLabelCallback' },
  collections: { yes: 'edgeLabelYes', no: 'edgeLabelNo' },
};

const LANGUAGES = ['en', 'es', 'ja', 'ar'] as const;

const ARABIC_CHAR_RANGE = /[\u0600-\u06FF]/;

function buildTemplatesFor(language: string): IndustryTemplate[] {
  const t = makeBuilderT(language);
  return buildIndustryTemplates(t, language);
}

function findStarter(templates: IndustryTemplate[], key: IndustryTemplateKey): IndustryTemplate {
  const match = templates.find((tpl) => tpl.key === key);
  if (!match) {
    throw new Error(`Starter template ${key} missing from buildIndustryTemplates output`);
  }
  return match;
}

function truncatedForPreview(value: string, maxChars: number): string {
  return value.length > maxChars ? `${value.slice(0, maxChars - 1)}…` : value;
}

describe('Agent Builder template picker — starter workflows', () => {
  it('every new starter is exported by INDUSTRY_TEMPLATES_RAW with 6 nodes / 6 edges', () => {
    for (const key of NEW_STARTER_KEYS) {
      const raw = INDUSTRY_TEMPLATES_RAW.find((tpl) => tpl.key === key);
      expect(raw, `INDUSTRY_TEMPLATES_RAW is missing starter ${key}`).toBeDefined();
      expect(raw!.nodes).toHaveLength(6);
      expect(raw!.edges).toHaveLength(6);
      const conditional = raw!.edges.filter((e) => e.labelKey);
      expect(conditional).toHaveLength(2);
      const expected = EXPECTED_CONDITIONAL_LABELS[key];
      const yesEdge = conditional.find((e) => e.sourceHandle === 'yes');
      const noEdge = conditional.find((e) => e.sourceHandle === 'no');
      expect(yesEdge?.labelKey).toBe(expected.yes);
      expect(noEdge?.labelKey).toBe(expected.no);
    }
  });

  for (const language of LANGUAGES) {
    describe(`language=${language}`, () => {
      for (const key of NEW_STARTER_KEYS) {
        it(`renders the ${key} starter, opens a localized preview, and selects it`, () => {
          const templates = buildTemplatesFor(language);
          const t = makeBuilderT(language);
          const expected = findStarter(templates, key);

          expect(expected.label).not.toContain(FALLBACK_MARKER);
          expect(expected.description).not.toContain(FALLBACK_MARKER);
          expect(expected.usedEnglishFallback).toBe(false);

          let loaded: IndustryTemplate | null = null;
          let hovered: IndustryTemplateKey | null = null;
          const Harness = () => {
            const [hoverKey, setHoverKey] = React.useState<IndustryTemplateKey | null>(null);
            React.useEffect(() => {
              hovered = hoverKey;
            }, [hoverKey]);
            const hoveredTpl = hoverKey ? templates.find((x) => x.key === hoverKey) ?? null : null;
            return (
              <>
                <IndustryTemplateMenuList
                  templates={templates}
                  t={t}
                  language={language}
                  onSelect={(tpl) => {
                    loaded = tpl;
                    setHoverKey(null);
                  }}
                  onHover={(k) => setHoverKey(k)}
                />
                {hoveredTpl && (
                  <TemplateHoverPreview
                    template={hoveredTpl}
                    t={t}
                    language={language}
                    floating={false}
                  />
                )}
              </>
            );
          };
          render(<Harness />);

          const menu = screen.getByTestId('industry-template-menu');
          const labelEl = within(menu).getByTestId(`template-label-${key}`);
          expect(labelEl.textContent).toBe(expected.label);
          const button = labelEl.closest('button');
          expect(button).not.toBeNull();
          expect(button!.getAttribute('role')).toBe('menuitem');

          fireEvent.mouseEnter(button!);
          expect(hovered).toBe(key);

          const preview = screen.getByTestId('template-hover-preview');
          expect(preview.getAttribute('data-template-key')).toBe(key);
          expect(preview.getAttribute('lang')).toBe(language);
          expect(within(preview).getByTestId('template-hover-label').textContent).toBe(expected.label);
          expect(within(preview).getByTestId('template-hover-description').textContent).toBe(
            expected.description,
          );

          for (const node of expected.nodes) {
            const nodeLabel = node.data?.label as string | undefined;
            expect(nodeLabel, `${key} node ${node.id} label`).toBeTruthy();
            expect(nodeLabel).not.toContain(FALLBACK_MARKER);
            const text = preview.querySelector(`text[data-node-id="${node.id}"]`);
            expect(text, `node ${node.id} label rendered in preview`).not.toBeNull();
            expect(text!.textContent).toBe(truncatedForPreview(nodeLabel!, 14));
          }

          const expectedEdges = EXPECTED_CONDITIONAL_LABELS[key];
          const expectedYes = t(expectedEdges.yes);
          const expectedNo = t(expectedEdges.no);
          const renderedEdgeLabels = Array.from(preview.querySelectorAll('text[data-edge-label="true"]')).map(
            (el) => el.textContent,
          );
          expect(renderedEdgeLabels).toHaveLength(2);
          expect(renderedEdgeLabels).toEqual(
            expect.arrayContaining([
              truncatedForPreview(expectedYes, 16),
              truncatedForPreview(expectedNo, 16),
            ]),
          );
          for (const edgeLabel of renderedEdgeLabels) {
            expect(edgeLabel).not.toContain(FALLBACK_MARKER);
          }

          fireEvent.click(button!);
          expect(loaded).not.toBeNull();
          expect(loaded!.key).toBe(key);
          const loadedYesEdge = loaded!.edges.find((e) => e.sourceHandle === 'yes');
          const loadedNoEdge = loaded!.edges.find((e) => e.sourceHandle === 'no');
          expect(loadedYesEdge?.label).toBe(expectedYes);
          expect(loadedNoEdge?.label).toBe(expectedNo);
        });
      }
    });
  }

  it('non-English starters render labels distinct from the English baseline', () => {
    const en = buildTemplatesFor('en');
    for (const language of ['es', 'ja', 'ar'] as const) {
      const localised = buildTemplatesFor(language);
      for (const key of NEW_STARTER_KEYS) {
        const enFirstLabel = findStarter(en, key).nodes[0].data?.label as string;
        const langFirstLabel = findStarter(localised, key).nodes[0].data?.label as string;
        expect(
          langFirstLabel,
          `starter ${key} first node label should differ from English in ${language}`,
        ).not.toBe(enFirstLabel);
      }
    }
  });

  describe('Arabic RTL preview', () => {
    it.each(NEW_STARTER_KEYS)('renders %s in dir=rtl with Arabic-script labels', (key) => {
      const t = makeBuilderT('ar');
      const tpl = findStarter(buildTemplatesFor('ar'), key);
      render(
        <TemplateHoverPreview template={tpl} t={t} language="ar" floating={false} />,
      );

      const preview = screen.getByTestId('template-hover-preview');
      expect(preview.getAttribute('dir')).toBe('rtl');
      expect(preview.getAttribute('lang')).toBe('ar');
      expect(within(preview).getByTestId('template-hover-label').textContent ?? '').toMatch(
        ARABIC_CHAR_RANGE,
      );
      expect(within(preview).getByTestId('template-hover-description').textContent ?? '').toMatch(
        ARABIC_CHAR_RANGE,
      );

      // Each node's underlying label must be in Arabic script. The rendered
      // SVG text is truncated to fit, so check the source data for Arabic
      // content but assert the truncated text is rendered in the DOM.
      for (const node of tpl.nodes) {
        const label = node.data?.label as string;
        expect(label, `${key} node ${node.id} label`).toMatch(ARABIC_CHAR_RANGE);
        const text = preview.querySelector(`text[data-node-id="${node.id}"]`);
        expect(text, `${key} node ${node.id} label rendered in preview`).not.toBeNull();
        expect(text!.textContent ?? '').toBe(truncatedForPreview(label, 14));
      }

      const conditionalEdges = tpl.edges.filter((e) => e.label);
      expect(conditionalEdges).toHaveLength(2);
      for (const edge of conditionalEdges) {
        expect(edge.label!).toMatch(ARABIC_CHAR_RANGE);
      }
      const renderedEdgeLabels = Array.from(
        preview.querySelectorAll('text[data-edge-label="true"]'),
      ).map((el) => el.textContent ?? '');
      expect(renderedEdgeLabels).toHaveLength(2);
      for (const edgeLabel of renderedEdgeLabels) {
        expect(edgeLabel).toMatch(ARABIC_CHAR_RANGE);
      }
    });
  });
});
