import { useState, useEffect, useRef, useCallback } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { MessageSquare, X, Send, Mic, MicOff, ArrowRight, Phone } from 'lucide-react';
import { formatCents, formatDollars } from '../lib/formatCurrency';
import { ANNUAL_DISCOUNT, type BillingPeriod } from './MinutesPricingCalculator';
import {
  readBillingPeriodPreference,
  writeBillingPeriodPreference,
  subscribeBillingPeriodPreference,
} from '../lib/billingPeriodPreference';

interface SpeechRecognitionAlternative {
  transcript: string;
  confidence: number;
}

interface SpeechRecognitionResult {
  readonly length: number;
  readonly isFinal: boolean;
  [index: number]: SpeechRecognitionAlternative;
}

interface SpeechRecognitionResultList {
  readonly length: number;
  [index: number]: SpeechRecognitionResult;
}

interface SpeechRecognitionEvent extends Event {
  readonly results: SpeechRecognitionResultList;
  readonly resultIndex: number;
}

interface SpeechRecognition extends EventTarget {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((event: SpeechRecognitionEvent) => void) | null;
  onerror: ((event: Event) => void) | null;
  onend: ((event: Event) => void) | null;
  start: () => void;
  stop: () => void;
}

type SpeechRecognitionConstructor = new () => SpeechRecognition;

declare global {
  interface Window {
    SpeechRecognition?: SpeechRecognitionConstructor;
    webkitSpeechRecognition?: SpeechRecognitionConstructor;
  }
}

interface Message {
  role: 'user' | 'assistant';
  content: string;
  actions?: AgentAction[];
}

interface AgentAction {
  type: 'launch_demo' | 'navigate' | 'recommend_plan' | 'capture_lead' | 'schedule_consultation';
  data: Record<string, unknown>;
}

const QUICK_ACTIONS = [
  { label: 'See a demo', message: 'I\'d like to see a demo of your AI agents' },
  { label: 'View pricing', message: 'What are your pricing plans?' },
  { label: 'Talk to sales', message: 'I\'d like to talk to someone on your sales team' },
];

const VERTICAL_AGENT_MAP: Record<string, string> = {
  medical: 'medical-intake',
  dental: 'dental-scheduling',
  hvac: 'hvac-home-services',
  'home-services': 'hvac-home-services',
  legal: 'legal-intake',
  'customer-support': 'customer-support',
  collections: 'outbound-sales',
  'real-estate': 'real-estate',
  restaurant: 'restaurant',
  'property-management': 'property-management',
  insurance: 'insurance-verification',
};

export default function WebsiteSalesWidget() {
  const [isOpen, setIsOpen] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [hasGreeted, setHasGreeted] = useState(false);
  const [showPulse, setShowPulse] = useState(true);
  const [isListening, setIsListening] = useState(false);
  const [voiceMode, setVoiceMode] = useState(false);
  const [voiceSupported, setVoiceSupported] = useState(false);
  // Page-level billing-period default for new recommendation cards.
  // Initialised from (and synced with) the shared marketing preference
  // so a visitor who already toggled "Annual" on /pricing sees Annual
  // selected here, with the trial CTA carrying ?interval=annual without
  // a second click in the chat.
  const [defaultRecommendInterval, setDefaultRecommendInterval] = useState<BillingPeriod>(
    () => readBillingPeriodPreference() ?? 'monthly',
  );
  // Per-card override (keyed by a stable per-action key built from the
  // message + action index) so a visitor who flips one card doesn't
  // disturb others — and so multiple recommend_plan cards in a single
  // assistant message remain independent.
  const [recommendIntervals, setRecommendIntervals] = useState<Record<string, BillingPeriod>>({});
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const recognitionRef = useRef<SpeechRecognition | null>(null);
  const lastPageRef = useRef<string>('');
  const location = useLocation();
  const navigate = useNavigate();

  useEffect(() => {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (SpeechRecognition) {
      setVoiceSupported(true);
      const recognition = new SpeechRecognition();
      recognition.continuous = false;
      recognition.interimResults = true;
      recognition.lang = 'en-US';

      recognition.onresult = (event: SpeechRecognitionEvent) => {
        const last = event.results[event.results.length - 1];
        if (last.isFinal) {
          const transcript = last[0].transcript;
          if (transcript.trim()) {
            setVoiceMode(true);
            sendMessage(transcript.trim());
          }
          setIsListening(false);
        } else {
          setInput(last[0].transcript);
        }
      };

      recognition.onerror = () => {
        setIsListening(false);
      };

      recognition.onend = () => {
        setIsListening(false);
      };

      recognitionRef.current = recognition;
    }
  }, []);

  // Listen for billing-period changes broadcast by the Pricing page (or
  // another tab/window) so the chat widget's default interval stays in
  // lockstep without requiring a remount.
  useEffect(() => {
    return subscribeBillingPeriodPreference((next) => {
      setDefaultRecommendInterval(next);
    });
  }, []);

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [messages, scrollToBottom]);

  useEffect(() => {
    if (isOpen && !hasGreeted) {
      fetchGreeting();
      setHasGreeted(true);
      setShowPulse(false);
      lastPageRef.current = location.pathname;
    }
    if (isOpen) {
      setTimeout(() => inputRef.current?.focus(), 300);
    }
  }, [isOpen]);

  useEffect(() => {
    if (isOpen && hasGreeted && location.pathname !== lastPageRef.current) {
      lastPageRef.current = location.pathname;
      updatePageContext(location.pathname);
    }
  }, [location.pathname, isOpen, hasGreeted]);

  const updatePageContext = async (page: string) => {
    if (!conversationId) return;
    try {
      await fetch('/api/website-agent/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: `[System: The visitor just navigated to ${page}. Adjust your context accordingly but do not send a new greeting unless asked.]`,
          conversationId,
          sourcePage: page,
        }),
      });
    } catch {}
  };

  const fetchGreeting = async () => {
    try {
      const res = await fetch(`/api/website-agent/greeting?page=${encodeURIComponent(location.pathname)}`);
      if (res.ok) {
        const data = await res.json();
        setMessages([{ role: 'assistant', content: data.greeting }]);
      } else {
        setMessages([{ role: 'assistant', content: 'Hi! I\'m QVO\'s AI assistant. How can I help you today?' }]);
      }
    } catch {
      setMessages([{ role: 'assistant', content: 'Hi! I\'m QVO\'s AI assistant. How can I help you today?' }]);
    }
  };

  const sendMessage = async (text: string) => {
    if (!text.trim() || loading) return;

    const userMsg: Message = { role: 'user', content: text.trim() };
    setMessages(prev => [...prev, userMsg]);
    setInput('');
    setLoading(true);

    try {
      const res = await fetch('/api/website-agent/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: text.trim(),
          conversationId: conversationId,
          sourcePage: location.pathname,
        }),
      });

      if (!res.ok) {
        throw new Error('Chat request failed');
      }

      const data = await res.json();

      if (!conversationId && data.conversationId) {
        setConversationId(data.conversationId);
      }

      const assistantMsg: Message = {
        role: 'assistant',
        content: data.message,
        actions: data.actions,
      };
      setMessages(prev => [...prev, assistantMsg]);

      if (voiceSupported && voiceMode) {
        speakResponse(data.message);
        setVoiceMode(false);
      }

      if (data.actions) {
        for (const action of data.actions) {
          handleAction(action);
        }
      }
    } catch {
      setMessages(prev => [
        ...prev,
        { role: 'assistant', content: 'Sorry, I\'m having trouble connecting. Please try again in a moment.' },
      ]);
    } finally {
      setLoading(false);
    }
  };

  const speakResponse = (text: string) => {
    if ('speechSynthesis' in window) {
      window.speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.rate = 1.0;
      utterance.pitch = 1.0;
      utterance.volume = 0.8;
      window.speechSynthesis.speak(utterance);
    }
  };

  const toggleVoice = () => {
    if (!recognitionRef.current) return;

    if (isListening) {
      recognitionRef.current.stop();
      setIsListening(false);
      if ('speechSynthesis' in window) {
        window.speechSynthesis.cancel();
      }
    } else {
      setInput('');
      try {
        recognitionRef.current.start();
        setIsListening(true);
      } catch {
        setIsListening(false);
      }
    }
  };

  const handleAction = (action: AgentAction) => {
    switch (action.type) {
      case 'launch_demo': {
        const vertical = action.data.vertical as string;
        const agentId = VERTICAL_AGENT_MAP[vertical] || vertical;
        navigate(`/demo?agent=${encodeURIComponent(agentId)}`);
        break;
      }
      case 'navigate':
        if (action.data.path && typeof action.data.path === 'string') {
          navigate(action.data.path);
        }
        break;
      case 'recommend_plan':
        if (action.data.plan && conversationId) {
          fetch('/api/website-agent/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              message: `[System: Visitor clicked to start trial for ${action.data.plan} plan]`,
              conversationId,
              sourcePage: location.pathname,
            }),
          }).catch(() => {});
        }
        break;
      case 'capture_lead':
        break;
      case 'schedule_consultation':
        break;
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage(input);
    }
  };

  return (
    <>
      {isOpen && (
        <div className="fixed bottom-24 right-6 w-[380px] max-h-[560px] rounded-2xl overflow-hidden z-[999999] shadow-2xl flex flex-col bg-surface border border-border-strong/20 animate-in slide-in-from-bottom-4 duration-300 max-[420px]:w-[calc(100vw-32px)] max-[420px]:right-4 max-[420px]:bottom-20">
          <div className="bg-sidebar-bg px-5 py-4 flex items-center justify-between shrink-0">
            <div className="flex items-center gap-2.5">
              <div className="w-8 h-8 rounded-lg bg-primary flex items-center justify-center">
                <Phone className="h-4 w-4 text-white" />
              </div>
              <div>
                <h3 className="text-white font-display text-sm font-semibold">QVO Assistant</h3>
                <p className="text-white/50 text-[11px]">AI Sales & Support</p>
              </div>
            </div>
            <button
              onClick={() => setIsOpen(false)}
              className="text-white/60 hover:text-white transition-colors p-1"
              aria-label="Close chat"
            >
              <X className="h-5 w-5" />
            </button>
          </div>

          <div className="flex-1 overflow-y-auto p-4 space-y-3 min-h-[280px] max-h-[380px] bg-surface-secondary/30">
            {messages.map((msg, i) => (
              <div key={i} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                <div
                  className={`max-w-[85%] px-3.5 py-2.5 rounded-xl text-sm leading-relaxed ${
                    msg.role === 'user'
                      ? 'bg-primary text-white rounded-br-sm'
                      : 'bg-surface text-text-primary border border-border-strong/20 rounded-bl-sm shadow-sm'
                  }`}
                >
                  {msg.content}
                  {msg.actions && msg.actions.some(a => a.type === 'recommend_plan') && (
                    <div
                      className={`mt-2 pt-2 border-t ${
                        msg.role === 'user' ? 'border-white/20 dark:border-white/20' : 'border-border-strong/20'
                      }`}
                    >
                      {msg.actions.filter(a => a.type === 'recommend_plan').map((a, j) => {
                        const plan = String(a.data.plan ?? '');
                        const planLabel = plan.charAt(0).toUpperCase() + plan.slice(1);
                        const monthlyPriceCents =
                          typeof a.data.monthlyPriceCents === 'number'
                            ? a.data.monthlyPriceCents
                            : null;
                        const includedMinutes =
                          typeof a.data.includedMinutes === 'number'
                            ? a.data.includedMinutes
                            : null;
                        const overageRate =
                          typeof a.data.overageRatePerMinute === 'number'
                            ? a.data.overageRatePerMinute
                            : null;
                        const annualMonthlyPriceCents =
                          monthlyPriceCents !== null
                            ? Math.round(monthlyPriceCents * (1 - ANNUAL_DISCOUNT))
                            : null;
                        const cardKey = `${i}:${j}`;
                        const cardInterval: BillingPeriod =
                          recommendIntervals[cardKey] ?? defaultRecommendInterval;
                        const isAnnual = cardInterval === 'annual';
                        const displayedPriceCents = isAnnual
                          ? annualMonthlyPriceCents
                          : monthlyPriceCents;
                        const priceLabel =
                          displayedPriceCents !== null
                            ? `${formatCents(displayedPriceCents, {
                                minimumFractionDigits: 0,
                                maximumFractionDigits: 0,
                              })}/month`
                            : null;
                        const altPriceLabel =
                          annualMonthlyPriceCents !== null && monthlyPriceCents !== null
                            ? isAnnual
                              ? `${formatCents(monthlyPriceCents, {
                                  minimumFractionDigits: 0,
                                  maximumFractionDigits: 0,
                                })}/mo billed monthly`
                              : `${formatCents(annualMonthlyPriceCents, {
                                  minimumFractionDigits: 0,
                                  maximumFractionDigits: 0,
                                })}/mo billed annually (save ${Math.round(ANNUAL_DISCOUNT * 100)}%)`
                            : null;
                        const ctaHref = `/signup?plan=${plan}${isAnnual ? '&interval=annual' : ''}`;
                        const setInterval = (next: BillingPeriod) => {
                          setRecommendIntervals(prev => ({ ...prev, [cardKey]: next }));
                          // Broadcast the visitor's choice so the
                          // Pricing page (and any other open chat card)
                          // honors the same selection.
                          writeBillingPeriodPreference(next);
                        };
                        const togglePillBase =
                          'px-2 py-0.5 rounded-full text-[10px] font-semibold transition-colors';
                        const activePill =
                          msg.role === 'user'
                            ? 'bg-white text-primary'
                            : 'bg-primary text-white';
                        const inactivePill =
                          msg.role === 'user'
                            ? 'text-white/70 hover:text-white'
                            : 'text-text-primary/60 hover:text-text-primary';
                        return (
                          <div key={j} className="flex flex-col gap-1 mt-1">
                            <div
                              className={`text-xs font-semibold ${
                                msg.role === 'user' ? 'text-white' : 'text-text-primary'
                              }`}
                              data-testid={`recommend-plan-price-${plan}`}
                            >
                              {planLabel}
                              {priceLabel ? ` — ${priceLabel}` : ''}
                            </div>
                            {altPriceLabel && (
                              <div
                                className={`text-[11px] ${
                                  msg.role === 'user' ? 'text-white/70' : 'text-text-primary/60'
                                }`}
                                data-testid={`recommend-plan-alt-price-${plan}`}
                              >
                                {altPriceLabel}
                              </div>
                            )}
                            {(includedMinutes !== null || overageRate !== null) && (
                              <div
                                className={`text-[11px] ${
                                  msg.role === 'user' ? 'text-white/70' : 'text-text-primary/60'
                                }`}
                              >
                                {includedMinutes !== null
                                  ? `${includedMinutes.toLocaleString()} AI minutes`
                                  : ''}
                                {includedMinutes !== null && overageRate !== null ? ' · ' : ''}
                                {overageRate !== null
                                  ? `${formatDollars(overageRate)}/min overage`
                                  : ''}
                              </div>
                            )}
                            {annualMonthlyPriceCents !== null && (
                              <div
                                className={`mt-1 inline-flex items-center gap-1 self-start rounded-full p-0.5 ${
                                  msg.role === 'user'
                                    ? 'bg-white/15'
                                    : 'bg-surface-secondary/60 border border-border-strong/20'
                                }`}
                                role="group"
                                aria-label={`Billing interval for ${planLabel} plan`}
                              >
                                <button
                                  type="button"
                                  onClick={() => setInterval('monthly')}
                                  aria-pressed={!isAnnual}
                                  data-testid={`recommend-plan-interval-monthly-${plan}`}
                                  className={`${togglePillBase} ${
                                    !isAnnual ? activePill : inactivePill
                                  }`}
                                >
                                  Monthly
                                </button>
                                <button
                                  type="button"
                                  onClick={() => setInterval('annual')}
                                  aria-pressed={isAnnual}
                                  data-testid={`recommend-plan-interval-annual-${plan}`}
                                  className={`${togglePillBase} ${
                                    isAnnual ? activePill : inactivePill
                                  }`}
                                >
                                  Annual −{Math.round(ANNUAL_DISCOUNT * 100)}%
                                </button>
                              </div>
                            )}
                            <button
                              onClick={() => navigate(ctaHref)}
                              data-testid={`recommend-plan-cta-${plan}`}
                              className={`flex items-center gap-1.5 text-xs font-semibold mt-1 ${
                                msg.role === 'user'
                                  ? 'text-white/90 hover:text-white'
                                  : 'text-primary hover:text-primary-hover'
                              }`}
                            >
                              Start {planLabel} Trial
                              <ArrowRight className="h-3 w-3" />
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>
            ))}

            {loading && (
              <div className="flex justify-start">
                <div
                  className="bg-surface border border-border-strong/20 rounded-xl rounded-bl-sm px-4 py-3 shadow-sm"
                  role="status"
                  aria-label="Assistant is typing a reply"
                >
                  <div className="flex gap-1.5" aria-hidden="true">
                    <span className="w-2 h-2 bg-border-strong/40 rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
                    <span className="w-2 h-2 bg-border-strong/40 rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
                    <span className="w-2 h-2 bg-border-strong/40 rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
                  </div>
                </div>
              </div>
            )}

            {messages.length <= 1 && !loading && (
              <div className="flex flex-wrap gap-2 mt-2">
                {QUICK_ACTIONS.map((qa) => (
                  <button
                    key={qa.label}
                    onClick={() => sendMessage(qa.message)}
                    className="text-xs font-medium bg-surface border border-primary/20 text-primary hover:bg-primary/5 px-3 py-1.5 rounded-full transition-colors"
                  >
                    {qa.label}
                  </button>
                ))}
              </div>
            )}

            <div ref={messagesEndRef} />
          </div>

          <div className="border-t border-border-strong/20 p-3 bg-surface shrink-0">
            {isListening && (
              <div className="flex items-center gap-2 mb-2 px-1">
                <div className="flex items-center gap-[2px] h-4">
                  {Array.from({ length: 8 }).map((_, i) => (
                    <div
                      key={i}
                      className="w-[3px] bg-primary rounded-full animate-pulse"
                      style={{
                        height: `${8 + Math.random() * 12}px`,
                        animationDelay: `${i * 0.1}s`,
                        animationDuration: `${0.5 + Math.random() * 0.5}s`,
                      }}
                    />
                  ))}
                </div>
                <span className="text-xs text-primary font-medium">Listening...</span>
              </div>
            )}
            <div className="flex gap-2">
              {voiceSupported && (
                <button
                  onClick={toggleVoice}
                  disabled={loading}
                  className={`p-2.5 rounded-xl transition-colors shrink-0 ${
                    isListening
                      ? 'bg-danger text-white animate-pulse'
                      : 'bg-surface-secondary/50 text-text-primary hover:bg-surface-secondary border border-border-strong/20'
                  } disabled:opacity-40`}
                  aria-label={isListening ? 'Stop listening' : 'Start voice input'}
                  title={isListening ? 'Stop listening' : 'Speak your message'}
                >
                  {isListening ? <MicOff className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
                </button>
              )}
              <input
                ref={inputRef}
                type="text"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder={isListening ? 'Listening...' : 'Type a message...'}
                disabled={loading}
                className="flex-1 px-3.5 py-2.5 text-sm border border-border-strong/30 rounded-xl bg-surface-secondary/30 text-text-primary placeholder:text-border-strong focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary/40 disabled:opacity-50"
              />
              <button
                onClick={() => sendMessage(input)}
                disabled={!input.trim() || loading}
                className="p-2.5 bg-primary hover:bg-primary-hover text-white rounded-xl transition-colors disabled:opacity-40 disabled:cursor-not-allowed shrink-0"
                aria-label="Send message"
              >
                <Send className="h-4 w-4" />
              </button>
            </div>
          </div>
        </div>
      )}

      <button
        onClick={() => setIsOpen(!isOpen)}
        className={`fixed bottom-6 right-6 w-14 h-14 rounded-full shadow-lg hover:shadow-xl transition-all duration-200 z-[999999] flex items-center justify-center max-[420px]:bottom-4 max-[420px]:right-4 ${
          isOpen
            ? 'bg-sidebar-bg hover:bg-sidebar-hover'
            : 'bg-primary hover:bg-primary-hover hover:scale-105'
        }`}
        aria-label={isOpen ? 'Close chat' : 'Open chat'}
      >
        {isOpen ? (
          <X className="h-5 w-5 text-white" />
        ) : (
          <>
            <MessageSquare className="h-5 w-5 text-white" />
            {showPulse && (
              <span
                aria-hidden="true"
                className="absolute -top-0.5 -right-0.5 w-3.5 h-3.5 bg-danger rounded-full border-2 border-white animate-pulse"
              />
            )}
          </>
        )}
      </button>
    </>
  );
}
