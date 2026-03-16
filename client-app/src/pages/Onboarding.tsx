import { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../lib/api';
import { CheckCircle2, Loader2, Phone, Bot, ArrowRight, Sparkles } from 'lucide-react';

interface ProvisioningStatus {
  status: 'pending' | 'provisioning' | 'ready';
  agentCount: number;
  phoneNumberCount: number;
}

const AGENT_TEMPLATES = [
  { value: 'answering-service', label: 'Answering Service', description: 'General inbound call handling and ticket creation' },
  { value: 'medical-after-hours', label: 'Medical After-Hours', description: 'Medical triage with urgent escalation' },
  { value: 'dental', label: 'Dental Practice', description: 'Dental appointment scheduling and emergency routing' },
  { value: 'property-management', label: 'Property Management', description: 'Maintenance requests and emergency dispatch' },
  { value: 'home-services', label: 'Home Services', description: 'HVAC, plumbing, and electrical service booking' },
  { value: 'legal', label: 'Legal Intake', description: 'Consultation scheduling with conflict-of-interest screening' },
];

export default function Onboarding() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [step, setStep] = useState(1);
  const [provisioningStatus, setProvisioningStatus] = useState<ProvisioningStatus | null>(null);
  const [selectedTemplate, setSelectedTemplate] = useState('answering-service');
  const [updatingAgent, setUpdatingAgent] = useState(false);
  const [pollCount, setPollCount] = useState(0);
  const verifyAttempted = useRef(false);

  const verifyCheckout = useCallback(async () => {
    const sessionId = searchParams.get('session_id');
    if (!sessionId || verifyAttempted.current) return;
    verifyAttempted.current = true;
    try {
      const result = await api.post<{ status: string }>('/tenants/me/verify-checkout', { sessionId });
      if (result.status === 'ready') {
        setProvisioningStatus({ status: 'ready', agentCount: 1, phoneNumberCount: 0 });
        setStep(2);
      }
    } catch {
      // Fall through to polling
    }
  }, [searchParams]);

  const pollStatus = useCallback(async () => {
    try {
      const data = await api.get<ProvisioningStatus>('/tenants/me/provisioning-status');
      setProvisioningStatus(data);
      if (data.status === 'ready') {
        setStep(2);
      }
    } catch {
      // Retry silently
    }
  }, []);

  useEffect(() => {
    verifyCheckout();
    pollStatus();
  }, [verifyCheckout, pollStatus]);

  useEffect(() => {
    if (provisioningStatus?.status === 'ready') return;
    const interval = setInterval(() => {
      setPollCount((c) => c + 1);
      pollStatus();
    }, 3000);
    return () => clearInterval(interval);
  }, [provisioningStatus?.status, pollStatus, pollCount]);

  const handleTemplateConfirm = async () => {
    if (selectedTemplate === 'answering-service') {
      setStep(3);
      return;
    }

    setUpdatingAgent(true);
    try {
      const agents = await api.get<{ agents: Array<{ id: string }> }>('/agents');
      if (agents.agents.length > 0) {
        await api.patch(`/agents/${agents.agents[0].id}`, {
          type: selectedTemplate,
          name: AGENT_TEMPLATES.find((t) => t.value === selectedTemplate)?.label ?? selectedTemplate,
        });
      }
      setStep(3);
    } catch {
      setStep(3);
    } finally {
      setUpdatingAgent(false);
    }
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
                    onClick={() => setStep(2)}
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

              <button
                onClick={handleTemplateConfirm}
                disabled={updatingAgent}
                className="w-full bg-primary hover:bg-primary-hover text-white font-medium py-2.5 px-4 rounded-lg text-sm transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
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
                  onClick={() => navigate('/phone-numbers')}
                  className="w-full bg-primary hover:bg-primary-hover text-white font-medium py-2.5 px-4 rounded-lg text-sm transition-colors flex items-center justify-center gap-2"
                >
                  <Phone className="h-4 w-4" /> Add Phone Number
                </button>
                <button
                  onClick={() => navigate('/')}
                  className="w-full bg-surface hover:bg-surface-secondary text-text-primary font-medium py-2.5 px-4 rounded-lg text-sm transition-colors border border-border"
                >
                  Skip for Now — Go to Dashboard
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
