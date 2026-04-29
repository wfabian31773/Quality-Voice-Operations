import { useParams, Link } from 'react-router-dom';
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Phone, Clock, DollarSign, Users, CheckCircle2, ArrowRight,
  Stethoscope, Home, Scale, Wrench, Smile, BarChart3, Shield,
  Calendar, MessageSquare, TrendingUp, Star, Zap, Target,
  PawPrint, Car, Landmark, Hotel,
} from 'lucide-react';
import SEO from '../../components/SEO';
import RevealSection from '../../components/RevealSection';
import ROICalculator from '../../components/ROICalculator';
import { trackPageView, trackVerticalEngagement, trackCTAClick, trackConversionEvent, captureUtmOnLoad } from '../../lib/analytics';
import { CTA } from '../../lib/analyticsCtas';

interface VerticalData {
  slug: string;
  name: string;
  headline: string;
  subheadline: string;
  description: string;
  icon: typeof Phone;
  color: string;
  colorLight: string;
  heroImage: string;
  heroOverlayAccent: string;
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
    heroImage: '/industry-hero/healthcare.jpg',
    heroOverlayAccent: 'from-blue-500/20 to-primary/10',
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
    heroImage: '/industry-hero/real-estate.jpg',
    heroOverlayAccent: 'from-emerald-500/20 to-primary/10',
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
    heroImage: '/industry-hero/legal.jpg',
    heroOverlayAccent: 'from-amber-600/20 to-orange-500/10',
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
    heroImage: '/industry-hero/home-services.jpg',
    heroOverlayAccent: 'from-orange-500/20 to-amber-500/10',
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
    heroImage: '/industry-hero/dental.jpg',
    heroOverlayAccent: 'from-cyan-500/20 to-primary/10',
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
  veterinary: {
    slug: 'veterinary',
    name: 'Veterinary',
    headline: 'AI Voice Agents for Veterinary Clinics',
    subheadline: 'Book appointments, triage urgent pet care, and handle prescription refills 24/7 — so your team can focus on the animals in front of them.',
    description: 'QVO helps veterinary practices answer every call, schedule visits, and manage refills with friendly AI agents that pet owners actually love.',
    icon: PawPrint,
    color: 'bg-green-600',
    colorLight: 'bg-green-50',
    heroImage: '/industry-hero/veterinary.jpg',
    heroOverlayAccent: 'from-green-500/20 to-primary/10',
    painPoints: [
      { title: 'Front desk overload', description: 'Your team can\'t check in patients, answer calls, and run the lobby at the same time. Calls drop, owners get frustrated.' },
      { title: 'After-hours emergencies', description: 'Pet emergencies don\'t respect business hours. Without 24/7 triage, owners take their pets — and their loyalty — to the ER clinic.' },
      { title: 'Refill request backlog', description: 'Prescription refill calls eat hours of tech and DVM time every week. Most could be handled with simple structured intake.' },
      { title: 'No-show appointments', description: 'Forgotten visits cost the average clinic $80,000+/year. Manual reminder calls rarely happen consistently.' },
    ],
    agentExamples: [
      { name: 'Pet Appointment Agent', description: 'Books wellness exams, vaccines, and surgeries with real-time provider and exam-room availability.', capabilities: ['Provider matching', 'Multi-pet households', 'Reminder SMS', 'Pre-visit instructions'] },
      { name: 'After-Hours Triage Agent', description: 'Assesses pet symptoms, classifies urgency, and routes true emergencies to the on-call DVM or partner ER.', capabilities: ['Symptom triage', 'ER referral', 'Owner reassurance', 'Same-day booking'] },
      { name: 'Refill & Records Agent', description: 'Captures structured refill requests and routes to the right tech for DVM approval.', capabilities: ['Pharmacy lookup', 'Refill validation', 'DVM queue', 'PIMS integration'] },
    ],
    stats: [
      { value: '93%', label: 'Calls answered' },
      { value: '40%', label: 'Tech hours freed' },
      { value: '32%', label: 'No-show reduction' },
      { value: '24/7', label: 'Triage coverage' },
    ],
    testimonial: { quote: 'Our techs got their afternoons back. Refill calls and appointment booking just… handle themselves now, and our clients keep telling us the phone experience feels more personal, not less.', author: 'Dr. Amelia Park', role: 'Medical Director', company: 'Riverside Animal Hospital' },
    demoAgent: 'veterinary-scheduling',
    metaTitle: 'AI Voice Agents for Veterinary Clinics | QVO',
    metaDescription: 'Book pet appointments, triage emergencies, and handle prescription refills 24/7 with AI voice agents built for veterinary practices.',
  },
  automotive: {
    slug: 'automotive',
    name: 'Automotive',
    headline: 'AI Voice Agents for Auto Service & Dealerships',
    subheadline: 'Book service appointments, route sales leads, and follow up on RO updates — without your service writers getting buried in calls.',
    description: 'QVO helps dealerships and independent service centers turn every inbound call into a booked appointment, qualified lead, or satisfied customer.',
    icon: Car,
    color: 'bg-slate-700',
    colorLight: 'bg-slate-50',
    heroImage: '/industry-hero/automotive.jpg',
    heroOverlayAccent: 'from-slate-500/25 to-blue-500/10',
    painPoints: [
      { title: 'Service writers on hold', description: 'Writers juggle customers at the desk, vendor calls, and inbound bookings. Phone customers wait — or hang up.' },
      { title: 'Lost sales leads', description: 'Inbound sales calls outside showroom hours go to voicemail. Buyers move on to the next dealer in 10 minutes.' },
      { title: 'Repair order limbo', description: 'Customers call repeatedly for RO status updates because no one calls them back, tying up the service drive.' },
      { title: 'Manual reminder calls', description: 'Recall campaigns, state inspection reminders, and CSI follow-ups never happen at scale without automation.' },
    ],
    agentExamples: [
      { name: 'Service Booking Agent', description: 'Books oil changes, diagnostics, and major service with real-time bay and advisor availability.', capabilities: ['Service type routing', 'Loaner coordination', 'VIN/recall lookup', 'DMS integration'] },
      { name: 'Sales Lead Agent', description: 'Qualifies inbound buyers — vehicle interest, trade-in, financing — and books test drives 24/7.', capabilities: ['Trade-in capture', 'Financing pre-screen', 'Test drive booking', 'CRM handoff'] },
      { name: 'RO Status & CSI Agent', description: 'Proactively calls customers with repair updates and follows up post-service for reviews.', capabilities: ['RO status updates', 'Pickup coordination', 'Review requests', 'Recall outreach'] },
    ],
    stats: [
      { value: '4x', label: 'After-hours leads captured' },
      { value: '85%', label: 'Calls handled without writer' },
      { value: '+22 pts', label: 'CSI score lift' },
      { value: '< 1 min', label: 'Service booking time' },
    ],
    testimonial: { quote: 'We used to lose two or three deals a week to missed calls after 7 PM. QVO captures those leads, qualifies them, and the salesperson sees the full conversation in our CRM by morning.', author: 'Tony Alvarez', role: 'General Manager', company: 'Hillcrest Auto Group' },
    demoAgent: 'automotive-service',
    metaTitle: 'AI Voice Agents for Auto Dealers & Service Centers | QVO',
    metaDescription: 'Book service appointments, capture sales leads 24/7, and automate RO status updates with AI voice agents built for the automotive industry.',
  },
  finance: {
    slug: 'finance',
    name: 'Financial Services',
    headline: 'AI Voice Agents for Financial Services',
    subheadline: 'Qualify leads, book advisor consultations, and handle routine client inquiries — with the discretion and professionalism your industry expects.',
    description: 'QVO helps RIAs, wealth managers, and insurance agencies grow without adding headcount, while keeping every client interaction structured, auditable, and on-brand.',
    icon: Landmark,
    color: 'bg-indigo-700',
    colorLight: 'bg-indigo-50',
    heroImage: '/industry-hero/finance.jpg',
    heroOverlayAccent: 'from-indigo-500/25 to-blue-500/10',
    painPoints: [
      { title: 'Slow lead follow-up', description: 'Web-form leads grow cold within minutes. Most advisors don\'t call back same-day, costing high-value relationships.' },
      { title: 'Advisor calendar chaos', description: 'Advisors and assistants spend hours each week scheduling and rescheduling intro calls and reviews.' },
      { title: 'Inconsistent disclosures', description: 'When staff are rushed, required disclosures get skipped or worded differently every time, creating compliance review headaches.' },
      { title: 'Routine client questions', description: 'Statement questions, balance checks, and form requests crowd the line and pull staff off revenue work.' },
    ],
    agentExamples: [
      { name: 'Prospect Qualification Agent', description: 'Qualifies inbound prospects by investable assets, goals, and timeline using your firm-approved script and disclosures.', capabilities: ['Suitability questions', 'Firm-approved disclosures', 'Calendar booking', 'CRM enrichment'] },
      { name: 'Client Service Agent', description: 'Handles routine client requests — statement copies, address changes, beneficiary forms — and escalates anything sensitive.', capabilities: ['Identity verification', 'Form generation', 'Secure escalation', 'Audit logging'] },
      { name: 'Review Scheduler', description: 'Proactively books quarterly and annual reviews with each advisor\'s book of business.', capabilities: ['Book segmentation', 'Advisor availability', 'Confirmation flow', 'Re-book on cancel'] },
    ],
    stats: [
      { value: '< 60s', label: 'Lead response time' },
      { value: 'Every call', label: 'Disclosures captured' },
      { value: '12 hrs/wk', label: 'Per-advisor time saved' },
      { value: '2.4x', label: 'Review meetings booked' },
    ],
    testimonial: { quote: 'Every prospect now gets a polished, on-script intake within 60 seconds — even at 9 PM. Our advisors walk into discovery calls already knowing the relationship is qualified and disclosures are on file.', author: 'David Whitman, CFP®', role: 'Managing Principal', company: 'Whitman Wealth Advisors' },
    demoAgent: 'finance-prospect',
    metaTitle: 'AI Voice Agents for Financial Advisors & RIAs | QVO',
    metaDescription: 'Qualify prospects in under a minute, book advisor consultations, and handle routine client service calls with structured, auditable AI voice agents for financial services.',
  },
  hospitality: {
    slug: 'hospitality',
    name: 'Hospitality',
    headline: 'AI Voice Agents for Hotels & Restaurants',
    subheadline: 'Take reservations, answer guest questions, and handle requests in any language — 24/7, with the warmth your brand is known for.',
    description: 'QVO helps boutique hotels, restaurant groups, and resorts deliver consistent, multilingual phone experiences without overstaffing the front desk.',
    icon: Hotel,
    color: 'bg-amber-700',
    colorLight: 'bg-amber-50',
    heroImage: '/industry-hero/hospitality.jpg',
    heroOverlayAccent: 'from-amber-500/25 to-rose-500/10',
    painPoints: [
      { title: 'Front desk distractions', description: 'Phone calls pull staff away from in-person guests, hurting check-in experience and guest satisfaction scores.' },
      { title: 'Lost reservations', description: 'Guests calling at peak times hit hold music and book elsewhere. OTA fees eat the rest of your margin.' },
      { title: 'Language barriers', description: 'International guests get rerouted or hung up on. Your reviews mention it — and so do your competitors\'.' },
      { title: 'Repetitive requests', description: 'Wi-Fi passwords, parking, late checkout — the same 20 questions fill 70% of call volume every day.' },
    ],
    agentExamples: [
      { name: 'Reservation Agent', description: 'Books and modifies reservations directly in your PMS or restaurant booking system, in 30+ languages.', capabilities: ['PMS / OpenTable integration', 'Multilingual', 'Upsell prompts', 'Confirmation SMS'] },
      { name: 'Guest Concierge Agent', description: 'Answers FAQs, handles housekeeping requests, and routes anything sensitive to the right department.', capabilities: ['Property knowledge base', 'Request ticketing', 'Department routing', 'Loyalty lookup'] },
      { name: 'Post-Stay Follow-Up Agent', description: 'Calls guests post-stay for feedback and review requests, capturing issues before they hit public review sites.', capabilities: ['NPS surveys', 'Review prompts', 'Recovery escalation', 'Direct booking offers'] },
    ],
    stats: [
      { value: '30+', label: 'Languages supported' },
      { value: '38%', label: 'Direct bookings lift' },
      { value: '70%', label: 'FAQ calls deflected' },
      { value: '4.8/5', label: 'Guest call rating' },
    ],
    testimonial: { quote: 'Our concierge team finally has time for guests in the lobby. Phone reservations are up almost 40% and our French and Mandarin-speaking guests now get the same warm experience as everyone else.', author: 'Isabelle Moreau', role: 'General Manager', company: 'The Marlow Boutique Hotel' },
    demoAgent: 'hospitality-reservations',
    metaTitle: 'AI Voice Agents for Hotels & Restaurants | QVO',
    metaDescription: 'Take reservations, answer guest questions, and handle requests in 30+ languages with AI voice agents built for hospitality.',
  },
};

export default function VerticalLanding() {
  const { t } = useTranslation('marketing');
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
          <h1 className="text-2xl font-display font-bold text-text-primary mb-4">{t('vertical_page.not_found.title')}</h1>
          <p className="text-slate-600 mb-6">{t('vertical_page.not_found.subtitle')}</p>
          <Link to="/use-cases" className="text-primary hover:underline">{t('vertical_page.not_found.view_all')} &rarr;</Link>
        </div>
      </div>
    );
  }

  const Icon = data.icon;
  const verticalName = data.name;
  const verticalLower = data.name.toLowerCase();

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

      <section className="relative overflow-hidden">
        {/* Background photo */}
        <div className="absolute inset-0">
          <img
            src={data.heroImage}
            alt={`${data.name} workspace`}
            className="w-full h-full object-cover"
          />
          {/* Dark base for text contrast (left-weighted) */}
          <div className="absolute inset-0 bg-gradient-to-r from-sidebar-bg via-sidebar-bg/85 to-sidebar-bg/30 lg:to-sidebar-bg/10" />
          <div className="absolute inset-0 bg-gradient-to-t from-sidebar-bg/80 via-transparent to-sidebar-bg/40" />
          {/* Accent wash */}
          <div className={`absolute inset-0 bg-gradient-to-br opacity-70 mix-blend-soft-light ${data.heroOverlayAccent}`} />
        </div>

        <div className="relative max-w-7xl mx-auto px-6 lg:px-8 py-24 lg:py-32">
          <div className="grid lg:grid-cols-[1.1fr,1fr] gap-12 items-center">
            <div className="max-w-2xl">
              <div className="flex items-center gap-3 mb-6">
                <div className={`w-10 h-10 rounded-xl ${data.color} flex items-center justify-center shadow-lg`}>
                  <Icon className="h-5 w-5 text-white" />
                </div>
                <span className="text-sm font-medium text-primary uppercase tracking-[0.2em]">{data.name}</span>
              </div>
              <h1 className="text-4xl md:text-5xl lg:text-6xl font-display font-bold text-white leading-[1.05] mb-6">
                {data.headline}
              </h1>
              <p className="text-lg md:text-xl text-white/80 leading-relaxed mb-8">
                {data.subheadline}
              </p>
              <div className="flex flex-wrap gap-4">
                <Link
                  to="/signup"
                  onClick={() => { trackCTAClick(CTA.START_FREE_TRIAL, `industry-${data.slug}`, 'hero'); trackConversionEvent('cta_click', `/industries/${data.slug}`, { cta: 'signup' }); }}
                  className="btn-primary-glow inline-flex items-center gap-2 bg-primary hover:bg-primary-hover text-on-primary px-6 py-3 rounded-xl font-medium transition-colors duration-[var(--motion-base)] min-h-[44px]"
                >
                  {t('vertical_page.hero.start_trial')} <ArrowRight className="h-4 w-4" />
                </Link>
                <Link
                  to={`/demo?agent=${data.demoAgent}`}
                  onClick={() => { trackCTAClick(CTA.TRY_LIVE_DEMO, `industry-${data.slug}`, 'hero'); trackConversionEvent('demo_started', `/industries/${data.slug}`); }}
                  className="inline-flex items-center gap-2 bg-white/15 hover:bg-white/25 text-white px-6 py-3 rounded-xl font-medium transition-colors backdrop-blur-sm border border-white/20"
                >
                  {t('vertical_page.hero.try_demo')} <Phone className="h-4 w-4" />
                </Link>
              </div>
            </div>

            {/* Right-side floating stats card — desktop only */}
            <div className="hidden lg:flex justify-end">
              <div className="relative max-w-sm w-full">
                <div className="rounded-2xl bg-sidebar-bg/70 backdrop-blur-md border border-white/15 p-6 shadow-2xl">
                  <div className="flex items-center gap-2 mb-4">
                    <span className="w-2 h-2 rounded-full bg-success animate-pulse" />
                    <span className="text-[11px] font-semibold uppercase tracking-[0.15em] text-success">{t('vertical_page.card.live_performance')}</span>
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    {data.stats.slice(0, 4).map((stat) => (
                      <div key={stat.label}>
                        <p className="font-display text-2xl font-bold text-white leading-none">{stat.value}</p>
                        <p className="text-[11px] text-white/60 mt-1.5">{stat.label}</p>
                      </div>
                    ))}
                  </div>
                  <div className="mt-5 pt-4 border-t border-white/10 flex items-center gap-2 text-[11px] text-white/70">
                    <CheckCircle2 className="h-3.5 w-3.5 text-primary" />
                    {t('vertical_page.card.from_customers_in', { vertical: verticalLower })}
                  </div>
                </div>
                <div className="absolute -bottom-3 -left-3 rounded-xl bg-white shadow-xl border border-slate-100 p-3 flex items-center gap-2.5 max-w-[220px]">
                  <div className={`w-8 h-8 rounded-lg ${data.color} flex items-center justify-center shrink-0`}>
                    <Icon className="h-4 w-4 text-white" />
                  </div>
                  <div className="min-w-0">
                    <p className="text-[11px] font-semibold text-text-primary leading-tight">{t('vertical_page.card.pre_built_for', { vertical: verticalName })}</p>
                    <p className="text-[10px] text-slate-500 leading-tight mt-0.5">{t('vertical_page.card.deploy_minutes')}</p>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="py-12 bg-white border-b border-slate-100">
        <div className="max-w-7xl mx-auto px-6 lg:px-8">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-8">
            {data.stats.map((stat) => (
              <div key={stat.label} className="text-center">
                <div className="text-3xl md:text-4xl font-display font-bold text-text-primary">{stat.value}</div>
                <div className="text-sm text-slate-500 mt-1">{stat.label}</div>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="py-20 bg-surface-secondary">
        <div className="max-w-7xl mx-auto px-6 lg:px-8">
          <RevealSection>
            <div className="text-center mb-16">
              <h2 className="text-3xl md:text-4xl font-display font-bold text-text-primary mb-4">
                {t('vertical_page.problems.title')}
              </h2>
              <p className="text-lg text-slate-600 max-w-2xl mx-auto">
                {t('vertical_page.problems.subtitle', { vertical: verticalName })}
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
                      <h3 className="font-display font-semibold text-text-primary mb-2">{point.title}</h3>
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
              <h2 className="text-3xl md:text-4xl font-display font-bold text-text-primary mb-4">
                {t('vertical_page.agents.title', { vertical: verticalName })}
              </h2>
              <p className="text-lg text-slate-600 max-w-2xl mx-auto">
                {t('vertical_page.agents.subtitle', { vertical_lower: verticalLower })}
              </p>
            </div>
          </RevealSection>
          <div className="grid md:grid-cols-3 gap-8">
            {data.agentExamples.map((agent, idx) => (
              <RevealSection key={agent.name} delay={`delay-${idx * 150}`}>
                <div className="bg-surface-secondary rounded-2xl p-6 border border-slate-100 h-full flex flex-col">
                  <div className={`w-10 h-10 rounded-xl ${data.color} flex items-center justify-center mb-4`}>
                    <Zap className="h-5 w-5 text-white" />
                  </div>
                  <h3 className="font-display font-semibold text-text-primary text-lg mb-2">{agent.name}</h3>
                  <p className="text-sm text-slate-600 mb-4 flex-1">{agent.description}</p>
                  <ul className="space-y-2">
                    {agent.capabilities.map((cap) => (
                      <li key={cap} className="flex items-center gap-2 text-sm text-slate-700">
                        <CheckCircle2 className="h-4 w-4 text-primary shrink-0" />
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

      <section className="py-20 bg-surface-secondary">
        <div className="max-w-7xl mx-auto px-6 lg:px-8">
          <RevealSection>
            <div className="text-center mb-12">
              <h2 className="text-3xl md:text-4xl font-display font-bold text-text-primary mb-4">
                {t('vertical_page.roi.title')}
              </h2>
              <p className="text-lg text-slate-600 max-w-2xl mx-auto">
                {t('vertical_page.roi.subtitle', { vertical_lower: verticalLower })}
              </p>
            </div>
          </RevealSection>
          <ROICalculator vertical={data.slug} />
        </div>
      </section>

      <section className="py-20 bg-sidebar-bg">
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
              <h2 className="text-3xl md:text-4xl font-display font-bold text-text-primary mb-4">
                {t('vertical_page.why.title', { vertical: verticalName })}
              </h2>
            </div>
          </RevealSection>
          <div className="grid md:grid-cols-3 gap-8">
            {[
              { icon: Shield, title: t('vertical_page.why.industry_expertise_title'), desc: t('vertical_page.why.industry_expertise_desc', { vertical_lower: verticalLower }) },
              { icon: Clock, title: t('vertical_page.why.deploy_title'), desc: t('vertical_page.why.deploy_desc') },
              { icon: BarChart3, title: t('vertical_page.why.roi_title'), desc: t('vertical_page.why.roi_desc') },
            ].map((item, idx) => (
              <RevealSection key={item.title} delay={`delay-${idx * 150}`}>
                <div className="text-center">
                  <div className="w-12 h-12 rounded-2xl bg-primary/10 flex items-center justify-center mx-auto mb-4">
                    <item.icon className="h-6 w-6 text-primary" />
                  </div>
                  <h3 className="font-display font-semibold text-text-primary text-lg mb-2">{item.title}</h3>
                  <p className="text-sm text-slate-600 leading-relaxed">{item.desc}</p>
                </div>
              </RevealSection>
            ))}
          </div>
        </div>
      </section>

      <section className="py-20 bg-gradient-to-br from-primary to-primary-hover">
        <div className="max-w-4xl mx-auto px-6 lg:px-8 text-center">
          <h2 className="text-3xl md:text-4xl font-display font-bold text-white mb-4">
            {t('vertical_page.bottom_cta.title', { vertical: verticalName })}
          </h2>
          <p className="text-lg text-white/80 mb-8 max-w-2xl mx-auto">
            {t('vertical_page.bottom_cta.subtitle', { vertical_lower: verticalLower })}
          </p>
          <div className="flex flex-wrap justify-center gap-4">
            <Link
              to="/signup"
              onClick={() => { trackCTAClick(CTA.START_FREE_TRIAL, `industry-${data.slug}`, 'bottom-cta'); trackConversionEvent('cta_click', `/industries/${data.slug}`, { cta: 'signup_bottom' }); }}
              className="inline-flex items-center gap-2 bg-white text-primary hover:bg-white/90 px-8 py-3.5 rounded-xl font-semibold transition-colors"
            >
              {t('vertical_page.bottom_cta.start_trial')} <ArrowRight className="h-4 w-4" />
            </Link>
            <Link
              to={`/demo?agent=${data.demoAgent}`}
              onClick={() => trackCTAClick(CTA.TRY_LIVE_DEMO, `industry-${data.slug}`, 'bottom-cta')}
              className="inline-flex items-center gap-2 bg-white/20 hover:bg-white/30 text-white px-8 py-3.5 rounded-xl font-semibold transition-colors backdrop-blur-sm"
            >
              {t('vertical_page.bottom_cta.see_demo')} <Phone className="h-4 w-4" />
            </Link>
          </div>
        </div>
      </section>
    </>
  );
}

export const VERTICAL_SLUGS = Object.keys(verticals);
