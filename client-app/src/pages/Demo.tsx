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
  if (type === 'call_ended') return 'text-green-400';
  if (type === 'call_started') return 'text-blue-400';
  if (type === 'workflow_triggered') return 'text-yellow-400';
  return 'text-gray-400';
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

function PhoneDisplay({ phone, accentColor }: { phone: DemoPhone | undefined; accentColor: 'blue' | 'purple' }) {
  const bgClass = accentColor === 'blue' ? 'bg-blue-500/10 border-blue-500/20' : 'bg-purple-500/10 border-purple-500/20';
  const iconClass = accentColor === 'blue' ? 'text-blue-400' : 'text-purple-400';
  const labelClass = accentColor === 'blue' ? 'text-blue-300' : 'text-purple-300';

  if (!phone) {
    return (
      <div className={`flex items-center gap-3 ${bgClass} rounded-xl px-5 py-4 border`}>
        <AlertCircle className={`h-5 w-5 ${iconClass} shrink-0`} />
        <div>
          <p className={`text-xs ${labelClass} mb-0.5`}>Demo line</p>
          <p className="text-sm text-gray-400">Not configured</p>
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
          <p className="text-sm text-gray-400">Contact your administrator to provision a Twilio number</p>
        </div>
      </div>
    );
  }

  return (
    <div className={`flex items-center gap-3 ${bgClass} rounded-xl px-5 py-4 border`}>
      <Phone className={`h-5 w-5 ${iconClass} shrink-0`} />
      <div>
        <p className={`text-xs ${labelClass} mb-0.5`}>Call to try it</p>
        <p className="text-lg font-mono font-bold text-white">{formatPhoneNumber(phone.phoneNumber)}</p>
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
    <div className="min-h-screen bg-gradient-to-br from-gray-900 via-gray-800 to-gray-900 text-white">
      <header className="border-b border-white/10 px-6 py-4">
        <div className="max-w-6xl mx-auto flex items-center justify-between">
          <h1 className="text-xl font-bold tracking-tight">Voice AI Operations Hub</h1>
          <a
            href="/login"
            className="text-sm text-blue-400 hover:text-blue-300 transition-colors"
          >
            Sign In
          </a>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-6 py-12">
        <div className="text-center mb-12">
          <h2 className="text-4xl font-bold mb-4 bg-gradient-to-r from-blue-400 to-purple-400 bg-clip-text text-transparent">
            Experience Voice AI Live
          </h2>
          <p className="text-lg text-gray-300 max-w-2xl mx-auto">
            Call one of our demo agents and experience the power of AI-driven
            voice interactions. No signup required.
          </p>
        </div>

        {demoConfigured === false && (
          <div className="mb-8 p-4 bg-yellow-500/10 border border-yellow-500/30 rounded-xl text-center text-yellow-300 text-sm">
            Demo phone lines are not yet provisioned. The demo system is ready but requires real Twilio phone numbers to accept calls.
          </div>
        )}

        <div className="grid md:grid-cols-2 gap-8 mb-12">
          <div className="bg-white/5 border border-white/10 rounded-2xl p-8 hover:border-blue-500/50 transition-colors">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 rounded-lg bg-blue-500/20 flex items-center justify-center">
                <Headphones className="h-5 w-5 text-blue-400" />
              </div>
              <h3 className="text-xl font-semibold">Answering Service</h3>
            </div>
            <p className="text-gray-400 mb-6">
              A professional answering service demo. Aria will greet you, take a
              message, and demonstrate professional call handling.
            </p>
            <PhoneDisplay phone={answeringPhone} accentColor="blue" />
          </div>

          <div className="bg-white/5 border border-white/10 rounded-2xl p-8 hover:border-purple-500/50 transition-colors">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 rounded-lg bg-purple-500/20 flex items-center justify-center">
                <Stethoscope className="h-5 w-5 text-purple-400" />
              </div>
              <h3 className="text-xl font-semibold">Medical After-Hours</h3>
            </div>
            <p className="text-gray-400 mb-6">
              An after-hours medical answering demo. Aria will collect your
              concern, assess urgency, and take a callback number.
            </p>
            <PhoneDisplay phone={medicalPhone} accentColor="purple" />
          </div>
        </div>

        <div className="grid md:grid-cols-3 gap-6 mb-12">
          <div className="md:col-span-1 bg-white/5 border border-white/10 rounded-2xl p-6">
            <div className="flex items-center gap-2 mb-4">
              <BarChart3 className="h-5 w-5 text-green-400" />
              <h3 className="font-semibold">Demo Stats</h3>
            </div>
            <div className="text-center py-6">
              <p className="text-5xl font-bold text-green-400">
                {loading ? '...' : totalCalls.toLocaleString()}
              </p>
              <p className="text-sm text-gray-400 mt-2">Total Demo Calls</p>
            </div>
            <p className="text-xs text-gray-500 text-center">
              Rate limited to 5 calls per hour per caller
            </p>
          </div>

          <div className="md:col-span-2 bg-white/5 border border-white/10 rounded-2xl p-6">
            <div className="flex items-center gap-2 mb-4">
              <Activity className="h-5 w-5 text-blue-400" />
              <h3 className="font-semibold">Live Activity Feed</h3>
              <span className="ml-auto text-xs text-gray-500">Updates every 5s</span>
            </div>
            {loading ? (
              <div className="flex items-center justify-center py-12">
                <div className="animate-spin h-6 w-6 border-2 border-blue-400 border-t-transparent rounded-full" />
              </div>
            ) : events.length === 0 ? (
              <div className="text-center py-12 text-gray-500">
                <p>No demo calls yet. Be the first to try it!</p>
              </div>
            ) : (
              <div className="space-y-3 max-h-80 overflow-y-auto">
                {events.map((event) => (
                  <div
                    key={event.id}
                    className="flex items-center justify-between px-4 py-3 bg-white/5 rounded-lg"
                  >
                    <div className="flex items-center gap-3">
                      <span className={`text-xs font-medium ${eventColor(event.eventType)}`}>
                        {formatEventType(event.eventType)}
                      </span>
                      <span className="text-sm text-gray-300">{event.agentName}</span>
                    </div>
                    <div className="flex items-center gap-4 text-xs text-gray-500">
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

        <div className="text-center text-sm text-gray-500 space-y-2">
          <p>
            Demo calls are handled by the same AI engine used in production.
          </p>
          <p>
            Ready to get started?{' '}
            <a href="/login" className="text-blue-400 hover:text-blue-300 transition-colors">
              Create your account
            </a>{' '}
            and deploy your own voice AI agents.
          </p>
        </div>
      </main>
    </div>
  );
}
