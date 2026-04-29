import { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
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

const AGENT_TEMPLATES = [
  { value: 'answering-service', label: 'Answering Service', description: 'General inbound call handling and ticket creation' },
  { value: 'medical-after-hours', label: 'Medical After-Hours', description: 'Medical triage with urgent escalation' },
  { value: 'dental', label: 'Dental Practice', description: 'Dental appointment scheduling and emergency routing' },
  { value: 'property-management', label: 'Property Management', description: 'Maintenance requests and emergency dispatch' },
  { value: 'home-services', label: 'Home Services', description: 'HVAC, plumbing, and electrical service booking' },
  { value: 'legal', label: 'Legal Intake', description: 'Consultation scheduling with conflict-of-interest screening' },
  { value: 'real-estate', label: 'Real Estate', description: 'Buyer/seller qualification and showing scheduling' },
  { value: 'restaurant', label: 'Restaurant Reservations', description: 'Take reservations or add callers to the waitlist' },
  { value: 'salon', label: 'Salon & Spa', description: 'Book stylist appointments and confirm the day before' },
];

/**
 * Maps an onboarding template slug (the agent `type` we save on the starter
 * agent) to the industry template key used by `getIndustryTemplateCopy`. Slugs
 * not listed here keep the agent's existing greeting/system prompt — that's
 * the case for `answering-service` (the provisioning default) and
 * `property-management` (no industry copy authored yet). Mirrors
 * `AGENT_TYPE_TO_TEMPLATE` in `client-app/src/pages/Agents.tsx` so the wizard
 * seeds the same copy as the Agents page quick-create.
 */
const AGENT_TYPE_TO_TEMPLATE: Record<string, IndustryTemplateKey> = {
  'medical-after-hours': 'medical',
  'dental': 'dental',
  'home-services': 'hvac',
  'legal': 'legal',
  'real-estate': 'realestate',
  'restaurant': 'restaurant',
  'salon': 'salon',
};

export default function Onboarding() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const queryClient = useQueryClient();
  const [step, setStep] = useState(1);
  const [provisioningStatus, setProvisioningStatus] = useState<ProvisioningStatus | null>(null);
  const [selectedTemplate, setSelectedTemplate] = useState('answering-service');
  const [updatingAgent, setUpdatingAgent] = useState(false);
  const [pollCount, setPollCount] = useState(0);
  const [preferencesLoaded, setPreferencesLoaded] = useState(false);
  const verifyAttempted = useRef(false);
  const persistedStepRef = useRef<number | null>(null);
  const tenantPrimaryLanguage = useTenantPrimaryLanguage();

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
        if (currentType && AGENT_TEMPLATES.some((t) => t.value === currentType)) {
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
          name: AGENT_TEMPLATES.find((t) => t.value === selectedTemplate)?.label ?? selectedTemplate,
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

  return (
    <div className="min-h-screen bg-surface-secondary flex items-center justify-center px-4">
      <div className="w-full max-w-lg">
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-12 h-12 rounded-xl bg-primary text-white mb-4">
            <Sparkles className="h-6 w-6" />
          </div>
          <h1 className="text-2xl font-bold text-text-primary">Welcome to Voice AI Operations Hub</h1>
          <p className="text-sm text-text-secondary mt-1">Let's get your environment set up</p>
        </div>

        <div className="flex items-center justify-center gap-2 mb-8">
          {[1, 2, 3].map((s) => (
            <div
              key={s}
              className={`h-2 rounded-full transition-all ${
                s === step ? 'w-8 bg-primary' : s < step ? 'w-8 bg-green-500' : 'w-8 bg-border'
              }`}
            />
          ))}
        </div>

        <div className="bg-surface rounded-xl border border-border p-6 shadow-sm">
          {step === 1 && (
            <div className="text-center space-y-4">
              <h2 className="text-lg font-semibold text-text-primary">Setting Up Your Environment</h2>
              {provisioningStatus?.status === 'ready' ? (
                <>
                  <div className="flex items-center justify-center gap-2 text-green-600">
                    <CheckCircle2 className="h-8 w-8" />
                    <span className="font-medium">Environment Ready</span>
                  </div>
                  <p className="text-sm text-text-secondary">Your tenant environment has been provisioned successfully.</p>
                  <button
                    onClick={() => advanceTo(2)}
                    className="w-full bg-primary hover:bg-primary-hover text-white font-medium py-2.5 px-4 rounded-lg text-sm transition-colors flex items-center justify-center gap-2"
                  >
                    Continue <ArrowRight className="h-4 w-4" />
                  </button>
                </>
              ) : (
                <>
                  <Loader2 className="h-8 w-8 animate-spin text-primary mx-auto" />
                  <p className="text-sm text-text-secondary">
                    {provisioningStatus?.status === 'provisioning'
                      ? 'Provisioning your environment...'
                      : 'Waiting for payment confirmation...'}
                  </p>
                  <p className="text-xs text-text-secondary">This usually takes just a few seconds.</p>
                </>
              )}
            </div>
          )}

          {step === 2 && (
            <div className="space-y-4">
              <div className="flex items-center gap-2 mb-2">
                <Bot className="h-5 w-5 text-primary" />
                <h2 className="text-lg font-semibold text-text-primary">Choose Your Agent Template</h2>
              </div>
              <p className="text-sm text-text-secondary">Select the template that best fits your business. You can customize it later.</p>

              <div className="space-y-2 max-h-72 overflow-y-auto">
                {AGENT_TEMPLATES.map((template) => (
                  <label
                    key={template.value}
                    className={`flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${
                      selectedTemplate === template.value
                        ? 'border-primary bg-primary/5'
                        : 'border-border hover:border-primary/40'
                    }`}
                  >
                    <input
                      type="radio"
                      name="template"
                      value={template.value}
                      checked={selectedTemplate === template.value}
                      onChange={() => setSelectedTemplate(template.value)}
                      className="mt-1 accent-primary"
                    />
                    <div>
                      <div className="text-sm font-medium text-text-primary">{template.label}</div>
                      <div className="text-xs text-text-secondary">{template.description}</div>
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
                  <ArrowLeft className="h-4 w-4" /> Back
                </button>
                <button
                  onClick={handleTemplateConfirm}
                  disabled={updatingAgent}
                  className="flex-1 bg-primary hover:bg-primary-hover text-white font-medium py-2.5 px-4 rounded-lg text-sm transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
                >
                  {updatingAgent ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" /> Updating...
                    </>
                  ) : (
                    <>
                      Continue <ArrowRight className="h-4 w-4" />
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
                <h2 className="text-lg font-semibold text-text-primary">Add Your First Phone Number</h2>
              </div>
              <p className="text-sm text-text-secondary">
                Connect a phone number to start receiving calls through your AI agent. You can do this now or from the dashboard later.
              </p>

              <div className="flex flex-col gap-3 pt-2">
                <button
                  onClick={() => handleFinish('/phone-numbers')}
                  className="w-full bg-primary hover:bg-primary-hover text-white font-medium py-2.5 px-4 rounded-lg text-sm transition-colors flex items-center justify-center gap-2"
                >
                  <Phone className="h-4 w-4" /> Add Phone Number
                </button>
                <button
                  onClick={() => handleFinish('/')}
                  className="w-full bg-surface hover:bg-surface-secondary text-text-primary font-medium py-2.5 px-4 rounded-lg text-sm transition-colors border border-border"
                >
                  Skip for Now — Go to Dashboard
                </button>
                <button
                  type="button"
                  onClick={goBack}
                  className="w-full text-text-secondary hover:text-text-primary font-medium py-2 px-4 rounded-lg text-sm transition-colors flex items-center justify-center gap-2"
                >
                  <ArrowLeft className="h-4 w-4" /> Back to template
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
