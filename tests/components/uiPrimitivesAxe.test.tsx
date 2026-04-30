// @vitest-environment happy-dom
import * as React from 'react';
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import axe, { type Result } from 'axe-core';
import {
  Hero,
  PageSection,
  SectionHeader,
  ContentCard,
  FeatureGrid,
  CTABand,
  StatStrip,
  TestimonialBlock,
  Callout,
  Badge,
  Reveal,
  Stagger,
} from '../../client-app/src/components/ui';

afterEach(() => cleanup());

const RULE_SET = [
  'button-name',
  'link-name',
  'aria-allowed-attr',
  'aria-required-attr',
  'aria-required-children',
  'aria-required-parent',
  'aria-roles',
  'aria-valid-attr',
  'aria-valid-attr-value',
  'aria-hidden-focus',
  'role-img-alt',
  'image-alt',
  'heading-order',
  'list',
  'listitem',
];

async function runAxe(container: HTMLElement): Promise<Result[]> {
  const result = await axe.run(container, {
    runOnly: { type: 'rule', values: RULE_SET },
  });
  return result.violations.filter(
    (v) => v.impact === 'critical' || v.impact === 'serious',
  );
}

const cases: Array<{ name: string; el: React.ReactElement }> = [
  { name: 'Hero', el: <Hero title="Hi" description="d" /> },
  {
    name: 'PageSection',
    el: (
      <PageSection>
        <p>x</p>
      </PageSection>
    ),
  },
  {
    name: 'SectionHeader',
    el: <SectionHeader eyebrow="EB" title="t" description="d" />,
  },
  { name: 'ContentCard', el: <ContentCard>body</ContentCard> },
  {
    name: 'FeatureGrid',
    el: (
      <FeatureGrid
        features={[
          { title: 'A', description: 'a' },
          { title: 'B', description: 'b' },
        ]}
      />
    ),
  },
  {
    name: 'CTABand',
    el: <CTABand title="Ready?" actions={<button type="button">Go</button>} />,
  },
  {
    name: 'StatStrip',
    el: <StatStrip stats={[{ label: 'Calls', value: '120' }]} />,
  },
  {
    name: 'TestimonialBlock',
    el: <TestimonialBlock quote="Great." name="Jane" title="CTO" company="Acme" />,
  },
  { name: 'Callout', el: <Callout title="Heads up">body</Callout> },
  { name: 'Badge', el: <Badge variant="success">live</Badge> },
  {
    name: 'Reveal',
    el: <Reveal>revealed</Reveal>,
  },
  {
    name: 'Stagger',
    el: (
      <Stagger>
        <span data-stagger-item>one</span>
        <span data-stagger-item>two</span>
      </Stagger>
    ),
  },
];

describe('UI primitives — a11y smoke (axe-core)', () => {
  it.each(cases)('$name has no critical/serious axe violations', async ({ el }) => {
    const { container } = render(<MemoryRouter>{el}</MemoryRouter>);
    const blocking = await runAxe(container);
    if (blocking.length > 0) {
      const summary = blocking
        .map((v) => `${v.id} (${v.impact}): ${v.help}`)
        .join('\n');
      throw new Error(`axe violations:\n${summary}`);
    }
    expect(blocking).toHaveLength(0);
  });
});
