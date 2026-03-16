import { useState } from 'react';
import { Mail, Phone, MapPin, CheckCircle2 } from 'lucide-react';

export default function Contact() {
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
        throw new Error(data.error || 'Failed to send message');
      }
      setSubmitted(true);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to send message. Please try emailing us directly.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div>
      <section className="bg-harbor text-white py-20 lg:py-28">
        <div className="max-w-7xl mx-auto px-6 lg:px-8">
          <div className="max-w-3xl">
            <p className="text-teal font-display text-sm font-semibold tracking-wide uppercase mb-4">
              Contact
            </p>
            <h1 className="font-display text-4xl lg:text-5xl font-bold leading-tight mb-6">
              Let's talk about your voice operations.
            </h1>
            <p className="text-lg text-white/70 leading-relaxed font-body max-w-2xl">
              Whether you're evaluating QVO for your practice or need help with an existing account, our team is here.
            </p>
          </div>
        </div>
      </section>

      <section className="py-20 lg:py-28">
        <div className="max-w-7xl mx-auto px-6 lg:px-8">
          <div className="grid lg:grid-cols-5 gap-12">
            <div className="lg:col-span-3">
              {submitted ? (
                <div className="bg-white rounded-2xl border border-soft-steel/50 p-12 text-center">
                  <div className="w-14 h-14 rounded-2xl bg-calm-green/10 flex items-center justify-center mx-auto mb-6">
                    <CheckCircle2 className="h-7 w-7 text-calm-green" />
                  </div>
                  <h2 className="font-display text-2xl font-bold text-harbor mb-3">Message received.</h2>
                  <p className="text-slate-ink/60 font-body">
                    We'll get back to you within one business day. If your request is urgent, call us directly.
                  </p>
                </div>
              ) : (
                <form onSubmit={handleSubmit} className="bg-white rounded-2xl border border-soft-steel/50 p-8 lg:p-10">
                  <h2 className="font-display text-xl font-bold text-harbor mb-6">Send us a message</h2>
                  <div className="space-y-5">
                    <div className="grid md:grid-cols-2 gap-5">
                      <div>
                        <label className="block text-sm font-medium font-body text-harbor mb-1.5">Full name</label>
                        <input
                          type="text"
                          required
                          value={form.name}
                          onChange={(e) => setForm({ ...form, name: e.target.value })}
                          className="w-full px-4 py-2.5 rounded-lg border border-soft-steel bg-white text-slate-ink text-sm font-body focus:outline-none focus:ring-2 focus:ring-teal/30 focus:border-teal transition"
                          placeholder="Jane Smith"
                        />
                      </div>
                      <div>
                        <label className="block text-sm font-medium font-body text-harbor mb-1.5">Email</label>
                        <input
                          type="email"
                          required
                          value={form.email}
                          onChange={(e) => setForm({ ...form, email: e.target.value })}
                          className="w-full px-4 py-2.5 rounded-lg border border-soft-steel bg-white text-slate-ink text-sm font-body focus:outline-none focus:ring-2 focus:ring-teal/30 focus:border-teal transition"
                          placeholder="jane@practice.com"
                        />
                      </div>
                    </div>
                    <div>
                      <label className="block text-sm font-medium font-body text-harbor mb-1.5">Company or practice name</label>
                      <input
                        type="text"
                        value={form.company}
                        onChange={(e) => setForm({ ...form, company: e.target.value })}
                        className="w-full px-4 py-2.5 rounded-lg border border-soft-steel bg-white text-slate-ink text-sm font-body focus:outline-none focus:ring-2 focus:ring-teal/30 focus:border-teal transition"
                        placeholder="Bright Smiles Dental"
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium font-body text-harbor mb-1.5">How can we help?</label>
                      <textarea
                        required
                        rows={5}
                        value={form.message}
                        onChange={(e) => setForm({ ...form, message: e.target.value })}
                        className="w-full px-4 py-2.5 rounded-lg border border-soft-steel bg-white text-slate-ink text-sm font-body focus:outline-none focus:ring-2 focus:ring-teal/30 focus:border-teal transition resize-none"
                        placeholder="Tell us about your call volume, current setup, and what you'd like to improve."
                      />
                    </div>
                    {error && (
                      <div className="bg-controlled-red/10 border border-controlled-red/20 text-controlled-red text-sm px-4 py-3 rounded-lg font-body">
                        {error}
                      </div>
                    )}
                    <button
                      type="submit"
                      disabled={submitting}
                      className="bg-teal hover:bg-teal-hover text-white font-semibold py-3 px-6 rounded-lg text-sm transition-colors disabled:opacity-50"
                    >
                      {submitting ? 'Sending...' : 'Send message'}
                    </button>
                  </div>
                </form>
              )}
            </div>

            <div className="lg:col-span-2 space-y-6">
              <div className="bg-white rounded-2xl border border-soft-steel/50 p-7">
                <div className="flex items-center gap-3 mb-3">
                  <div className="w-9 h-9 rounded-lg bg-teal/10 flex items-center justify-center">
                    <Mail className="h-4.5 w-4.5 text-teal" />
                  </div>
                  <h3 className="font-display text-sm font-semibold text-harbor">Email</h3>
                </div>
                <p className="text-sm text-slate-ink/60 font-body">hello@qualityvoiceops.com</p>
              </div>

              <div className="bg-white rounded-2xl border border-soft-steel/50 p-7">
                <div className="flex items-center gap-3 mb-3">
                  <div className="w-9 h-9 rounded-lg bg-teal/10 flex items-center justify-center">
                    <Phone className="h-4.5 w-4.5 text-teal" />
                  </div>
                  <h3 className="font-display text-sm font-semibold text-harbor">Phone</h3>
                </div>
                <p className="text-sm text-slate-ink/60 font-body">Available during business hours</p>
              </div>

              <div className="bg-white rounded-2xl border border-soft-steel/50 p-7">
                <div className="flex items-center gap-3 mb-3">
                  <div className="w-9 h-9 rounded-lg bg-teal/10 flex items-center justify-center">
                    <MapPin className="h-4.5 w-4.5 text-teal" />
                  </div>
                  <h3 className="font-display text-sm font-semibold text-harbor">Location</h3>
                </div>
                <p className="text-sm text-slate-ink/60 font-body">Remote-first. Serving businesses across the US.</p>
              </div>

              <div className="bg-frost-blue rounded-2xl p-7">
                <h3 className="font-display text-sm font-semibold text-harbor mb-2">Already a customer?</h3>
                <p className="text-sm text-slate-ink/60 font-body">
                  Sign in to your dashboard for account support, or email our support team directly.
                </p>
              </div>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
