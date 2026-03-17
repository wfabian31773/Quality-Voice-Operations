import { useState, useEffect } from 'react';
import { Link, useParams } from 'react-router-dom';
import { BarChart3, Clock, DollarSign, Phone, TrendingUp, Users, ArrowRight, Star } from 'lucide-react';
import SEO from '../../components/SEO';
import RevealSection from '../../components/RevealSection';
import { trackPageView, trackConversionEvent, captureUtmOnLoad } from '../../lib/analytics';

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

function MetricCard({ icon: Icon, label, value, color }: { icon: typeof Phone; label: string; value: string; color: string }) {
  return (
    <div className={`${color} rounded-xl p-4 text-center`}>
      <Icon className="h-5 w-5 mx-auto mb-2 opacity-70" />
      <div className="text-xl font-display font-bold">{value}</div>
      <div className="text-xs mt-1 opacity-70">{label}</div>
    </div>
  );
}

function CaseStudyCard({ study }: { study: CaseStudy }) {
  const m = study.metrics;
  return (
    <RevealSection>
      <div className="bg-white rounded-2xl border border-slate-100 overflow-hidden hover:shadow-lg transition-shadow">
        <div className="bg-gradient-to-r from-harbor to-slate-700 p-6">
          <div className="flex items-center gap-2 mb-2">
            <span className="text-xs font-medium text-teal bg-teal/20 px-2 py-0.5 rounded-full capitalize">
              {study.industry}
            </span>
            <span className="text-xs text-white/50">{study.companySize} business</span>
          </div>
          <h3 className="text-lg font-display font-bold text-white">{study.title}</h3>
        </div>
        <div className="p-6">
          <p className="text-sm text-slate-600 mb-6 leading-relaxed">{study.summary}</p>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <MetricCard icon={Phone} label="Calls handled" value={m.totalCalls.toLocaleString()} color="bg-blue-50 text-blue-700" />
            <MetricCard icon={TrendingUp} label="Automation" value={`${Math.round(m.automationRate * 100)}%`} color="bg-emerald-50 text-emerald-700" />
            <MetricCard icon={DollarSign} label="Cost savings" value={`${m.costSavingsPercent}%`} color="bg-purple-50 text-purple-700" />
            <MetricCard icon={Clock} label="Avg response" value={`${m.avgResponseTime}s`} color="bg-amber-50 text-amber-700" />
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
        <div className="animate-spin h-8 w-8 border-2 border-teal border-t-transparent rounded-full" />
      </div>
    );
  }

  if (!study) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-center">
          <h1 className="text-2xl font-display font-bold text-harbor mb-4">Case Study Not Found</h1>
          <Link to="/case-studies" className="text-teal hover:underline">View all case studies</Link>
        </div>
      </div>
    );
  }

  const m = study.metrics;

  return (
    <>
      <SEO title={`${study.title} | QVO Case Study`} description={study.summary} />
      <section className="py-20 bg-gradient-to-br from-harbor via-harbor to-slate-800">
        <div className="max-w-4xl mx-auto px-6 lg:px-8">
          <div className="flex items-center gap-2 mb-4">
            <span className="text-sm font-medium text-teal bg-teal/20 px-3 py-1 rounded-full capitalize">{study.industry}</span>
          </div>
          <h1 className="text-3xl md:text-4xl font-display font-bold text-white mb-4">{study.title}</h1>
          <p className="text-lg text-white/70">{study.summary}</p>
        </div>
      </section>
      <section className="py-16 bg-white">
        <div className="max-w-4xl mx-auto px-6 lg:px-8">
          <h2 className="text-2xl font-display font-bold text-harbor mb-8">Key Results</h2>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-12">
            <MetricCard icon={Phone} label="Calls handled" value={m.totalCalls.toLocaleString()} color="bg-blue-50 text-blue-700" />
            <MetricCard icon={TrendingUp} label="Automation rate" value={`${Math.round(m.automationRate * 100)}%`} color="bg-emerald-50 text-emerald-700" />
            <MetricCard icon={DollarSign} label="Monthly savings" value={`$${m.monthlySavings.toLocaleString()}`} color="bg-purple-50 text-purple-700" />
            <MetricCard icon={Star} label="Satisfaction" value={`${m.satisfactionScore}/5.0`} color="bg-amber-50 text-amber-700" />
          </div>
          <div className="grid md:grid-cols-2 gap-6">
            <div className="bg-slate-50 rounded-xl p-6">
              <h3 className="font-display font-semibold text-harbor mb-3">Performance</h3>
              <div className="space-y-3">
                <div className="flex justify-between text-sm"><span className="text-slate-600">Avg response time</span><span className="font-medium">{m.avgResponseTime}s</span></div>
                <div className="flex justify-between text-sm"><span className="text-slate-600">Days active</span><span className="font-medium">{m.daysActive}</span></div>
                <div className="flex justify-between text-sm"><span className="text-slate-600">Cost reduction</span><span className="font-medium text-emerald-600">{m.costSavingsPercent}%</span></div>
              </div>
            </div>
            <div className="bg-slate-50 rounded-xl p-6">
              <h3 className="font-display font-semibold text-harbor mb-3">Business Impact</h3>
              <div className="space-y-3">
                <div className="flex justify-between text-sm"><span className="text-slate-600">Annual savings</span><span className="font-medium text-emerald-600">${(m.monthlySavings * 12).toLocaleString()}</span></div>
                <div className="flex justify-between text-sm"><span className="text-slate-600">Total calls automated</span><span className="font-medium">{Math.round(m.totalCalls * m.automationRate).toLocaleString()}</span></div>
                <div className="flex justify-between text-sm"><span className="text-slate-600">Company size</span><span className="font-medium capitalize">{study.companySize}</span></div>
              </div>
            </div>
          </div>
        </div>
      </section>
      <section className="py-16 bg-gradient-to-br from-teal to-teal-hover">
        <div className="max-w-4xl mx-auto px-6 lg:px-8 text-center">
          <h2 className="text-2xl md:text-3xl font-display font-bold text-white mb-4">Get Results Like These</h2>
          <p className="text-white/80 mb-8">Start your free 14-day trial and see what QVO can do for your business.</p>
          <Link to="/signup" className="inline-flex items-center gap-2 bg-white text-teal hover:bg-white/90 px-8 py-3.5 rounded-xl font-semibold transition-colors">
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
    trackConversionEvent('page_view', '/case-studies');
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

      <section className="py-20 bg-gradient-to-br from-harbor via-harbor to-slate-800">
        <div className="max-w-7xl mx-auto px-6 lg:px-8 text-center">
          <h1 className="text-4xl md:text-5xl font-display font-bold text-white mb-4">Customer Success Stories</h1>
          <p className="text-lg text-white/70 max-w-2xl mx-auto">
            Real results from real businesses using QVO AI voice agents to transform their operations.
          </p>
        </div>
      </section>

      <section className="py-16 bg-mist">
        <div className="max-w-7xl mx-auto px-6 lg:px-8">
          {loading ? (
            <div className="flex justify-center py-16">
              <div className="animate-spin h-8 w-8 border-2 border-teal border-t-transparent rounded-full" />
            </div>
          ) : studies.length === 0 ? (
            <div className="text-center py-16">
              <BarChart3 className="h-12 w-12 text-slate-300 mx-auto mb-4" />
              <h2 className="text-xl font-display font-semibold text-harbor mb-2">Case studies coming soon</h2>
              <p className="text-slate-500 mb-6">Our customers are achieving amazing results. Check back soon for detailed case studies.</p>
              <Link to="/demo" className="text-teal hover:underline">Try a live demo in the meantime &rarr;</Link>
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

      <section className="py-16 bg-white">
        <div className="max-w-4xl mx-auto px-6 lg:px-8 text-center">
          <h2 className="text-2xl md:text-3xl font-display font-bold text-harbor mb-4">Ready to Be Our Next Success Story?</h2>
          <p className="text-slate-600 mb-8">Start your free trial and see results within the first week.</p>
          <div className="flex flex-wrap justify-center gap-4">
            <Link to="/signup" className="inline-flex items-center gap-2 bg-teal hover:bg-teal-hover text-white px-8 py-3.5 rounded-xl font-semibold transition-colors">
              Start Free Trial <ArrowRight className="h-4 w-4" />
            </Link>
            <Link to="/demo" className="inline-flex items-center gap-2 bg-harbor/5 hover:bg-harbor/10 text-harbor px-8 py-3.5 rounded-xl font-semibold transition-colors">
              See Live Demo
            </Link>
          </div>
        </div>
      </section>
    </>
  );
}
