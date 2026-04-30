import { useEffect, useRef } from 'react';
import { User, Bot } from 'lucide-react';

export interface TranscriptMessage {
  id: string;
  speaker: 'caller' | 'agent';
  text: string;
  timestamp: string;
}

interface ConversationTranscriptProps {
  messages: TranscriptMessage[];
  isActive: boolean;
}

function formatTime(ts: string): string {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export default function ConversationTranscript({ messages, isActive }: ConversationTranscriptProps) {
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  return (
    <div className="bg-surface rounded-2xl border border-border-strong/50 p-6 flex flex-col h-full">
      <div className="flex items-center gap-2 mb-4">
        <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center">
          <Bot className="h-4 w-4 text-primary" />
        </div>
        <h3 className="font-display font-semibold text-text-primary">Live Transcript</h3>
        {isActive && (
          <span className="ml-auto flex items-center gap-1.5 text-xs text-success font-body">
            <span aria-hidden="true" className="w-2 h-2 bg-success rounded-full animate-pulse" />
            Live
          </span>
        )}
      </div>

      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto space-y-3 max-h-96 min-h-[200px] scroll-smooth"
      >
        {messages.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-text-primary/40 font-body">
            <Bot className="h-8 w-8 mb-2 opacity-40" />
            <p className="text-sm">
              {isActive ? 'Waiting for conversation...' : 'Call a demo line to see the transcript here'}
            </p>
          </div>
        ) : (
          messages.map((msg) => (
            <div
              key={msg.id}
              className={`flex gap-3 animate-[fadeSlideIn_0.3s_ease-out] ${
                msg.speaker === 'agent' ? 'flex-row' : 'flex-row-reverse'
              }`}
            >
              <div
                className={`w-7 h-7 rounded-full flex items-center justify-center shrink-0 ${
                  msg.speaker === 'agent'
                    ? 'bg-primary/10'
                    : 'bg-surface-muted'
                }`}
              >
                {msg.speaker === 'agent' ? (
                  <Bot className="h-3.5 w-3.5 text-primary" />
                ) : (
                  <User className="h-3.5 w-3.5 text-text-primary" />
                )}
              </div>
              <div
                className={`max-w-[80%] ${
                  msg.speaker === 'agent' ? 'text-left' : 'text-right'
                }`}
              >
                <div className="flex items-center gap-2 mb-0.5">
                  <span className="text-[10px] font-semibold uppercase tracking-wide text-text-primary/50 font-body">
                    {msg.speaker === 'agent' ? 'Agent' : 'Caller'}
                  </span>
                  <span className="text-[10px] text-text-primary/30 font-body">
                    {formatTime(msg.timestamp)}
                  </span>
                </div>
                <div
                  className={`inline-block px-3.5 py-2 rounded-2xl text-sm font-body leading-relaxed ${
                    msg.speaker === 'agent'
                      ? 'bg-primary/5 text-text-primary/80 rounded-tl-sm'
                      : 'bg-surface-secondary text-text-primary/80 rounded-tr-sm'
                  }`}
                >
                  {msg.text}
                </div>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
