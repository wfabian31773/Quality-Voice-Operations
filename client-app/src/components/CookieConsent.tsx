import { useEffect, useState } from 'react';
import { X, Cookie } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

const STORAGE_KEY = 'qvo-cookie-consent-v1';

interface ConsentState {
  essential: true;
  analytics: boolean;
  marketing: boolean;
  decided: boolean;
  decidedAt: string;
}

function readConsent(): ConsentState | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as ConsentState;
  } catch {
    return null;
  }
}

function writeConsent(state: Partial<ConsentState>) {
  const final: ConsentState = {
    essential: true,
    analytics: state.analytics ?? false,
    marketing: state.marketing ?? false,
    decided: true,
    decidedAt: new Date().toISOString(),
  };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(final));
  } catch {
    /* ignore */
  }
}

export default function CookieConsent() {
  const { t } = useTranslation();
  const [visible, setVisible] = useState(false);
  const [showCustomize, setShowCustomize] = useState(false);
  const [analytics, setAnalytics] = useState(false);
  const [marketing, setMarketing] = useState(false);

  useEffect(() => {
    const dnt =
      typeof navigator !== 'undefined' &&
      ((navigator as Navigator & { doNotTrack?: string }).doNotTrack === '1' ||
        (window as Window & { doNotTrack?: string }).doNotTrack === '1');

    const existing = readConsent();
    if (existing?.decided) return;
    if (dnt) {
      // Honor DNT: persist a reject decision silently.
      writeConsent({ analytics: false, marketing: false });
      return;
    }
    setVisible(true);
  }, []);

  if (!visible) return null;

  const acceptAll = () => {
    writeConsent({ analytics: true, marketing: true });
    setVisible(false);
  };
  const rejectAll = () => {
    writeConsent({ analytics: false, marketing: false });
    setVisible(false);
  };
  const saveCustom = () => {
    writeConsent({ analytics, marketing });
    setVisible(false);
  };

  return (
    <div className="fixed bottom-4 left-4 right-4 md:left-auto md:right-6 md:max-w-sm z-toast">
      <div className="bg-surface rounded-2xl shadow-2xl border border-border overflow-hidden">
        <div className="p-5">
          <div className="flex items-start justify-between mb-3">
            <div className="flex items-center gap-2">
              <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center">
                <Cookie className="h-4 w-4 text-primary" />
              </div>
              <h3 className="font-display text-sm font-semibold text-text-primary">{t('cookie_consent.title')}</h3>
            </div>
            <button
              onClick={rejectAll}
              className="text-text-secondary hover:text-text-primary"
              aria-label={t('cookie_consent.dismiss_aria')}
            >
              <X className="h-4 w-4" />
            </button>
          </div>
          <p className="text-xs text-text-secondary font-body leading-relaxed mb-4">
            {t('cookie_consent.message')}{' '}
            {t('cookie_consent.see_policy')}{' '}
            <Link to="/privacy" className="text-primary hover:underline">{t('cookie_consent.privacy_policy_link')}</Link>.
          </p>

          {showCustomize && (
            <div className="space-y-2.5 mb-4 pb-4 border-b border-border">
              <label className="flex items-start gap-2.5 cursor-not-allowed opacity-70">
                <input type="checkbox" checked disabled className="mt-1" />
                <div>
                  <div className="text-xs font-medium text-text-primary">{t('cookie_consent.essential_label')}</div>
                  <div className="text-[11px] text-text-secondary">{t('cookie_consent.essential_desc')}</div>
                </div>
              </label>
              <label className="flex items-start gap-2.5 cursor-pointer">
                <input
                  type="checkbox"
                  checked={analytics}
                  onChange={(e) => setAnalytics(e.target.checked)}
                  className="mt-1"
                />
                <div>
                  <div className="text-xs font-medium text-text-primary">{t('cookie_consent.analytics_label')}</div>
                  <div className="text-[11px] text-text-secondary">{t('cookie_consent.analytics_desc')}</div>
                </div>
              </label>
              <label className="flex items-start gap-2.5 cursor-pointer">
                <input
                  type="checkbox"
                  checked={marketing}
                  onChange={(e) => setMarketing(e.target.checked)}
                  className="mt-1"
                />
                <div>
                  <div className="text-xs font-medium text-text-primary">{t('cookie_consent.marketing_label')}</div>
                  <div className="text-[11px] text-text-secondary">{t('cookie_consent.marketing_desc')}</div>
                </div>
              </label>
            </div>
          )}

          <div className="flex flex-wrap gap-2">
            {showCustomize ? (
              <button
                onClick={saveCustom}
                className="flex-1 bg-primary hover:bg-primary-hover text-on-primary text-xs font-semibold px-3 py-2 rounded-lg"
              >
                {t('cookie_consent.save_preferences')}
              </button>
            ) : (
              <button
                onClick={acceptAll}
                className="flex-1 bg-primary hover:bg-primary-hover text-on-primary text-xs font-semibold px-3 py-2 rounded-lg"
              >
                {t('cookie_consent.accept_all')}
              </button>
            )}
            <button
              onClick={rejectAll}
              className="flex-1 bg-surface-secondary hover:bg-surface-muted text-text-primary text-xs font-semibold px-3 py-2 rounded-lg"
            >
              {t('cookie_consent.reject_all')}
            </button>
            {!showCustomize && (
              <button
                onClick={() => setShowCustomize(true)}
                className="flex-1 text-primary hover:text-primary-hover text-xs font-semibold px-3 py-2 rounded-lg border border-primary/30"
              >
                {t('cookie_consent.customize')}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
