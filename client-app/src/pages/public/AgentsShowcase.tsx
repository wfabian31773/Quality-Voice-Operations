import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  Stethoscope, Scale, Megaphone, Headphones, Users, Home,
  Phone, Globe, MessageSquare, ArrowRight, ChevronDown, ChevronUp,
  CheckCircle2, AlertTriangle, Bot, Zap, Calendar, Shield,
  Wrench, Building2, UtensilsCrossed,
} from 'lucide-react';
import SEO from '../../components/SEO';
import RevealSection from '../../components/RevealSection';
import { useEffect } from 'react';
import { trackPageView, trackVerticalEngagement, trackCTAClick } from '../../lib/analytics';
import { VERTICAL_ACTION } from '../../lib/analyticsLabels';
import { CTA } from '../../lib/analyticsCtas';

type Category = 'All' | 'Healthcare' | 'Legal' | 'Sales & Marketing' | 'Operations' | 'Support';

const categoryToI18nKey: Record<Category, string> = {
  All: 'all',
  Healthcare: 'healthcare',
  Legal: 'legal',
  'Sales & Marketing': 'sales',
  Operations: 'operations',
  Support: 'support',
};

type ConversationRole = 'caller' | 'agent';

interface AgentTemplate {
  id: string;
  category: Category;
  channels: Array<'phone' | 'web' | 'sms'>;
  icon: React.ElementType;
  color: string;
  avatar?: string;
  conversationRoles: ConversationRole[];
}

const channelIcons: Record<string, { icon: React.ElementType; i18nKey: string }> = {
  phone: { icon: Phone, i18nKey: 'phone' },
  web: { icon: Globe, i18nKey: 'web' },
  sms: { icon: MessageSquare, i18nKey: 'sms' },
};

const categories: Category[] = ['All', 'Healthcare', 'Legal', 'Sales & Marketing', 'Operations', 'Support'];

const categoryIcons: Record<Category, React.ElementType> = {
  All: Bot,
  Healthcare: Stethoscope,
  Legal: Scale,
  'Sales & Marketing': Megaphone,
  Operations: Home,
  Support: Users,
};

const C: ConversationRole = 'caller';
const A: ConversationRole = 'agent';

const agentTemplates: AgentTemplate[] = [
  {
    id: 'medical-intake',
    category: 'Healthcare',
    channels: ['phone', 'web'],
    icon: Stethoscope,
    color: 'bg-primary/10 text-primary border-primary/20',
    avatar: '/assets/avatars/medical.png',
    conversationRoles: [C, A, C, A, C, A],
  },
  {
    id: 'dental-scheduling',
    category: 'Healthcare',
    channels: ['phone', 'sms'],
    icon: Headphones,
    color: 'bg-surface-muted text-text-primary border-border-strong/40',
    avatar: '/assets/avatars/dental.png',
    conversationRoles: [C, A, C, A, C, A],
  },
  {
    id: 'legal-intake',
    category: 'Legal',
    channels: ['phone', 'web', 'sms'],
    icon: Scale,
    color: 'bg-amber-100/80 text-amber-700 border-amber-200',
    avatar: '/assets/avatars/legal.png',
    conversationRoles: [C, A, C, A, C, A],
  },
  {
    id: 'hvac-home-services',
    category: 'Operations',
    channels: ['phone', 'sms'],
    icon: Wrench,
    color: 'bg-orange-100/80 text-orange-700 border-orange-200',
    avatar: '/assets/avatars/hvac.png',
    conversationRoles: [C, A, C, A, C, A],
  },
  {
    id: 'outbound-sales',
    category: 'Sales & Marketing',
    channels: ['phone', 'sms'],
    icon: Megaphone,
    color: 'bg-purple-100/80 text-purple-700 border-purple-200',
    avatar: '/assets/avatars/collections.png',
    conversationRoles: [A, C, A, C, A, C, A],
  },
  {
    id: 'customer-support',
    category: 'Support',
    channels: ['phone', 'web', 'sms'],
    icon: Users,
    color: 'bg-blue-100/80 text-blue-700 border-blue-200',
    avatar: '/assets/avatars/customer-support.png',
    conversationRoles: [C, A, C, A, C, A],
  },
  {
    id: 'insurance-verification',
    category: 'Healthcare',
    channels: ['phone', 'web'],
    icon: Shield,
    color: 'bg-primary/10 text-primary border-primary/20',
    avatar: '/assets/avatars/insurance.png',
    conversationRoles: [C, A, C, A],
  },
  {
    id: 'appointment-reminder',
    category: 'Operations',
    channels: ['phone', 'sms'],
    icon: Calendar,
    color: 'bg-emerald-100/80 text-emerald-700 border-emerald-200',
    avatar: '/assets/avatars/answering-service.png',
    conversationRoles: [A, C, A, C, A],
  },
  {
    id: 'property-management',
    category: 'Operations',
    channels: ['phone', 'sms'],
    icon: Building2,
    color: 'bg-indigo-100/80 text-indigo-700 border-indigo-200',
    conversationRoles: [C, A, C, A, C, A],
  },
  {
    id: 'restaurant',
    category: 'Operations',
    channels: ['phone', 'sms'],
    icon: UtensilsCrossed,
    color: 'bg-rose-100/80 text-rose-700 border-rose-200',
    conversationRoles: [C, A, C, A, C, A],
  },
  {
    id: 'real-estate',
    category: 'Sales & Marketing',
    channels: ['phone', 'web', 'sms'],
    icon: Home,
    color: 'bg-amber-100/80 text-amber-700 border-amber-200',
    conversationRoles: [C, A, C, A, C, A],
  },
];

function asStringArray(value: unknown, debugKey?: string): string[] {
  if (Array.isArray(value)) {
    return value.filter((v): v is string => typeof v === 'string');
  }
  if (debugKey) {
    // eslint-disable-next-line no-console
    console.warn(
      `[AgentsShowcase] Expected array for translation key "${debugKey}", got ${typeof value}. Check marketing.json locale files.`,
    );
  }
  return [];
}

function ChannelBadge({ channel }: { channel: string }) {
  const { t } = useTranslation('marketing');
  const info = channelIcons[channel];
  if (!info) return null;
  const Icon = info.icon;
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 text-xs font-medium bg-white/80 text-text-primary/70 rounded border border-border">
      <Icon className="h-3 w-3" />
      {t(`agents_page.channels.${info.i18nKey}`)}
    </span>
  );
}

function AgentCard({ agent }: { agent: AgentTemplate }) {
  const { t } = useTranslation('marketing');
  const [expanded, setExpanded] = useState(false);
  const Icon = agent.icon;

  const base = `agents_data.${agent.id}`;
  const name = t(`${base}.name`);
  const description = t(`${base}.description`);
  const capabilities = asStringArray(t(`${base}.capabilities`, { returnObjects: true }), `${base}.capabilities`);
  const conversationTexts = asStringArray(t(`${base}.conversation`, { returnObjects: true }), `${base}.conversation`);
  const workflowSteps = asStringArray(t(`${base}.workflow_steps`, { returnObjects: true }), `${base}.workflow_steps`);
  const toolsUsed = asStringArray(t(`${base}.tools_used`, { returnObjects: true }), `${base}.tools_used`);
  const escalationBehavior = t(`${base}.escalation_behavior`);

  return (
    <div className="bg-white rounded-xl border border-border shadow-sm hover:shadow-md transition-all duration-200 overflow-hidden">
      <div className="p-6">
        <div className="flex items-start gap-4 mb-4">
          {agent.avatar ? (
            <div className="w-12 h-12 rounded-xl overflow-hidden shrink-0 border border-border/20">
              <img src={agent.avatar} alt={`${name} avatar`} className="w-full h-full object-cover" loading="lazy" />
            </div>
          ) : (
            <div className={`w-12 h-12 rounded-xl flex items-center justify-center shrink-0 ${agent.color}`}>
              <Icon className="h-6 w-6" />
            </div>
          )}
          <div className="min-w-0">
            <h3 className="font-display text-lg font-bold text-text-primary mb-1">{name}</h3>
            <span className="text-xs font-medium text-primary uppercase tracking-wide">
              {t(`agents_page.categories.${categoryToI18nKey[agent.category]}`)}
            </span>
          </div>
        </div>

        <p className="text-sm text-text-primary/70 leading-relaxed mb-4">{description}</p>

        <div className="flex flex-wrap gap-1.5 mb-4">
          {agent.channels.map((ch) => (
            <ChannelBadge key={ch} channel={ch} />
          ))}
        </div>

        <div className="space-y-1.5 mb-5">
          {capabilities.slice(0, 4).map((cap) => (
            <div key={cap} className="flex items-center gap-2 text-sm text-text-primary/80">
              <CheckCircle2 className="h-3.5 w-3.5 text-success shrink-0" />
              {cap}
            </div>
          ))}
          {capabilities.length > 4 && (
            <p className="text-xs text-text-muted ml-5.5">{t('agents_page.card.more_capabilities', { count: capabilities.length - 4 })}</p>
          )}
        </div>

        <div className="flex items-center gap-3">
          <Link
            to={`/signup?agent=${agent.id}`}
            className="inline-flex items-center gap-1.5 bg-primary hover:bg-primary-hover text-white text-sm font-semibold px-4 py-2 rounded-lg transition-colors"
            onClick={() => { trackCTAClick(CTA.DEPLOY_AGENT, 'agents', agent.id); trackVerticalEngagement(agent.id, VERTICAL_ACTION.DEPLOY_CLICK); }}
          >
            {t('agents_page.card.deploy')}
            <ArrowRight className="h-3.5 w-3.5" />
          </Link>
          <button
            onClick={() => setExpanded(!expanded)}
            className="inline-flex items-center gap-1 text-sm font-medium text-text-primary hover:text-primary transition-colors px-2 py-2"
          >
            {expanded ? t('agents_page.card.less_detail') : t('agents_page.card.more_detail')}
            {expanded ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
          </button>
        </div>
      </div>

      {expanded && (
        <div className="border-t border-border bg-surface-secondary/50 px-6 py-5 space-y-5">
          <div>
            <h4 className="font-display text-sm font-semibold text-text-primary mb-3 flex items-center gap-1.5">
              <MessageSquare className="h-4 w-4 text-primary" />
              {t('agents_page.card.example_conversation')}
            </h4>
            <div className="space-y-2.5 bg-white rounded-lg border border-border p-4">
              {conversationTexts.map((text, i) => {
                const role: ConversationRole = agent.conversationRoles[i] ?? 'agent';
                return (
                  <div key={i} className={`flex ${role === 'agent' ? 'justify-start' : 'justify-end'}`}>
                    <div
                      className={`max-w-[80%] px-3 py-2 rounded-lg text-sm ${
                        role === 'agent'
                          ? 'bg-primary/10 text-text-primary border border-primary/20'
                          : 'bg-surface-muted text-text-primary border border-border-strong/40'
                      }`}
                    >
                      <span className="block text-[10px] font-semibold uppercase tracking-wider mb-0.5 opacity-60">
                        {role === 'agent' ? t('agents_page.card.ai_agent_label') : t('agents_page.card.caller_label')}
                      </span>
                      {text}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          <div>
            <h4 className="font-display text-sm font-semibold text-text-primary mb-3 flex items-center gap-1.5">
              <Zap className="h-4 w-4 text-primary" />
              {t('agents_page.card.workflow_steps')}
            </h4>
            <ol className="space-y-1.5">
              {workflowSteps.map((step, i) => (
                <li key={i} className="flex items-start gap-2.5 text-sm text-text-primary/80">
                  <span className="w-5 h-5 rounded-full bg-primary/10 text-primary text-xs font-bold flex items-center justify-center shrink-0 mt-0.5">
                    {i + 1}
                  </span>
                  {step}
                </li>
              ))}
            </ol>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <h4 className="font-display text-sm font-semibold text-text-primary mb-2 flex items-center gap-1.5">
                <Bot className="h-4 w-4 text-primary" />
                {t('agents_page.card.tools_used')}
              </h4>
              <ul className="space-y-1">
                {toolsUsed.map((tool) => (
                  <li key={tool} className="text-sm text-text-primary/70 flex items-center gap-1.5">
                    <span className="w-1 h-1 rounded-full bg-primary shrink-0" />
                    {tool}
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <h4 className="font-display text-sm font-semibold text-text-primary mb-2 flex items-center gap-1.5">
                <AlertTriangle className="h-4 w-4 text-amber-500" />
                {t('agents_page.card.escalation_behavior')}
              </h4>
              <p className="text-sm text-text-primary/70 leading-relaxed">{escalationBehavior}</p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default function AgentsShowcase() {
  const { t } = useTranslation('marketing');
  const [activeCategory, setActiveCategory] = useState<Category>('All');

  useEffect(() => {
    trackPageView('/ai-agents');
  }, []);

  const filtered = activeCategory === 'All'
    ? agentTemplates
    : agentTemplates.filter((a) => a.category === activeCategory);

  return (
    <div>
      <SEO
        title={t('agents_page.seo_title')}
        description={t('agents_page.seo_description')}
        canonicalPath="/ai-agents"
      />
      <section className="bg-sidebar-bg text-white py-20 lg:py-28">
        <div className="max-w-7xl mx-auto px-6 lg:px-8">
          <div className="max-w-3xl">
            <p className="text-primary font-display text-sm font-semibold tracking-wide uppercase mb-4">
              {t('agents_page.hero.eyebrow')}
            </p>
            <h1 className="font-display text-4xl lg:text-5xl font-bold leading-tight mb-6">
              {t('agents_page.hero.title')}
            </h1>
            <p className="text-lg text-white/70 leading-relaxed mb-8 font-body">
              {t('agents_page.hero.description')}
            </p>
            <div className="flex flex-col sm:flex-row gap-4">
              <Link
                to="/signup"
                className="inline-flex items-center justify-center gap-2 bg-primary hover:bg-primary-hover text-white font-semibold px-6 py-3.5 rounded-lg transition-colors text-sm"
                onClick={() => trackCTAClick(CTA.START_FREE_TRIAL, 'agents_hero')}
              >
                {t('common.start_free_trial')}
                <ArrowRight className="h-4 w-4" />
              </Link>
              <Link
                to="/demo"
                className="inline-flex items-center justify-center gap-2 border border-white/25 hover:bg-white/10 text-white font-semibold px-6 py-3.5 rounded-lg transition-colors text-sm"
                onClick={() => trackCTAClick(CTA.TRY_LIVE_DEMO, 'agents_hero')}
              >
                {t('common.try_live_demo')}
              </Link>
            </div>
          </div>
        </div>
      </section>

      <section className="py-16 lg:py-20">
        <div className="max-w-7xl mx-auto px-6 lg:px-8">
          <div className="flex flex-wrap gap-2 mb-10">
            {categories.map((cat) => {
              const CatIcon = categoryIcons[cat];
              return (
                <button
                  key={cat}
                  onClick={() => setActiveCategory(cat)}
                  className={`inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                    activeCategory === cat
                      ? 'bg-sidebar-bg text-white shadow-sm'
                      : 'bg-white text-text-primary/70 border border-border hover:border-sidebar-bg/40 hover:text-text-primary'
                  }`}
                >
                  <CatIcon className="h-4 w-4" />
                  {t(`agents_page.categories.${categoryToI18nKey[cat]}`)}
                </button>
              );
            })}
          </div>

          <RevealSection>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {filtered.map((agent) => (
              <AgentCard key={agent.id} agent={agent} />
            ))}
          </div>
          </RevealSection>

          {filtered.length === 0 && (
            <div className="text-center py-16">
              <Bot className="h-12 w-12 text-text-muted mx-auto mb-4" />
              <p className="text-text-primary/60 font-body">{t('agents_page.empty')}</p>
            </div>
          )}
        </div>
      </section>

      <section className="bg-sidebar-bg text-white py-16 lg:py-20">
        <div className="max-w-7xl mx-auto px-6 lg:px-8 text-center">
          <h2 className="font-display text-3xl lg:text-4xl font-bold mb-4">
            {t('agents_page.bottom_cta.title')}
          </h2>
          <p className="text-lg text-white/70 mb-8 max-w-2xl mx-auto font-body">
            {t('agents_page.bottom_cta.subtitle')}
          </p>
          <div className="flex flex-col sm:flex-row justify-center gap-4">
            <Link
              to="/signup"
              className="inline-flex items-center justify-center gap-2 bg-primary hover:bg-primary-hover text-white font-semibold px-8 py-3.5 rounded-lg transition-colors text-sm"
              onClick={() => trackCTAClick(CTA.START_FREE_TRIAL, 'agents_bottom')}
            >
              {t('common.start_free_trial')}
              <ArrowRight className="h-4 w-4" />
            </Link>
            <Link
              to="/pricing"
              className="inline-flex items-center justify-center gap-2 border border-white/25 hover:bg-white/10 text-white font-semibold px-8 py-3.5 rounded-lg transition-colors text-sm"
              onClick={() => trackCTAClick(CTA.VIEW_PRICING, 'agents_bottom')}
            >
              {t('agents_page.bottom_cta.view_pricing')}
            </Link>
          </div>
        </div>
      </section>
    </div>
  );
}
