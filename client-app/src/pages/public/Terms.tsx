import { useEffect } from 'react';
import SEO from '../../components/SEO';
import { trackPageView } from '../../lib/analytics';

const sections = [
  { id: 'acceptance', title: '1. Acceptance of Terms', body: 'By accessing or using QVO ("Service"), you agree to be bound by these Terms of Service ("Terms"). If you do not agree, do not use the Service. These Terms apply to all users, including visitors, customers, and authorized users of customer accounts.' },
  { id: 'services', title: '2. Description of Services', body: 'QVO provides AI-powered voice and SMS automation, including inbound call handling, outbound campaigns, conversational agents, analytics, and related integrations. We may modify, suspend, or discontinue features at any time with reasonable notice.' },
  { id: 'accounts', title: '3. Accounts & Eligibility', body: 'You must be at least 18 years old and able to form a binding contract. You are responsible for safeguarding your credentials, all activity under your account, and ensuring your authorized users comply with these Terms.' },
  { id: 'payment', title: '4. Fees & Payment', body: 'Paid plans are billed monthly or annually in advance. Usage-based charges (e.g., minute overages, telephony pass-through) are billed in arrears. Fees are non-refundable except where required by law. We may change pricing with 30 days notice.' },
  { id: 'acceptable-use', title: '5. Acceptable Use', body: 'You will not use QVO for: (a) unlawful, fraudulent, or harassing communications; (b) spam, autodialer abuse, or violations of TCPA, TSR, CAN-SPAM, or GDPR; (c) reverse engineering or attempting to disrupt the Service; (d) processing PHI, payment card data, or other regulated data outside permitted configurations.' },
  { id: 'ip', title: '6. Intellectual Property', body: 'QVO and its licensors retain all rights, title, and interest in the Service, including all software, models, prompts, designs, and trademarks. Customer retains ownership of Customer Data and grants QVO a license to process it solely to provide the Service.' },
  { id: 'disclaimers', title: '7. Disclaimers', body: 'THE SERVICE IS PROVIDED "AS IS" AND "AS AVAILABLE" WITHOUT WARRANTIES OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, AND NON-INFRINGEMENT. AI outputs may contain errors and should be reviewed before relying on them for critical decisions.' },
  { id: 'liability', title: '8. Limitation of Liability', body: 'To the maximum extent permitted by law, QVO\'s aggregate liability for any claim arising out of or relating to the Service is limited to the fees paid by Customer in the 12 months preceding the event giving rise to the claim. QVO is not liable for indirect, incidental, special, consequential, or punitive damages.' },
  { id: 'termination', title: '9. Termination', body: 'Either party may terminate for material breach uncured after 30 days notice. We may suspend the Service immediately for security incidents, non-payment, or violations of acceptable use. Upon termination, Customer Data will be deleted within 30 days unless required to retain by law.' },
  { id: 'disputes', title: '10. Governing Law & Dispute Resolution', body: 'These Terms are governed by the laws of the State of Delaware, USA, without regard to conflict of laws. Disputes will be resolved by binding arbitration administered by JAMS in San Francisco, except either party may seek injunctive relief in court.' },
  { id: 'contact', title: '11. Contact', body: 'Questions about these Terms? Contact legal@qvo.example or write to: QVO Legal, [Address pending finalization].' },
];

export default function Terms() {
  useEffect(() => { trackPageView('/terms'); }, []);
  return (
    <div className="bg-white">
      <SEO title="Terms of Service — QVO" description="QVO Terms of Service governing use of the platform." canonicalPath="/terms" />
      <section className="bg-sidebar-bg text-white py-16">
        <div className="max-w-4xl mx-auto px-6 lg:px-8">
          <h1 className="font-display text-4xl font-bold mb-3">Terms of Service</h1>
          <p className="text-white/70 font-body">Last updated: {new Date().toISOString().slice(0, 10)}</p>
          <div className="mt-4 inline-block bg-accent/15 border border-accent/30 px-3 py-1.5 rounded-md text-xs text-accent font-medium">
            DRAFT — pending legal review
          </div>
        </div>
      </section>
      <section className="py-16">
        <div className="max-w-4xl mx-auto px-6 lg:px-8">
          <p className="text-text-primary/70 font-body mb-8 leading-relaxed">
            These Terms govern your use of QVO. Please read them carefully. By using the Service, you accept these Terms.
          </p>
          <div className="space-y-8">
            {sections.map((s) => (
              <div key={s.id} id={s.id}>
                <h2 className="font-display text-xl font-semibold text-text-primary mb-3">{s.title}</h2>
                <p className="text-sm text-text-primary/70 font-body leading-relaxed">{s.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>
    </div>
  );
}
