import { useEffect, useState } from 'react';
import { Phone, Calendar, CheckCircle2, Mic } from 'lucide-react';
import { reducedMotion } from '../hooks/useScrollReveal';

type Turn = {
  speaker: 'caller' | 'agent';
  text: string;
  tag?: string;
};

const SCRIPT: Turn[] = [
  { speaker: 'caller', text: 'Hi, I need to schedule a cleaning for my daughter.' },
  { speaker: 'agent', text: 'Happy to help. Is this her first visit with us?', tag: 'Intent: book_appointment' },
  { speaker: 'caller', text: 'Yes, she\'s been seeing Dr. Morgan across town.' },
  { speaker: 'agent', text: 'Got it. I have Thursday at 3:30 or Friday at 10:15 with Dr. Chen.', tag: 'Calendar check · 0.4s' },
  { speaker: 'caller', text: 'Thursday works great.' },
  { speaker: 'agent', text: 'Booked. I\'ll text a confirmation with the intake form.', tag: 'Action: send_sms' },
];

export default function LiveTranscriptMock() {
  const [visible, setVisible] = useState(reducedMotion ? SCRIPT.length : 0);
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (reducedMotion) return;
    if (visible >= SCRIPT.length) {
      const reset = setTimeout(() => {
        setVisible(0);
        setElapsed(0);
      }, 4500);
      return () => clearTimeout(reset);
    }
    const delay = visible === 0 ? 600 : 1400;
    const t = setTimeout(() => setVisible((v) => v + 1), delay);
    return () => clearTimeout(t);
  }, [visible]);

  useEffect(() => {
    if (reducedMotion) return;
    const t = setInterval(() => setElapsed((e) => e + 1), 1000);
    return () => clearInterval(t);
  }, []);

  const mins = Math.floor(elapsed / 60);
  const secs = (elapsed % 60).toString().padStart(2, '0');

  return (
    <div className="relative">
      {/* Outer frame: simulated browser/window chrome */}
      <div className="rounded-2xl bg-gradient-to-b from-white/[0.08] to-white/[0.02] border border-white/15 shadow-2xl backdrop-blur-sm overflow-hidden">
        {/* Title bar */}
        <div className="flex items-center justify-between px-4 py-2.5 border-b border-white/10 bg-black/20">
          <div className="flex items-center gap-1.5" aria-hidden="true">
            <span className="w-2.5 h-2.5 rounded-full bg-red-400/70" />
            <span className="w-2.5 h-2.5 rounded-full bg-yellow-400/70" />
            <span className="w-2.5 h-2.5 rounded-full bg-green-400/70" />
          </div>
          <div className="flex items-center gap-2 text-[11px] text-white/50 font-body">
            <span aria-hidden="true" className="w-1.5 h-1.5 rounded-full bg-green-400 motion-safe:animate-pulse" />
            Live Call · Dental Scheduler
          </div>
          <div className="text-[11px] text-white/40 font-mono tabular-nums">
            {mins}:{secs}
          </div>
        </div>

        {/* Caller header */}
        <div className="flex items-center gap-3 px-5 py-4 border-b border-white/10 bg-white/[0.02]">
          <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-primary to-success/60 flex items-center justify-center shadow-lg">
            <Phone className="h-4 w-4 text-white" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-white leading-tight">+1 (415) 555-0142</p>
            <p className="text-xs text-white/50 leading-tight mt-0.5">New caller · San Francisco, CA</p>
          </div>
          <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-success/15 border border-success/25">
            <span aria-hidden="true" className="w-1.5 h-1.5 rounded-full bg-success motion-safe:animate-pulse" />
            <span className="text-[11px] font-semibold uppercase tracking-wider text-success">Live</span>
          </div>
        </div>

        {/* Transcript */}
        <div className="px-5 py-4 space-y-3 min-h-[280px] max-h-[280px] overflow-hidden">
          {SCRIPT.slice(0, visible).map((turn, i) => (
            <div
              key={i}
              className={`flex gap-2.5 ${turn.speaker === 'agent' ? 'justify-start' : 'justify-end'} transition-all duration-500 ease-out`}
              style={{
                opacity: 1,
                transform: 'translateY(0)',
                animation: reducedMotion ? undefined : 'transcript-fade-in 0.5s ease-out',
              }}
            >
              {turn.speaker === 'agent' && (
                <div className="w-7 h-7 rounded-lg bg-primary/20 border border-primary/30 flex items-center justify-center shrink-0">
                  <Mic className="h-3 w-3 text-primary" />
                </div>
              )}
              <div className={`max-w-[78%] ${turn.speaker === 'agent' ? '' : 'text-right'}`}>
                <p className="text-[11px] uppercase tracking-wider font-semibold mb-1 text-white/55">
                  {turn.speaker === 'agent' ? 'QVO Agent' : 'Caller'}
                </p>
                <div
                  className={`inline-block rounded-xl px-3.5 py-2 text-sm leading-snug text-left ${
                    turn.speaker === 'agent'
                      ? 'bg-primary/15 border border-primary/25 text-white'
                      : 'bg-white/10 border border-white/15 text-white/90'
                  }`}
                >
                  {turn.text}
                </div>
                {turn.tag && (
                  <p className="text-[10px] font-mono text-primary/70 mt-1.5">{turn.tag}</p>
                )}
              </div>
            </div>
          ))}
          {visible < SCRIPT.length && !reducedMotion && (
            <div className="flex gap-2.5 items-center">
              <div className="w-7 h-7 rounded-lg bg-primary/20 border border-primary/30 flex items-center justify-center shrink-0">
                <Mic className="h-3 w-3 text-primary" />
              </div>
              <div
                className="flex items-center gap-1 px-3.5 py-2.5 rounded-xl bg-primary/10 border border-primary/20"
                role="status"
                aria-label="Agent is typing a response"
              >
                <span aria-hidden="true" className="w-1.5 h-1.5 rounded-full bg-primary/70 motion-safe:animate-bounce [animation-delay:-0.3s]" />
                <span aria-hidden="true" className="w-1.5 h-1.5 rounded-full bg-primary/70 motion-safe:animate-bounce [animation-delay:-0.15s]" />
                <span aria-hidden="true" className="w-1.5 h-1.5 rounded-full bg-primary/70 motion-safe:animate-bounce" />
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Floating "action taken" card */}
      <div className="absolute -bottom-5 -right-4 glass-card rounded-xl p-3.5 shadow-xl border border-white/15 bg-sidebar-bg/80 backdrop-blur-md max-w-[240px]">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-lg bg-success/20 border border-success/30 flex items-center justify-center shrink-0">
            <Calendar className="w-4 h-4 text-success" />
          </div>
          <div className="min-w-0">
            <p className="text-xs font-semibold text-white leading-tight">Appointment booked</p>
            <p className="text-[10px] text-white/55 leading-tight mt-0.5 truncate">Thu 3:30 PM · Dr. Chen · SMS sent</p>
          </div>
        </div>
      </div>

      {/* Floating outcome badge */}
      <div className="absolute -top-4 -left-4 glass-card rounded-xl p-3 shadow-xl border border-white/15 bg-sidebar-bg/80 backdrop-blur-md">
        <div className="flex items-center gap-2">
          <div className="w-6 h-6 rounded-full bg-primary/20 flex items-center justify-center">
            <CheckCircle2 className="w-3.5 h-3.5 text-primary" />
          </div>
          <div>
            <p className="text-[10px] font-semibold text-white leading-tight">Resolved in 1 call</p>
            <p className="text-[9px] text-white/50 leading-tight">$0 dispatched to voicemail</p>
          </div>
        </div>
      </div>
    </div>
  );
}
