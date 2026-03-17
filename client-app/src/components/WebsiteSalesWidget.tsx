import { useState, useEffect, useRef, useCallback } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { MessageSquare, X, Send, Mic, MicOff, ArrowRight, Phone } from 'lucide-react';

type SpeechRecognitionType = typeof window extends { SpeechRecognition: infer T } ? T : never;
type SpeechRecognitionInstance = InstanceType<SpeechRecognitionType>;

declare global {
  interface Window {
    SpeechRecognition?: new () => SpeechRecognitionInstance;
    webkitSpeechRecognition?: new () => SpeechRecognitionInstance;
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
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const recognitionRef = useRef<SpeechRecognition | null>(null);
  const lastPageRef = useRef<string>('');
  const location = useLocation();
  const navigate = useNavigate();

  useEffect(() => {
    const SpeechRecognition = window.SpeechRecognition || (window as unknown as { webkitSpeechRecognition: typeof window.SpeechRecognition }).webkitSpeechRecognition;
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
        <div className="fixed bottom-24 right-6 w-[380px] max-h-[560px] rounded-2xl overflow-hidden z-[999999] shadow-2xl flex flex-col bg-white border border-soft-steel/20 animate-in slide-in-from-bottom-4 duration-300 max-[420px]:w-[calc(100vw-32px)] max-[420px]:right-4 max-[420px]:bottom-20">
          <div className="bg-harbor px-5 py-4 flex items-center justify-between shrink-0">
            <div className="flex items-center gap-2.5">
              <div className="w-8 h-8 rounded-lg bg-teal flex items-center justify-center">
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

          <div className="flex-1 overflow-y-auto p-4 space-y-3 min-h-[280px] max-h-[380px] bg-mist/30">
            {messages.map((msg, i) => (
              <div key={i} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                <div
                  className={`max-w-[85%] px-3.5 py-2.5 rounded-xl text-sm leading-relaxed ${
                    msg.role === 'user'
                      ? 'bg-teal text-white rounded-br-sm'
                      : 'bg-white text-slate-ink border border-soft-steel/20 rounded-bl-sm shadow-sm'
                  }`}
                >
                  {msg.content}
                  {msg.actions && msg.actions.some(a => a.type === 'recommend_plan') && (
                    <div className="mt-2 pt-2 border-t border-white/20">
                      {msg.actions.filter(a => a.type === 'recommend_plan').map((a, j) => (
                        <button
                          key={j}
                          onClick={() => navigate(`/signup?plan=${a.data.plan}`)}
                          className="flex items-center gap-1.5 text-xs font-semibold text-white/90 hover:text-white mt-1"
                        >
                          Start {String(a.data.plan).charAt(0).toUpperCase() + String(a.data.plan).slice(1)} Trial
                          <ArrowRight className="h-3 w-3" />
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            ))}

            {loading && (
              <div className="flex justify-start">
                <div className="bg-white border border-soft-steel/20 rounded-xl rounded-bl-sm px-4 py-3 shadow-sm">
                  <div className="flex gap-1.5">
                    <span className="w-2 h-2 bg-soft-steel/40 rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
                    <span className="w-2 h-2 bg-soft-steel/40 rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
                    <span className="w-2 h-2 bg-soft-steel/40 rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
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
                    className="text-xs font-medium bg-white border border-teal/20 text-teal hover:bg-teal/5 px-3 py-1.5 rounded-full transition-colors"
                  >
                    {qa.label}
                  </button>
                ))}
              </div>
            )}

            <div ref={messagesEndRef} />
          </div>

          <div className="border-t border-soft-steel/20 p-3 bg-white shrink-0">
            {isListening && (
              <div className="flex items-center gap-2 mb-2 px-1">
                <div className="flex items-center gap-[2px] h-4">
                  {Array.from({ length: 8 }).map((_, i) => (
                    <div
                      key={i}
                      className="w-[3px] bg-teal rounded-full animate-pulse"
                      style={{
                        height: `${8 + Math.random() * 12}px`,
                        animationDelay: `${i * 0.1}s`,
                        animationDuration: `${0.5 + Math.random() * 0.5}s`,
                      }}
                    />
                  ))}
                </div>
                <span className="text-xs text-teal font-medium">Listening...</span>
              </div>
            )}
            <div className="flex gap-2">
              {voiceSupported && (
                <button
                  onClick={toggleVoice}
                  disabled={loading}
                  className={`p-2.5 rounded-xl transition-colors shrink-0 ${
                    isListening
                      ? 'bg-controlled-red text-white animate-pulse'
                      : 'bg-mist/50 text-harbor hover:bg-mist border border-soft-steel/20'
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
                className="flex-1 px-3.5 py-2.5 text-sm border border-soft-steel/30 rounded-xl bg-mist/30 text-harbor placeholder:text-soft-steel focus:outline-none focus:ring-2 focus:ring-teal/20 focus:border-teal/40 disabled:opacity-50"
              />
              <button
                onClick={() => sendMessage(input)}
                disabled={!input.trim() || loading}
                className="p-2.5 bg-teal hover:bg-teal-hover text-white rounded-xl transition-colors disabled:opacity-40 disabled:cursor-not-allowed shrink-0"
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
            ? 'bg-harbor hover:bg-harbor-light'
            : 'bg-teal hover:bg-teal-hover hover:scale-105'
        }`}
        aria-label={isOpen ? 'Close chat' : 'Open chat'}
      >
        {isOpen ? (
          <X className="h-5 w-5 text-white" />
        ) : (
          <>
            <MessageSquare className="h-5 w-5 text-white" />
            {showPulse && (
              <span className="absolute -top-0.5 -right-0.5 w-3.5 h-3.5 bg-controlled-red rounded-full border-2 border-white animate-pulse" />
            )}
          </>
        )}
      </button>
    </>
  );
}
