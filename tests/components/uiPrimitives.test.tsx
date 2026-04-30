// @vitest-environment happy-dom
import * as React from 'react';
import { describe, it, expect, afterEach, beforeAll } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import {
  PageSection,
  Hero,
  SectionHeader,
  useParallax,
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

void React;

beforeAll(() => {
  if (typeof (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver === 'undefined') {
    class IO {
      observe() {}
      unobserve() {}
      disconnect() {}
      takeRecords() {
        return [];
      }
      root = null;
      rootMargin = '';
      thresholds = [];
    }
    (globalThis as unknown as { IntersectionObserver: typeof IO }).IntersectionObserver = IO;
  }
});

afterEach(() => cleanup());

describe('PageSection', () => {
  it('renders as a <section> by default with children', () => {
    render(
      <PageSection>
        <p>section body</p>
      </PageSection>,
    );
    expect(screen.getByText('section body').closest('section')).toBeTruthy();
  });

  it('respects the `as` prop', () => {
    const { container } = render(
      <PageSection as="article">
        <p>article body</p>
      </PageSection>,
    );
    expect(container.querySelector('article')).toBeTruthy();
  });
});

describe('Hero', () => {
  it('renders title in an <h1> and the eyebrow', () => {
    render(<Hero eyebrow="Eyebrow" title="Hero title" description="Hero desc" />);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Hero title');
    expect(screen.getByText('Eyebrow')).toBeTruthy();
    expect(screen.getByText('Hero desc')).toBeTruthy();
  });

  it('renders trust + meta + actions slots', () => {
    render(
      <Hero
        title="t"
        trust={<span>trust slot</span>}
        meta={<span>meta slot</span>}
        actions={<button type="button">Go</button>}
      />,
    );
    expect(screen.getByText('trust slot')).toBeTruthy();
    expect(screen.getByText('meta slot')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Go' })).toBeTruthy();
  });
});

describe('SectionHeader', () => {
  it('renders an <h2> by default', () => {
    render(<SectionHeader title="Section title" eyebrow="eb" description="d" />);
    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe('Section title');
    expect(screen.getByText('eb')).toBeTruthy();
    expect(screen.getByText('d')).toBeTruthy();
  });
});

describe('ContentCard', () => {
  it('renders as a div by default with body', () => {
    render(<ContentCard>Card body</ContentCard>);
    expect(screen.getByText('Card body')).toBeTruthy();
  });

  it('renders as an anchor when href is supplied', () => {
    render(
      <ContentCard as="a" href="/x">
        link body
      </ContentCard>,
    );
    const link = screen.getByText('link body').closest('a');
    expect(link?.getAttribute('href')).toBe('/x');
  });

  it('renders a react-router Link when `to` is supplied', () => {
    render(
      <MemoryRouter>
        <ContentCard to="/dashboard">link body</ContentCard>
      </MemoryRouter>,
    );
    const a = screen.getByText('link body').closest('a');
    expect(a).toBeTruthy();
    expect(a?.getAttribute('href')).toBe('/dashboard');
    expect(a?.getAttribute('to')).toBeNull();
  });

  it('renders as a button with type="button" when onClick is supplied', () => {
    render(<ContentCard onClick={() => undefined}>click body</ContentCard>);
    const btn = screen.getByText('click body').closest('button');
    expect(btn).toBeTruthy();
    expect(btn?.getAttribute('type')).toBe('button');
  });

  it('forwards arbitrary DOM props (data-* / aria-*) to the rendered element', () => {
    const { container } = render(
      <ContentCard data-stagger-item aria-label="metric card" data-testid="mc">
        body
      </ContentCard>,
    );
    const card = container.querySelector('[data-testid="mc"]') as HTMLElement;
    expect(card).toBeTruthy();
    expect(card.getAttribute('data-stagger-item')).not.toBeNull();
    expect(card.getAttribute('aria-label')).toBe('metric card');
  });
});

describe('FeatureGrid', () => {
  it('renders one card per feature', () => {
    render(
      <FeatureGrid
        features={[
          { title: 'A', description: 'a body' },
          { title: 'B', description: 'b body' },
          { title: 'C', description: 'c body' },
        ]}
      />,
    );
    expect(screen.getByText('A')).toBeTruthy();
    expect(screen.getByText('B')).toBeTruthy();
    expect(screen.getByText('C')).toBeTruthy();
    expect(screen.getByText('a body')).toBeTruthy();
  });
});

describe('CTABand', () => {
  it('renders title + actions', () => {
    render(
      <CTABand title="Ready?" actions={<button type="button">Start</button>} />,
    );
    expect(screen.getByRole('heading').textContent).toBe('Ready?');
    expect(screen.getByRole('button', { name: 'Start' })).toBeTruthy();
  });
});

describe('StatStrip', () => {
  it('renders each stat label + value', () => {
    render(
      <StatStrip
        stats={[
          { label: 'Calls', value: '12K' },
          { label: 'Booked', value: '38%' },
        ]}
      />,
    );
    expect(screen.getByText('Calls')).toBeTruthy();
    expect(screen.getByText('12K')).toBeTruthy();
    expect(screen.getByText('Booked')).toBeTruthy();
    expect(screen.getByText('38%')).toBeTruthy();
  });
});

describe('TestimonialBlock', () => {
  it('renders quote, attribution, and rating stars', () => {
    const { container } = render(
      <TestimonialBlock
        quote="Best decision we made this year."
        name="Jane Doe"
        title="Owner"
        company="Acme"
        initials="JD"
        rating={4}
      />,
    );
    expect(screen.getByText(/Best decision/)).toBeTruthy();
    expect(screen.getByText('Jane Doe')).toBeTruthy();
    expect(container.querySelectorAll('svg').length).toBeGreaterThanOrEqual(5);
  });
});

describe('Callout', () => {
  it.each([
    ['info', 'note'],
    ['success', 'status'],
    ['warning', 'alert'],
    ['danger', 'alert'],
    ['neutral', 'note'],
  ] as const)('tone=%s renders with role=%s', (tone, role) => {
    render(
      <Callout tone={tone} title={`${tone} title`}>
        body
      </Callout>,
    );
    const node = screen.getByRole(role);
    expect(node.textContent).toContain(`${tone} title`);
    expect(node.textContent).toContain('body');
  });
});

describe('CTABand contrast', () => {
  it('tone="primary" pairs bg-primary with text-on-primary (not text-on-sidebar)', () => {
    const { container } = render(
      <CTABand tone="primary" eyebrow="EB" title="T" description="D" actions={<button>go</button>} />,
    );
    const html = container.innerHTML;
    expect(html).toContain('bg-primary');
    expect(html).toContain('text-on-primary');
    expect(html).not.toMatch(/text-on-sidebar/);
  });
  it('tone="inverse" pairs bg-sidebar-bg with text-on-sidebar', () => {
    const { container } = render(
      <CTABand tone="inverse" title="T" description="D" actions={<button>go</button>} />,
    );
    const html = container.innerHTML;
    expect(html).toContain('bg-sidebar-bg');
    expect(html).toContain('text-on-sidebar');
  });
  it('tone="gradient" uses text-on-sidebar (gradient ends on sidebar/primary navy)', () => {
    const { container } = render(
      <CTABand tone="gradient" title="T" description="D" actions={<button>go</button>} />,
    );
    expect(container.innerHTML).toContain('text-on-sidebar');
  });
  it('tone="subtle" uses text-text-primary on bg-surface-secondary', () => {
    const { container } = render(
      <CTABand tone="subtle" title="T" description="D" actions={<button>go</button>} />,
    );
    const html = container.innerHTML;
    expect(html).toContain('bg-surface-secondary');
    expect(html).toContain('text-text-primary');
  });
});

describe('Badge contrast', () => {
  const tintedVariants = ['primary', 'success', 'warning', 'danger', 'info', 'accent', 'neutral'] as const;
  it.each(tintedVariants)('variant=%s uses text-text-primary on its tinted background', (variant) => {
    const { container } = render(<Badge variant={variant}>label</Badge>);
    const span = container.firstElementChild as HTMLElement;
    const cls = span.getAttribute('class') ?? '';
    expect(cls).toContain('text-text-primary');
    expect(cls).not.toMatch(/(?:^|\s)text-(?:primary|success|warning|danger|info|accent|text-secondary)(?=\s|$)/);
  });
  it('inverse variant uses text-on-sidebar', () => {
    const { container } = render(<Badge variant="inverse">label</Badge>);
    const cls = container.firstElementChild?.getAttribute('class') ?? '';
    expect(cls).toContain('text-on-sidebar');
  });
});

describe('Badge', () => {
  it('renders the label and an icon when provided', () => {
    const { container } = render(
      <Badge variant="primary" icon={<svg data-testid="ic" />}>
        New
      </Badge>,
    );
    expect(screen.getByText('New')).toBeTruthy();
    expect(container.querySelector('[data-testid="ic"]')).toBeTruthy();
  });

  it('renders a leading dot when dot=true', () => {
    const { container } = render(
      <Badge variant="success" dot>
        Live
      </Badge>,
    );
    // First child of the badge span should be the dot.
    const badge = container.firstElementChild as HTMLElement;
    expect(badge.firstElementChild?.tagName.toLowerCase()).toBe('span');
    expect(badge.textContent).toBe('Live');
  });
});

describe('Reveal', () => {
  it('renders children inside a `.motion-reveal` wrapper', () => {
    const { container } = render(
      <Reveal>
        <p>revealed</p>
      </Reveal>,
    );
    expect(screen.getByText('revealed')).toBeTruthy();
    expect(container.querySelector('.motion-reveal')).toBeTruthy();
  });
});

describe('useParallax', () => {
  function ParallaxProbe() {
    const ref = useParallax({ distance: 8 });
    return <div ref={ref} className="motion-parallax" data-testid="px">x</div>;
  }
  it('sets --parallax-y on the host element after mount', () => {
    const { getByTestId } = render(<ParallaxProbe />);
    const el = getByTestId('px');
    const v = el.style.getPropertyValue('--parallax-y');
    expect(v).toMatch(/px$/);
  });
});

describe('inverse-tone primitives (dark-mode parity)', () => {
  const cases: Array<{ name: string; el: React.ReactElement }> = [
    { name: 'Hero', el: <Hero tone="inverse" title="t" description="d" /> },
    {
      name: 'PageSection',
      el: (
        <PageSection tone="inverse">
          <p>x</p>
        </PageSection>
      ),
    },
    {
      name: 'ContentCard',
      el: <ContentCard tone="inverse">x</ContentCard>,
    },
    {
      name: 'StatStrip',
      el: <StatStrip inverse stats={[{ label: 'L', value: 'V' }]} />,
    },
    {
      name: 'TestimonialBlock',
      el: (
        <TestimonialBlock
          inverse
          quote="q"
          name="N"
          title="T"
          company="C"
          initials="N"
        />
      ),
    },
    {
      name: 'CTABand inverse',
      el: <CTABand tone="inverse" title="t" />,
    },
    { name: 'Badge inverse', el: <Badge variant="inverse">b</Badge> },
  ];
  it.each(cases)('$name never pairs sidebar surfaces with text-on-inverse', ({ el }) => {
    const { container } = render(el);
    const all = container.querySelectorAll('*');
    for (const node of Array.from(all)) {
      const cls = node.getAttribute('class') ?? '';
      const usesSidebarSurface = /\bbg-sidebar-(bg|hover)\b/.test(cls);
      const usesOnInverse = /\btext-on-inverse\b/.test(cls);
      if (usesSidebarSurface) {
        expect(usesOnInverse).toBe(false);
      }
    }
  });
});

describe('Stagger', () => {
  it('renders all children', () => {
    render(
      <Stagger>
        <span data-stagger-item className="motion-stagger-item">
          one
        </span>
        <span data-stagger-item className="motion-stagger-item">
          two
        </span>
      </Stagger>,
    );
    expect(screen.getByText('one')).toBeTruthy();
    expect(screen.getByText('two')).toBeTruthy();
  });

  it('integrates with ContentCard: data-stagger-item reaches the DOM and per-child --stagger-delay is set', () => {
    const { container } = render(
      <Stagger step={50}>
        <ContentCard data-stagger-item className="motion-stagger-item">
          a
        </ContentCard>
        <ContentCard data-stagger-item className="motion-stagger-item">
          b
        </ContentCard>
        <ContentCard data-stagger-item className="motion-stagger-item">
          c
        </ContentCard>
      </Stagger>,
    );
    const items = container.querySelectorAll('[data-stagger-item]');
    expect(items.length).toBe(3);
    const styles = Array.from(items).map(
      (el) => (el as HTMLElement).style.getPropertyValue('--stagger-delay'),
    );
    expect(styles).toEqual(['0ms', '50ms', '100ms']);
  });
});
