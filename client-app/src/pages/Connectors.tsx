import { useState, useEffect, useCallback } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import {
  X,
  CheckCircle2,
  Circle,
  Clock,
  Unplug,
  ExternalLink,
  Zap,
  Phone,
  Calendar,
  MessageSquare,
  Globe,
  BarChart3,
  Users,
  Briefcase,
  Mail,
} from 'lucide-react';
import { useRole } from '../lib/useRole';

interface Connector {
  integrationId: string;
  connectorType: string;
  provider: string;
  name: string;
  isEnabled: boolean;
  configKeys: string[];
  lastSyncAt: string | null;
  lastSyncStatus: string | null;
}

interface ConnectorDefinition {
  id: string;
  name: string;
  provider: string;
  connectorType: string;
  description: string;
  syncScope: string;
  icon: React.ReactNode;
  brandColor: string;
  fields: CredentialField[];
  events: string[];
  oauthProvider?: string;
}

interface CredentialField {
  key: string;
  label: string;
  type: 'text' | 'password';
  placeholder: string;
  required?: boolean;
}

const CONNECTOR_DEFINITIONS: ConnectorDefinition[] = [
  {
    id: 'hubspot',
    name: 'HubSpot',
    provider: 'hubspot',
    connectorType: 'crm',
    description: 'Automatically log calls, create contacts, and push AI summaries to your CRM.',
    syncScope: 'Calls, Contacts, Notes',
    icon: <BarChart3 className="h-6 w-6" />,
    brandColor: 'from-orange-500 to-orange-600',
    oauthProvider: 'hubspot',
    fields: [
      { key: 'access_token', label: 'Access Token', type: 'password', placeholder: 'HubSpot private app access token', required: true },
    ],
    events: ['call.completed', 'appointment.booked'],
  },
  {
    id: 'google-calendar',
    name: 'Google Calendar',
    provider: 'google-calendar',
    connectorType: 'scheduling',
    description: 'Sync appointments to your calendar and check availability before scheduling.',
    syncScope: 'Appointments, Availability',
    icon: <Calendar className="h-6 w-6" />,
    brandColor: 'from-blue-500 to-blue-600',
    oauthProvider: 'google',
    fields: [
      { key: 'client_id', label: 'Client ID', type: 'text', placeholder: 'Google OAuth Client ID', required: true },
      { key: 'client_secret', label: 'Client Secret', type: 'password', placeholder: 'Google OAuth Client Secret', required: true },
      { key: 'refresh_token', label: 'Refresh Token', type: 'password', placeholder: 'Google OAuth Refresh Token', required: true },
      { key: 'calendar_id', label: 'Calendar ID', type: 'text', placeholder: 'primary' },
      { key: 'timezone', label: 'Timezone', type: 'text', placeholder: 'America/New_York' },
    ],
    events: ['appointment.booked'],
  },
  {
    id: 'twilio-sms',
    name: 'Twilio SMS',
    provider: 'twilio',
    connectorType: 'sms',
    description: 'Send SMS notifications, escalation alerts, and follow-up messages.',
    syncScope: 'SMS, Escalations',
    icon: <Phone className="h-6 w-6" />,
    brandColor: 'from-red-500 to-red-600',
    fields: [
      { key: 'account_sid', label: 'Account SID', type: 'text', placeholder: 'ACxxx...', required: true },
      { key: 'auth_token', label: 'Auth Token', type: 'password', placeholder: 'Auth token', required: true },
      { key: 'from_number', label: 'From Number', type: 'text', placeholder: '+15551234567', required: true },
    ],
    events: ['sms.sent'],
  },
  {
    id: 'slack',
    name: 'Slack',
    provider: 'slack',
    connectorType: 'custom',
    description: 'Post call summaries and missed call alerts to your Slack channel automatically.',
    syncScope: 'Call Summaries, Alerts',
    icon: <MessageSquare className="h-6 w-6" />,
    brandColor: 'from-purple-500 to-purple-600',
    oauthProvider: 'slack',
    fields: [
      { key: 'bot_token', label: 'Bot Token', type: 'password', placeholder: 'xoxb-...', required: true },
      { key: 'channel_id', label: 'Channel ID', type: 'text', placeholder: 'C01XXXXXXXX', required: true },
    ],
    events: ['call.completed', 'call.missed', 'appointment.booked', 'ticket.created'],
  },
  {
    id: 'zapier',
    name: 'Zapier',
    provider: 'zapier',
    connectorType: 'webhook',
    description: 'Trigger Zapier workflows on platform events via webhooks.',
    syncScope: 'All Events (Webhook)',
    icon: <Zap className="h-6 w-6" />,
    brandColor: 'from-amber-500 to-amber-600',
    fields: [
      { key: 'webhook_url', label: 'Webhook URL', type: 'text', placeholder: 'https://hooks.zapier.com/hooks/catch/...', required: true },
      { key: 'api_key', label: 'API Key (optional)', type: 'password', placeholder: 'Optional signing secret' },
    ],
    events: ['call.completed', 'appointment.booked', 'sms.sent', 'ticket.created'],
  },
];

const COMING_SOON_CONNECTORS = [
  { name: 'Salesforce', icon: <Globe className="h-6 w-6" />, color: 'from-blue-400 to-blue-500' },
  { name: 'Pipedrive', icon: <Users className="h-6 w-6" />, color: 'from-green-500 to-green-600' },
  { name: 'Outlook Calendar', icon: <Mail className="h-6 w-6" />, color: 'from-sky-500 to-sky-600' },
  { name: 'QuickBooks', icon: <Briefcase className="h-6 w-6" />, color: 'from-emerald-500 to-emerald-600' },
];

function formatSyncTime(iso: string): string {
  const date = new Date(iso);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  const diffHr = Math.floor(diffMin / 60);
  const diffDays = Math.floor(diffHr / 24);

  if (diffMin < 1) return 'Just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  if (diffHr < 24) return `${diffHr}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString();
}

function ConnectModal({
  definition,
  onClose,
  existingConnector,
}: {
  definition: ConnectorDefinition;
  onClose: () => void;
  existingConnector?: Connector;
}) {
  const queryClient = useQueryClient();
  const [credentials, setCredentials] = useState<Record<string, string>>({});
  const [oauthPending, setOauthPending] = useState(false);
  const isReconnect = !!existingConnector;

  const handleOAuthMessage = useCallback((event: MessageEvent) => {
    if (event.origin !== window.location.origin) return;
    if (event.data?.type === 'oauth_complete' && event.data?.provider === definition.provider) {
      setOauthPending(false);
      queryClient.invalidateQueries({ queryKey: ['connectors'] });
      onClose();
    }
  }, [definition.provider, queryClient, onClose]);

  useEffect(() => {
    window.addEventListener('message', handleOAuthMessage);
    return () => window.removeEventListener('message', handleOAuthMessage);
  }, [handleOAuthMessage]);

  const startOAuth = async () => {
    if (!definition.oauthProvider) return;
    setOauthPending(true);
    try {
      const data = await api.get<{ authUrl: string }>(`/connectors/oauth/${definition.oauthProvider}/init`);
      const popup = window.open(data.authUrl, `oauth_${definition.oauthProvider}`, 'width=600,height=700,popup=yes');
      if (!popup) {
        setOauthPending(false);
        alert('Please allow popups for this site to connect via OAuth.');
      }
    } catch {
      setOauthPending(false);
    }
  };

  const connectMutation = useMutation({
    mutationFn: (creds: Record<string, string>) =>
      api.post('/connectors', {
        connectorType: definition.connectorType,
        provider: definition.provider,
        name: definition.name,
        credentials: creds,
        isEnabled: true,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['connectors'] });
      onClose();
    },
  });

  const setCred = (key: string, val: string) =>
    setCredentials((prev) => ({ ...prev, [key]: val }));

  const requiredFilled = definition.fields
    .filter((f) => f.required !== false)
    .every((f) => (credentials[f.key] ?? '').trim().length > 0);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4">
      <div className="bg-surface border border-border rounded-xl shadow-lg w-full max-w-md max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <div className="flex items-center gap-3">
            <div className={`w-9 h-9 rounded-lg bg-gradient-to-br ${definition.brandColor} flex items-center justify-center text-white`}>
              {definition.icon}
            </div>
            <div>
              <h2 className="text-lg font-semibold text-text-primary">
                {isReconnect ? 'Reconnect' : 'Connect'} {definition.name}
              </h2>
              <p className="text-xs text-text-secondary">{definition.description}</p>
            </div>
          </div>
          <button onClick={onClose}><X className="h-5 w-5 text-text-secondary" /></button>
        </div>

        <div className="p-5 space-y-4">
          {definition.oauthProvider && (
            <div>
              <button
                onClick={startOAuth}
                disabled={oauthPending}
                className="w-full text-sm font-medium bg-primary text-white hover:bg-primary-hover transition px-4 py-2.5 rounded-lg disabled:opacity-50 flex items-center justify-center gap-2"
              >
                {oauthPending ? (
                  <>Waiting for authorization...</>
                ) : (
                  <>
                    <ExternalLink className="h-4 w-4" />
                    Connect with {definition.name} (OAuth)
                  </>
                )}
              </button>
              <div className="relative my-4">
                <div className="absolute inset-0 flex items-center">
                  <div className="w-full border-t border-border" />
                </div>
                <div className="relative flex justify-center text-xs">
                  <span className="bg-surface px-2 text-text-secondary">or enter credentials manually</span>
                </div>
              </div>
            </div>
          )}

          <form
            onSubmit={(e) => {
              e.preventDefault();
              connectMutation.mutate(credentials);
            }}
            className="space-y-4"
          >
            <div className="space-y-3">
              {definition.fields.map((field) => (
                <div key={field.key}>
                  <label className="block text-sm font-medium text-text-primary mb-1">
                    {field.label}
                    {field.required !== false && <span className="text-danger ml-0.5">*</span>}
                  </label>
                  <input
                    type={field.type}
                    value={credentials[field.key] ?? ''}
                    onChange={(e) => setCred(field.key, e.target.value)}
                    placeholder={field.placeholder}
                    className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-text-primary text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
                  />
                </div>
              ))}
            </div>

            <div className="bg-surface-hover/50 rounded-lg p-3">
              <p className="text-xs font-medium text-text-secondary mb-1.5">Events this connector handles:</p>
              <div className="flex flex-wrap gap-1.5">
                {definition.events.map((event) => (
                  <span key={event} className="text-xs bg-primary/10 text-primary px-2 py-0.5 rounded-full">
                    {event}
                  </span>
                ))}
              </div>
            </div>

            {connectMutation.error && (
              <p className="text-danger text-sm">{(connectMutation.error as Error).message}</p>
            )}

            <div className="flex justify-end gap-3 pt-2">
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-2 text-sm font-medium text-text-secondary rounded-lg border border-border hover:bg-surface-hover transition"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={connectMutation.isPending || !requiredFilled}
                className="px-4 py-2 text-sm font-medium bg-primary text-white rounded-lg hover:bg-primary-hover transition disabled:opacity-50"
              >
                {connectMutation.isPending ? 'Connecting...' : isReconnect ? 'Reconnect' : 'Connect'}
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}

function ConnectorCard({
  definition,
  connector,
  isManager,
  onConnect,
  onDisconnect,
}: {
  definition: ConnectorDefinition;
  connector?: Connector;
  isManager: boolean;
  onConnect: () => void;
  onDisconnect: () => void;
}) {
  const isConnected = !!connector && connector.isEnabled;
  const hasCredentials = !!connector;

  return (
    <div className={`bg-surface border rounded-xl p-5 shadow-sm transition-all hover:shadow-md ${isConnected ? 'border-green-300 dark:border-green-700' : 'border-border'}`}>
      <div className="flex items-start justify-between mb-3">
        <div className="flex items-center gap-3">
          <div className={`w-10 h-10 rounded-lg bg-gradient-to-br ${definition.brandColor} flex items-center justify-center text-white shadow-sm`}>
            {definition.icon}
          </div>
          <div>
            <h3 className="font-semibold text-text-primary">{definition.name}</h3>
            <p className="text-xs text-text-secondary">{definition.connectorType}</p>
          </div>
        </div>
        {isConnected ? (
          <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400">
            <CheckCircle2 className="h-3 w-3" /> Connected
          </span>
        ) : hasCredentials ? (
          <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400">
            <Circle className="h-3 w-3" /> Disabled
          </span>
        ) : (
          <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400">
            <Circle className="h-3 w-3" /> Not Connected
          </span>
        )}
      </div>

      <p className="text-sm text-text-secondary mb-3 line-clamp-2">{definition.description}</p>

      <div className="space-y-1.5 mb-4">
        <div className="flex items-center gap-2 text-xs text-text-secondary">
          <ExternalLink className="h-3 w-3 flex-shrink-0" />
          <span>Sync: {definition.syncScope}</span>
        </div>
        {isConnected && connector?.lastSyncAt && (
          <div className="flex items-center gap-2 text-xs text-text-secondary">
            <Clock className="h-3 w-3 flex-shrink-0" />
            <span>Last sync: {formatSyncTime(connector.lastSyncAt)}</span>
            {connector.lastSyncStatus === 'error' && (
              <span className="text-danger font-medium">(error)</span>
            )}
          </div>
        )}
        {isConnected && !connector?.lastSyncAt && (
          <div className="flex items-center gap-2 text-xs text-text-secondary">
            <Clock className="h-3 w-3 flex-shrink-0" />
            <span>Awaiting first sync</span>
          </div>
        )}
      </div>

      <div className="flex flex-wrap gap-1.5 mb-4">
        {definition.events.map((event) => (
          <span key={event} className="text-[10px] bg-surface-hover px-2 py-0.5 rounded-full text-text-secondary">
            {event}
          </span>
        ))}
      </div>

      {isManager && (
        <div className="flex gap-2 pt-3 border-t border-border">
          {isConnected ? (
            <>
              <button
                onClick={onConnect}
                className="flex-1 text-xs font-medium text-text-secondary hover:text-primary transition px-3 py-1.5 rounded-lg border border-border hover:border-primary/30"
              >
                Reconnect
              </button>
              <button
                onClick={onDisconnect}
                className="flex-1 text-xs font-medium text-danger hover:text-red-700 transition px-3 py-1.5 rounded-lg border border-border hover:border-danger/30 inline-flex items-center justify-center gap-1"
              >
                <Unplug className="h-3 w-3" /> Disconnect
              </button>
            </>
          ) : (
            <button
              onClick={onConnect}
              className="w-full text-sm font-medium bg-primary text-white hover:bg-primary-hover transition px-4 py-2 rounded-lg"
            >
              Connect
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export default function Connectors() {
  const [connectTarget, setConnectTarget] = useState<ConnectorDefinition | null>(null);
  const queryClient = useQueryClient();
  const { isManager } = useRole();

  const { data, isLoading } = useQuery({
    queryKey: ['connectors'],
    queryFn: () => api.get<{ connectors: Connector[]; total: number }>('/connectors?limit=100'),
  });

  const disconnectMutation = useMutation({
    mutationFn: (integrationId: string) => api.delete(`/connectors/${integrationId}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['connectors'] }),
  });

  const connectors = data?.connectors ?? [];

  const findConnector = (def: ConnectorDefinition): Connector | undefined =>
    connectors.find((c) => c.provider === def.provider);

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold text-text-primary">Integrations</h1>
        <p className="text-sm text-text-secondary mt-1">
          Connect your tools in one click. Events flow automatically to all active integrations.
        </p>
      </div>

      {isLoading ? (
        <div className="text-center py-12 text-text-secondary">Loading integrations...</div>
      ) : (
        <>
          <div>
            <h2 className="text-lg font-semibold text-text-primary mb-4">Available Integrations</h2>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {CONNECTOR_DEFINITIONS.map((def) => {
                const existing = findConnector(def);
                return (
                  <ConnectorCard
                    key={def.id}
                    definition={def}
                    connector={existing}
                    isManager={isManager}
                    onConnect={() => setConnectTarget(def)}
                    onDisconnect={() => {
                      if (existing && confirm(`Disconnect ${def.name}? This will remove all stored credentials.`)) {
                        disconnectMutation.mutate(existing.integrationId);
                      }
                    }}
                  />
                );
              })}
            </div>
          </div>

          <div>
            <h2 className="text-lg font-semibold text-text-primary mb-1">Coming Soon</h2>
            <p className="text-sm text-text-secondary mb-4">Phase 2 integrations on our roadmap.</p>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              {COMING_SOON_CONNECTORS.map((c) => (
                <div
                  key={c.name}
                  className="bg-surface border border-border rounded-xl p-5 opacity-60 cursor-default"
                >
                  <div className="flex items-center gap-3 mb-2">
                    <div className={`w-10 h-10 rounded-lg bg-gradient-to-br ${c.color} flex items-center justify-center text-white shadow-sm`}>
                      {c.icon}
                    </div>
                    <h3 className="font-semibold text-text-primary">{c.name}</h3>
                  </div>
                  <span className="inline-block text-xs font-medium bg-surface-hover text-text-secondary px-2.5 py-1 rounded-full">
                    Coming Soon
                  </span>
                </div>
              ))}
            </div>
          </div>

          <div className="bg-surface border border-border rounded-xl p-5">
            <h3 className="text-sm font-semibold text-text-primary mb-2">Event Bus</h3>
            <p className="text-xs text-text-secondary mb-3">
              These platform events automatically push to all connected integrations:
            </p>
            <div className="flex flex-wrap gap-2">
              {['call.completed', 'appointment.booked', 'sms.sent', 'ticket.created'].map((event) => (
                <span key={event} className="inline-flex items-center gap-1.5 text-xs font-medium bg-primary/10 text-primary px-3 py-1.5 rounded-full">
                  <Zap className="h-3 w-3" />
                  {event}
                </span>
              ))}
            </div>
          </div>
        </>
      )}

      {connectTarget && (
        <ConnectModal
          definition={connectTarget}
          existingConnector={findConnector(connectTarget)}
          onClose={() => setConnectTarget(null)}
        />
      )}
    </div>
  );
}
