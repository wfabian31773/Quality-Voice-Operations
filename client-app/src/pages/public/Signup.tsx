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
import { SIGNUP_STEP, CONVERSION_STAGE } from '../../lib/analyticsLabels';
import { CTA } from '../../lib/analyticsCtas';
import { getPlanMonthlyPriceWholeDollars } from '../../../../shared/billing/planCatalog';
import { ANNUAL_DISCOUNT, type BillingPeriod } from '../../components/MinutesPricingCalculator';
import { formatDollars } from '../../lib/formatCurrency';

const TURNSTILE_SITE_KEY = ((import.meta as unknown as { env?: Record<string, string | undefined> }).env?.VITE_TURNSTILE_SITE_KEY) || '';

export default function Signup() {
  const { t } = useTranslation(['common', 'marketing']);
  const [searchParams] = useSearchParams();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [orgName, setOrgName] = useState('');
  const [plan, setPlan] = useState(searchParams.get('plan') || 'starter');
  const initialInterval: BillingPeriod = searchParams.get('interval') === 'annual' ? 'annual' : 'monthly';
  const [interval, setInterval] = useState<BillingPeriod>(initialInterval);
  const isAnnual = interval === 'annual';
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [captchaToken, setCaptchaToken] = useState('');
  const captchaRef = useRef<HTMLDivElement>(null);
  const { user } = useAuth();
  const navigate = useNavigate();

  const computePrice = (tier: 'starter' | 'pro' | 'enterprise') => {
    const monthly = getPlanMonthlyPriceWholeDollars(tier);
    return isAnnual ? Math.round(monthly * (1 - ANNUAL_DISCOUNT)) : monthly;
  };

  // Annual savings = the dollar gap between displayed monthly and discounted
  // annual-monthly prices, projected over a year. Mirrors the same math the
  // /pricing tier cards use so the two pages stay consistent.
  const computeAnnualSavings = (tier: 'starter' | 'pro' | 'enterprise') => {
    const monthly = getPlanMonthlyPriceWholeDollars(tier);
    const annualMonthly = Math.round(monthly * (1 - ANNUAL_DISCOUNT));
    return (monthly - annualMonthly) * 12;
  };

  const plans = [
    { key: 'starter', name: t('auth.plan_starter'), price: computePrice('starter'), annualSavings: computeAnnualSavings('starter') },
    { key: 'pro', name: t('auth.plan_pro'), price: computePrice('pro'), popular: true, annualSavings: computeAnnualSavings('pro') },
    { key: 'enterprise', name: t('auth.plan_enterprise'), price: computePrice('enterprise'), annualSavings: computeAnnualSavings('enterprise') },
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
    trackConversionEvent(CONVERSION_STAGE.SIGNUP_STARTED, '/signup');
  }, []);

  useEffect(() => {
    if (!TURNSTILE_SITE_KEY || !captchaRef.current) return;

    const win = window as unknown as Record<string, unknown>;
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
    trackCTAClick(CTA.SIGNUP_SUBMIT, 'signup', plan);
    try {
      const res = await api.post<{ checkoutUrl: string; token: string; emailVerificationRequired?: boolean }>('/auth/signup', {
        name: orgName,
        email,
        password,
        plan,
        interval,
        captchaToken: captchaToken || undefined,
        visitorId: getVisitorId(),
      });
      if (res.token) {
        setToken(res.token);
      }
      trackSignupConversion(plan, res.checkoutUrl ? SIGNUP_STEP.CHECKOUT : SIGNUP_STEP.ONBOARDING);
      trackConversionEvent(CONVERSION_STAGE.SIGNUP_COMPLETED, '/signup', { plan, interval });
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
      <section className="bg-sidebar-bg text-white py-16 lg:py-20">
        <div className="max-w-7xl mx-auto px-6 lg:px-8">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-12 lg:gap-20 items-start">
            <div>
              <p className="text-primary font-display text-sm font-semibold tracking-wide uppercase mb-4">
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
                    <CheckCircle2 className="h-4 w-4 text-primary shrink-0" />
                    {b}
                  </li>
                ))}
              </ul>
              <p className="text-sm text-white/50 font-body">
                {t('auth.signup_help')}{' '}
                <Link to="/pricing" className="text-primary hover:text-primary-hover underline underline-offset-2 transition-colors">
                  {t('auth.signup_compare')}
                </Link>
              </p>
            </div>

            <div className="bg-surface rounded-2xl shadow-xl p-8">
              <div className="flex items-center gap-3 mb-6">
                <div className="w-10 h-10 rounded-xl bg-primary flex items-center justify-center">
                  <UserPlus className="h-5 w-5 text-white" />
                </div>
                <div>
                  <h2 className="font-display text-lg font-bold text-text-primary">{t('auth.signup_card_title')}</h2>
                  <p className="text-xs text-text-primary/60">{t('auth.signup_card_subtitle')}</p>
                </div>
              </div>

              <form onSubmit={handleSubmit} className="space-y-4">
                {error && (
                  <div className="bg-red-50 dark:bg-red-500/15 text-red-700 dark:text-red-300 text-sm px-3 py-2 rounded-lg border border-red-200 dark:border-red-500/30">
                    {error}
                  </div>
                )}

                <div>
                  <label htmlFor="signup-org-name" className="block text-sm font-medium text-text-primary mb-1.5">{t('auth.organization_name')}</label>
                  <input
                    id="signup-org-name"
                    type="text"
                    value={orgName}
                    onChange={(e) => setOrgName(e.target.value)}
                    required
                    className="w-full px-3.5 py-2.5 rounded-lg border border-border bg-surface text-text-primary text-sm focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary transition placeholder:text-text-muted"
                    placeholder={t('auth.organization_name_placeholder')}
                  />
                </div>

                <div>
                  <label htmlFor="signup-email" className="block text-sm font-medium text-text-primary mb-1.5">{t('auth.email')}</label>
                  <input
                    id="signup-email"
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    required
                    className="w-full px-3.5 py-2.5 rounded-lg border border-border bg-surface text-text-primary text-sm focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary transition placeholder:text-text-muted"
                    placeholder={t('auth.email_placeholder')}
                  />
                </div>

                <div>
                  <label htmlFor="signup-password" className="block text-sm font-medium text-text-primary mb-1.5">{t('auth.password')}</label>
                  <input
                    id="signup-password"
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                    minLength={8}
                    className="w-full px-3.5 py-2.5 rounded-lg border border-border bg-surface text-text-primary text-sm focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary transition placeholder:text-text-muted"
                    placeholder={t('auth.password_min_8_placeholder')}
                  />
                </div>

                <div>
                  <div className="flex items-center justify-between mb-2 gap-2">
                    <span id="signup-plan-label" className="block text-sm font-medium text-text-primary">{t('auth.select_plan')}</span>
                    <div
                      role="group"
                      aria-label="Billing period"
                      data-testid="signup-billing-toggle"
                      className="inline-flex items-center bg-surface-secondary border border-border rounded-md p-0.5 text-[11px]"
                    >
                      <button
                        type="button"
                        data-testid="signup-billing-monthly"
                        aria-pressed={!isAnnual}
                        onClick={() => setInterval('monthly')}
                        className={`px-2.5 py-1 rounded font-display font-semibold transition-colors ${
                          !isAnnual
                            ? 'bg-primary text-white shadow-sm'
                            : 'text-text-primary/70 hover:text-text-primary'
                        }`}
                      >
                        {t('auth.billing_monthly')}
                      </button>
                      <button
                        type="button"
                        data-testid="signup-billing-annual"
                        aria-pressed={isAnnual}
                        onClick={() => setInterval('annual')}
                        className={`px-2.5 py-1 rounded font-display font-semibold transition-colors inline-flex items-center gap-1 ${
                          isAnnual
                            ? 'bg-primary text-white shadow-sm'
                            : 'text-text-primary/70 hover:text-text-primary'
                        }`}
                      >
                        {t('auth.billing_annual')}
                        <span
                          className={`text-[9px] font-semibold px-1 py-0.5 rounded-full ${
                            isAnnual ? 'bg-white/20 dark:bg-white/20 text-white' : 'bg-success/10 text-success'
                          }`}
                        >
                          −20%
                        </span>
                      </button>
                    </div>
                  </div>
                  <div role="group" aria-labelledby="signup-plan-label" className="grid grid-cols-3 gap-2">
                    {plans.map((p) => {
                      const annualSavingsFormatted = formatDollars(p.annualSavings, {
                        minimumFractionDigits: 0,
                        maximumFractionDigits: 0,
                      });
                      return (
                        <button
                          key={p.key}
                          type="button"
                          data-testid={`signup-plan-${p.key}`}
                          onClick={() => { setPlan(p.key); trackCTAClick(CTA.PLAN_SELECTED, 'signup', `${p.key}_${interval}`); }}
                          className={`relative px-3 py-3 rounded-lg border text-center transition-all ${
                            plan === p.key
                              ? 'border-primary bg-primary/5 ring-2 ring-primary/20'
                              : 'border-border hover:border-sidebar-bg/30'
                          }`}
                        >
                          {p.popular && (
                            <span className="absolute -top-2.5 left-1/2 -translate-x-1/2 text-[10px] font-bold bg-primary text-white px-2 py-0.5 rounded-full uppercase tracking-wider">
                              {t('auth.popular')}
                            </span>
                          )}
                          <span className="block text-sm font-semibold text-text-primary">{p.name}</span>
                          <span className="block text-xs text-text-primary/60 mt-0.5">${p.price}{t('auth.per_month_short')}</span>
                          {isAnnual && (
                            <>
                              <span
                                data-testid={`signup-plan-${p.key}-save-badge`}
                                aria-label={t('marketing:pricing.tier_card.save_badge_aria', { percent: Math.round(ANNUAL_DISCOUNT * 100) })}
                                className="inline-block mt-1 text-[9px] font-semibold bg-success/10 text-success px-1.5 py-0.5 rounded-full uppercase tracking-wide"
                              >
                                {t('marketing:pricing.tier_card.save_badge', { percent: Math.round(ANNUAL_DISCOUNT * 100) })}
                              </span>
                              <span
                                data-testid={`signup-plan-${p.key}-save-amount`}
                                aria-label={t('marketing:pricing.tier_card.save_amount_aria', { amount: annualSavingsFormatted })}
                                className="block mt-1 text-[10px] font-semibold text-success"
                              >
                                {t('marketing:pricing.tier_card.save_amount', { amount: annualSavingsFormatted })}
                              </span>
                            </>
                          )}
                        </button>
                      );
                    })}
                  </div>
                  <p className="mt-2 text-[11px] text-text-primary/50 font-body" data-testid="signup-billing-note">
                    {isAnnual ? t('auth.billing_annual_note') : t('auth.billing_monthly_note')}
                  </p>
                </div>

                {TURNSTILE_SITE_KEY && (
                  <div className="flex justify-center">
                    <div ref={captchaRef} />
                  </div>
                )}

                <button
                  type="submit"
                  disabled={loading}
                  className="w-full flex items-center justify-center gap-2 bg-primary hover:bg-primary-hover disabled:opacity-50 text-white font-semibold py-3 rounded-lg transition-colors text-sm mt-2"
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

                <p className="text-center text-[10px] text-text-primary/40 mt-1">
                  {t('auth.verification_required')}
                </p>

                <p className="text-center text-xs text-text-primary/50 mt-3">
                  {t('auth.have_account')}{' '}
                  <Link to="/login" className="text-primary hover:text-primary-hover font-medium transition-colors">
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
