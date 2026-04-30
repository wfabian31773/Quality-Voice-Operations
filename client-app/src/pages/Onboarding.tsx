import '../styles/tw-app.css';
import { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api } from '../lib/api';
import { CheckCircle2, Loader2, Phone, Bot, ArrowRight, ArrowLeft, Sparkles } from 'lucide-react';
import { type IndustryTemplateKey, getIndustryTemplateCopy } from '../lib/agentBuilderI18n';
import { useTenantPrimaryLanguage } from '../hooks/useTenantPrimaryLanguage';

interface ProvisioningStatus {
  status: 'pending' | 'provisioning' | 'ready';
  agentCount: number;
  phoneNumberCount: number;
}

interface UserPreferences {
  onboarding_step?: number;
  onboarding_completed?: boolean;
  [key: string]: unknown;
}

const TOTAL_ONBOARDING_STEPS = 3;

function clampStep(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const rounded = Math.floor(value);
  if (rounded < 1 || rounded > TOTAL_ONBOARDING_STEPS) return null;
  return rounded;
}

const AGENT_TEMPLATE_VALUES = [
  'answering-service',
  'medical-after-hours',
  'dental',
  'property-management',
  'home-services',
  'legal',
  'real-estate',
  'restaurant',
  'salon',
] as const;

/**
 * Maps an onboarding template slug (the agent `type` we save on the starter
 * agent) to the industry template key used by `getIndustryTemplateCopy`. Slugs
 * not listed here keep the agent's existing greeting/system prompt — that's
 * the case for `answering-service` (the provisioning default). Mirrors
 * `AGENT_TYPE_TO_TEMPLATE` in `client-app/src/pages/Agents.tsx` so the wizard
 * seeds the same copy as the Agents page quick-create.
 */
const AGENT_TYPE_TO_TEMPLATE: Record<string, IndustryTemplateKey> = {
  'medical-after-hours': 'medical',
  'dental': 'dental',
  'property-management': 'propertymanagement',
  'home-services': 'hvac',
  'legal': 'legal',
  'real-estate': 'realestate',
  'restaurant': 'restaurant',
  'salon': 'salon',
};

export default function Onboarding() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const queryClient = useQueryClient();
  const [step, setStep] = useState(1);
  // Track the furthest step the user has reached so we know which progress
  // dots are safe to make clickable. Steps the user hasn't unlocked yet stay
  // non-interactive so they can't skip past required confirmations.
  const [maxVisitedStep, setMaxVisitedStep] = useState(1);
  const [provisioningStatus, setProvisioningStatus] = useState<ProvisioningStatus | null>(null);
  const [selectedTemplate, setSelectedTemplate] = useState('answering-service');
  const [updatingAgent, setUpdatingAgent] = useState(false);
  const [pollCount, setPollCount] = useState(0);
  const [preferencesLoaded, setPreferencesLoaded] = useState(false);
  const verifyAttempted = useRef(false);
  const persistedStepRef = useRef<number | null>(null);
  const tenantPrimaryLanguage = useTenantPrimaryLanguage();

  const templateLabel = (value: string) => t(`onboarding.templates.${value}.label`);
  const templateDescription = (value: string) => t(`onboarding.templates.${value}.description`);

  // Persist the user's current step to the server so they can resume
  // exactly where they left off after a refresh, logout, or new login.
  const persistStep = useCallback(async (nextStep: number, completed = false) => {
    if (persistedStepRef.current === nextStep && !completed) return;
    persistedStepRef.current = nextStep;
    try {
      await api.patch('/me/preferences', {
        onboarding_step: nextStep,
        ...(completed ? { onboarding_completed: true } : {}),
      });
    } catch {
      // Best-effort: a failed save shouldn't block the wizard. The user
      // can still navigate; we'll try again on the next step change.
    }
  }, []);

  const advanceTo = useCallback(
    (nextStep: number, options: { persist?: boolean; completed?: boolean } = {}) => {
      const { persist = true, completed = false } = options;
      setStep((current) => {
        // Never go backwards — if the user has already advanced past this
        // step (e.g. resumed at step 3 from saved progress), the
        // provisioning-ready signal mustn't yank them back to step 2.
        const target = Math.max(current, nextStep);
        if (persist) {
          void persistStep(target, completed);
        }
        return target;
      });
    },
    [persistStep],
  );

  // Explicit user-initiated back navigation. Unlike `advanceTo`, this is
  // allowed to move the wizard backwards so users can revisit and change
  // earlier answers (e.g. their template choice).
  const goBack = useCallback(() => {
    setStep((current) => {
      const target = Math.max(1, current - 1);
      if (target !== current) {
        void persistStep(target);
      }
      return target;
    });
  }, [persistStep]);

  // Jump to a specific previously-visited step when the user clicks one of
  // the progress dots. Mirrors `goBack`'s setState + persist pattern but
  // accepts an arbitrary target. We refuse to jump past the furthest step
  // the user has already reached so the dots can never be used to skip
  // ahead past required confirmations.
  const goToStep = useCallback(
    (target: number) => {
      setStep((current) => {
        if (target === current) return current;
        if (target < 1 || target > TOTAL_ONBOARDING_STEPS) return current;
        if (target > Math.max(current, maxVisitedStep)) return current;
        void persistStep(target);
        return target;
      });
    },
    [persistStep, maxVisitedStep],
  );

  // Keep `maxVisitedStep` in sync with the furthest step we've ever shown,
  // including when we resume from saved progress (which sets `step`
  // directly in the preferences-loading effect below).
  useEffect(() => {
    setMaxVisitedStep((prev) => Math.max(prev, step));
  }, [step]);

  // Load saved progress before doing anything else so we don't overwrite
  // a higher saved step with the default `1`. Also pre-load the current
  // agent's template so revisiting step 2 reflects the user's existing
  // choice rather than the default radio selection.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const result = await api.get<{ preferences: UserPreferences }>('/me/preferences');
        if (cancelled) return;
        const saved = clampStep(result.preferences?.onboarding_step);
        if (saved !== null && !result.preferences?.onboarding_completed) {
          setStep(saved);
          persistedStepRef.current = saved;
        }
      } catch {
        // If we can't load preferences, fall back to starting at step 1.
      } finally {
        if (!cancelled) setPreferencesLoaded(true);
      }
    })();
    (async () => {
      try {
        const agents = await api.get<{ agents: Array<{ type?: string }> }>('/agents');
        if (cancelled) return;
        const currentType = agents.agents[0]?.type;
        if (currentType && (AGENT_TEMPLATE_VALUES as readonly string[]).includes(currentType)) {
          setSelectedTemplate(currentType);
        }
      } catch {
        // Fall back to the default selection.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const verifyCheckout = useCallback(async () => {
    const sessionId = searchParams.get('session_id');
    if (!sessionId || verifyAttempted.current) return;
    verifyAttempted.current = true;
    try {
      const result = await api.post<{ status: string }>('/tenants/me/verify-checkout', { sessionId });
      if (result.status === 'ready') {
        setProvisioningStatus({ status: 'ready', agentCount: 1, phoneNumberCount: 0 });
        // Invalidate the shared TenantLayout cache so it doesn't keep
        // bouncing the user back to /onboarding on its 5-minute stale data.
        queryClient.invalidateQueries({ queryKey: ['tenant-provisioning-status'] });
        advanceTo(2);
      }
    } catch {
      // Fall through to polling
    }
  }, [searchParams, advanceTo, queryClient]);

  const pollStatus = useCallback(async () => {
    try {
      const data = await api.get<ProvisioningStatus>('/tenants/me/provisioning-status');
      setProvisioningStatus(data);
      if (data.status === 'ready') {
        // Invalidate the shared TenantLayout cache so it picks up the fresh
        // status instead of holding the 5-minute-stale "pending" snapshot.
        queryClient.invalidateQueries({ queryKey: ['tenant-provisioning-status'] });
        advanceTo(2);
      }
    } catch {
      // Retry silently
    }
  }, [advanceTo, queryClient]);

  useEffect(() => {
    if (!preferencesLoaded) return;
    verifyCheckout();
    pollStatus();
  }, [preferencesLoaded, verifyCheckout, pollStatus]);

  useEffect(() => {
    if (!preferencesLoaded) return;
    if (provisioningStatus?.status === 'ready') return;
    const interval = setInterval(() => {
      setPollCount((c) => c + 1);
      pollStatus();
    }, 3000);
    return () => clearInterval(interval);
  }, [preferencesLoaded, provisioningStatus?.status, pollStatus, pollCount]);

  const handleTemplateConfirm = async () => {
    if (selectedTemplate === 'answering-service') {
      advanceTo(3);
      return;
    }

    setUpdatingAgent(true);
    try {
      const agents = await api.get<{ agents: Array<{ id: string }> }>('/agents');
      if (agents.agents.length > 0) {
        const updates: Record<string, unknown> = {
          type: selectedTemplate,
          name: templateLabel(selectedTemplate),
        };
        // When the chosen template has industry copy authored, seed the
        // greeting + system prompt from it — same behaviour as the Agents
        // page quick-create. The fresh starter agent only has the generic
        // defaults at this point, so it's always safe to overwrite without
        // checking for user customisation.
        const templateKey = AGENT_TYPE_TO_TEMPLATE[selectedTemplate];
        if (templateKey) {
          const copy = getIndustryTemplateCopy(tenantPrimaryLanguage, templateKey);
          updates.welcome_greeting = copy.welcomeGreeting;
          updates.system_prompt = copy.systemPrompt;
        }
        await api.patch(`/agents/${agents.agents[0].id}`, updates);
      }
      advanceTo(3);
    } catch {
      advanceTo(3);
    } finally {
      setUpdatingAgent(false);
    }
  };

  const handleFinish = (path: string) => {
    // Wizard is done — record completion so we don't resume into the
    // (now-stale) wizard the next time the user lands here.
    void persistStep(TOTAL_ONBOARDING_STEPS, true);
    navigate(path);
  };

  const stepLabels = [
    t('onboarding.step_labels.setup'),
    t('onboarding.step_labels.template'),
    t('onboarding.step_labels.phone_number'),
  ];

  return (
    <div className="min-h-screen bg-surface-secondary flex items-center justify-center px-4">
      <div className="w-full max-w-lg">
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-12 h-12 rounded-xl bg-primary text-white mb-4">
            <Sparkles className="h-6 w-6" />
          </div>
          <h1 className="text-2xl font-bold text-text-primary">{t('onboarding.title')}</h1>
          <p className="text-sm text-text-secondary mt-1">{t('onboarding.subtitle')}</p>
        </div>

        <div className="flex items-start justify-center gap-6 mb-8">
          {[1, 2, 3].map((s) => {
            const isActive = s === step;
            // A dot counts as "completed" once the user has reached it,
            // even if they later navigated back. That way the green
            // colouring stays consistent for visited-but-not-current
            // steps regardless of which direction the user is moving.
            // Compare against `max(step, maxVisitedStep)` so the current
            // step is always treated as visited even on the render pass
            // before the `maxVisitedStep` sync effect has run.
            const furthestUnlocked = Math.max(step, maxVisitedStep);
            const isCompleted = !isActive && s <= furthestUnlocked;
            const isClickable = s <= furthestUnlocked;
            const label = stepLabels[s - 1];
            const dotColorClass = isActive
              ? 'bg-primary'
              : isCompleted
                ? 'bg-green-500'
                : 'bg-border';
            const labelColorClass = isActive
              ? 'text-text-primary font-medium'
              : isCompleted
                ? 'text-text-primary'
                : 'text-text-secondary';
            const dotClass = `h-2 w-8 rounded-full transition-all ${dotColorClass}`;
            const labelClass = `text-xs leading-tight ${labelColorClass}`;
            if (isClickable) {
              return (
                <button
                  key={s}
                  type="button"
                  onClick={() => goToStep(s)}
                  disabled={isActive}
                  aria-label={t('onboarding.go_to_step_aria', { step: s, label })}
                  aria-current={isActive ? 'step' : undefined}
                  className={`flex flex-col items-center gap-2 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 ${
                    isActive
                      ? 'cursor-default'
                      : 'cursor-pointer hover:opacity-80'
                  }`}
                >
                  <span className={dotClass} />
                  <span className={labelClass}>{label}</span>
                </button>
              );
            }
            return (
              <div key={s} className="flex flex-col items-center gap-2">
                <div aria-hidden="true" className={dotClass} />
                <span className={labelClass}>{label}</span>
              </div>
            );
          })}
        </div>

        <div className="bg-surface rounded-xl border border-border p-6 shadow-sm">
          {step === 1 && (
            <div className="text-center space-y-4">
              <h2 className="text-lg font-semibold text-text-primary">{t('onboarding.setup.title')}</h2>
              {provisioningStatus?.status === 'ready' ? (
                <>
                  <div className="flex items-center justify-center gap-2 text-green-600">
                    <CheckCircle2 className="h-8 w-8" />
                    <span className="font-medium">{t('onboarding.setup.ready')}</span>
                  </div>
                  <p className="text-sm text-text-secondary">{t('onboarding.setup.ready_message')}</p>
                  <button
                    onClick={() => advanceTo(2)}
                    className="w-full bg-primary hover:bg-primary-hover text-white font-medium py-2.5 px-4 rounded-lg text-sm transition-colors flex items-center justify-center gap-2"
                  >
                    {t('onboarding.setup.continue')} <ArrowRight className="h-4 w-4" />
                  </button>
                </>
              ) : (
                <>
                  <Loader2 className="h-8 w-8 animate-spin text-primary mx-auto" />
                  <p className="text-sm text-text-secondary">
                    {provisioningStatus?.status === 'provisioning'
                      ? t('onboarding.setup.provisioning')
                      : t('onboarding.setup.waiting_payment')}
                  </p>
                  <p className="text-xs text-text-secondary">{t('onboarding.setup.usually_quick')}</p>
                </>
              )}
            </div>
          )}

          {step === 2 && (
            <div className="space-y-4">
              <div className="flex items-center gap-2 mb-2">
                <Bot className="h-5 w-5 text-primary" />
                <h2 className="text-lg font-semibold text-text-primary">{t('onboarding.template.title')}</h2>
              </div>
              <p className="text-sm text-text-secondary">{t('onboarding.template.subtitle')}</p>

              <div className="space-y-2 max-h-72 overflow-y-auto">
                {AGENT_TEMPLATE_VALUES.map((value) => (
                  <label
                    key={value}
                    className={`flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${
                      selectedTemplate === value
                        ? 'border-primary bg-primary/5'
                        : 'border-border hover:border-primary/40'
                    }`}
                  >
                    <input
                      type="radio"
                      name="template"
                      value={value}
                      checked={selectedTemplate === value}
                      onChange={() => setSelectedTemplate(value)}
                      className="mt-1 accent-primary"
                    />
                    <div>
                      <div className="text-sm font-medium text-text-primary">{templateLabel(value)}</div>
                      <div className="text-xs text-text-secondary">{templateDescription(value)}</div>
                    </div>
                  </label>
                ))}
              </div>

              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={goBack}
                  disabled={updatingAgent}
                  className="bg-surface hover:bg-surface-secondary text-text-primary font-medium py-2.5 px-4 rounded-lg text-sm transition-colors border border-border disabled:opacity-50 flex items-center justify-center gap-2"
                >
                  <ArrowLeft className="h-4 w-4" /> {t('onboarding.template.back')}
                </button>
                <button
                  onClick={handleTemplateConfirm}
                  disabled={updatingAgent}
                  className="flex-1 bg-primary hover:bg-primary-hover text-white font-medium py-2.5 px-4 rounded-lg text-sm transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
                >
                  {updatingAgent ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" /> {t('onboarding.template.updating')}
                    </>
                  ) : (
                    <>
                      {t('onboarding.template.continue')} <ArrowRight className="h-4 w-4" />
                    </>
                  )}
                </button>
              </div>
            </div>
          )}

          {step === 3 && (
            <div className="space-y-4 text-center">
              <div className="flex items-center justify-center gap-2 mb-2">
                <Phone className="h-5 w-5 text-primary" />
                <h2 className="text-lg font-semibold text-text-primary">{t('onboarding.phone.title')}</h2>
              </div>
              <p className="text-sm text-text-secondary">{t('onboarding.phone.description')}</p>

              <div className="flex flex-col gap-3 pt-2">
                <button
                  onClick={() => handleFinish('/phone-numbers')}
                  className="w-full bg-primary hover:bg-primary-hover text-white font-medium py-2.5 px-4 rounded-lg text-sm transition-colors flex items-center justify-center gap-2"
                >
                  <Phone className="h-4 w-4" /> {t('onboarding.phone.add')}
                </button>
                <button
                  onClick={() => handleFinish('/')}
                  className="w-full bg-surface hover:bg-surface-secondary text-text-primary font-medium py-2.5 px-4 rounded-lg text-sm transition-colors border border-border"
                >
                  {t('onboarding.phone.skip')}
                </button>
                <button
                  type="button"
                  onClick={goBack}
                  className="w-full text-text-secondary hover:text-text-primary font-medium py-2 px-4 rounded-lg text-sm transition-colors flex items-center justify-center gap-2"
                >
                  <ArrowLeft className="h-4 w-4" /> {t('onboarding.phone.back')}
                </button>
              </div>
            </div>
          )}
        </div>

        <div className="mt-4 text-center">
          <button
            type="button"
            onClick={() => handleFinish('/')}
            className="text-xs text-text-secondary hover:text-text-primary underline-offset-4 hover:underline transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 rounded"
          >
            {t('onboarding.dont_show')}
          </button>
          <p className="text-[11px] text-text-secondary mt-1">
            {t('onboarding.restart_anytime')}
          </p>
        </div>
      </div>
    </div>
  );
}
