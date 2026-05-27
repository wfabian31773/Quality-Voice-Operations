import { useState, useEffect } from 'react';
import { Link, useParams } from 'react-router-dom';
import { BarChart3, Clock, DollarSign, Phone, TrendingUp, ArrowRight, Star } from 'lucide-react';
import SEO from '../../components/SEO';
import RevealSection from '../../components/RevealSection';
import { StatCard } from '../../components/ui';
import { trackPageView, trackConversionEvent, captureUtmOnLoad } from '../../lib/analytics';
import { CONVERSION_STAGE } from '../../lib/analyticsLabels';
import { formatDollars } from '../../lib/formatCurrency';

interface CaseStudyMetrics {
  totalCalls: number;
  automationRate: number;
  avgResponseTime: number;
  costSavingsPercent: number;
  monthlySavings: number;
  satisfactionScore: number;
  daysActive: number;
}

interface CaseStudy {
  id: string;
  industry: string;
  companySize: string;
  metrics: CaseStudyMetrics;
  title: string;
  summary: string;
  publicSlug: string | null;
  createdAt: string;
}

function CaseStudyCard({ study }: { study: CaseStudy }) {
  const m = study.metrics;
  return (
    <RevealSection>
      <div className="bg-surface rounded-2xl border border-border overflow-hidden hover:shadow-lg transition-shadow">
        <div className="bg-gradient-to-r from-sidebar-bg to-[#334155] p-6">
          <div className="flex items-center gap-2 mb-2">
            <span className="text-xs font-medium text-primary bg-primary/20 px-2 py-0.5 rounded-full capitalize">
              {study.industry}
            </span>
            <span className="text-xs text-white/50">{study.companySize} business</span>
          </div>
          <h3 className="text-lg font-display font-bold text-white">{study.title}</h3>
        </div>
        <div className="p-6">
          <p className="text-sm text-text-secondary mb-6 leading-relaxed">{study.summary}</p>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <StatCard icon={Phone} label="Calls handled" value={m.totalCalls.toLocaleString()} tone="info" />
            <StatCard icon={TrendingUp} label="Automation" value={`${Math.round(m.automationRate * 100)}%`} tone="success" />
            <StatCard icon={DollarSign} label="Cost savings" value={`${m.costSavingsPercent}%`} tone="accent" />
            <StatCard icon={Clock} label="Avg response" value={`${m.avgResponseTime}s`} tone="warning" />
          </div>
        </div>
      </div>
    </RevealSection>
  );
}

function CaseStudyDetail({ slug }: { slug: string }) {
  const [study, setStudy] = useState<CaseStudy | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`/api/public/case-studies/${slug}`)
      .then((r) => {
        if (!r.ok) throw new Error('Not found');
        return r.json();
      })
      .then(setStudy)
      .catch(() => setStudy(null))
      .finally(() => setLoading(false));
  }, [slug]);

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-spin h-8 w-8 border-2 border-primary border-t-transparent rounded-full" />
      </div>
    );
  }

  if (!study) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-center">
          <h1 className="text-2xl font-display font-bold text-text-primary mb-4">Case Study Not Found</h1>
          <Link to="/case-studies" className="text-primary hover:underline">View all case studies</Link>
        </div>
      </div>
    );
  }

  const m = study.metrics;

  return (
    <>
      <SEO title={`${study.title} | QVO Case Study`} description={study.summary} />
      <section className="py-20 bg-gradient-to-br from-sidebar-bg via-sidebar-bg to-[#1e293b]">
        <div className="max-w-4xl mx-auto px-6 lg:px-8">
          <div className="flex items-center gap-2 mb-4">
            <span className="text-sm font-medium text-primary bg-primary/20 px-3 py-1 rounded-full capitalize">{study.industry}</span>
          </div>
          <h1 className="text-3xl md:text-4xl font-display font-bold text-white mb-4">{study.title}</h1>
          <p className="text-lg text-white/70">{study.summary}</p>
        </div>
      </section>
      <section className="py-16 bg-surface">
        <div className="max-w-4xl mx-auto px-6 lg:px-8">
          <h2 className="text-2xl font-display font-bold text-text-primary mb-8">Key Results</h2>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-12">
            <StatCard icon={Phone} label="Calls handled" value={m.totalCalls.toLocaleString()} tone="info" />
            <StatCard icon={TrendingUp} label="Automation rate" value={`${Math.round(m.automationRate * 100)}%`} tone="success" />
            <StatCard icon={DollarSign} label="Monthly savings" value={formatDollars(m.monthlySavings, { minimumFractionDigits: 0, maximumFractionDigits: 0 })} tone="accent" />
            <StatCard icon={Star} label="Satisfaction" value={`${m.satisfactionScore}/5.0`} tone="warning" />
          </div>
          <div className="grid md:grid-cols-2 gap-6">
            <div className="bg-surface-secondary rounded-xl p-6">
              <h3 className="font-display font-semibold text-text-primary mb-3">Performance</h3>
              <div className="space-y-3">
                <div className="flex justify-between text-sm"><span className="text-text-secondary">Avg response time</span><span className="font-medium text-text-primary">{m.avgResponseTime}s</span></div>
                <div className="flex justify-between text-sm"><span className="text-text-secondary">Days active</span><span className="font-medium text-text-primary">{m.daysActive}</span></div>
                <div className="flex justify-between text-sm"><span className="text-text-secondary">Cost reduction</span><span className="font-medium text-success dark:text-success">{m.costSavingsPercent}%</span></div>
              </div>
            </div>
            <div className="bg-surface-secondary rounded-xl p-6">
              <h3 className="font-display font-semibold text-text-primary mb-3">Business Impact</h3>
              <div className="space-y-3">
                <div className="flex justify-between text-sm"><span className="text-text-secondary">Annual savings</span><span className="font-medium text-success dark:text-success">{formatDollars(m.monthlySavings * 12, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}</span></div>
                <div className="flex justify-between text-sm"><span className="text-text-secondary">Total calls automated</span><span className="font-medium text-text-primary">{Math.round(m.totalCalls * m.automationRate).toLocaleString()}</span></div>
                <div className="flex justify-between text-sm"><span className="text-text-secondary">Company size</span><span className="font-medium text-text-primary capitalize">{study.companySize}</span></div>
              </div>
            </div>
          </div>
        </div>
      </section>
      <section className="py-16 bg-gradient-to-br from-primary to-primary-hover">
        <div className="max-w-4xl mx-auto px-6 lg:px-8 text-center">
          <h2 className="text-2xl md:text-3xl font-display font-bold text-white mb-4">Get Results Like These</h2>
          <p className="text-white/80 mb-8">Start your free 14-day trial and see what QVO can do for your business.</p>
          <Link to="/signup" className="inline-flex items-center gap-2 bg-surface text-primary hover:bg-surface-hover px-8 py-3.5 rounded-xl font-semibold transition-colors">
            Start Free Trial <ArrowRight className="h-4 w-4" />
          </Link>
        </div>
      </section>
    </>
  );
}

export default function CaseStudies() {
  const { slug } = useParams<{ slug?: string }>();
  const [studies, setStudies] = useState<CaseStudy[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    trackPageView('/case-studies');
    captureUtmOnLoad();
    trackConversionEvent(CONVERSION_STAGE.PAGE_VIEW, '/case-studies');
  }, []);

  useEffect(() => {
    if (!slug) {
      fetch('/api/public/case-studies')
        .then((r) => {
          if (!r.ok) throw new Error('Failed to fetch');
          return r.json();
        })
        .then((data) => setStudies(Array.isArray(data) ? data : []))
        .catch(() => setStudies([]))
        .finally(() => setLoading(false));
    }
  }, [slug]);

  if (slug) {
    return <CaseStudyDetail slug={slug} />;
  }

  return (
    <>
      <SEO
        title="Customer Success Stories | QVO"
        description="See how businesses across healthcare, legal, real estate, and home services use QVO AI voice agents to automate calls and grow revenue."
      />

      <section className="py-20 bg-gradient-to-br from-sidebar-bg via-sidebar-bg to-[#1e293b]">
        <div className="max-w-7xl mx-auto px-6 lg:px-8 text-center">
          <h1 className="text-4xl md:text-5xl font-display font-bold text-white mb-4">Customer Success Stories</h1>
          <p className="text-lg text-white/70 max-w-2xl mx-auto">
            Real results from real businesses using QVO AI voice agents to transform their operations.
          </p>
        </div>
      </section>

      <section className="py-16 bg-surface-secondary">
        <div className="max-w-7xl mx-auto px-6 lg:px-8">
          {loading ? (
            <div className="flex justify-center py-16">
              <div className="animate-spin h-8 w-8 border-2 border-primary border-t-transparent rounded-full" />
            </div>
          ) : studies.length === 0 ? (
            <div>
              <div className="grid md:grid-cols-3 gap-6 mb-10">
                {[
                  { vertical: 'Healthcare', name: 'Lakewood Family Medicine', metric: '63%', label: 'reduction in missed calls', summary: 'Replaced an overflowed front desk with a 24/7 voice agent that handles intake and reschedules.' },
                  { vertical: 'Home Services', name: 'Comfort First HVAC', metric: '$184K', label: 'recovered annually', summary: 'After-hours emergency calls now book directly into the dispatch queue without an on-call coordinator.' },
                  { vertical: 'Legal', name: 'Park & Associates', metric: '4.9 / 5', label: 'caller satisfaction', summary: 'Intake automation freed paralegals from screening calls so they could focus on case work.' },
                ].map((s) => (
                  <div key={s.name} className="bg-surface border border-border/30 rounded-2xl p-6">
                    <span className="text-xs font-semibold text-primary bg-primary/10 px-2.5 py-1 rounded-full">{s.vertical}</span>
                    <h3 className="font-display text-lg font-bold text-text-primary mt-4 mb-2">{s.name}</h3>
                    <div className="mb-3">
                      <p className="font-display text-3xl font-bold text-primary">{s.metric}</p>
                      <p className="text-xs text-text-primary/60 font-body">{s.label}</p>
                    </div>
                    <p className="text-sm text-text-primary/70 font-body leading-relaxed">{s.summary}</p>
                  </div>
                ))}
              </div>
              <div className="text-center bg-surface border border-border/30 rounded-2xl py-10 px-6">
                <BarChart3 className="h-10 w-10 text-text-muted mx-auto mb-3" />
                <h3 className="text-lg font-display font-semibold text-text-primary mb-2">Detailed case studies coming soon</h3>
                <p className="text-text-secondary mb-5 max-w-xl mx-auto text-sm">
                  We are publishing in-depth stories from our healthcare, legal, and home-service customers. In the meantime, request a custom walkthrough.
                </p>
                <div className="flex flex-wrap justify-center gap-3">
                  <Link to="/book-demo" className="inline-flex items-center gap-2 bg-primary hover:bg-primary-hover text-white px-5 py-2.5 rounded-lg text-sm font-semibold transition-colors">
                    Book a demo <ArrowRight className="h-4 w-4" />
                  </Link>
                  <Link to="/demo" className="inline-flex items-center gap-2 bg-surface-secondary hover:bg-surface-hover text-text-primary px-5 py-2.5 rounded-lg text-sm font-semibold transition-colors">
                    Try the live demo
                  </Link>
                </div>
              </div>
            </div>
          ) : (
            <div className="grid md:grid-cols-2 gap-8">
              {studies.map((study) => (
                <Link key={study.id} to={study.publicSlug ? `/case-studies/${study.publicSlug}` : '#'}>
                  <CaseStudyCard study={study} />
                </Link>
              ))}
            </div>
          )}
        </div>
      </section>

      <section className="py-16 bg-surface">
        <div className="max-w-4xl mx-auto px-6 lg:px-8 text-center">
          <h2 className="text-2xl md:text-3xl font-display font-bold text-text-primary mb-4">Ready to Be Our Next Success Story?</h2>
          <p className="text-text-secondary mb-8">Start your free trial and see results within the first week.</p>
          <div className="flex flex-wrap justify-center gap-4">
            <Link to="/signup" className="inline-flex items-center gap-2 bg-primary hover:bg-primary-hover text-white px-8 py-3.5 rounded-xl font-semibold transition-colors">
              Start Free Trial <ArrowRight className="h-4 w-4" />
            </Link>
            <Link to="/book-demo" className="inline-flex items-center gap-2 bg-surface-secondary hover:bg-surface-muted text-text-primary px-8 py-3.5 rounded-xl font-semibold transition-colors">
              Book a Demo
            </Link>
            <Link to="/demo" className="inline-flex items-center gap-2 text-text-primary/70 hover:text-text-primary px-6 py-3.5 rounded-xl font-semibold transition-colors">
              See Live Demo
            </Link>
          </div>
        </div>
      </section>
    </>
  );
}
