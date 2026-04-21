import { useState, useEffect, useCallback, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import {
  X,
  CheckCircle2,
  AlertCircle,
  Clock,
  Unplug,
  ExternalLink,
  Zap,
  Search,
  Plug,
  Settings,
  RefreshCw,
} from 'lucide-react';
import { useRole } from '../lib/useRole';
import BrandLogo from '../components/BrandLogo';

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

type Category = 'CRM' | 'Scheduling' | 'SMS' | 'Notifications' | 'Automation' | 'Ticketing' | 'Accounting';

interface ConnectorDefinition {
  id: string;
  name: string;
  provider: string;
  connectorType: string;
  category: Category;
  description: string;
  syncScope: string;
  logoId: string;
  fields: CredentialField[];
  events: string[];
  oauthProvider?: string;
  docsUrl?: string;
  setupHelp?: string;
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
    category: 'CRM',
    description: 'Automatically log calls, create contacts, and push AI summaries to your CRM.',
    syncScope: 'Calls, Contacts, Notes',
    logoId: 'hubspot',
    oauthProvider: 'hubspot',
    docsUrl: 'https://developers.hubspot.com/docs/api/private-apps',
    setupHelp: 'Create a private app in HubSpot and copy the access token, or sign in with OAuth below.',
    fields: [
      { key: 'access_token', label: 'Access Token', type: 'password', placeholder: 'HubSpot private app access token', required: true },
    ],
    events: ['call.completed', 'appointment.booked'],
  },
  {
    id: 'salesforce',
    name: 'Salesforce',
    provider: 'salesforce',
    connectorType: 'crm',
    category: 'CRM',
    description: 'Log calls and AI summaries against the right Contact, Lead, or Opportunity in Salesforce.',
    syncScope: 'Calls, Contacts, Leads, Tasks',
    logoId: 'salesforce',
    oauthProvider: 'salesforce',
    docsUrl: 'https://help.salesforce.com/s/articleView?id=sf.connected_app_create.htm',
    setupHelp: 'Sign in with Salesforce to authorize QVO. For sandbox orgs, set SALESFORCE_LOGIN_URL=https://test.salesforce.com on the server.',
    fields: [
      { key: 'access_token', label: 'Access Token', type: 'password', placeholder: 'Salesforce session/access token', required: true },
      { key: 'instance_url', label: 'Instance URL', type: 'text', placeholder: 'https://your-domain.my.salesforce.com', required: true },
      { key: 'refresh_token', label: 'Refresh Token', type: 'password', placeholder: 'Salesforce refresh token (recommended)' },
    ],
    events: ['call.completed', 'appointment.booked'],
  },
  {
    id: 'google-calendar',
    name: 'Google Calendar',
    provider: 'google-calendar',
    connectorType: 'scheduling',
    category: 'Scheduling',
    description: 'Sync appointments to your calendar and check availability before scheduling.',
    syncScope: 'Appointments, Availability',
    logoId: 'google-calendar',
    oauthProvider: 'google',
    docsUrl: 'https://developers.google.com/calendar/api/guides/auth',
    setupHelp: 'Sign in with Google to grant calendar access, or paste OAuth client credentials manually.',
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
    id: 'outlook-calendar',
    name: 'Outlook Calendar',
    provider: 'outlook-calendar',
    connectorType: 'scheduling',
    category: 'Scheduling',
    description: 'Sync appointments to your Microsoft 365 calendar with real-time availability checks.',
    syncScope: 'Appointments, Availability',
    logoId: 'outlook-calendar',
    oauthProvider: 'outlook',
    docsUrl: 'https://learn.microsoft.com/en-us/graph/auth-v2-user',
    setupHelp: 'Sign in with Microsoft to grant calendar access, or paste OAuth client credentials manually.',
    fields: [
      { key: 'client_id', label: 'Client ID', type: 'text', placeholder: 'Microsoft Entra App Client ID', required: true },
      { key: 'client_secret', label: 'Client Secret', type: 'password', placeholder: 'Microsoft Entra App Client Secret', required: true },
      { key: 'refresh_token', label: 'Refresh Token', type: 'password', placeholder: 'Microsoft OAuth Refresh Token', required: true },
      { key: 'calendar_id', label: 'Calendar ID', type: 'text', placeholder: 'Leave blank for primary' },
      { key: 'timezone', label: 'Timezone', type: 'text', placeholder: 'America/New_York' },
    ],
    events: ['appointment.booked'],
  },
  {
    id: 'twilio-sms',
    name: 'Twilio SMS',
    provider: 'twilio',
    connectorType: 'sms',
    category: 'SMS',
    description: 'Send SMS notifications, escalation alerts, and follow-up messages.',
    syncScope: 'SMS, Escalations',
    logoId: 'twilio',
    docsUrl: 'https://www.twilio.com/docs/iam/keys/api-key',
    setupHelp: 'Find your Account SID and Auth Token in the Twilio Console under Account → API keys & tokens.',
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
    category: 'Notifications',
    description: 'Post call summaries and missed call alerts to your Slack channel automatically.',
    syncScope: 'Call Summaries, Alerts',
    logoId: 'slack',
    oauthProvider: 'slack',
    docsUrl: 'https://api.slack.com/authentication/token-types#bot',
    setupHelp: 'Sign in with Slack to add the QVO app to a workspace, or paste a bot token from your Slack app.',
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
    category: 'Automation',
    description: 'Trigger Zapier workflows on platform events via webhooks.',
    syncScope: 'All Events (Webhook)',
    logoId: 'zapier',
    docsUrl: 'https://zapier.com/help/create/code-webhooks/trigger-zaps-from-webhooks',
    setupHelp: 'In Zapier, create a Zap with a "Webhooks by Zapier" trigger and paste the catch URL below.',
    fields: [
      { key: 'webhook_url', label: 'Webhook URL', type: 'text', placeholder: 'https://hooks.zapier.com/hooks/catch/...', required: true },
      { key: 'api_key', label: 'API Key (optional)', type: 'password', placeholder: 'Optional signing secret' },
    ],
    events: ['call.completed', 'appointment.booked', 'sms.sent', 'ticket.created'],
  },
  {
    id: 'webhook',
    name: 'Custom Webhook',
    provider: 'webhook',
    connectorType: 'webhook',
    category: 'Automation',
    description: 'Send platform events to any HTTPS endpoint. Pair with Make, n8n, or your own service.',
    syncScope: 'All Events (Webhook)',
    logoId: 'webhook',
    setupHelp: 'Provide an HTTPS endpoint that accepts JSON POSTs. Optionally set a signing secret for HMAC verification.',
    fields: [
      { key: 'webhook_url', label: 'Webhook URL', type: 'text', placeholder: 'https://your-service.example.com/hooks/qvo', required: true },
      { key: 'signing_secret', label: 'Signing Secret (optional)', type: 'password', placeholder: 'Used to compute the X-QVO-Signature header' },
    ],
    events: ['call.completed', 'appointment.booked', 'sms.sent', 'ticket.created'],
  },
  {
    id: 'pipedrive',
    name: 'Pipedrive',
    provider: 'pipedrive',
    connectorType: 'crm',
    category: 'CRM',
    description: 'Sync contacts and deals to Pipedrive. Calls and meetings attach to the right open deal automatically.',
    syncScope: 'Contacts, Deals, Activities',
    logoId: 'pipedrive',
    oauthProvider: 'pipedrive',
    docsUrl: 'https://developers.pipedrive.com/docs/api/v1/oauth-authorization',
    setupHelp: 'Sign in with Pipedrive (OAuth) or paste a personal API token from Settings → Personal preferences → API.',
    fields: [
      { key: 'api_token', label: 'API Token', type: 'password', placeholder: 'Pipedrive personal API token', required: true },
      { key: 'company_domain', label: 'Company Domain', type: 'text', placeholder: 'yourcompany (from yourcompany.pipedrive.com)' },
    ],
    events: ['call.completed', 'appointment.booked'],
  },
  {
    id: 'quickbooks',
    name: 'QuickBooks',
    provider: 'quickbooks',
    connectorType: 'accounting',
    category: 'Accounting',
    description: 'Sync customers and create invoices when calls complete. Pair with your service catalog item to auto-bill jobs booked by the agent.',
    syncScope: 'Customers, Invoices',
    logoId: 'quickbooks',
    oauthProvider: 'quickbooks',
    docsUrl: 'https://developer.intuit.com/app/developer/qbo/docs/develop/authentication-and-authorization/oauth-2.0',
    setupHelp: 'Sign in with QuickBooks (OAuth). Set the invoice item and default amount to enable auto-invoicing on call.completed.',
    fields: [
      { key: 'access_token', label: 'Access Token', type: 'password', placeholder: 'QuickBooks OAuth access token', required: true },
      { key: 'realm_id', label: 'Company (Realm) ID', type: 'text', placeholder: '4620816365xxxxxx', required: true },
      { key: 'environment', label: 'Environment', type: 'text', placeholder: 'production or sandbox' },
      { key: 'invoice_item_id', label: 'Invoice Item ID (optional)', type: 'text', placeholder: 'Item ref to bill on call.completed' },
      { key: 'default_invoice_amount', label: 'Default Invoice Amount (optional)', type: 'text', placeholder: 'e.g. 75.00' },
    ],
    events: ['call.completed', 'appointment.booked'],
  },
  {
    id: 'custom-ticketing',
    name: 'Custom Ticketing',
    provider: 'custom-ticketing',
    connectorType: 'ticketing',
    category: 'Ticketing',
    description: 'Create tickets in your help-desk via a generic adapter. Bring your own endpoint and auth.',
    syncScope: 'Tickets',
    logoId: 'custom-ticketing',
    setupHelp: 'Provide the create-ticket endpoint and an API key. Field mapping is configured per-tenant.',
    fields: [
      { key: 'endpoint_url', label: 'Endpoint URL', type: 'text', placeholder: 'https://helpdesk.example.com/api/tickets', required: true },
      { key: 'api_key', label: 'API Key', type: 'password', placeholder: 'Bearer token or API key', required: true },
    ],
    events: ['ticket.created'],
  },
];

const CATEGORIES: Category[] = ['CRM', 'Scheduling', 'SMS', 'Notifications', 'Automation', 'Ticketing', 'Accounting'];

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
        <div className="flex items-start justify-between px-5 py-4 border-b border-border">
          <div className="flex items-center gap-3">
            <BrandLogo provider={definition.logoId} size={40} />
            <div>
              <h2 className="text-lg font-semibold text-text-primary">
                {isReconnect ? 'Reconnect' : 'Connect'} {definition.name}
              </h2>
              <p className="text-xs text-text-secondary">{definition.category}</p>
            </div>
          </div>
          <button onClick={onClose} aria-label="Close">
            <X className="h-5 w-5 text-text-secondary" />
          </button>
        </div>

        <div className="p-5 space-y-4">
          <p className="text-sm text-text-secondary">{definition.description}</p>

          {definition.setupHelp && (
            <div className="rounded-lg border border-border bg-surface-hover/40 p-3 text-xs text-text-secondary">
              {definition.setupHelp}
              {definition.docsUrl && (
                <>
                  {' '}
                  <a
                    href={definition.docsUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-primary hover:underline inline-flex items-center gap-0.5"
                  >
                    Find your credentials in {definition.name} docs
                    <ExternalLink className="h-3 w-3" />
                  </a>
                </>
              )}
            </div>
          )}

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

function ConnectedCard({
  definition,
  connector,
  isManager,
  onReconnect,
  onDisconnect,
}: {
  definition: ConnectorDefinition;
  connector: Connector;
  isManager: boolean;
  onReconnect: () => void;
  onDisconnect: () => void;
}) {
  const enabled = connector.isEnabled;
  const syncError = connector.lastSyncStatus === 'error';

  return (
    <div className="bg-surface border border-border rounded-xl p-5 shadow-sm hover:shadow-md transition-all">
      <div className="flex items-start justify-between gap-3 mb-3">
        <div className="flex items-center gap-3 min-w-0">
          <BrandLogo provider={definition.logoId} size={36} />
          <div className="min-w-0">
            <h3 className="font-semibold text-text-primary truncate">{definition.name}</h3>
            <p className="text-xs text-text-secondary">{definition.category}</p>
          </div>
        </div>
        {enabled && !syncError ? (
          <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400 whitespace-nowrap">
            <CheckCircle2 className="h-3 w-3" /> Connected
          </span>
        ) : syncError ? (
          <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400 whitespace-nowrap">
            <AlertCircle className="h-3 w-3" /> Sync error
          </span>
        ) : (
          <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400 whitespace-nowrap">
            Disabled
          </span>
        )}
      </div>

      <div className="space-y-1.5 mb-4 text-xs text-text-secondary">
        <div className="flex items-center gap-2">
          <RefreshCw className="h-3 w-3 flex-shrink-0" />
          <span>Sync: {definition.syncScope}</span>
        </div>
        <div className="flex items-center gap-2">
          <Clock className="h-3 w-3 flex-shrink-0" />
          {connector.lastSyncAt ? (
            <span>Last sync: {formatSyncTime(connector.lastSyncAt)}</span>
          ) : (
            <span>Awaiting first sync</span>
          )}
        </div>
      </div>

      {isManager && (
        <div className="flex gap-2 pt-3 border-t border-border">
          <button
            onClick={onReconnect}
            className="flex-1 text-xs font-medium text-text-secondary hover:text-primary transition px-3 py-1.5 rounded-lg border border-border hover:border-primary/30 inline-flex items-center justify-center gap-1"
          >
            <Settings className="h-3 w-3" /> Manage
          </button>
          <button
            onClick={onDisconnect}
            className="flex-1 text-xs font-medium text-danger hover:text-red-700 transition px-3 py-1.5 rounded-lg border border-border hover:border-danger/30 inline-flex items-center justify-center gap-1"
          >
            <Unplug className="h-3 w-3" /> Disconnect
          </button>
        </div>
      )}
    </div>
  );
}

function AvailableCard({
  definition,
  isManager,
  onConnect,
}: {
  definition: ConnectorDefinition;
  isManager: boolean;
  onConnect: () => void;
}) {
  return (
    <div className="bg-surface border border-border rounded-xl p-5 shadow-sm hover:shadow-md hover:border-primary/30 transition-all flex flex-col">
      <div className="flex items-start gap-3 mb-3">
        <BrandLogo provider={definition.logoId} size={36} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <h3 className="font-semibold text-text-primary truncate">{definition.name}</h3>
            <span className="text-[10px] uppercase tracking-wide font-medium text-text-secondary bg-surface-hover px-2 py-0.5 rounded-full whitespace-nowrap">
              {definition.category}
            </span>
          </div>
          <p className="text-sm text-text-secondary mt-1 line-clamp-2">{definition.description}</p>
        </div>
      </div>

      <div className="flex flex-wrap gap-1.5 mb-4 mt-auto">
        {definition.events.slice(0, 3).map((event) => (
          <span key={event} className="text-[10px] bg-surface-hover px-2 py-0.5 rounded-full text-text-secondary">
            {event}
          </span>
        ))}
      </div>

      {isManager && (
        <button
          onClick={onConnect}
          className="w-full text-sm font-medium bg-primary text-white hover:bg-primary-hover transition px-4 py-2 rounded-lg inline-flex items-center justify-center gap-1.5"
        >
          <Plug className="h-4 w-4" />
          Connect
        </button>
      )}
    </div>
  );
}

const SUGGESTED_FIRST = ['hubspot', 'google-calendar', 'slack'];

export default function Connectors() {
  const [connectTarget, setConnectTarget] = useState<ConnectorDefinition | null>(null);
  const [search, setSearch] = useState('');
  const [activeCategory, setActiveCategory] = useState<Category | 'All'>('All');
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

  const connectedDefs = useMemo(
    () => CONNECTOR_DEFINITIONS.filter((def) => findConnector(def)),
    [connectors],
  );

  const availableDefs = useMemo(() => {
    return CONNECTOR_DEFINITIONS.filter((def) => !findConnector(def)).filter((def) => {
      if (activeCategory !== 'All' && def.category !== activeCategory) return false;
      if (search.trim()) {
        const q = search.trim().toLowerCase();
        if (
          !def.name.toLowerCase().includes(q) &&
          !def.description.toLowerCase().includes(q) &&
          !def.category.toLowerCase().includes(q)
        )
          return false;
      }
      return true;
    });
  }, [connectors, activeCategory, search]);

  const categoryCounts = useMemo(() => {
    const counts: Record<string, number> = { All: 0 };
    CONNECTOR_DEFINITIONS.filter((def) => !findConnector(def)).forEach((def) => {
      counts.All = (counts.All ?? 0) + 1;
      counts[def.category] = (counts[def.category] ?? 0) + 1;
    });
    return counts;
  }, [connectors]);

  const suggested = CONNECTOR_DEFINITIONS.filter((d) => SUGGESTED_FIRST.includes(d.id));

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
          {connectedDefs.length > 0 ? (
            <div>
              <div className="flex items-baseline justify-between mb-4">
                <h2 className="text-lg font-semibold text-text-primary">
                  Connected{' '}
                  <span className="text-text-secondary font-normal">({connectedDefs.length})</span>
                </h2>
              </div>
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {connectedDefs.map((def) => {
                  const existing = findConnector(def)!;
                  return (
                    <ConnectedCard
                      key={def.id}
                      definition={def}
                      connector={existing}
                      isManager={isManager}
                      onReconnect={() => setConnectTarget(def)}
                      onDisconnect={() => {
                        if (
                          confirm(`Disconnect ${def.name}? This will remove all stored credentials.`)
                        ) {
                          disconnectMutation.mutate(existing.integrationId);
                        }
                      }}
                    />
                  );
                })}
              </div>
            </div>
          ) : (
            <div className="bg-surface border border-border rounded-xl p-8 text-center">
              <div className="w-14 h-14 rounded-2xl bg-primary/10 text-primary flex items-center justify-center mx-auto mb-4">
                <Plug className="h-7 w-7" />
              </div>
              <h2 className="text-base font-semibold text-text-primary mb-1">
                You haven't connected anything yet
              </h2>
              <p className="text-sm text-text-secondary mb-5 max-w-md mx-auto">
                Pick one of these to get the most value from QVO right away — calls, calendars, and team alerts.
              </p>
              <div className="flex flex-wrap justify-center gap-3">
                {suggested.map((def) => (
                  <button
                    key={def.id}
                    onClick={() => setConnectTarget(def)}
                    className="inline-flex items-center gap-2 px-3.5 py-2 rounded-lg border border-border bg-surface hover:border-primary/40 hover:bg-surface-hover transition text-sm font-medium text-text-primary"
                  >
                    <BrandLogo provider={def.logoId} size={20} />
                    Connect {def.name}
                  </button>
                ))}
              </div>
            </div>
          )}

          <div>
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-4">
              <h2 className="text-lg font-semibold text-text-primary">Available</h2>
              <div className="relative w-full sm:w-64">
                <Search className="h-4 w-4 absolute left-3 top-1/2 -translate-y-1/2 text-text-secondary" />
                <input
                  type="text"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search integrations"
                  className="w-full pl-9 pr-3 py-2 rounded-lg border border-border bg-surface text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-primary/30"
                />
              </div>
            </div>

            <div className="flex flex-wrap gap-2 mb-5">
              <button
                onClick={() => setActiveCategory('All')}
                className={`text-xs font-medium px-3 py-1.5 rounded-full border transition ${
                  activeCategory === 'All'
                    ? 'bg-primary text-white border-primary'
                    : 'bg-surface text-text-secondary border-border hover:border-primary/40'
                }`}
              >
                All <span className="opacity-70">({categoryCounts.All ?? 0})</span>
              </button>
              {CATEGORIES.map((cat) => (
                <button
                  key={cat}
                  onClick={() => setActiveCategory(cat)}
                  className={`text-xs font-medium px-3 py-1.5 rounded-full border transition ${
                    activeCategory === cat
                      ? 'bg-primary text-white border-primary'
                      : 'bg-surface text-text-secondary border-border hover:border-primary/40'
                  }`}
                >
                  {cat} <span className="opacity-70">({categoryCounts[cat] ?? 0})</span>
                </button>
              ))}
            </div>

            {availableDefs.length === 0 ? (
              <div className="text-sm text-text-secondary bg-surface border border-border rounded-xl p-6 text-center">
                No integrations match your filters.
              </div>
            ) : (
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {availableDefs.map((def) => (
                  <AvailableCard
                    key={def.id}
                    definition={def}
                    isManager={isManager}
                    onConnect={() => setConnectTarget(def)}
                  />
                ))}
              </div>
            )}
          </div>

          <div className="bg-surface border border-border rounded-xl p-5">
            <h3 className="text-sm font-semibold text-text-primary mb-2">Event Bus</h3>
            <p className="text-xs text-text-secondary mb-3">
              These platform events automatically push to all connected integrations:
            </p>
            <div className="flex flex-wrap gap-2">
              {['call.completed', 'appointment.booked', 'sms.sent', 'ticket.created'].map((event) => (
                <span
                  key={event}
                  className="inline-flex items-center gap-1.5 text-xs font-medium bg-primary/10 text-primary px-3 py-1.5 rounded-full"
                >
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
