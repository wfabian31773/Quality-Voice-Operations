import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Mail, Phone, MapPin, CheckCircle2 } from 'lucide-react';
import SEO from '../../components/SEO';
import RevealSection from '../../components/RevealSection';

export default function Contact() {
  const { t } = useTranslation('marketing');
  const [submitted, setSubmitted] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [form, setForm] = useState({ name: '', email: '', company: '', message: '' });

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setSubmitting(true);
    try {
      const res = await fetch('/api/contact', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || t('contact.form.send_default_error'));
      }
      setSubmitted(true);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : t('contact.form.send_fallback_error'));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div>
      <SEO
        title={t('contact.seo_title')}
        description={t('contact.seo_description')}
        canonicalPath="/contact"
      />
      {/*
        Contact hero — flat dark band placeholder. Wayne's bespoke
        Higgsfield render slots in here later (drop file at
        /hero/contact-hero.{webp,mp4} and add a <picture>/<video> above
        the gradient layer). Until then:
          - radial-gradient backdrop at 50% 50% (centered glow — only
            page that uses dead-center; reads as "you reached us"
            symmetry on the talk-to-us page)
          - oversize tracking-tight headline (text-6xl @ lg)
          - explicit text-white on h1 — defensive against the QVO base
            reset h1 color rule that renders headlines invisible on dark
            surfaces (same bug we fixed on /demo, /pricing, /features)
        py-16 lg:py-24 (was py-20 lg:py-28) — tighter density now that
        there's no image to support the larger padding.
      */}
      <section className="relative overflow-hidden bg-sidebar-bg text-white py-16 lg:py-24">
        <div
          aria-hidden
          className="absolute inset-0 pointer-events-none"
          style={{
            background:
              'radial-gradient(ellipse 70% 60% at 50% 50%, rgba(46,140,131,0.20), transparent 70%)',
          }}
        />
        <div className="relative max-w-7xl mx-auto px-6 lg:px-8">
          <div className="max-w-3xl">
            <p className="text-primary font-display text-sm font-semibold tracking-wide uppercase mb-4">
              {t('contact.hero.eyebrow')}
            </p>
            <h1 className="font-display text-white text-4xl lg:text-6xl font-bold leading-tight tracking-tight mb-6">
              {t('contact.hero.title')}
            </h1>
            <p className="text-lg text-white/70 leading-relaxed font-body max-w-2xl">
              {t('contact.hero.description')}
            </p>
          </div>
        </div>
      </section>

      <section className="py-20 lg:py-28">
        <div className="max-w-7xl mx-auto px-6 lg:px-8">
          <RevealSection>
          <div className="grid lg:grid-cols-5 gap-12">
            <div className="lg:col-span-3">
              {submitted ? (
                <div className="bg-surface rounded-2xl border border-border/50 p-12 text-center">
                  <div className="w-14 h-14 rounded-2xl bg-success/10 flex items-center justify-center mx-auto mb-6">
                    <CheckCircle2 className="h-7 w-7 text-success" />
                  </div>
                  <h2 className="font-display text-2xl font-bold text-text-primary mb-3">
                    {t('contact.form.submitted_title')}
                  </h2>
                  <p className="text-text-secondary font-body">
                    {t('contact.form.submitted_desc')}
                  </p>
                </div>
              ) : (
                <form onSubmit={handleSubmit} className="bg-surface rounded-2xl border border-border/50 p-8 lg:p-10">
                  <h2 className="font-display text-xl font-bold text-text-primary mb-6">
                    {t('contact.form.title')}
                  </h2>
                  <div className="space-y-5">
                    <div className="grid md:grid-cols-2 gap-5">
                      <div>
                        <label htmlFor="contact-name" className="block text-sm font-medium font-body text-text-primary mb-1.5">{t('contact.form.name_label')}</label>
                        <input
                          id="contact-name"
                          type="text"
                          required
                          value={form.name}
                          onChange={(e) => setForm({ ...form, name: e.target.value })}
                          className="w-full px-4 py-2.5 rounded-lg border border-border bg-surface text-text-primary text-sm font-body focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary transition"
                          placeholder={t('contact.form.name_placeholder')}
                        />
                      </div>
                      <div>
                        <label htmlFor="contact-email" className="block text-sm font-medium font-body text-text-primary mb-1.5">{t('contact.form.email_label')}</label>
                        <input
                          id="contact-email"
                          type="email"
                          required
                          value={form.email}
                          onChange={(e) => setForm({ ...form, email: e.target.value })}
                          className="w-full px-4 py-2.5 rounded-lg border border-border bg-surface text-text-primary text-sm font-body focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary transition"
                          placeholder={t('contact.form.email_placeholder')}
                        />
                      </div>
                    </div>
                    <div>
                      <label htmlFor="contact-company" className="block text-sm font-medium font-body text-text-primary mb-1.5">{t('contact.form.company_label')}</label>
                      <input
                        id="contact-company"
                        type="text"
                        value={form.company}
                        onChange={(e) => setForm({ ...form, company: e.target.value })}
                        className="w-full px-4 py-2.5 rounded-lg border border-border bg-surface text-text-primary text-sm font-body focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary transition"
                        placeholder={t('contact.form.company_placeholder')}
                      />
                    </div>
                    <div>
                      <label htmlFor="contact-message" className="block text-sm font-medium font-body text-text-primary mb-1.5">{t('contact.form.message_label')}</label>
                      <textarea
                        id="contact-message"
                        required
                        rows={5}
                        value={form.message}
                        onChange={(e) => setForm({ ...form, message: e.target.value })}
                        className="w-full px-4 py-2.5 rounded-lg border border-border bg-surface text-text-primary text-sm font-body focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary transition resize-none"
                        placeholder={t('contact.form.message_placeholder')}
                      />
                    </div>
                    {error && (
                      <div className="bg-danger/10 border border-danger/20 text-danger text-sm px-4 py-3 rounded-lg font-body">
                        {error}
                      </div>
                    )}
                    <button
                      type="submit"
                      disabled={submitting}
                      className="bg-primary hover:bg-primary-hover text-white font-semibold py-3 px-6 rounded-lg text-sm transition-colors disabled:opacity-50"
                    >
                      {submitting ? t('common.sending') : t('common.send_message')}
                    </button>
                  </div>
                </form>
              )}
            </div>

            <div className="lg:col-span-2 space-y-6">
              <div className="bg-surface rounded-2xl border border-border/50 p-7">
                <div className="flex items-center gap-3 mb-3">
                  <div className="w-9 h-9 rounded-lg bg-primary/10 flex items-center justify-center">
                    <Mail className="h-4.5 w-4.5 text-primary" />
                  </div>
                  <h3 className="font-display text-sm font-semibold text-text-primary">{t('contact.info.email_label')}</h3>
                </div>
                <p className="text-sm text-text-secondary font-body">{t('contact.info.email_value')}</p>
              </div>

              <div className="bg-surface rounded-2xl border border-border/50 p-7">
                <div className="flex items-center gap-3 mb-3">
                  <div className="w-9 h-9 rounded-lg bg-primary/10 flex items-center justify-center">
                    <Phone className="h-4.5 w-4.5 text-primary" />
                  </div>
                  <h3 className="font-display text-sm font-semibold text-text-primary">{t('contact.info.phone_label')}</h3>
                </div>
                <p className="text-sm text-text-secondary font-body">{t('contact.info.phone_value')}</p>
              </div>

              <div className="bg-surface rounded-2xl border border-border/50 p-7">
                <div className="flex items-center gap-3 mb-3">
                  <div className="w-9 h-9 rounded-lg bg-primary/10 flex items-center justify-center">
                    <MapPin className="h-4.5 w-4.5 text-primary" />
                  </div>
                  <h3 className="font-display text-sm font-semibold text-text-primary">{t('contact.info.location_label')}</h3>
                </div>
                <p className="text-sm text-text-secondary font-body">{t('contact.info.location_value')}</p>
              </div>

              <div className="bg-info-light rounded-2xl p-7">
                <h3 className="font-display text-sm font-semibold text-text-primary mb-2">{t('contact.info.customer_label')}</h3>
                <p className="text-sm text-text-secondary font-body">
                  {t('contact.info.customer_value')}
                </p>
              </div>
            </div>
          </div>
          </RevealSection>
        </div>
      </section>
    </div>
  );
}
