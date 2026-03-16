import { useState, useEffect, useCallback } from 'react';
import { Phone, Activity, BarChart3, Headphones, Stethoscope, AlertCircle } from 'lucide-react';

const API_BASE = '/api';

interface DemoEvent {
  id: string;
  eventType: string;
  agentName: string;
  durationSeconds: number | null;
  timestamp: string;
}

interface DemoPhone {
  phoneNumber: string;
  friendlyName: string;
  agentTemplate: string | null;
  isPlaceholder: boolean;
}

function formatPhoneNumber(raw: string): string {
  const digits = raw.replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('1')) {
    return `+1 (${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}`;
  }
  return raw;
}

function formatEventType(type: string): string {
  const map: Record<string, string> = {
    call_started: 'Call Started',
    call_ended: 'Call Ended',
    workflow_triggered: 'Workflow Triggered',
  };
  return map[type] ?? type.replace(/_/g, ' ');
}

function eventColor(type: string): string {
  if (type === 'call_ended') return 'text-calm-green';
  if (type === 'call_started') return 'text-teal';
  if (type === 'workflow_triggered') return 'text-warm-amber';
  return 'text-soft-steel';
}

function timeAgo(ts: string): string {
  const diff = Date.now() - new Date(ts).getTime();
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function PhoneDisplay({ phone, variant }: { phone: DemoPhone | undefined; variant: 'teal' | 'harbor' }) {
  const bgClass = variant === 'teal' ? 'bg-teal/10 border-teal/20' : 'bg-harbor/10 border-harbor/20';
  const iconClass = variant === 'teal' ? 'text-teal' : 'text-harbor-light';
  const labelClass = variant === 'teal' ? 'text-teal' : 'text-harbor-light';

  if (!phone) {
    return (
      <div className={`flex items-center gap-3 ${bgClass} rounded-xl px-5 py-4 border`}>
        <AlertCircle className={`h-5 w-5 ${iconClass} shrink-0`} />
        <div>
          <p className={`text-xs ${labelClass} mb-0.5`}>Demo line</p>
          <p className="text-sm text-slate-ink/50">Not configured</p>
        </div>
      </div>
    );
  }

  if (phone.isPlaceholder) {
    return (
      <div className={`flex items-center gap-3 ${bgClass} rounded-xl px-5 py-4 border`}>
        <Phone className={`h-5 w-5 ${iconClass} shrink-0`} />
        <div>
          <p className={`text-xs ${labelClass} mb-0.5`}>Demo line — awaiting real number</p>
          <p className="text-sm text-slate-ink/50">Contact your administrator to provision a Twilio number</p>
        </div>
      </div>
    );
  }

  return (
    <div className={`flex items-center gap-3 ${bgClass} rounded-xl px-5 py-4 border`}>
      <Phone className={`h-5 w-5 ${iconClass} shrink-0`} />
      <div>
        <p className={`text-xs ${labelClass} mb-0.5`}>Call to try it</p>
        <p className="text-lg font-mono font-bold text-harbor">{formatPhoneNumber(phone.phoneNumber)}</p>
      </div>
    </div>
  );
}

export default function Demo() {
  const [events, setEvents] = useState<DemoEvent[]>([]);
  const [totalCalls, setTotalCalls] = useState(0);
  const [phones, setPhones] = useState<DemoPhone[]>([]);
  const [demoConfigured, setDemoConfigured] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchActivity = useCallback(async () => {
    try {
      const [activityRes, statsRes] = await Promise.all([
        fetch(`${API_BASE}/demo/activity`),
        fetch(`${API_BASE}/demo/stats`),
      ]);
      if (activityRes.ok) {
        const data = await activityRes.json();
        setEvents(data.events ?? []);
      }
      if (statsRes.ok) {
        const data = await statsRes.json();
        setTotalCalls(data.totalCalls ?? 0);
      }
    } catch {
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetch(`${API_BASE}/demo/phones`)
      .then((r) => r.json())
      .then((data) => {
        setPhones(data.phones ?? []);
        setDemoConfigured(data.configured ?? false);
      })
      .catch(() => {
        setDemoConfigured(false);
      });
  }, []);

  useEffect(() => {
    fetchActivity();
    const interval = setInterval(fetchActivity, 5000);
    return () => clearInterval(interval);
  }, [fetchActivity]);

  const answeringPhone = phones.find(
    (p) => p.agentTemplate === 'answering-service' || p.friendlyName.toLowerCase().includes('answering'),
  );
  const medicalPhone = phones.find(
    (p) => p.agentTemplate === 'medical-after-hours' || p.friendlyName.toLowerCase().includes('medical'),
  );

  return (
    <div>
      <section className="bg-harbor text-white py-16 lg:py-24">
        <div className="max-w-6xl mx-auto px-6 lg:px-8 text-center">
          <p className="text-teal font-display text-sm font-semibold tracking-wide uppercase mb-4">
            Live Demo
          </p>
          <h1 className="font-display text-4xl lg:text-5xl font-bold mb-4">
            Experience QVO live.
          </h1>
          <p className="text-lg text-white/70 font-body max-w-2xl mx-auto">
            Call one of our demo agents and hear what professional voice operations sound like. No signup required.
          </p>
        </div>
      </section>

      <section className="py-12 lg:py-16">
        <div className="max-w-6xl mx-auto px-6 lg:px-8">
          {demoConfigured === false && (
            <div className="mb-8 p-4 bg-warm-amber/10 border border-warm-amber/30 rounded-xl text-center text-warm-amber text-sm font-body">
              Demo phone lines are not yet provisioned. The demo system is ready but requires phone numbers to accept calls.
            </div>
          )}

          <div className="grid md:grid-cols-2 gap-8 mb-12">
            <div className="bg-white rounded-2xl border border-soft-steel/50 p-8 hover:border-teal/30 transition-colors">
              <div className="flex items-center gap-3 mb-4">
                <div className="w-10 h-10 rounded-xl bg-teal/10 flex items-center justify-center">
                  <Headphones className="h-5 w-5 text-teal" />
                </div>
                <h3 className="font-display text-xl font-semibold text-harbor">Answering Service</h3>
              </div>
              <p className="text-sm text-slate-ink/60 font-body mb-6 leading-relaxed">
                A professional answering service demo. The agent will greet you, take a message, and demonstrate professional call handling.
              </p>
              <PhoneDisplay phone={answeringPhone} variant="teal" />
            </div>

            <div className="bg-white rounded-2xl border border-soft-steel/50 p-8 hover:border-harbor/30 transition-colors">
              <div className="flex items-center gap-3 mb-4">
                <div className="w-10 h-10 rounded-xl bg-harbor/10 flex items-center justify-center">
                  <Stethoscope className="h-5 w-5 text-harbor" />
                </div>
                <h3 className="font-display text-xl font-semibold text-harbor">Medical After-Hours</h3>
              </div>
              <p className="text-sm text-slate-ink/60 font-body mb-6 leading-relaxed">
                An after-hours medical answering demo. The agent will collect your concern, assess urgency, and take a callback number.
              </p>
              <PhoneDisplay phone={medicalPhone} variant="harbor" />
            </div>
          </div>

          <div className="grid md:grid-cols-3 gap-6 mb-12">
            <div className="md:col-span-1 bg-white rounded-2xl border border-soft-steel/50 p-6">
              <div className="flex items-center gap-2 mb-4">
                <BarChart3 className="h-5 w-5 text-calm-green" />
                <h3 className="font-display font-semibold text-harbor">Demo Stats</h3>
              </div>
              <div className="text-center py-6">
                <p className="text-5xl font-display font-bold text-teal">
                  {loading ? '...' : totalCalls.toLocaleString()}
                </p>
                <p className="text-sm text-slate-ink/50 font-body mt-2">Total Demo Calls</p>
              </div>
              <p className="text-xs text-slate-ink/40 font-body text-center">
                Rate limited to 5 calls per hour per caller
              </p>
            </div>

            <div className="md:col-span-2 bg-white rounded-2xl border border-soft-steel/50 p-6">
              <div className="flex items-center gap-2 mb-4">
                <Activity className="h-5 w-5 text-teal" />
                <h3 className="font-display font-semibold text-harbor">Live Activity Feed</h3>
                <span className="ml-auto text-xs text-slate-ink/40 font-body">Updates every 5s</span>
              </div>
              {loading ? (
                <div className="flex items-center justify-center py-12">
                  <div className="animate-spin h-6 w-6 border-2 border-teal border-t-transparent rounded-full" />
                </div>
              ) : events.length === 0 ? (
                <div className="text-center py-12 text-slate-ink/40 font-body">
                  <p>No demo calls yet. Be the first to try it!</p>
                </div>
              ) : (
                <div className="space-y-2.5 max-h-80 overflow-y-auto">
                  {events.map((event) => (
                    <div
                      key={event.id}
                      className="flex items-center justify-between px-4 py-3 bg-mist rounded-lg"
                    >
                      <div className="flex items-center gap-3">
                        <span className={`text-xs font-medium font-body ${eventColor(event.eventType)}`}>
                          {formatEventType(event.eventType)}
                        </span>
                        <span className="text-sm text-slate-ink/70 font-body">{event.agentName}</span>
                      </div>
                      <div className="flex items-center gap-4 text-xs text-slate-ink/40 font-body">
                        {event.durationSeconds != null && (
                          <span>{event.durationSeconds}s</span>
                        )}
                        <span>{timeAgo(event.timestamp)}</span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          <div className="text-center text-sm text-slate-ink/50 font-body space-y-2">
            <p>
              Demo calls are handled by the same system used in production.
            </p>
          </div>
        </div>
      </section>
    </div>
  );
}
