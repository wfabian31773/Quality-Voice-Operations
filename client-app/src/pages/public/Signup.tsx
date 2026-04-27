import { useState, useEffect, useRef } from 'react';
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../../lib/auth';
import { api, setToken } from '../../lib/api';
import {
  UserPlus, ArrowRight, CheckCircle2, Loader2,
} from 'lucide-react';
import SEO from '../../components/SEO';
import { trackPageView, trackSignupConversion, trackCTAClick, trackConversionEvent, captureUtmOnLoad, getVisitorId } from '../../lib/analytics';
import { getPlanMonthlyPriceWholeDollars } from '../../../../shared/billing/planCatalog';

const TURNSTILE_SITE_KEY = (import.meta as Record<string, Record<string, string>>).env?.VITE_TURNSTILE_SITE_KEY || '';

export default function Signup() {
  const { t } = useTranslation();
  const [searchParams] = useSearchParams();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [orgName, setOrgName] = useState('');
  const [plan, setPlan] = useState(searchParams.get('plan') || 'starter');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [captchaToken, setCaptchaToken] = useState('');
  const captchaRef = useRef<HTMLDivElement>(null);
  const { user } = useAuth();
  const navigate = useNavigate();

  const plans = [
    { key: 'starter', name: t('auth.plan_starter'), price: getPlanMonthlyPriceWholeDollars('starter') },
    { key: 'pro', name: t('auth.plan_pro'), price: getPlanMonthlyPriceWholeDollars('pro'), popular: true },
    { key: 'enterprise', name: t('auth.plan_enterprise'), price: getPlanMonthlyPriceWholeDollars('enterprise') },
  ];

  const benefits = [
    t('auth.benefit_trial'),
    t('auth.benefit_no_card'),
    t('auth.benefit_templates'),
    t('auth.benefit_analytics'),
    t('auth.benefit_cancel'),
  ];

  useEffect(() => {
    trackPageView('/signup');
    captureUtmOnLoad();
    trackConversionEvent('signup_started', '/signup');
  }, []);

  useEffect(() => {
    if (!TURNSTILE_SITE_KEY || !captchaRef.current) return;

    const win = window as Record<string, unknown>;
    if (typeof win.turnstile !== 'undefined') {
      const turnstile = win.turnstile as { render: (el: HTMLElement, opts: Record<string, unknown>) => void };
      turnstile.render(captchaRef.current, {
        sitekey: TURNSTILE_SITE_KEY,
        callback: (token: string) => setCaptchaToken(token),
        'expired-callback': () => setCaptchaToken(''),
      });
      return;
    }

    const script = document.createElement('script');
    script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?onload=onTurnstileLoad';
    script.async = true;

    win.onTurnstileLoad = () => {
      if (captchaRef.current && typeof win.turnstile !== 'undefined') {
        const turnstile = win.turnstile as { render: (el: HTMLElement, opts: Record<string, unknown>) => void };
        turnstile.render(captchaRef.current, {
          sitekey: TURNSTILE_SITE_KEY,
          callback: (token: string) => setCaptchaToken(token),
          'expired-callback': () => setCaptchaToken(''),
        });
      }
    };

    document.head.appendChild(script);
    return () => {
      script.remove();
      delete win.onTurnstileLoad;
    };
  }, []);

  if (user) {
    return <Navigate to="/dashboard" replace />;
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (password.length < 8) {
      setError(t('auth.password_too_short'));
      return;
    }

    if (TURNSTILE_SITE_KEY && !captchaToken) {
      setError(t('auth.captcha_failed'));
      return;
    }

    setLoading(true);
    trackCTAClick('signup_submit', 'signup', plan);
    try {
      const res = await api.post<{ checkoutUrl: string; token: string; emailVerificationRequired?: boolean }>('/auth/signup', {
        name: orgName,
        email,
        password,
        plan,
        captchaToken: captchaToken || undefined,
        visitorId: getVisitorId(),
      });
      if (res.token) {
        setToken(res.token);
      }
      trackSignupConversion(plan, res.checkoutUrl ? 'checkout' : 'onboarding');
      trackConversionEvent('signup_completed', '/signup', { plan });
      if (res.checkoutUrl) {
        window.location.href = res.checkoutUrl;
      } else {
        navigate('/onboarding');
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : t('auth.signup_failed_retry'));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div>
      <SEO
        title="Sign Up — Start Your Free Trial"
        description="Create your QVO account and start your 7-day free trial. Set up AI voice agents for your business in minutes. No credit card required."
        canonicalPath="/signup"
      />
      <section className="bg-harbor text-white py-16 lg:py-20">
        <div className="max-w-7xl mx-auto px-6 lg:px-8">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-12 lg:gap-20 items-start">
            <div>
              <p className="text-teal font-display text-sm font-semibold tracking-wide uppercase mb-4">
                {t('auth.signup_eyebrow')}
              </p>
              <h1 className="font-display text-3xl lg:text-4xl font-bold leading-tight mb-6">
                {t('auth.signup_headline')}
              </h1>
              <p className="text-lg text-white/70 leading-relaxed mb-8 font-body">
                {t('auth.signup_subhead')}
              </p>
              <ul className="space-y-3 mb-8">
                {benefits.map((b) => (
                  <li key={b} className="flex items-center gap-2.5 text-sm text-white/80">
                    <CheckCircle2 className="h-4 w-4 text-teal shrink-0" />
                    {b}
                  </li>
                ))}
              </ul>
              <p className="text-sm text-white/50 font-body">
                {t('auth.signup_help')}{' '}
                <Link to="/pricing" className="text-teal hover:text-teal-hover underline underline-offset-2 transition-colors">
                  {t('auth.signup_compare')}
                </Link>
              </p>
            </div>

            <div className="bg-white rounded-2xl shadow-xl p-8">
              <div className="flex items-center gap-3 mb-6">
                <div className="w-10 h-10 rounded-xl bg-teal flex items-center justify-center">
                  <UserPlus className="h-5 w-5 text-white" />
                </div>
                <div>
                  <h2 className="font-display text-lg font-bold text-harbor">{t('auth.signup_card_title')}</h2>
                  <p className="text-xs text-slate-ink/60">{t('auth.signup_card_subtitle')}</p>
                </div>
              </div>

              <form onSubmit={handleSubmit} className="space-y-4">
                {error && (
                  <div className="bg-red-50 text-red-700 text-sm px-3 py-2 rounded-lg border border-red-200">
                    {error}
                  </div>
                )}

                <div>
                  <label className="block text-sm font-medium text-harbor mb-1.5">{t('auth.organization_name')}</label>
                  <input
                    type="text"
                    value={orgName}
                    onChange={(e) => setOrgName(e.target.value)}
                    required
                    className="w-full px-3.5 py-2.5 rounded-lg border border-steel/40 bg-white text-harbor text-sm focus:outline-none focus:ring-2 focus:ring-teal/30 focus:border-teal transition placeholder:text-soft-steel"
                    placeholder={t('auth.organization_name_placeholder')}
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-harbor mb-1.5">{t('auth.email')}</label>
                  <input
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    required
                    className="w-full px-3.5 py-2.5 rounded-lg border border-steel/40 bg-white text-harbor text-sm focus:outline-none focus:ring-2 focus:ring-teal/30 focus:border-teal transition placeholder:text-soft-steel"
                    placeholder={t('auth.email_placeholder')}
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-harbor mb-1.5">{t('auth.password')}</label>
                  <input
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                    minLength={8}
                    className="w-full px-3.5 py-2.5 rounded-lg border border-steel/40 bg-white text-harbor text-sm focus:outline-none focus:ring-2 focus:ring-teal/30 focus:border-teal transition placeholder:text-soft-steel"
                    placeholder={t('auth.password_min_8_placeholder')}
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-harbor mb-2">{t('auth.select_plan')}</label>
                  <div className="grid grid-cols-3 gap-2">
                    {plans.map((p) => (
                      <button
                        key={p.key}
                        type="button"
                        onClick={() => { setPlan(p.key); trackCTAClick('plan_selected', 'signup', p.key); }}
                        className={`relative px-3 py-3 rounded-lg border text-center transition-all ${
                          plan === p.key
                            ? 'border-teal bg-teal/5 ring-2 ring-teal/20'
                            : 'border-steel/30 hover:border-harbor/30'
                        }`}
                      >
                        {p.popular && (
                          <span className="absolute -top-2.5 left-1/2 -translate-x-1/2 text-[10px] font-bold bg-teal text-white px-2 py-0.5 rounded-full uppercase tracking-wider">
                            {t('auth.popular')}
                          </span>
                        )}
                        <span className="block text-sm font-semibold text-harbor">{p.name}</span>
                        <span className="block text-xs text-slate-ink/60 mt-0.5">${p.price}{t('auth.per_month_short')}</span>
                      </button>
                    ))}
                  </div>
                </div>

                {TURNSTILE_SITE_KEY && (
                  <div className="flex justify-center">
                    <div ref={captchaRef} />
                  </div>
                )}

                <button
                  type="submit"
                  disabled={loading}
                  className="w-full flex items-center justify-center gap-2 bg-teal hover:bg-teal-hover disabled:opacity-50 text-white font-semibold py-3 rounded-lg transition-colors text-sm mt-2"
                >
                  {loading ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <>
                      {t('auth.start_trial_button')}
                      <ArrowRight className="h-4 w-4" />
                    </>
                  )}
                </button>

                <p className="text-center text-[10px] text-slate-ink/40 mt-1">
                  {t('auth.verification_required')}
                </p>

                <p className="text-center text-xs text-slate-ink/50 mt-3">
                  {t('auth.have_account')}{' '}
                  <Link to="/login" className="text-teal hover:text-teal-hover font-medium transition-colors">
                    {t('auth.sign_in_link')}
                  </Link>
                </p>
              </form>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
