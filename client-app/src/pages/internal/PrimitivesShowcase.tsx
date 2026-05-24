import { useState, useEffect } from 'react';
import {
  Sparkles,
  ArrowRight,
  Phone,
  Bot,
  Calendar,
  ShieldCheck,
  Zap,
  Workflow,
  Sun,
  Moon,
} from 'lucide-react';
import {
  PageSection,
  SectionHeader,
  Hero,
  ContentCard,
  FeatureGrid,
  CTABand,
  StatStrip,
  TestimonialBlock,
  Callout,
  Badge,
  Reveal,
  Stagger,
} from '../../components/ui';

const featureItems = [
  {
    icon: Phone,
    title: 'Always-on phone agents',
    description: 'AI answers every call in under a second, books, qualifies, and routes to the right team.',
  },
  {
    icon: Bot,
    title: 'Tuned to your business',
    description: 'Train on your scripts, services, and pricing. Switch tone and language per number.',
  },
  {
    icon: Calendar,
    title: 'Calendar-aware booking',
    description: 'Holds slots, syncs with Google or Outlook, and confirms with the customer over SMS.',
  },
];

const stats = [
  { label: 'Calls answered', value: '12.4K', sub: 'last 30 days' },
  { label: 'Booked rate', value: '38%', sub: '+9pt vs human-only' },
  { label: 'Avg. response', value: '0.6s', sub: 'first word out' },
  { label: 'CSAT', value: '4.7 / 5', sub: 'post-call survey' },
];

/** Renders every shared UI primitive on the locked tokens, in light and dark mode. */
export default function PrimitivesShowcase() {
  const [theme, setTheme] = useState<'light' | 'dark'>('light');

  useEffect(() => {
    const root = document.documentElement;
    const had = root.classList.contains('dark');
    if (theme === 'dark') root.classList.add('dark');
    else root.classList.remove('dark');
    return () => {
      if (had) root.classList.add('dark');
      else root.classList.remove('dark');
    };
  }, [theme]);

  return (
    <div className="bg-bg text-text-primary" data-testid="primitives-showcase">
      <div className="sticky top-0 z-popover border-b border-border bg-surface/80 backdrop-blur">
        <div className="mx-auto max-w-7xl px-6 py-3 flex items-center justify-between gap-4">
          <div className="flex items-center gap-2">
            <Badge variant="accent" dot>
              Internal preview
            </Badge>
            <span className="text-sm text-text-secondary">Shared UI primitives · Refined Harbor</span>
          </div>
          <button
            type="button"
            onClick={() => setTheme((t) => (t === 'light' ? 'dark' : 'light'))}
            className="inline-flex items-center gap-2 rounded-lg border border-border bg-surface px-3 py-1.5 text-sm font-medium text-text-primary hover:bg-surface-hover transition-colors"
            aria-label={`Switch to ${theme === 'light' ? 'dark' : 'light'} mode`}
          >
            {theme === 'light' ? <Moon className="h-4 w-4" /> : <Sun className="h-4 w-4" />}
            {theme === 'light' ? 'Dark mode' : 'Light mode'}
          </button>
        </div>
      </div>

      <Hero
        tone="gradient"
        size="default"
        eyebrow="Hero · gradient"
        title="Pick up every call. Book more work. Stay calm."
        description="QVO is the always-on phone team for service businesses — answering, qualifying, and scheduling 24/7 so you can focus on the job in front of you."
        actions={
          <>
            <button type="button" className="inline-flex items-center gap-2 rounded-lg bg-primary text-on-primary px-5 py-2.5 font-semibold motion-hover-lift">
              Start free <ArrowRight className="h-4 w-4" />
            </button>
            <button type="button" className="inline-flex items-center gap-2 rounded-lg border border-border bg-surface px-5 py-2.5 font-semibold text-text-primary motion-hover-lift">
              Book a demo
            </button>
          </>
        }
        meta="No credit card required · Cancel anytime"
        trust={
          <Badge variant="primary" icon={<Sparkles className="h-3 w-3" />}>
            New · Spanish + bilingual flows
          </Badge>
        }
      />

      <PageSection tone="subtle" pad="lg">
        <SectionHeader
          eyebrow="SectionHeader"
          title="Built from the same primitives we ship to customers"
          description="Every block on this page comes from `client-app/src/components/ui` and resolves through the locked Refined Harbor tokens."
          align="center"
        />
        <Reveal className="mt-10">
          <FeatureGrid features={featureItems} columns={3} />
        </Reveal>
      </PageSection>

      <PageSection pad="lg">
        <SectionHeader
          eyebrow="ContentCard · variants"
          title="Surface tones, padding, and interactivity"
          description="Use `tone='subtle'` for nested groupings, `tone='primary'` for highlight strips, `tone='inverse'` to anchor a page on a dark band."
        />
        <Stagger className="mt-8 grid gap-4 md:grid-cols-2 lg:grid-cols-4">
          <ContentCard data-stagger-item className="motion-stagger-item flex flex-col gap-3" interactive>
            <ShieldCheck className="h-5 w-5 text-primary" />
            <p className="font-semibold">Default tone</p>
            <p className="text-sm text-text-secondary">Standard surface card with hover lift.</p>
          </ContentCard>
          <ContentCard data-stagger-item className="motion-stagger-item flex flex-col gap-3" tone="subtle">
            <Workflow className="h-5 w-5 text-primary" />
            <p className="font-semibold">Subtle tone</p>
            <p className="text-sm text-text-secondary">Recedes inside busy layouts.</p>
          </ContentCard>
          <ContentCard data-stagger-item className="motion-stagger-item flex flex-col gap-3" tone="primary">
            <Zap className="h-5 w-5 text-primary" />
            <p className="font-semibold">Primary tone</p>
            <p className="text-sm text-text-secondary">For highlight rows and "what's new" rails.</p>
          </ContentCard>
          <ContentCard data-stagger-item className="motion-stagger-item flex flex-col gap-3" tone="inverse">
            <Sparkles className="h-5 w-5" />
            <p className="font-semibold">Inverse tone</p>
            <p className="text-sm text-on-sidebar opacity-80">Use on dark CTA bands and footers.</p>
          </ContentCard>
        </Stagger>
      </PageSection>

      <PageSection tone="inverse" pad="lg">
        <SectionHeader
          eyebrow="StatStrip · inverse"
          title="Stat strips reuse the same numerals everywhere"
          description="Drops cleanly on light or dark surfaces — no duplicate code per page."
          inverse
          align="center"
        />
        <div className="mt-10">
          <StatStrip stats={stats} columns={4} inverse />
        </div>
      </PageSection>

      <PageSection pad="lg">
        <div className="grid gap-6 lg:grid-cols-2">
          <TestimonialBlock
            eyebrow="Plumbing · 14-truck shop"
            quote="QVO answered 1,200 missed calls in the first month. We hired one fewer dispatcher and our review average went up half a star."
            name="Maya Alvarez"
            title="Operations Lead"
            company="Stillwater Plumbing"
            initials="MA"
            rating={5}
          />
          <TestimonialBlock
            eyebrow="HVAC · seasonal demand"
            quote="The bilingual switch alone is worth it. Spanish-speaking customers used to bounce — now they're booked before we open."
            name="Diego Romero"
            title="Owner"
            company="Romero HVAC"
            initials="DR"
            rating={5}
          />
        </div>
      </PageSection>

      <PageSection tone="subtle" pad="lg">
        <SectionHeader eyebrow="Callout" title="In-page guidance with semantic tone" />
        <div className="mt-8 grid gap-4 md:grid-cols-2">
          <Callout tone="info" title="What changed">
            Spanish + bilingual flows are live for every plan tier — no per-minute upcharge.
          </Callout>
          <Callout tone="success" title="You're all set">
            Your number is forwarding correctly. Test calls will appear in the Inbox within seconds.
          </Callout>
          <Callout tone="warning" title="Heads up">
            Two of your agents are using the same greeting. Consider differentiating them.
          </Callout>
          <Callout tone="danger" title="Action required">
            Billing failed. Update your card to keep your AI agents online.
          </Callout>
        </div>
      </PageSection>

      <PageSection pad="lg">
        <SectionHeader eyebrow="Badge · variants" title="Pills and tags" />
        <div className="mt-6 flex flex-wrap gap-2">
          <Badge variant="primary">Primary</Badge>
          <Badge variant="success" dot>
            Live
          </Badge>
          <Badge variant="warning">Beta</Badge>
          <Badge variant="danger">Down</Badge>
          <Badge variant="info">Info</Badge>
          <Badge variant="accent">New</Badge>
          <Badge variant="neutral">Draft</Badge>
          <Badge variant="primary" icon={<Sparkles className="h-3 w-3" />}>
            With icon
          </Badge>
        </div>
      </PageSection>

      <CTABand
        tone="gradient"
        eyebrow="CTABand · gradient"
        title="Ready to never miss another call?"
        description="Set up takes about 12 minutes. We'll port your number, train your agents, and walk you through the first booked job."
        actions={
          <>
            <button type="button" className="inline-flex items-center gap-2 rounded-lg bg-on-sidebar text-primary px-5 py-2.5 font-semibold motion-hover-lift">
              Start free trial
            </button>
            <button type="button" className="inline-flex items-center gap-2 rounded-lg border border-on-sidebar/40 px-5 py-2.5 font-semibold text-on-sidebar motion-hover-lift">
              Talk to sales
            </button>
          </>
        }
      />
    </div>
  );
}
