import type { LucideIcon } from 'lucide-react';
import {
  Layers, Sparkles, Plug, BookOpen, Phone, Bot, Briefcase,
  Stethoscope, Smile, Scale, Home, Wrench, Network, GitMerge, Globe,
} from 'lucide-react';

export type MarketingPageCategory = 'Product' | 'Industries' | 'Resources';

export interface MarketingPage {
  slug: string;
  path: string;
  title: string;
  description: string;
  category: MarketingPageCategory;
  icon: LucideIcon;
  keywords: string[];
}

export const marketingPages: MarketingPage[] = [
  // ---------- Product ----------
  {
    slug: 'platform-overview',
    path: '/product',
    title: 'Platform overview',
    description: 'How QVO\'s voice operations platform works — agents, calls, workflows, and analytics in one place.',
    category: 'Product',
    icon: Layers,
    keywords: ['platform', 'overview', 'voice', 'operations', 'product'],
  },
  {
    slug: 'features',
    path: '/features',
    title: 'Features',
    description: 'The full feature set: agent builder, telephony, integrations, observability, autopilot, and more.',
    category: 'Product',
    icon: Sparkles,
    keywords: ['features', 'capabilities', 'product'],
  },
  {
    slug: 'integrations',
    path: '/integrations',
    title: 'Integrations',
    description: 'Connect QVO to HubSpot, Calendar, Slack, helpdesks, webhooks, and more.',
    category: 'Product',
    icon: Plug,
    keywords: ['integrations', 'hubspot', 'salesforce', 'slack', 'connectors'],
  },
  {
    slug: 'pricing',
    path: '/pricing',
    title: 'Pricing',
    description: 'Plans for solo operators, growing teams, and multi-location enterprises.',
    category: 'Product',
    icon: Briefcase,
    keywords: ['pricing', 'plans', 'cost', 'billing'],
  },
  {
    slug: 'ai-agents',
    path: '/ai-agents',
    title: 'AI agents',
    description: 'Showcase of QVO\'s production AI voice agents and what they can do on a live call.',
    category: 'Product',
    icon: Bot,
    keywords: ['ai', 'agents', 'voice', 'showcase'],
  },
  {
    slug: 'federated-ingest',
    path: '/product/federated-ingest',
    title: 'Federated Ingest API',
    description:
      'Bring your own voice agent. Ingest call events, transcripts, and tickets into QVO from any external voice stack via authenticated REST endpoints with idempotency and 7-day live + 30-day backfill windows.',
    category: 'Product',
    icon: GitMerge,
    keywords: [
      'federated', 'ingest', 'api', 'byo', 'bring your own', 'developer',
      'webhooks', 'rest', 'endpoints', 'idempotency', 'backfill', 'integration',
    ],
  },
  {
    slug: 'global-intelligence-network',
    path: '/product/global-intelligence-network',
    title: 'Global Intelligence Network',
    description:
      'Cross-tenant benchmarks for answer rate, AHT, conversion, and CSAT — see how your operation stacks up against the median and top quartile in your vertical, with privacy-first aggregation.',
    category: 'Product',
    icon: Globe,
    keywords: [
      'global intelligence', 'gin', 'benchmarks', 'cross-tenant', 'cohort',
      'median', 'top quartile', 'vertical', 'analytics', 'comparison',
    ],
  },

  // ---------- Industries ----------
  {
    slug: 'vertical-agents',
    path: '/industries/vertical-agents',
    title: 'Vertical agents',
    description:
      'Pre-built voice agents tuned for specific industries — Azul Vision (field service), Medical Front Desk, Dental, Legal Intake, Real Estate, and more, ready to deploy in minutes.',
    category: 'Industries',
    icon: Network,
    keywords: [
      'vertical', 'agents', 'azul vision', 'medical', 'dental', 'field service',
      'legal', 'real estate', 'templates', 'industry',
    ],
  },
  {
    slug: 'healthcare',
    path: '/industries/healthcare',
    title: 'Healthcare',
    description: 'HIPAA-aware voice AI for patient scheduling, intake, refills, and after-hours triage.',
    category: 'Industries',
    icon: Stethoscope,
    keywords: ['healthcare', 'medical', 'hipaa', 'patient', 'clinic'],
  },
  {
    slug: 'dental',
    path: '/industries/dental',
    title: 'Dental',
    description: 'Voice agents for dental practices — appointment scheduling, recall outreach, and insurance triage.',
    category: 'Industries',
    icon: Smile,
    keywords: ['dental', 'dentist', 'practice', 'appointments'],
  },
  {
    slug: 'legal',
    path: '/industries/legal',
    title: 'Legal',
    description: 'Intake automation for law firms — qualified lead capture, conflict checks, and routing to the right attorney.',
    category: 'Industries',
    icon: Scale,
    keywords: ['legal', 'law firm', 'intake', 'attorney'],
  },
  {
    slug: 'real-estate',
    path: '/industries/real-estate',
    title: 'Real estate',
    description: 'AI agents for brokerages — listing inquiries, showing scheduling, and lead qualification.',
    category: 'Industries',
    icon: Home,
    keywords: ['real estate', 'brokerage', 'listings', 'agent'],
  },
  {
    slug: 'home-services',
    path: '/industries/home-services',
    title: 'Home services',
    description: 'Dispatch and booking automation for HVAC, plumbing, electrical, and field-service trades.',
    category: 'Industries',
    icon: Wrench,
    keywords: ['home services', 'hvac', 'plumbing', 'field service', 'trades'],
  },

  // ---------- Resources ----------
  {
    slug: 'docs',
    path: '/docs',
    title: 'Documentation',
    description: 'Guides, API reference, and troubleshooting for QVO.',
    category: 'Resources',
    icon: BookOpen,
    keywords: ['docs', 'documentation', 'guides', 'api'],
  },
  {
    slug: 'demo',
    path: '/demo',
    title: 'Live demo',
    description: 'Try a live QVO voice agent in your browser — no signup required.',
    category: 'Resources',
    icon: Phone,
    keywords: ['demo', 'try', 'live', 'voice'],
  },
];

export function searchMarketingPages(query: string): MarketingPage[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  return marketingPages.filter((p) => {
    const hay = [p.title, p.description, p.category, ...p.keywords].join(' ').toLowerCase();
    return hay.includes(q);
  });
}
