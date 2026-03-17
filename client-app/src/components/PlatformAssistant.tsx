import { useState, useRef, useEffect, useCallback } from 'react';
import { useLocation } from 'react-router-dom';
import { api } from '../lib/api';
import { MessageSquare, X, Send, Loader2, Bot, User, Sparkles, AlertCircle } from 'lucide-react';

interface AssistantMessage {
  role: 'user' | 'assistant';
  content: string;
  actions?: Array<{ action: string; status: string; message?: string }>;
  timestamp?: string;
}

interface ChatResponse {
  sessionId: string;
  response: string;
  actions: Array<{ action: string; status: string; message?: string; result?: unknown }>;
}

const QUICK_ACTIONS = [
  { label: 'Create an agent', prompt: 'Help me create a new agent' },
  { label: 'Connect integration', prompt: 'How do I connect an integration?' },
  { label: 'Set up phone number', prompt: 'How do I set up a phone number?' },
  { label: 'Help with billing', prompt: 'Tell me about the billing plans' },
];

export default function PlatformAssistant() {
  const location = useLocation();
  const [isOpen, setIsOpen] = useState(false);
  const [messages, setMessages] = useState<AssistantMessage[]>([]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [messages, scrollToBottom]);

  useEffect(() => {
    if (isOpen && inputRef.current) {
      inputRef.current.focus();
    }
  }, [isOpen]);

  const sendMessage = async (messageText: string) => {
    if (!messageText.trim() || isLoading) return;

    const userMessage: AssistantMessage = {
      role: 'user',
      content: messageText.trim(),
      timestamp: new Date().toISOString(),
    };

    setMessages((prev) => [...prev, userMessage]);
    setInput('');
    setIsLoading(true);
    setError(null);

    try {
      const result = await api.post<ChatResponse>('/assistant/chat', {
        message: messageText.trim(),
        sessionId,
        pageContext: location.pathname,
      });

      setSessionId(result.sessionId);

      const assistantMessage: AssistantMessage = {
        role: 'assistant',
        content: result.response,
        actions: result.actions,
        timestamp: new Date().toISOString(),
      };

      setMessages((prev) => [...prev, assistantMessage]);
    } catch (err) {
      setError('Failed to get a response. Please try again.');
    } finally {
      setIsLoading(false);
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    sendMessage(input);
  };

  const handleNewChat = () => {
    setMessages([]);
    setSessionId(null);
    setError(null);
  };

  const renderContent = (content: string) => {
    const parts: React.ReactNode[] = [];
    const lines = content.split('\n');
    lines.forEach((line, lineIdx) => {
      if (lineIdx > 0) parts.push(<br key={`br-${lineIdx}`} />);
      const segments = line.split(/(\*\*.*?\*\*)/g);
      segments.forEach((seg, segIdx) => {
        if (seg.startsWith('**') && seg.endsWith('**')) {
          parts.push(<strong key={`${lineIdx}-${segIdx}`}>{seg.slice(2, -2)}</strong>);
        } else {
          parts.push(seg);
        }
      });
    });
    return parts;
  };

  return (
    <>
      {!isOpen && (
        <button
          onClick={() => setIsOpen(true)}
          className="fixed bottom-6 right-6 z-50 w-14 h-14 rounded-full bg-primary text-white shadow-lg hover:shadow-xl hover:scale-105 transition-all duration-200 flex items-center justify-center group"
          aria-label="Open assistant"
        >
          <Sparkles className="h-6 w-6 group-hover:rotate-12 transition-transform" />
        </button>
      )}

      {isOpen && (
        <div className="fixed bottom-6 right-6 z-50 w-96 max-h-[600px] bg-surface border border-border rounded-2xl shadow-2xl flex flex-col overflow-hidden animate-in slide-in-from-bottom-4 duration-300">
          <div className="bg-primary text-white px-5 py-4 flex items-center justify-between shrink-0">
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 rounded-full bg-white/20 flex items-center justify-center">
                <Bot className="h-4 w-4" />
              </div>
              <div>
                <h3 className="text-sm font-semibold">QVO Assistant</h3>
                <p className="text-xs text-white/70">Platform guide</p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              {messages.length > 0 && (
                <button
                  onClick={handleNewChat}
                  className="text-white/60 hover:text-white text-xs bg-white/10 hover:bg-white/20 px-2 py-1 rounded transition-colors"
                >
                  New chat
                </button>
              )}
              <button
                onClick={() => setIsOpen(false)}
                className="text-white/60 hover:text-white transition-colors"
                aria-label="Close assistant"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
          </div>

          <div className="flex-1 overflow-y-auto p-4 space-y-4 min-h-0" style={{ maxHeight: '420px' }}>
            {messages.length === 0 && (
              <div className="space-y-4">
                <div className="flex gap-3">
                  <div className="w-7 h-7 rounded-full bg-primary/10 flex items-center justify-center shrink-0 mt-0.5">
                    <Bot className="h-3.5 w-3.5 text-primary" />
                  </div>
                  <div className="bg-surface-secondary rounded-xl rounded-tl-sm px-4 py-3 text-sm text-foreground">
                    Hi! I'm your QVO Platform Assistant. I can help you set up agents, connect integrations, and get the most out of the platform. What would you like help with?
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-2 pl-10">
                  {QUICK_ACTIONS.map((action) => (
                    <button
                      key={action.label}
                      onClick={() => sendMessage(action.prompt)}
                      className="text-xs text-left px-3 py-2 rounded-lg border border-border hover:bg-surface-secondary hover:border-primary/30 transition-colors text-muted"
                    >
                      {action.label}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {messages.map((msg, idx) => (
              <div key={idx} className={`flex gap-3 ${msg.role === 'user' ? 'flex-row-reverse' : ''}`}>
                <div className={`w-7 h-7 rounded-full flex items-center justify-center shrink-0 mt-0.5 ${
                  msg.role === 'user'
                    ? 'bg-primary text-white'
                    : 'bg-primary/10'
                }`}>
                  {msg.role === 'user'
                    ? <User className="h-3.5 w-3.5" />
                    : <Bot className="h-3.5 w-3.5 text-primary" />
                  }
                </div>
                <div className={`max-w-[80%] rounded-xl px-4 py-3 text-sm ${
                  msg.role === 'user'
                    ? 'bg-primary text-white rounded-tr-sm'
                    : 'bg-surface-secondary text-foreground rounded-tl-sm'
                }`}>
                  <div>{renderContent(msg.content)}</div>
                  {msg.actions && msg.actions.length > 0 && (
                    <div className="mt-2 space-y-1">
                      {msg.actions.map((action, aIdx) => (
                        <div key={aIdx} className={`text-xs px-2 py-1 rounded ${
                          action.status === 'success'
                            ? 'bg-green-500/20 text-green-200'
                            : 'bg-red-500/20 text-red-200'
                        }`}>
                          {action.status === 'success' ? '✓' : '✗'} {action.message || action.action}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            ))}

            {isLoading && (
              <div className="flex gap-3">
                <div className="w-7 h-7 rounded-full bg-primary/10 flex items-center justify-center shrink-0 mt-0.5">
                  <Bot className="h-3.5 w-3.5 text-primary" />
                </div>
                <div className="bg-surface-secondary rounded-xl rounded-tl-sm px-4 py-3">
                  <div className="flex items-center gap-2 text-sm text-muted">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    Thinking...
                  </div>
                </div>
              </div>
            )}

            {error && (
              <div className="flex items-center gap-2 text-xs text-red-500 px-3 py-2 bg-red-500/10 rounded-lg">
                <AlertCircle className="h-3.5 w-3.5 shrink-0" />
                {error}
              </div>
            )}

            <div ref={messagesEndRef} />
          </div>

          <form onSubmit={handleSubmit} className="p-3 border-t border-border shrink-0">
            <div className="flex gap-2">
              <input
                ref={inputRef}
                type="text"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder="Ask anything..."
                className="flex-1 px-3 py-2 text-sm rounded-lg border border-border bg-surface focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary text-foreground placeholder:text-muted"
                disabled={isLoading}
                maxLength={2000}
              />
              <button
                type="submit"
                disabled={!input.trim() || isLoading}
                className="px-3 py-2 rounded-lg bg-primary text-white hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                aria-label="Send message"
              >
                <Send className="h-4 w-4" />
              </button>
            </div>
          </form>
        </div>
      )}
    </>
  );
}
