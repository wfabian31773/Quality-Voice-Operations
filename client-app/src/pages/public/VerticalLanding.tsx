import { useParams, Link } from 'react-router-dom';
import { useEffect } from 'react';
import {
  Phone, Clock, DollarSign, Users, CheckCircle2, ArrowRight,
  Stethoscope, Home, Scale, Wrench, Smile, BarChart3, Shield,
  Calendar, MessageSquare, TrendingUp, Star, Zap, Target,
} from 'lucide-react';
import SEO from '../../components/SEO';
import RevealSection from '../../components/RevealSection';
import ROICalculator from '../../components/ROICalculator';
import { trackPageView, trackVerticalEngagement, trackCTAClick, trackConversionEvent, captureUtmOnLoad } from '../../lib/analytics';

interface VerticalData {
  slug: string;
  name: string;
  headline: string;
  subheadline: string;
  description: string;
  icon: typeof Phone;
  color: string;
  colorLight: string;
  painPoints: Array<{ title: string; description: string }>;
  agentExamples: Array<{ name: string; description: string; capabilities: string[] }>;
  stats: Array<{ value: string; label: string }>;
  testimonial: { quote: string; author: string; role: string; company: string };
  demoAgent: string;
  metaTitle: string;
  metaDescription: string;
}

const verticals: Record<string, VerticalData> = {
  healthcare: {
    slug: 'healthcare',
    name: 'Healthcare',
    headline: 'AI Voice Agents Built for Healthcare',
    subheadline: 'Handle patient calls 24/7 — scheduling, intake, prescription refills, and triage — with HIPAA-aware voice AI that never puts patients on hold.',
    description: 'QVO helps healthcare practices automate patient communication while maintaining the personal touch patients expect.',
    icon: Stethoscope,
    color: 'bg-blue-600',
    colorLight: 'bg-blue-50',
    painPoints: [
      { title: 'Missed patient calls', description: 'Up to 30% of patient calls go unanswered during peak hours, leading to no-shows and lost revenue.' },
      { title: 'Staff burnout', description: 'Front desk staff spend 60% of their day on repetitive phone tasks — scheduling, confirmations, and insurance checks.' },
      { title: 'After-hours gaps', description: 'Patients needing urgent triage after hours hit voicemail. Competitors with 24/7 answering capture those patients.' },
      { title: 'No-show costs', description: 'Each no-show costs practices $150-$300. Without automated reminders and easy rescheduling, rates stay high.' },
    ],
    agentExamples: [
      { name: 'Patient Scheduling Agent', description: 'Books, reschedules, and confirms appointments in real time with calendar integration.', capabilities: ['Real-time availability check', 'SMS confirmations', 'Waitlist management', 'Provider matching'] },
      { name: 'Medical Intake Agent', description: 'Conducts structured intake interviews, captures symptoms, insurance info, and medical history.', capabilities: ['Structured data capture', 'Insurance verification', 'EHR integration', 'Pre-visit preparation'] },
      { name: 'After-Hours Triage Agent', description: 'Answers calls 24/7, assesses urgency, and routes emergencies to on-call providers.', capabilities: ['Urgency classification', 'On-call escalation', 'Patient callback scheduling', 'Emergency routing'] },
    ],
    stats: [
      { value: '95%', label: 'Call answer rate' },
      { value: '40%', label: 'Staff time saved' },
      { value: '28%', label: 'No-show reduction' },
      { value: '<30s', label: 'Average answer time' },
    ],
    testimonial: { quote: 'We went from missing 1 in 3 calls to answering every single one. Our patient satisfaction scores jumped 22 points in the first month.', author: 'Dr. Sarah Mitchell', role: 'Practice Administrator', company: 'Lakewood Family Medicine' },
    demoAgent: 'medical-intake',
    metaTitle: 'AI Voice Agents for Healthcare | QVO',
    metaDescription: 'Automate patient scheduling, intake, and after-hours triage with HIPAA-aware AI voice agents. Answer every call 24/7 and reduce no-shows by 28%.',
  },
  'real-estate': {
    slug: 'real-estate',
    name: 'Real Estate',
    headline: 'AI Voice Agents for Real Estate',
    subheadline: 'Capture every lead, qualify buyers instantly, and schedule showings 24/7 — so you never lose a deal to a missed call.',
    description: 'QVO helps real estate professionals respond to leads in seconds, not hours, with AI agents that qualify prospects and book showings automatically.',
    icon: Home,
    color: 'bg-emerald-600',
    colorLight: 'bg-emerald-50',
    painPoints: [
      { title: 'Slow lead response', description: 'Leads contacted after 5 minutes are 10x less likely to convert. Most agents respond in hours, not minutes.' },
      { title: 'After-hours inquiries', description: '42% of real estate inquiries come outside business hours. Those leads go to the next agent who answers.' },
      { title: 'Unqualified showings', description: 'Agents waste hours on showings with unqualified buyers who can\'t close. Pre-qualification saves time.' },
      { title: 'Lead routing chaos', description: 'Leads from multiple sources (Zillow, Realtor.com, sign calls) get lost without centralized capture.' },
    ],
    agentExamples: [
      { name: 'Lead Qualification Agent', description: 'Instantly qualifies inbound leads by budget, timeline, pre-approval status, and preferences.', capabilities: ['Budget qualification', 'Pre-approval check', 'Preference matching', 'CRM integration'] },
      { name: 'Showing Scheduler Agent', description: 'Books property showings by checking agent and property availability in real time.', capabilities: ['Calendar sync', 'Multi-property booking', 'Driving directions', 'Confirmation SMS'] },
      { name: 'Property Info Agent', description: 'Answers questions about listings — price, square footage, features, HOA — from your MLS data.', capabilities: ['MLS data lookup', 'Neighborhood info', 'Comparable properties', 'Open house details'] },
    ],
    stats: [
      { value: '< 30s', label: 'Lead response time' },
      { value: '3.2x', label: 'More leads captured' },
      { value: '45%', label: 'Showing-to-offer rate' },
      { value: '24/7', label: 'Lead capture' },
    ],
    testimonial: { quote: 'QVO responds to our Zillow leads in seconds. Our conversion rate doubled because we\'re always first to respond.', author: 'Marcus Chen', role: 'Broker/Owner', company: 'Pinnacle Realty Group' },
    demoAgent: 'real-estate',
    metaTitle: 'AI Voice Agents for Real Estate | QVO',
    metaDescription: 'Respond to real estate leads in seconds, qualify buyers automatically, and schedule showings 24/7 with AI voice agents.',
  },
  legal: {
    slug: 'legal',
    name: 'Legal',
    headline: 'AI Voice Agents for Law Firms',
    subheadline: 'Never miss a potential client. Conduct confidential intakes, qualify cases, and schedule consultations — professionally and around the clock.',
    description: 'QVO helps law firms capture every lead with professional AI intake agents that qualify cases and book consultations automatically.',
    icon: Scale,
    color: 'bg-amber-600',
    colorLight: 'bg-amber-50',
    painPoints: [
      { title: 'Missed client calls', description: 'The average law firm misses 35% of incoming calls. Each missed call could be a $5,000-$50,000 case.' },
      { title: 'Expensive intake staff', description: 'Full-time intake coordinators cost $45,000-$65,000/year, and can only handle one call at a time.' },
      { title: 'After-hours leads', description: 'People search for attorneys at night and on weekends. If you don\'t answer, the next firm will.' },
      { title: 'Inconsistent screening', description: 'Without structured intake, staff miss critical case details and accept cases outside your practice areas.' },
    ],
    agentExamples: [
      { name: 'Legal Intake Agent', description: 'Conducts professional case intake — captures incident details, injuries, timelines, and opposing parties.', capabilities: ['Structured case intake', 'Conflict check', 'Practice area matching', 'Document request'] },
      { name: 'Consultation Scheduler', description: 'Books initial consultations based on attorney availability, practice area, and case urgency.', capabilities: ['Attorney calendar sync', 'Practice area routing', 'Retainer info', 'Confirmation emails'] },
      { name: 'Case Status Agent', description: 'Provides existing clients with case status updates, next steps, and attorney callbacks.', capabilities: ['Case lookup', 'Status updates', 'Callback scheduling', 'Document reminders'] },
    ],
    stats: [
      { value: '100%', label: 'Calls answered' },
      { value: '$180K', label: 'Avg revenue recovered/year' },
      { value: '65%', label: 'Intake cost reduction' },
      { value: '4.8/5', label: 'Client satisfaction' },
    ],
    testimonial: { quote: 'We were losing 8-10 potential clients per week to missed calls. QVO captures every one now, and the intake quality is better than our previous staff.', author: 'Jennifer Park', role: 'Managing Partner', company: 'Park & Associates Law' },
    demoAgent: 'legal-intake',
    metaTitle: 'AI Voice Agents for Law Firms | QVO',
    metaDescription: 'Capture every potential client call with AI-powered legal intake agents. Qualify cases, schedule consultations, and reduce intake costs by 65%.',
  },
  'home-services': {
    slug: 'home-services',
    name: 'Home Services',
    headline: 'AI Voice Agents for Home Services',
    subheadline: 'Answer every service call, dispatch technicians instantly, and keep customers updated — even at 2 AM when the furnace dies.',
    description: 'QVO helps HVAC, plumbing, electrical, and home service companies capture every emergency call and dispatch faster than ever.',
    icon: Wrench,
    color: 'bg-orange-600',
    colorLight: 'bg-orange-50',
    painPoints: [
      { title: 'Lost emergency calls', description: 'After-hours emergencies go to voicemail. Homeowners call the next company in Google results.' },
      { title: 'Dispatcher overload', description: 'Dispatchers juggle phones, scheduling, and technician coordination. Calls get dropped during peak times.' },
      { title: 'No customer updates', description: 'Customers waiting for technicians get anxious with no ETA. They call repeatedly, tying up your lines.' },
      { title: 'Seasonal call spikes', description: 'First cold snap or heat wave doubles call volume overnight. You can\'t hire fast enough to keep up.' },
    ],
    agentExamples: [
      { name: 'Emergency Dispatch Agent', description: 'Triages emergencies, dispatches nearest available technician, and sends customer ETAs via SMS.', capabilities: ['Emergency triage', 'Technician matching', 'GPS-based dispatch', 'SMS ETAs'] },
      { name: 'Service Booking Agent', description: 'Books maintenance appointments, estimates, and inspections with real-time schedule availability.', capabilities: ['Service type matching', 'Time slot booking', 'Estimate scheduling', 'Confirmation calls'] },
      { name: 'Customer Follow-Up Agent', description: 'Calls customers post-service for satisfaction checks, reviews, and maintenance plan enrollment.', capabilities: ['Satisfaction surveys', 'Review requests', 'Maintenance plans', 'Referral capture'] },
    ],
    stats: [
      { value: '100%', label: 'Calls captured' },
      { value: '5 min', label: 'Avg dispatch time' },
      { value: '35%', label: 'Revenue increase' },
      { value: '4.9/5', label: 'Google rating' },
    ],
    testimonial: { quote: 'During last winter\'s cold snap, we handled 3x our normal call volume without adding a single person. QVO dispatched technicians faster than our best dispatcher.', author: 'Mike Rodriguez', role: 'Owner', company: 'Comfort First HVAC' },
    demoAgent: 'hvac-home-services',
    metaTitle: 'AI Voice Agents for Home Services | QVO',
    metaDescription: 'Never miss an emergency service call. AI voice agents for HVAC, plumbing, and electrical companies that dispatch technicians and update customers 24/7.',
  },
  dental: {
    slug: 'dental',
    name: 'Dental',
    headline: 'AI Voice Agents for Dental Practices',
    subheadline: 'Fill your schedule, reduce no-shows, and give every patient a warm, professional experience — without adding front desk staff.',
    description: 'QVO helps dental practices maximize chair time by automating patient scheduling, reminders, and recall campaigns with AI voice agents.',
    icon: Smile,
    color: 'bg-cyan-600',
    colorLight: 'bg-cyan-50',
    painPoints: [
      { title: 'Empty chairs', description: 'The average dental practice loses $150,000/year to unfilled appointments and last-minute cancellations.' },
      { title: 'Phone hold times', description: 'Patients who wait more than 60 seconds on hold hang up. 34% don\'t call back and book elsewhere.' },
      { title: 'Recall compliance', description: 'Only 40% of patients return for their 6-month recall. Manual reminder calls are time-consuming and inconsistent.' },
      { title: 'New patient conversion', description: 'New patient calls need immediate, warm handling. Rushed or delayed responses lose these high-value patients.' },
    ],
    agentExamples: [
      { name: 'Dental Scheduling Agent', description: 'Books hygiene, restorative, and emergency appointments with real-time operatory availability.', capabilities: ['Provider matching', 'Operatory scheduling', 'Insurance pre-check', 'New patient onboarding'] },
      { name: 'Recall Campaign Agent', description: 'Proactively calls patients due for cleanings, exams, and outstanding treatment.', capabilities: ['Recall list management', 'Outbound calling', 'Re-booking', 'Treatment reminders'] },
      { name: 'Emergency Triage Agent', description: 'Assesses dental emergencies after hours and schedules same-day appointments or provides care instructions.', capabilities: ['Pain assessment', 'Emergency scheduling', 'Care instructions', 'Provider alerts'] },
    ],
    stats: [
      { value: '94%', label: 'Booking rate' },
      { value: '35%', label: 'No-show reduction' },
      { value: '$12K', label: 'Monthly revenue recovered' },
      { value: '60%', label: 'Recall improvement' },
    ],
    testimonial: { quote: 'Our no-show rate dropped from 18% to 7% in the first quarter. The recall campaign agent alone brought back 140 overdue patients.', author: 'Dr. Lisa Nguyen', role: 'Practice Owner', company: 'Bright Smile Dental' },
    demoAgent: 'dental-scheduling',
    metaTitle: 'AI Voice Agents for Dental Practices | QVO',
    metaDescription: 'Fill your dental schedule and reduce no-shows with AI voice agents. Automate patient scheduling, recall campaigns, and emergency triage 24/7.',
  },
};

const iconMap: Record<string, typeof Phone> = {
  healthcare: Stethoscope,
  'real-estate': Home,
  legal: Scale,
  'home-services': Wrench,
  dental: Smile,
};

export default function VerticalLanding() {
  const { vertical } = useParams<{ vertical: string }>();
  const data = vertical ? verticals[vertical] : null;

  useEffect(() => {
    captureUtmOnLoad();
    if (data) {
      trackPageView(`/industries/${data.slug}`);
      trackVerticalEngagement(data.slug, 'page_view');
      trackConversionEvent('page_view', `/industries/${data.slug}`);
    }
  }, [data]);

  if (!data) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-center">
          <h1 className="text-2xl font-display font-bold text-harbor mb-4">Industry Not Found</h1>
          <p className="text-slate-600 mb-6">We don't have a page for that industry yet.</p>
          <Link to="/use-cases" className="text-teal hover:underline">View all use cases &rarr;</Link>
        </div>
      </div>
    );
  }

  const Icon = data.icon;

  return (
    <>
      <SEO
        title={data.metaTitle}
        description={data.metaDescription}
        canonicalPath={`/industries/${data.slug}`}
        structuredData={{
          '@context': 'https://schema.org',
          '@type': 'WebPage',
          name: data.metaTitle,
          description: data.metaDescription,
          url: `https://qvo.ai/industries/${data.slug}`,
          provider: {
            '@type': 'Organization',
            name: 'QVO',
            url: 'https://qvo.ai',
          },
        }}
      />

      <section className="relative overflow-hidden py-20 lg:py-28">
        <div className="absolute inset-0 bg-gradient-to-br from-harbor via-harbor to-slate-800" />
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top_right,_var(--tw-gradient-stops))] from-teal/20 via-transparent to-transparent" />
        <div className="relative max-w-7xl mx-auto px-6 lg:px-8">
          <div className="max-w-3xl">
            <div className="flex items-center gap-3 mb-6">
              <div className={`w-10 h-10 rounded-xl ${data.color} flex items-center justify-center`}>
                <Icon className="h-5 w-5 text-white" />
              </div>
              <span className="text-sm font-medium text-teal uppercase tracking-wider">{data.name}</span>
            </div>
            <h1 className="text-4xl md:text-5xl lg:text-6xl font-display font-bold text-white leading-tight mb-6">
              {data.headline}
            </h1>
            <p className="text-lg md:text-xl text-white/80 leading-relaxed mb-8">
              {data.subheadline}
            </p>
            <div className="flex flex-wrap gap-4">
              <Link
                to="/signup"
                onClick={() => { trackCTAClick('Start Free Trial', `industry-${data.slug}`, 'hero'); trackConversionEvent('cta_click', `/industries/${data.slug}`, { cta: 'signup' }); }}
                className="inline-flex items-center gap-2 bg-teal hover:bg-teal-hover text-white px-6 py-3 rounded-xl font-medium transition-colors"
              >
                Start Free Trial <ArrowRight className="h-4 w-4" />
              </Link>
              <Link
                to={`/demo?agent=${data.demoAgent}`}
                onClick={() => { trackCTAClick('Try Live Demo', `industry-${data.slug}`, 'hero'); trackConversionEvent('demo_started', `/industries/${data.slug}`); }}
                className="inline-flex items-center gap-2 bg-white/10 hover:bg-white/20 text-white px-6 py-3 rounded-xl font-medium transition-colors backdrop-blur-sm"
              >
                Try Live Demo <Phone className="h-4 w-4" />
              </Link>
            </div>
          </div>
        </div>
      </section>

      <section className="py-12 bg-white border-b border-slate-100">
        <div className="max-w-7xl mx-auto px-6 lg:px-8">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-8">
            {data.stats.map((stat) => (
              <div key={stat.label} className="text-center">
                <div className="text-3xl md:text-4xl font-display font-bold text-harbor">{stat.value}</div>
                <div className="text-sm text-slate-500 mt-1">{stat.label}</div>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="py-20 bg-mist">
        <div className="max-w-7xl mx-auto px-6 lg:px-8">
          <RevealSection>
            <div className="text-center mb-16">
              <h2 className="text-3xl md:text-4xl font-display font-bold text-harbor mb-4">
                The Problems You Face Every Day
              </h2>
              <p className="text-lg text-slate-600 max-w-2xl mx-auto">
                {data.name} businesses lose revenue and patients to these common phone-related challenges.
              </p>
            </div>
          </RevealSection>
          <div className="grid md:grid-cols-2 gap-6">
            {data.painPoints.map((point, idx) => (
              <RevealSection key={point.title} delay={`delay-${idx * 100}`}>
                <div className="bg-white rounded-2xl p-6 border border-slate-100 hover:shadow-lg transition-shadow">
                  <div className="flex items-start gap-4">
                    <div className="w-8 h-8 rounded-lg bg-red-50 flex items-center justify-center shrink-0 mt-0.5">
                      <Target className="h-4 w-4 text-red-500" />
                    </div>
                    <div>
                      <h3 className="font-display font-semibold text-harbor mb-2">{point.title}</h3>
                      <p className="text-sm text-slate-600 leading-relaxed">{point.description}</p>
                    </div>
                  </div>
                </div>
              </RevealSection>
            ))}
          </div>
        </div>
      </section>

      <section className="py-20 bg-white">
        <div className="max-w-7xl mx-auto px-6 lg:px-8">
          <RevealSection>
            <div className="text-center mb-16">
              <h2 className="text-3xl md:text-4xl font-display font-bold text-harbor mb-4">
                AI Agents Built for {data.name}
              </h2>
              <p className="text-lg text-slate-600 max-w-2xl mx-auto">
                Pre-built agent templates designed specifically for {data.name.toLowerCase()} workflows. Deploy in minutes, not months.
              </p>
            </div>
          </RevealSection>
          <div className="grid md:grid-cols-3 gap-8">
            {data.agentExamples.map((agent, idx) => (
              <RevealSection key={agent.name} delay={`delay-${idx * 150}`}>
                <div className="bg-mist rounded-2xl p-6 border border-slate-100 h-full flex flex-col">
                  <div className={`w-10 h-10 rounded-xl ${data.color} flex items-center justify-center mb-4`}>
                    <Zap className="h-5 w-5 text-white" />
                  </div>
                  <h3 className="font-display font-semibold text-harbor text-lg mb-2">{agent.name}</h3>
                  <p className="text-sm text-slate-600 mb-4 flex-1">{agent.description}</p>
                  <ul className="space-y-2">
                    {agent.capabilities.map((cap) => (
                      <li key={cap} className="flex items-center gap-2 text-sm text-slate-700">
                        <CheckCircle2 className="h-4 w-4 text-teal shrink-0" />
                        {cap}
                      </li>
                    ))}
                  </ul>
                </div>
              </RevealSection>
            ))}
          </div>
        </div>
      </section>

      <section className="py-20 bg-mist">
        <div className="max-w-7xl mx-auto px-6 lg:px-8">
          <RevealSection>
            <div className="text-center mb-12">
              <h2 className="text-3xl md:text-4xl font-display font-bold text-harbor mb-4">
                Calculate Your ROI
              </h2>
              <p className="text-lg text-slate-600 max-w-2xl mx-auto">
                See how much your {data.name.toLowerCase()} practice could save with QVO voice agents.
              </p>
            </div>
          </RevealSection>
          <ROICalculator vertical={data.slug} />
        </div>
      </section>

      <section className="py-20 bg-harbor">
        <div className="max-w-4xl mx-auto px-6 lg:px-8 text-center">
          <RevealSection>
            <div className="flex justify-center mb-4">
              {[...Array(5)].map((_, i) => (
                <Star key={i} className="h-5 w-5 text-yellow-400 fill-yellow-400" />
              ))}
            </div>
            <blockquote className="text-xl md:text-2xl text-white font-display leading-relaxed mb-6">
              "{data.testimonial.quote}"
            </blockquote>
            <div className="text-white/70">
              <span className="font-semibold text-white">{data.testimonial.author}</span>
              <span className="mx-2">·</span>
              {data.testimonial.role}, {data.testimonial.company}
            </div>
          </RevealSection>
        </div>
      </section>

      <section className="py-20 bg-white">
        <div className="max-w-7xl mx-auto px-6 lg:px-8">
          <RevealSection>
            <div className="text-center mb-12">
              <h2 className="text-3xl md:text-4xl font-display font-bold text-harbor mb-4">
                Why {data.name} Businesses Choose QVO
              </h2>
            </div>
          </RevealSection>
          <div className="grid md:grid-cols-3 gap-8">
            {[
              { icon: Shield, title: 'Industry Expertise', desc: `Purpose-built for ${data.name.toLowerCase()}. Our agents understand your terminology, workflows, and compliance needs.` },
              { icon: Clock, title: 'Deploy in Minutes', desc: 'Pre-configured agent templates mean you can go live the same day. No coding, no complex setup required.' },
              { icon: BarChart3, title: 'Measurable ROI', desc: 'Track every call, every booking, and every dollar saved. See exactly what your AI agents deliver.' },
            ].map((item, idx) => (
              <RevealSection key={item.title} delay={`delay-${idx * 150}`}>
                <div className="text-center">
                  <div className="w-12 h-12 rounded-2xl bg-teal/10 flex items-center justify-center mx-auto mb-4">
                    <item.icon className="h-6 w-6 text-teal" />
                  </div>
                  <h3 className="font-display font-semibold text-harbor text-lg mb-2">{item.title}</h3>
                  <p className="text-sm text-slate-600 leading-relaxed">{item.desc}</p>
                </div>
              </RevealSection>
            ))}
          </div>
        </div>
      </section>

      <section className="py-20 bg-gradient-to-br from-teal to-teal-hover">
        <div className="max-w-4xl mx-auto px-6 lg:px-8 text-center">
          <h2 className="text-3xl md:text-4xl font-display font-bold text-white mb-4">
            Ready to Transform Your {data.name} Practice?
          </h2>
          <p className="text-lg text-white/80 mb-8 max-w-2xl mx-auto">
            Join hundreds of {data.name.toLowerCase()} businesses using QVO to answer every call, book more appointments, and grow revenue.
          </p>
          <div className="flex flex-wrap justify-center gap-4">
            <Link
              to="/signup"
              onClick={() => { trackCTAClick('Start Free Trial', `industry-${data.slug}`, 'bottom-cta'); trackConversionEvent('cta_click', `/industries/${data.slug}`, { cta: 'signup_bottom' }); }}
              className="inline-flex items-center gap-2 bg-white text-teal hover:bg-white/90 px-8 py-3.5 rounded-xl font-semibold transition-colors"
            >
              Start Your Free Trial <ArrowRight className="h-4 w-4" />
            </Link>
            <Link
              to={`/demo?agent=${data.demoAgent}`}
              onClick={() => trackCTAClick('See Live Demo', `industry-${data.slug}`, 'bottom-cta')}
              className="inline-flex items-center gap-2 bg-white/20 hover:bg-white/30 text-white px-8 py-3.5 rounded-xl font-semibold transition-colors backdrop-blur-sm"
            >
              See Live Demo <Phone className="h-4 w-4" />
            </Link>
          </div>
        </div>
      </section>
    </>
  );
}

export const VERTICAL_SLUGS = Object.keys(verticals);
