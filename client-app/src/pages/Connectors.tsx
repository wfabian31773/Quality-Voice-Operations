import { useState, useEffect, useCallback, useMemo, type ReactNode } from 'react';
import { useLocation } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import {
  X,
  CheckCircle2,
  AlertCircle,
  AlertTriangle,
  Clock,
  Unplug,
  ExternalLink,
  Zap,
  Search,
  Plug,
  Settings,
  RefreshCw,
  Mail,
  MessageSquare,
  ShieldAlert,
  PowerOff,
} from 'lucide-react';
import { useRole } from '../lib/useRole';
import BrandLogo from '../components/BrandLogo';
import Modal from '../components/Modal';
import { PageHeader } from '../components/ui';

interface Connector {
  integrationId: string;
  connectorType: string;
  provider: string;
  name: string;
  isEnabled: boolean;
  configKeys: string[];
  lastSyncAt: string | null;
  lastSyncStatus: string | null;
  lastSyncError: string | null;
  lastSyncErrorAt: string | null;
  autoDisabledAt: string | null;
}

const AUTH_ERROR_REGEX = /\b(401|403|unauthorized|forbidden|invalid[_ -]?(grant|token|credential|auth)|expired|refresh.*(failed|token)|token.*expired|auth(entication)?[ _-]?(failed|error)|missing.*(token|credential)|not_authed|token_revoked|account_inactive)\b/i;

function isAuthError(message: string | null | undefined): boolean {
  if (!message) return false;
  return AUTH_ERROR_REGEX.test(message);
}

interface OAuthNotConfigured {
  providerLabel: string;
  missingEnv: string;
  docsUrl: string;
}

interface OAuthProviderAvailability {
  available: boolean;
  providerLabel: string;
  missingEnv?: string;
  docsUrl?: string;
}

interface OAuthAvailabilityResponse {
  providers: Record<string, OAuthProviderAvailability>;
}

function parseOAuthNotConfigured(err: unknown, fallback: { providerLabel: string; docsUrl?: string }): OAuthNotConfigured | null {
  if (!err || typeof err !== 'object') return null;
  const body = (err as { body?: { code?: string; providerLabel?: string; missingEnv?: string; docsUrl?: string } }).body;
  if (!body || body.code !== 'OAUTH_NOT_CONFIGURED') return null;
  return {
    providerLabel: body.providerLabel || fallback.providerLabel,
    missingEnv: body.missingEnv || '',
    docsUrl: body.docsUrl || fallback.docsUrl || '',
  };
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
  type: 'text' | 'password' | 'select';
  placeholder: string;
  required?: boolean;
  options?: Array<{ value: string; label: string }>;
  defaultValue?: string;
  helpText?: string;
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
    docsUrl: '/docs/connecting-hubspot',
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
    docsUrl: '/docs/connecting-salesforce',
    setupHelp: 'Create a Salesforce Connected App with api, refresh_token, and offline_access scopes. For sandbox orgs, set SALESFORCE_LOGIN_URL=https://test.salesforce.com on the server.',
    fields: [
      { key: 'access_token', label: 'Access Token', type: 'password', placeholder: 'Salesforce session/access token', required: true },
      { key: 'instance_url', label: 'Instance URL', type: 'text', placeholder: 'https://your-domain.my.salesforce.com', required: true },
      { key: 'refresh_token', label: 'Refresh Token', type: 'password', placeholder: 'Salesforce refresh token (recommended)' },
      {
        key: 'pipeline_mode',
        label: 'New caller pipeline',
        type: 'select',
        placeholder: '',
        defaultValue: 'leads',
        options: [
          { value: 'leads', label: 'Use Leads pipeline (top-of-funnel)' },
          { value: 'contacts', label: 'Contacts + Opportunities' },
        ],
        helpText: 'Choose how new inbound callers are recorded. Leads convert to Contact + Opportunity automatically when the AI agent qualifies them or books an appointment.',
      },
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
    docsUrl: '/docs/connecting-calendar',
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
    docsUrl: '/docs/connecting-outlook',
    setupHelp: 'Register a Microsoft Entra app with Calendars.ReadWrite and offline_access scopes, then set MICROSOFT_TENANT_ID on the server.',
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
    docsUrl: '/docs/connecting-slack',
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
    docsUrl: '/docs/connecting-pipedrive',
    setupHelp: 'Sign in with Pipedrive (OAuth) or paste a personal API token from Settings → Personal preferences → API.',
    fields: [
      { key: 'api_token', label: 'API Token', type: 'password', placeholder: 'Pipedrive personal API token', required: true },
      { key: 'company_domain', label: 'Company Domain', type: 'text', placeholder: 'yourcompany (from yourcompany.pipedrive.com)' },
    ],
    events: ['call.completed', 'appointment.booked'],
  },
  {
    id: 'zoho',
    name: 'Zoho CRM',
    provider: 'zoho',
    connectorType: 'crm',
    category: 'CRM',
    description: 'Sync contacts, accounts, and deals to Zoho CRM. Calls and appointments auto-attach to the right open deal.',
    syncScope: 'Contacts, Accounts, Deals, Calls',
    logoId: 'zoho',
    oauthProvider: 'zoho',
    docsUrl: '/docs/connecting-zoho',
    setupHelp: 'Sign in with Zoho (OAuth) to connect your Zoho CRM. The agent will write Calls, Notes, and Deals into the matching pipeline stage.',
    fields: [
      { key: 'access_token', label: 'Access Token', type: 'password', placeholder: 'Zoho OAuth access token', required: true },
      { key: 'refresh_token', label: 'Refresh Token', type: 'password', placeholder: 'Zoho OAuth refresh token (recommended)' },
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
    docsUrl: '/docs/connecting-quickbooks',
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

interface DispositionMapEntry { status: string; callDisposition: string }

interface HubSpotPipelineSummary {
  id: string;
  label: string;
  stages: Array<{ id: string; label: string }>;
}

interface PipedrivePipelineSummary {
  id: number;
  name: string;
  stages: Array<{ id: number; name: string }>;
}

const QVO_DISPOSITION_LABELS: Record<string, string> = {
  booked: 'Booked appointment',
  no_answer: 'No answer / voicemail',
  spam: 'Spam / junk',
  transferred: 'Transferred to human',
  completed: 'Completed call (other)',
};

interface DispositionMappingConfig {
  defaults: Record<string, DispositionMapEntry>;
  statusLabel: string;
  callDispositionLabel: string;
  description: ReactNode;
}

const DISPOSITION_MAPPING_CONFIGS: Record<string, DispositionMappingConfig> = {
  salesforce: {
    defaults: {
      booked: { status: 'Completed', callDisposition: 'Booked Appointment' },
      no_answer: { status: 'Completed', callDisposition: 'No Answer' },
      spam: { status: 'Completed', callDisposition: 'Spam' },
      transferred: { status: 'Completed', callDisposition: 'Transferred' },
      completed: { status: 'Completed', callDisposition: 'Completed Call' },
    },
    statusLabel: 'Salesforce Status',
    callDispositionLabel: 'Salesforce CallDisposition',
    description: (
      <>
        Map QVO call dispositions to your Salesforce Task <code>Status</code> and{' '}
        <code>CallDisposition</code> picklist values. Defaults work for most orgs — change
        these only if your org has customized those picklists.
      </>
    ),
  },
  hubspot: {
    defaults: {
      booked: { status: 'COMPLETED', callDisposition: 'Booked Appointment' },
      no_answer: { status: 'NO_ANSWER', callDisposition: 'No Answer' },
      spam: { status: 'COMPLETED', callDisposition: 'Spam' },
      transferred: { status: 'COMPLETED', callDisposition: 'Transferred' },
      completed: { status: 'COMPLETED', callDisposition: 'Completed Call' },
    },
    statusLabel: 'HubSpot hs_call_status',
    callDispositionLabel: 'HubSpot hs_call_disposition',
    description: (
      <>
        Map QVO call dispositions to HubSpot call engagement properties. <code>Status</code>{' '}
        is one of HubSpot's call status enums (e.g. <code>COMPLETED</code>, <code>NO_ANSWER</code>,{' '}
        <code>BUSY</code>). <code>Call disposition</code> can be a label or the GUID from your
        HubSpot call outcome settings.
      </>
    ),
  },
  pipedrive: {
    defaults: {
      booked: { status: 'meeting', callDisposition: 'Appointment Booked' },
      no_answer: { status: 'call', callDisposition: 'No Answer' },
      spam: { status: 'call', callDisposition: 'Spam Call' },
      transferred: { status: 'call', callDisposition: 'Call Transferred' },
      completed: { status: 'call', callDisposition: 'AI Voice Call' },
    },
    statusLabel: 'Pipedrive activity type',
    callDispositionLabel: 'Pipedrive activity subject',
    description: (
      <>
        Map QVO call dispositions to Pipedrive activity fields. <code>Activity type</code> is
        the key from your Pipedrive activity types (e.g. <code>call</code>, <code>meeting</code>,
        or any custom key). <code>Subject</code> is the activity title that appears in the timeline.
      </>
    ),
  },
  zoho: {
    defaults: {
      booked: { status: 'Completed', callDisposition: 'Appointment Booked' },
      no_answer: { status: 'Missed', callDisposition: 'No Answer' },
      spam: { status: 'Completed', callDisposition: 'Spam Call' },
      transferred: { status: 'Completed', callDisposition: 'Call Transferred' },
      completed: { status: 'Completed', callDisposition: 'AI Voice Call' },
    },
    statusLabel: 'Zoho Call_Status',
    callDispositionLabel: 'Zoho Call_Purpose',
    description: (
      <>
        Map QVO call dispositions to Zoho CRM Call fields. <code>Call_Status</code> is one of
        Zoho's call status values (e.g. <code>Completed</code>, <code>Missed</code>,{' '}
        <code>Scheduled</code>). <code>Call_Purpose</code> is a short label that appears on the
        Call record (e.g. <code>Appointment Booked</code>, <code>No Answer</code>).
      </>
    ),
  },
};

type SalesforceLeadOutcome = 'qualified' | 'disqualified' | 'nurture' | 'no_answer';

const SALESFORCE_LEAD_OUTCOMES: SalesforceLeadOutcome[] = [
  'qualified',
  'disqualified',
  'nurture',
  'no_answer',
];

const DEFAULT_SALESFORCE_LEAD_STATUS_MAP: Record<SalesforceLeadOutcome, string> = {
  qualified: 'Qualified',
  disqualified: 'Unqualified',
  nurture: 'Working - Contacted',
  no_answer: 'Open - Not Contacted',
};

const SALESFORCE_LEAD_OUTCOME_LABELS: Record<SalesforceLeadOutcome, string> = {
  qualified: 'Qualified caller',
  disqualified: 'Disqualified / spam',
  nurture: 'Nurture (not yet ready)',
  no_answer: 'No answer / voicemail',
};

const SALESFORCE_LEAD_OUTCOME_HINTS: Record<SalesforceLeadOutcome, string> = {
  qualified: 'Used as the converted-status when QVO converts the Lead to Contact + Opportunity.',
  disqualified: 'Lead is updated to this status; no conversion happens.',
  nurture: 'Lead is updated to this status so reps can follow up later.',
  no_answer: 'Lead is updated to this status when the caller didn\'t reach a person.',
};
const PICKLIST_CUSTOM_SENTINEL = '__qvo_custom__';

function PicklistField({
  value,
  options,
  placeholder,
  className,
  ariaLabel,
  allowEmpty,
  onChange,
}: {
  value: string;
  options: string[] | null;
  placeholder?: string;
  className?: string;
  ariaLabel?: string;
  allowEmpty?: boolean;
  onChange: (val: string) => void;
}) {
  const hasOptions = Array.isArray(options) && options.length > 0;
  const matchesOption = hasOptions && value !== '' && options!.includes(value);
  const [customMode, setCustomMode] = useState(
    () => hasOptions && value !== '' && !options!.includes(value),
  );

  useEffect(() => {
    if (!hasOptions) {
      setCustomMode(false);
      return;
    }
    if (value !== '' && !options!.includes(value)) {
      setCustomMode(true);
    }
  }, [hasOptions, options, value]);

  const inputClass = `px-3 py-2 rounded-lg border border-border bg-surface text-text-primary text-sm focus:outline-none focus:ring-2 focus:ring-primary/30 ${className ?? ''}`;

  if (!hasOptions) {
    return (
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label={ariaLabel}
        className={inputClass}
      />
    );
  }

  if (customMode) {
    return (
      <div className={`flex flex-col gap-1 ${className ?? ''}`}>
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          aria-label={ariaLabel}
          className="px-3 py-2 rounded-lg border border-border bg-surface text-text-primary text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
        />
        <button
          type="button"
          className="text-[11px] text-text-secondary hover:text-primary underline self-start"
          onClick={() => {
            setCustomMode(false);
            if (!options!.includes(value)) {
              onChange(allowEmpty ? '' : (options![0] ?? ''));
            }
          }}
        >
          Pick from picklist instead
        </button>
      </div>
    );
  }

  const selectValue = matchesOption ? value : '';

  return (
    <select
      value={selectValue}
      onChange={(e) => {
        const v = e.target.value;
        if (v === PICKLIST_CUSTOM_SENTINEL) {
          setCustomMode(true);
          return;
        }
        onChange(v);
      }}
      aria-label={ariaLabel}
      className={inputClass}
    >
      {(allowEmpty || selectValue === '') && (
        <option value="">{allowEmpty ? '— None —' : '— Choose a value —'}</option>
      )}
      {options!.map((opt) => (
        <option key={opt} value={opt}>{opt}</option>
      ))}
      <option value={PICKLIST_CUSTOM_SENTINEL}>Custom value…</option>
    </select>
  );
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
  const [credentials, setCredentials] = useState<Record<string, string>>(() => {
    const initial: Record<string, string> = {};
    for (const field of definition.fields) {
      if (field.defaultValue !== undefined) initial[field.key] = field.defaultValue;
    }
    return initial;
  });
  const [oauthPending, setOauthPending] = useState(false);
  const [oauthConfigError, setOauthConfigError] = useState<OAuthNotConfigured | null>(null);
  const [oauthError, setOauthError] = useState<string | null>(null);
  const isReconnect = !!existingConnector;
  const isSalesforce = definition.provider === 'salesforce';
  const dispositionConfig = DISPOSITION_MAPPING_CONFIGS[definition.provider];
  const hasDispositionMapping = !!dispositionConfig;
  const [dispositionMap, setDispositionMap] = useState<Record<string, DispositionMapEntry>>(
    () => (dispositionConfig ? { ...dispositionConfig.defaults } : {}),
  );
  const [leadStatusMap, setLeadStatusMap] = useState<Record<SalesforceLeadOutcome, string>>(
    () => ({ ...DEFAULT_SALESFORCE_LEAD_STATUS_MAP }),
  );
  const [leadStatusMapLoadError, setLeadStatusMapLoadError] = useState<string | null>(null);
  const [picklists, setPicklists] = useState<{ status: string[]; callDisposition: string[] } | null>(null);
  const [picklistsLoading, setPicklistsLoading] = useState(false);
  const [picklistsError, setPicklistsError] = useState<string | null>(null);

  const isHubspot = definition.provider === 'hubspot';
  const isPipedrive = definition.provider === 'pipedrive';
  const supportsPipelinePicker = isHubspot || isPipedrive;
  const [hubspotPipelines, setHubspotPipelines] = useState<HubSpotPipelineSummary[] | null>(null);
  const [pipedrivePipelines, setPipedrivePipelines] = useState<PipedrivePipelineSummary[] | null>(null);
  const [pipelinesLoading, setPipelinesLoading] = useState(false);
  const [pipelinesError, setPipelinesError] = useState<string | null>(null);
  const [appointmentPipelineId, setAppointmentPipelineId] = useState<string>('');
  const [appointmentStageId, setAppointmentStageId] = useState<string>('');
  const [defaultPipelineId, setDefaultPipelineId] = useState<string>('');
  const [defaultStageId, setDefaultStageId] = useState<string>('');
  const [originallySetPipelineKeys, setOriginallySetPipelineKeys] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!supportsPipelinePicker || !existingConnector) return;
    let cancelled = false;
    api
      .get<{
        settings: {
          appointmentPipelineId?: string | null;
          appointmentStageId?: string | null;
          defaultPipelineId?: string | null;
          defaultStageId?: string | null;
        };
      }>(`/connectors/${existingConnector.integrationId}/settings`)
      .then((data) => {
        if (cancelled) return;
        const settings = data?.settings ?? {};
        const originalKeys = new Set<string>();
        if (typeof settings.appointmentPipelineId === 'string' && settings.appointmentPipelineId) {
          setAppointmentPipelineId(settings.appointmentPipelineId);
          originalKeys.add('appointment_pipeline_id');
        }
        if (typeof settings.appointmentStageId === 'string' && settings.appointmentStageId) {
          setAppointmentStageId(settings.appointmentStageId);
          originalKeys.add('appointment_stage_id');
        }
        if (typeof settings.defaultPipelineId === 'string' && settings.defaultPipelineId) {
          setDefaultPipelineId(settings.defaultPipelineId);
          originalKeys.add('default_pipeline_id');
        }
        if (typeof settings.defaultStageId === 'string' && settings.defaultStageId) {
          setDefaultStageId(settings.defaultStageId);
          originalKeys.add('default_stage_id');
        }
        setOriginallySetPipelineKeys(originalKeys);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [supportsPipelinePicker, existingConnector]);

  useEffect(() => {
    if (!hasDispositionMapping || !existingConnector || !dispositionConfig) return;
    let cancelled = false;
    api
      .get<{
        settings: {
          dispositionMap: Record<string, Partial<DispositionMapEntry>> | null;
          leadStatusMap: Record<string, unknown> | null;
          leadStatusMapError?: string | null;
        };
      }>(`/connectors/${existingConnector.integrationId}/settings`)
      .then((data) => {
        if (cancelled) return;
        const remote = data?.settings?.dispositionMap;
        if (remote && typeof remote === 'object') {
          setDispositionMap((prev) => {
            const next = { ...prev };
            for (const key of Object.keys(dispositionConfig.defaults)) {
              const entry = remote[key];
              if (entry && typeof entry === 'object') {
                next[key] = {
                  status: typeof entry.status === 'string' ? entry.status : prev[key].status,
                  callDisposition:
                    typeof entry.callDisposition === 'string' ? entry.callDisposition : prev[key].callDisposition,
                };
              }
            }
            return next;
          });
        }
        const remoteLeadStatus = data?.settings?.leadStatusMap;
        if (remoteLeadStatus && typeof remoteLeadStatus === 'object') {
          setLeadStatusMap((prev) => {
            const next = { ...prev };
            for (const outcome of SALESFORCE_LEAD_OUTCOMES) {
              const value = (remoteLeadStatus as Record<string, unknown>)[outcome];
              if (typeof value === 'string' && value.trim()) {
                next[outcome] = value;
              }
            }
            return next;
          });
        }
        setLeadStatusMapLoadError(data?.settings?.leadStatusMapError ?? null);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [hasDispositionMapping, dispositionConfig, existingConnector]);

  useEffect(() => {
    if (!isSalesforce || !existingConnector) return;
    let cancelled = false;
    setPicklistsLoading(true);
    setPicklistsError(null);
    api
      .get<{ status: string[]; callDisposition: string[] }>(
        `/connectors/${existingConnector.integrationId}/salesforce/picklists`,
      )
      .then((data) => {
        if (cancelled) return;
        setPicklists({
          status: Array.isArray(data?.status) ? data.status : [],
          callDisposition: Array.isArray(data?.callDisposition) ? data.callDisposition : [],
        });
      })
      .catch((err) => {
        if (cancelled) return;
        setPicklistsError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setPicklistsLoading(false);
      });
    return () => { cancelled = true; };
  }, [isSalesforce, existingConnector]);

  useEffect(() => {
    if (!supportsPipelinePicker || !existingConnector) return;
    let cancelled = false;
    setPipelinesLoading(true);
    setPipelinesError(null);
    const path = isHubspot
      ? `/connectors/${existingConnector.integrationId}/hubspot/pipelines`
      : `/connectors/${existingConnector.integrationId}/pipedrive/pipelines`;
    api
      .get<{ pipelines: HubSpotPipelineSummary[] | PipedrivePipelineSummary[] }>(path)
      .then((data) => {
        if (cancelled) return;
        const list = Array.isArray(data?.pipelines) ? data.pipelines : [];
        if (isHubspot) {
          setHubspotPipelines(list as HubSpotPipelineSummary[]);
        } else {
          setPipedrivePipelines(list as PipedrivePipelineSummary[]);
        }
      })
      .catch((err) => {
        if (cancelled) return;
        setPipelinesError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setPipelinesLoading(false);
      });
    return () => { cancelled = true; };
  }, [supportsPipelinePicker, isHubspot, existingConnector]);

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
    setOauthConfigError(null);
    setOauthError(null);
    setOauthPending(true);
    try {
      const data = await api.get<{ authUrl: string }>(`/connectors/oauth/${definition.oauthProvider}/init`);
      const popup = window.open(data.authUrl, `oauth_${definition.oauthProvider}`, 'width=600,height=700,popup=yes');
      if (!popup) {
        setOauthPending(false);
        setOauthError('Please allow popups for this site to connect via OAuth.');
      }
    } catch (err) {
      setOauthPending(false);
      const notConfigured = parseOAuthNotConfigured(err, {
        providerLabel: definition.name,
        docsUrl: definition.docsUrl,
      });
      if (notConfigured) {
        setOauthConfigError(notConfigured);
      } else {
        setOauthError(err instanceof Error ? err.message : 'Failed to start OAuth.');
      }
    }
  };

  const connectMutation = useMutation({
    mutationFn: (input: { creds: Record<string, string>; credentialsToDelete: string[] }) =>
      api.post('/connectors', {
        connectorType: definition.connectorType,
        provider: definition.provider,
        name: definition.name,
        credentials: input.creds,
        credentialsToDelete: input.credentialsToDelete,
        isEnabled: true,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['connectors'] });
      queryClient.invalidateQueries({ queryKey: ['connector-settings'] });
      onClose();
    },
  });

  const setCred = (key: string, val: string) =>
    setCredentials((prev) => ({ ...prev, [key]: val }));

  const setDispositionField = (
    key: string,
    field: keyof DispositionMapEntry,
    val: string,
  ) =>
    setDispositionMap((prev) => ({
      ...prev,
      [key]: { ...prev[key], [field]: val },
    }));

  const buildSubmitCredentials = ():
    | { creds: Record<string, string>; credentialsToDelete: string[] }
    | { error: string } => {
    const creds: Record<string, string> = {};
    const credentialsToDelete: string[] = [];
    for (const [k, v] of Object.entries(credentials)) {
      if (v && v.trim().length > 0) creds[k] = v;
    }
    if (hasDispositionMapping && dispositionConfig) {
      const out: Record<string, DispositionMapEntry> = {};
      for (const [key, entry] of Object.entries(dispositionMap)) {
        const status = entry.status.trim();
        const callDisposition = entry.callDisposition.trim();
        const label = QVO_DISPOSITION_LABELS[key] ?? key;
        if (!status) {
          return { error: `${dispositionConfig.statusLabel} for "${label}" is required.` };
        }
        if (isSalesforce && picklists) {
          if (picklists.status.length > 0 && !picklists.status.includes(status)) {
            return {
              error: `${dispositionConfig.statusLabel} "${status}" for "${label}" is not in your Salesforce Task Status picklist. Choose an existing value or update the picklist in Salesforce first.`,
            };
          }
          if (
            callDisposition &&
            picklists.callDisposition.length > 0 &&
            !picklists.callDisposition.includes(callDisposition)
          ) {
            return {
              error: `${dispositionConfig.callDispositionLabel} "${callDisposition}" for "${label}" is not in your Salesforce Task CallDisposition picklist. Choose an existing value or update the picklist in Salesforce first.`,
            };
          }
        }
        out[key] = { status, callDisposition };
      }
      creds.disposition_map = JSON.stringify(out);

      const leadOut: Record<SalesforceLeadOutcome, string> = { ...DEFAULT_SALESFORCE_LEAD_STATUS_MAP };
      for (const outcome of SALESFORCE_LEAD_OUTCOMES) {
        const value = (leadStatusMap[outcome] ?? '').trim();
        if (!value) {
          return { error: `Salesforce Lead status for "${SALESFORCE_LEAD_OUTCOME_LABELS[outcome]}" is required.` };
        }
        leadOut[outcome] = value;
      }
      creds.lead_status_map = JSON.stringify(leadOut);
    }
    const noteClearedKey = (key: string, currentValue: string) => {
      if (!currentValue.trim() && originallySetPipelineKeys.has(key)) {
        credentialsToDelete.push(key);
      }
    };
    if (isHubspot) {
      if (appointmentPipelineId.trim()) creds.appointment_pipeline_id = appointmentPipelineId.trim();
      if (appointmentStageId.trim()) creds.appointment_stage_id = appointmentStageId.trim();
      noteClearedKey('appointment_pipeline_id', appointmentPipelineId);
      noteClearedKey('appointment_stage_id', appointmentStageId);
      if (appointmentStageId.trim() && !appointmentPipelineId.trim()) {
        return { error: 'Choose an appointment pipeline before choosing a stage.' };
      }
      if (hubspotPipelines && appointmentPipelineId.trim() && appointmentStageId.trim()) {
        const pipeline = hubspotPipelines.find((p) => p.id === appointmentPipelineId.trim());
        if (pipeline && !pipeline.stages.some((s) => s.id === appointmentStageId.trim())) {
          return { error: 'The selected appointment stage does not belong to the selected pipeline.' };
        }
      }
    }
    if (isPipedrive) {
      if (defaultPipelineId.trim()) creds.default_pipeline_id = defaultPipelineId.trim();
      if (defaultStageId.trim()) creds.default_stage_id = defaultStageId.trim();
      if (appointmentStageId.trim()) creds.appointment_stage_id = appointmentStageId.trim();
      noteClearedKey('default_pipeline_id', defaultPipelineId);
      noteClearedKey('default_stage_id', defaultStageId);
      noteClearedKey('appointment_stage_id', appointmentStageId);
      if (defaultStageId.trim() && !defaultPipelineId.trim()) {
        return { error: 'Choose a default pipeline before choosing a default stage.' };
      }
      if (pipedrivePipelines && defaultPipelineId.trim()) {
        const pipelineNum = Number(defaultPipelineId.trim());
        const pipeline = pipedrivePipelines.find((p) => p.id === pipelineNum);
        if (pipeline) {
          if (defaultStageId.trim()) {
            const stageNum = Number(defaultStageId.trim());
            if (!pipeline.stages.some((s) => s.id === stageNum)) {
              return { error: 'The selected default stage does not belong to the selected default pipeline.' };
            }
          }
          if (appointmentStageId.trim()) {
            const stageNum = Number(appointmentStageId.trim());
            if (!pipeline.stages.some((s) => s.id === stageNum)) {
              return { error: 'The selected appointment stage does not belong to the selected default pipeline.' };
            }
          }
        }
      }
    }
    return { creds, credentialsToDelete };
  };

  const [submitError, setSubmitError] = useState<string | null>(null);

  const requiredFilled = isReconnect
    ? true
    : definition.fields
        .filter((f) => f.required !== false)
        .every((f) => (credentials[f.key] ?? '').trim().length > 0);

  return (
    <Modal open onClose={onClose} ariaLabel={`${isReconnect ? 'Reconnect' : 'Connect'} ${definition.name}`} panelClassName={`bg-surface border border-border rounded-xl shadow-lg w-full ${hasDispositionMapping ? 'max-w-2xl' : 'max-w-md'} max-h-[90vh] overflow-y-auto`}>
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
                    {!definition.docsUrl.startsWith('/') && <ExternalLink className="h-3 w-3" />}
                  </a>
                </>
              )}
            </div>
          )}

          {definition.oauthProvider && (
            <div>
              {oauthConfigError && (
                <div
                  role="alert"
                  className="mb-3 rounded-lg border border-amber-300 dark:border-amber-800/60 bg-amber-50 dark:bg-amber-900/15 p-3 text-xs"
                >
                  <div className="flex items-start gap-1.5 text-amber-800 dark:text-amber-300">
                    <AlertTriangle className="h-3.5 w-3.5 flex-shrink-0 mt-0.5" />
                    <div className="min-w-0 space-y-1">
                      <p className="font-semibold">QVO is missing the {oauthConfigError.providerLabel} server credentials.</p>
                      <p className="text-amber-700 dark:text-amber-200/90">
                        Your platform admin needs to set{' '}
                        {oauthConfigError.missingEnv ? (
                          <code className="font-mono">{oauthConfigError.missingEnv}</code>
                        ) : (
                          'the OAuth client credentials'
                        )}{' '}
                        before this integration can be connected.
                        {oauthConfigError.docsUrl && (
                          <>
                            {' '}
                            <a
                              href={oauthConfigError.docsUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="font-semibold underline hover:no-underline inline-flex items-center gap-0.5"
                            >
                              See the setup guide
                              <ExternalLink className="h-3 w-3" />
                            </a>
                          </>
                        )}
                      </p>
                    </div>
                  </div>
                </div>
              )}
              {oauthError && !oauthConfigError && (
                <div
                  role="alert"
                  className="mb-3 rounded-lg border border-red-200 dark:border-red-900/40 bg-red-50 dark:bg-red-900/10 p-2.5 text-xs text-red-700 dark:text-red-400"
                >
                  <div className="flex items-start gap-1.5">
                    <AlertCircle className="h-3.5 w-3.5 flex-shrink-0 mt-0.5" />
                    <span>{oauthError}</span>
                  </div>
                </div>
              )}
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
              setSubmitError(null);
              const built = buildSubmitCredentials();
              if ('error' in built) {
                setSubmitError(built.error);
                return;
              }
              connectMutation.mutate(built);
            }}
            className="space-y-4"
          >
            <div className="space-y-3">
              {definition.fields.map((field) => (
                <div key={field.key}>
                  <label className="block text-sm font-medium text-text-primary mb-1">
                    {field.label}
                    {field.required !== false && field.type !== 'select' && <span className="text-danger ml-0.5">*</span>}
                  </label>
                  {field.type === 'select' ? (
                    <select
                      value={credentials[field.key] ?? field.defaultValue ?? ''}
                      onChange={(e) => setCred(field.key, e.target.value)}
                      className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-text-primary text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
                    >
                      {(field.options ?? []).map((opt) => (
                        <option key={opt.value} value={opt.value}>{opt.label}</option>
                      ))}
                    </select>
                  ) : (
                    <input
                      type={field.type}
                      value={credentials[field.key] ?? ''}
                      onChange={(e) => setCred(field.key, e.target.value)}
                      placeholder={field.placeholder}
                      className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-text-primary text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
                    />
                  )}
                  {field.helpText && (
                    <p className="text-xs text-text-secondary mt-1">{field.helpText}</p>
                  )}
                </div>
              ))}
            </div>

            {supportsPipelinePicker && (
              <div className="rounded-lg border border-border p-4 space-y-3">
                <div>
                  <h4 className="text-sm font-semibold text-text-primary">
                    {isHubspot ? 'Appointment pipeline & stage' : 'Default pipeline & appointment stage'}
                  </h4>
                  <p className="text-xs text-text-secondary mt-1">
                    {isHubspot
                      ? 'When the AI agent books an appointment, the matching deal is created or moved into this pipeline and stage. Leave blank to use HubSpot defaults.'
                      : 'Pipedrive deals created from inbound calls land in the default pipeline + stage. The appointment stage is used to advance an existing deal when an appointment is booked. Leave blank to fall back to Pipedrive defaults.'}
                  </p>
                  {!existingConnector ? (
                    <p className="text-[11px] text-text-secondary mt-2">
                      Pipelines load after the initial connection. You can come back to set these once {definition.name} is connected.
                    </p>
                  ) : pipelinesLoading ? (
                    <p className="text-[11px] text-text-secondary mt-2">Loading pipelines from {definition.name}…</p>
                  ) : pipelinesError ? (
                    <p className="text-[11px] text-amber-600 dark:text-amber-400 mt-2">
                      Could not load pipelines ({pipelinesError}). You can still paste raw IDs below.
                    </p>
                  ) : null}
                </div>
                {isHubspot && (
                  <div className="space-y-2">
                    <div>
                      <label className="block text-xs font-medium text-text-primary mb-1">Appointment pipeline</label>
                      {hubspotPipelines && hubspotPipelines.length > 0 ? (
                        <select
                          value={appointmentPipelineId}
                          onChange={(e) => {
                            setAppointmentPipelineId(e.target.value);
                            setAppointmentStageId('');
                          }}
                          className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-text-primary text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
                        >
                          <option value="">— Use HubSpot default pipeline —</option>
                          {hubspotPipelines.map((p) => (
                            <option key={p.id} value={p.id}>{p.label}</option>
                          ))}
                        </select>
                      ) : (
                        <input
                          type="text"
                          value={appointmentPipelineId}
                          onChange={(e) => setAppointmentPipelineId(e.target.value)}
                          placeholder="HubSpot pipeline ID (e.g. default)"
                          className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-text-primary text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
                        />
                      )}
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-text-primary mb-1">Appointment stage</label>
                      {hubspotPipelines && appointmentPipelineId ? (() => {
                        const pipeline = hubspotPipelines.find((p) => p.id === appointmentPipelineId);
                        const stages = pipeline?.stages ?? [];
                        return stages.length > 0 ? (
                          <select
                            value={appointmentStageId}
                            onChange={(e) => setAppointmentStageId(e.target.value)}
                            className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-text-primary text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
                          >
                            <option value="">— Choose a stage —</option>
                            {stages.map((s) => (
                              <option key={s.id} value={s.id}>{s.label}</option>
                            ))}
                          </select>
                        ) : (
                          <p className="text-[11px] text-text-secondary">No stages found for this pipeline.</p>
                        );
                      })() : (
                        <input
                          type="text"
                          value={appointmentStageId}
                          onChange={(e) => setAppointmentStageId(e.target.value)}
                          placeholder="HubSpot stage ID (choose a pipeline first to see options)"
                          className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-text-primary text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
                          disabled={hubspotPipelines !== null && hubspotPipelines.length > 0 && !appointmentPipelineId}
                        />
                      )}
                    </div>
                  </div>
                )}
                {isPipedrive && (
                  <div className="space-y-2">
                    <div>
                      <label className="block text-xs font-medium text-text-primary mb-1">Default pipeline</label>
                      {pipedrivePipelines && pipedrivePipelines.length > 0 ? (
                        <select
                          value={defaultPipelineId}
                          onChange={(e) => {
                            setDefaultPipelineId(e.target.value);
                            setDefaultStageId('');
                            setAppointmentStageId('');
                          }}
                          className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-text-primary text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
                        >
                          <option value="">— Use Pipedrive default pipeline —</option>
                          {pipedrivePipelines.map((p) => (
                            <option key={p.id} value={String(p.id)}>{p.name}</option>
                          ))}
                        </select>
                      ) : (
                        <input
                          type="text"
                          value={defaultPipelineId}
                          onChange={(e) => setDefaultPipelineId(e.target.value)}
                          placeholder="Pipedrive pipeline ID (numeric)"
                          className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-text-primary text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
                        />
                      )}
                    </div>
                    {(() => {
                      const pipelineNum = Number(defaultPipelineId);
                      const pipeline = pipedrivePipelines && Number.isFinite(pipelineNum)
                        ? pipedrivePipelines.find((p) => p.id === pipelineNum)
                        : null;
                      const stages = pipeline?.stages ?? [];
                      const useSelect = pipedrivePipelines && pipeline && stages.length > 0;
                      return (
                        <>
                          <div>
                            <label className="block text-xs font-medium text-text-primary mb-1">Default deal stage</label>
                            {useSelect ? (
                              <select
                                value={defaultStageId}
                                onChange={(e) => setDefaultStageId(e.target.value)}
                                className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-text-primary text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
                              >
                                <option value="">— Use Pipedrive first stage —</option>
                                {stages.map((s) => (
                                  <option key={s.id} value={String(s.id)}>{s.name}</option>
                                ))}
                              </select>
                            ) : (
                              <input
                                type="text"
                                value={defaultStageId}
                                onChange={(e) => setDefaultStageId(e.target.value)}
                                placeholder="Pipedrive stage ID (numeric)"
                                className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-text-primary text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
                                disabled={pipedrivePipelines !== null && pipedrivePipelines.length > 0 && !defaultPipelineId}
                              />
                            )}
                          </div>
                          <div>
                            <label className="block text-xs font-medium text-text-primary mb-1">Appointment stage</label>
                            {useSelect ? (
                              <select
                                value={appointmentStageId}
                                onChange={(e) => setAppointmentStageId(e.target.value)}
                                className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-text-primary text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
                              >
                                <option value="">— No automatic stage move —</option>
                                {stages.map((s) => (
                                  <option key={s.id} value={String(s.id)}>{s.name}</option>
                                ))}
                              </select>
                            ) : (
                              <input
                                type="text"
                                value={appointmentStageId}
                                onChange={(e) => setAppointmentStageId(e.target.value)}
                                placeholder="Pipedrive stage ID (numeric)"
                                className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-text-primary text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
                                disabled={pipedrivePipelines !== null && pipedrivePipelines.length > 0 && !defaultPipelineId}
                              />
                            )}
                          </div>
                        </>
                      );
                    })()}
                  </div>
                )}
              </div>
            )}

            {hasDispositionMapping && dispositionConfig && (
              <div className="rounded-lg border border-border p-4 space-y-3">
                <div>
                  <h4 className="text-sm font-semibold text-text-primary">Disposition mapping</h4>
                  <p className="text-xs text-text-secondary mt-1">{dispositionConfig.description}</p>
                  {isSalesforce && (
                    existingConnector ? (
                      picklistsLoading ? (
                        <p className="text-[11px] text-text-secondary mt-2">Loading picklists from Salesforce…</p>
                      ) : picklistsError ? (
                        <p className="text-[11px] text-amber-600 dark:text-amber-400 mt-2">
                          Could not load Salesforce picklists ({picklistsError}). Falling back to free-text entry; values are not validated.
                        </p>
                      ) : picklists ? (
                        <p className="text-[11px] text-text-secondary mt-2">
                          Loaded {picklists.status.length} Status and {picklists.callDisposition.length} CallDisposition values from your Salesforce org. Save is blocked if a value is not in the picklist.
                        </p>
                      ) : null
                    ) : (
                      <p className="text-[11px] text-text-secondary mt-2">
                        Picklist values from your Salesforce org will load after the initial connection. Until then, entries are not validated.
                      </p>
                    )
                  )}
                </div>
                <div className="space-y-2">
                  <div className="hidden sm:grid sm:grid-cols-12 gap-2 text-[11px] uppercase tracking-wide text-text-secondary px-1">
                    <div className="sm:col-span-4">QVO disposition</div>
                    <div className="sm:col-span-4">{dispositionConfig.statusLabel}</div>
                    <div className="sm:col-span-4">{dispositionConfig.callDispositionLabel}</div>
                  </div>
                  {Object.keys(dispositionConfig.defaults).map((key) => (
                    <div key={key} className="grid grid-cols-1 sm:grid-cols-12 gap-2 items-center">
                      <div className="sm:col-span-4 text-sm text-text-primary">
                        {QVO_DISPOSITION_LABELS[key] ?? key}
                        <span className="block text-[11px] text-text-secondary font-mono">{key}</span>
                      </div>
                      <PicklistField
                        className="sm:col-span-4"
                        value={dispositionMap[key]?.status ?? ''}
                        options={isSalesforce ? (picklists?.status ?? null) : null}
                        placeholder={dispositionConfig.defaults[key].status}
                        ariaLabel={`${dispositionConfig.statusLabel} for ${QVO_DISPOSITION_LABELS[key] ?? key}`}
                        onChange={(val) => setDispositionField(key, 'status', val)}
                      />
                      <PicklistField
                        className="sm:col-span-4"
                        value={dispositionMap[key]?.callDisposition ?? ''}
                        options={isSalesforce ? (picklists?.callDisposition ?? null) : null}
                        placeholder={dispositionConfig.defaults[key].callDisposition}
                        ariaLabel={`${dispositionConfig.callDispositionLabel} for ${QVO_DISPOSITION_LABELS[key] ?? key}`}
                        onChange={(val) => setDispositionField(key, 'callDisposition', val)}
                        allowEmpty
                      />
                    </div>
                  ))}
                </div>
                <button
                  type="button"
                  onClick={() => setDispositionMap({ ...dispositionConfig.defaults })}
                  className="text-xs text-text-secondary hover:text-primary underline"
                >
                  Reset to defaults
                </button>
              </div>
            )}

            {isSalesforce && (
              <div className="rounded-lg border border-border p-4 space-y-3">
                <div>
                  <h4 className="text-sm font-semibold text-text-primary">Lead status mapping</h4>
                  <p className="text-xs text-text-secondary mt-1">
                    Route AI qualification outcomes to specific Salesforce <code>Lead.Status</code>{' '}
                    picklist values. Qualified callers convert their Lead to Contact + Opportunity
                    using the &ldquo;qualified&rdquo; status; the others update the Lead in place so
                    reps can pick up the right downstream playbook.
                  </p>
                </div>
                {leadStatusMapLoadError && (
                  <div className="rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger">
                    Saved Lead status mapping couldn&rsquo;t be parsed
                    ({leadStatusMapLoadError}). Defaults are shown below — saving will overwrite the
                    broken value.
                  </div>
                )}
                <div className="space-y-2">
                  <div className="hidden sm:grid sm:grid-cols-12 gap-2 text-[11px] uppercase tracking-wide text-text-secondary px-1">
                    <div className="sm:col-span-5">QVO outcome</div>
                    <div className="sm:col-span-7">Salesforce Lead Status</div>
                  </div>
                  {SALESFORCE_LEAD_OUTCOMES.map((outcome) => (
                    <div key={outcome} className="grid grid-cols-1 sm:grid-cols-12 gap-2 sm:items-start">
                      <div className="sm:col-span-5 text-sm text-text-primary">
                        {SALESFORCE_LEAD_OUTCOME_LABELS[outcome]}
                        <span className="block text-[11px] text-text-secondary font-mono">{outcome}</span>
                        <span className="block text-[11px] text-text-secondary mt-0.5">
                          {SALESFORCE_LEAD_OUTCOME_HINTS[outcome]}
                        </span>
                      </div>
                      <input
                        type="text"
                        value={leadStatusMap[outcome] ?? ''}
                        onChange={(e) =>
                          setLeadStatusMap((prev) => ({ ...prev, [outcome]: e.target.value }))
                        }
                        placeholder={DEFAULT_SALESFORCE_LEAD_STATUS_MAP[outcome]}
                        className="sm:col-span-7 px-3 py-2 rounded-lg border border-border bg-surface text-text-primary text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
                      />
                    </div>
                  ))}
                </div>
                <button
                  type="button"
                  onClick={() => setLeadStatusMap({ ...DEFAULT_SALESFORCE_LEAD_STATUS_MAP })}
                  className="text-xs text-text-secondary hover:text-primary underline"
                >
                  Reset to defaults
                </button>
              </div>
            )}

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

            {submitError && (
              <p className="text-danger text-sm">{submitError}</p>
            )}
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
    </Modal>
  );
}

interface ConnectorPipelineSettings {
  appointmentPipelineId?: string | null;
  appointmentStageId?: string | null;
  appointmentPipelineLabel?: string | null;
  appointmentStageLabel?: string | null;
  defaultPipelineId?: string | null;
  defaultStageId?: string | null;
  defaultPipelineLabel?: string | null;
  defaultStageLabel?: string | null;
  pipelineLookupError?: string | null;
}

interface ConnectorCalendarSettings {
  calendarId?: string | null;
  timezone?: string | null;
  calendarLabel?: string | null;
  calendarLookupError?: string | null;
}

function PipelineSummary({
  provider,
  integrationId,
}: {
  provider: 'hubspot' | 'pipedrive';
  integrationId: string;
}) {
  const { data, isLoading } = useQuery({
    queryKey: ['connector-settings', integrationId],
    queryFn: () =>
      api.get<{ provider: string; settings: ConnectorPipelineSettings }>(
        `/connectors/${integrationId}/settings`,
      ),
    staleTime: 60_000,
  });

  if (isLoading || !data) return null;
  const settings = data.settings ?? {};

  type Row = { label: string; value: string; hint?: string; raw: boolean };
  const rows: Row[] = [];

  if (provider === 'hubspot') {
    const id = settings.appointmentPipelineId;
    const stageId = settings.appointmentStageId;
    if (id || stageId) {
      const pipelineLabel = settings.appointmentPipelineLabel;
      const stageLabel = settings.appointmentStageLabel;
      const pipelineMissing = !!id && !pipelineLabel;
      const stageMissing = !!stageId && !stageLabel;
      const useRaw = !!settings.pipelineLookupError || pipelineMissing || stageMissing;
      const pipelinePart = pipelineLabel ?? (id ? `pipeline ${id}` : null);
      const stagePart = stageLabel ?? (stageId ? `stage ${stageId}` : null);
      const value = [pipelinePart, stagePart].filter(Boolean).join(' → ');
      let hint: string | undefined;
      if (settings.pipelineLookupError) {
        hint = 'Could not load pipeline names from HubSpot — open Manage to reconfigure.';
      } else if (pipelineMissing && stageMissing) {
        hint = 'Saved pipeline and stage no longer exist in HubSpot — open Manage to reconfigure.';
      } else if (pipelineMissing) {
        hint = 'Saved pipeline no longer exists in HubSpot — open Manage to reconfigure.';
      } else if (stageMissing) {
        hint = 'Saved stage no longer exists in this pipeline — open Manage to reconfigure.';
      }
      rows.push({
        label: 'Appointment pipeline',
        value: value || '—',
        hint,
        raw: useRaw,
      });
    }
  } else if (provider === 'pipedrive') {
    const defPipelineId = settings.defaultPipelineId;
    const defStageId = settings.defaultStageId;
    const apptStageId = settings.appointmentStageId;
    const lookupError = !!settings.pipelineLookupError;
    if (defPipelineId || defStageId) {
      const pipelineMissing = !!defPipelineId && !settings.defaultPipelineLabel;
      const stageMissing = !!defStageId && !settings.defaultStageLabel;
      const pipelinePart = settings.defaultPipelineLabel ?? (defPipelineId ? `pipeline ${defPipelineId}` : null);
      const stagePart = settings.defaultStageLabel ?? (defStageId ? `stage ${defStageId}` : null);
      const value = [pipelinePart, stagePart].filter(Boolean).join(' → ');
      const useRaw = lookupError || pipelineMissing || stageMissing;
      let hint: string | undefined;
      if (lookupError) {
        hint = 'Could not load pipeline names from Pipedrive — open Manage to reconfigure.';
      } else if (pipelineMissing && stageMissing) {
        hint = 'Saved pipeline and stage no longer exist in Pipedrive — open Manage to reconfigure.';
      } else if (pipelineMissing) {
        hint = 'Saved pipeline no longer exists in Pipedrive — open Manage to reconfigure.';
      } else if (stageMissing) {
        hint = 'Saved stage no longer exists in this pipeline — open Manage to reconfigure.';
      }
      rows.push({
        label: 'Default pipeline',
        value: value || '—',
        hint,
        raw: useRaw,
      });
    }
    if (apptStageId) {
      const stageLabel = settings.appointmentStageLabel;
      const stageMissing = !stageLabel;
      const value = stageLabel ?? `stage ${apptStageId}`;
      const useRaw = lookupError || stageMissing;
      let hint: string | undefined;
      if (lookupError) {
        hint = 'Could not load stage name from Pipedrive — open Manage to reconfigure.';
      } else if (stageMissing) {
        hint = 'Saved stage no longer exists in this pipeline — open Manage to reconfigure.';
      }
      rows.push({
        label: 'Appointment stage',
        value,
        hint,
        raw: useRaw,
      });
    }
  }

  if (rows.length === 0) return null;

  return (
    <>
      {rows.map((row) => (
        <div key={row.label} className="flex items-start gap-2">
          <Settings className="h-3 w-3 flex-shrink-0 mt-0.5" />
          <div className="min-w-0">
            <span>
              {row.label}:{' '}
              <span className={`font-medium ${row.raw ? 'text-amber-700 dark:text-amber-400 font-mono' : 'text-text-primary'}`}>
                {row.value}
              </span>
            </span>
            {row.hint && (
              <span className="block text-[11px] text-amber-600 dark:text-amber-400 mt-0.5">
                {row.hint}
              </span>
            )}
          </div>
        </div>
      ))}
    </>
  );
}

function CalendarSummary({
  provider,
  integrationId,
}: {
  provider: 'google-calendar' | 'outlook-calendar';
  integrationId: string;
}) {
  const { data, isLoading } = useQuery({
    queryKey: ['connector-settings', integrationId],
    queryFn: () =>
      api.get<{ provider: string; settings: ConnectorCalendarSettings }>(
        `/connectors/${integrationId}/settings`,
      ),
    staleTime: 60_000,
  });

  if (isLoading || !data) return null;
  const settings = data.settings ?? {};
  const providerLabel = provider === 'google-calendar' ? 'Google' : 'Outlook';

  type Row = { label: string; value: string; hint?: string; raw: boolean };
  const rows: Row[] = [];

  const calendarId = settings.calendarId ?? null;
  const calendarLabel = settings.calendarLabel ?? null;
  const lookupError = settings.calendarLookupError ?? null;
  const isPrimary = !calendarId || calendarId.toLowerCase() === 'primary';

  let calendarValue: string;
  let calendarRaw = false;
  let calendarHint: string | undefined;
  if (isPrimary) {
    calendarValue = 'Primary calendar';
  } else if (calendarLabel) {
    calendarValue = calendarLabel;
  } else {
    calendarValue = calendarId ?? '—';
    calendarRaw = true;
    if (lookupError) {
      calendarHint = `Could not load calendar name from ${providerLabel} — open Manage to reconfigure.`;
    } else {
      calendarHint = `Saved calendar no longer exists in ${providerLabel} — open Manage to reconfigure.`;
    }
  }
  rows.push({ label: 'Calendar', value: calendarValue, hint: calendarHint, raw: calendarRaw });

  const timezone = settings.timezone ?? null;
  rows.push({
    label: 'Timezone',
    value: timezone ?? 'America/New_York (default)',
    raw: false,
  });

  return (
    <>
      {rows.map((row) => (
        <div key={row.label} className="flex items-start gap-2">
          <Settings className="h-3 w-3 flex-shrink-0 mt-0.5" />
          <div className="min-w-0">
            <span>
              {row.label}:{' '}
              <span className={`font-medium ${row.raw ? 'text-amber-700 dark:text-amber-400 font-mono' : 'text-text-primary'}`}>
                {row.value}
              </span>
            </span>
            {row.hint && (
              <span className="block text-[11px] text-amber-600 dark:text-amber-400 mt-0.5">
                {row.hint}
              </span>
            )}
          </div>
        </div>
      ))}
    </>
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
  const queryClient = useQueryClient();
  const enabled = connector.isEnabled;
  const autoDisabled = !enabled && Boolean(connector.autoDisabledAt);
  const needsReconnect = connector.lastSyncStatus === 'needs_reconnect';
  const syncError = connector.lastSyncStatus === 'error';
  const errorMessage = connector.lastSyncError;
  const authError = syncError && isAuthError(errorMessage);
  const truncatedError = errorMessage && errorMessage.length > 90
    ? `${errorMessage.slice(0, 90)}…`
    : errorMessage;
  const [reauthPending, setReauthPending] = useState(false);
  const [reauthConfigError, setReauthConfigError] = useState<OAuthNotConfigured | null>(null);

  const startReauth = async () => {
    if (!definition.oauthProvider) {
      onReconnect();
      return;
    }
    setReauthConfigError(null);
    setReauthPending(true);
    try {
      const data = await api.get<{ authUrl: string }>(`/connectors/oauth/${definition.oauthProvider}/init`);
      const popup = window.open(
        data.authUrl,
        `oauth_${definition.oauthProvider}`,
        'width=600,height=700,popup=yes',
      );
      if (!popup) {
        setReauthPending(false);
        alert('Please allow popups for this site to reconnect via OAuth.');
        return;
      }
      let pollClosed: number | undefined;
      let timeoutId: number | undefined;
      const cleanup = () => {
        window.removeEventListener('message', onMessage);
        if (pollClosed !== undefined) window.clearInterval(pollClosed);
        if (timeoutId !== undefined) window.clearTimeout(timeoutId);
        setReauthPending(false);
      };
      const onMessage = (event: MessageEvent) => {
        if (event.origin !== window.location.origin) return;
        if (event.data?.type === 'oauth_complete' && event.data?.provider === definition.provider) {
          queryClient.invalidateQueries({ queryKey: ['connectors'] });
          cleanup();
        }
      };
      window.addEventListener('message', onMessage);
      pollClosed = window.setInterval(() => {
        if (popup.closed) cleanup();
      }, 1000);
      timeoutId = window.setTimeout(cleanup, 5 * 60 * 1000);
    } catch (err) {
      setReauthPending(false);
      const notConfigured = parseOAuthNotConfigured(err, {
        providerLabel: definition.name,
        docsUrl: definition.docsUrl,
      });
      if (notConfigured) {
        setReauthConfigError(notConfigured);
      }
    }
  };

  return (
    <div
      data-integration-id={connector.integrationId}
      data-provider={definition.provider}
      className="bg-surface border border-border rounded-xl p-5 shadow-sm hover:shadow-md transition-all"
    >
      <div className="flex items-start justify-between gap-3 mb-3">
        <div className="flex items-center gap-3 min-w-0">
          <BrandLogo provider={definition.logoId} size={36} />
          <div className="min-w-0">
            <h3 className="font-semibold text-text-primary truncate">{definition.name}</h3>
            <p className="text-xs text-text-secondary">{definition.category}</p>
          </div>
        </div>
        {autoDisabled ? (
          <span
            className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-semibold bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300 ring-1 ring-red-400/60 dark:ring-red-500/40 whitespace-nowrap"
            title="This integration was failing for too long, so we automatically disabled it to stop wasting tool budget."
          >
            <AlertCircle className="h-3 w-3" /> Auto-disabled
          </span>
        ) : needsReconnect ? (
          <span
            className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-semibold bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300 ring-1 ring-amber-400/60 dark:ring-amber-500/40 whitespace-nowrap"
            title="The stored access token can no longer be refreshed. Sign in again to restore syncing."
          >
            <AlertTriangle className="h-3 w-3" /> Reconnect needed
          </span>
        ) : enabled && !syncError ? (
          <span
            className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400 whitespace-nowrap"
            aria-label={`${definition.name} sync status: connected`}
            title="Connected and syncing"
          >
            <CheckCircle2 className="h-3 w-3" aria-hidden="true" /> Connected
          </span>
        ) : syncError ? (
          <span
            className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400 whitespace-nowrap"
            aria-label={`${definition.name} sync status: sync error`}
            title="Last sync failed"
          >
            <AlertCircle className="h-3 w-3" aria-hidden="true" /> Sync error
          </span>
        ) : (
          <span
            className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400 whitespace-nowrap"
            aria-label={`${definition.name} sync status: disabled`}
            title="Connector is disabled"
          >
            <PowerOff className="h-3 w-3" aria-hidden="true" /> Disabled
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
        {(definition.provider === 'hubspot' || definition.provider === 'pipedrive') && (
          <PipelineSummary
            provider={definition.provider}
            integrationId={connector.integrationId}
          />
        )}
        {(definition.provider === 'google-calendar' || definition.provider === 'outlook-calendar') && (
          <CalendarSummary
            provider={definition.provider}
            integrationId={connector.integrationId}
          />
        )}
      </div>

      {autoDisabled && (
        <div
          className="mb-3 rounded-lg border border-red-300 dark:border-red-800/60 bg-red-50 dark:bg-red-900/15 p-3 text-xs"
          title="This integration was failing for too long, so it was automatically disabled to stop wasting tool budget."
        >
          <div className="flex items-start gap-1.5 text-red-800 dark:text-red-300">
            <AlertCircle className="h-3.5 w-3.5 flex-shrink-0 mt-0.5" />
            <div className="min-w-0">
              <p className="font-semibold mb-0.5">We disabled this integration</p>
              <p className="text-red-700 dark:text-red-200/90">
                {definition.name} was failing for too long, so we paused event dispatch to stop wasting tool budget. Reconnect below to re-enable it.
              </p>
              {connector.autoDisabledAt && (
                <p className="text-[10px] text-red-500/80 dark:text-red-400/70 mt-1">
                  Disabled {formatSyncTime(connector.autoDisabledAt)}
                </p>
              )}
            </div>
          </div>
          {isManager && (
            <button
              onClick={definition.oauthProvider ? startReauth : onReconnect}
              disabled={reauthPending}
              className="mt-2 w-full text-xs font-semibold bg-red-600 hover:bg-red-700 text-white transition px-3 py-1.5 rounded-md disabled:opacity-50 inline-flex items-center justify-center gap-1.5"
            >
              <ExternalLink className="h-3 w-3" />
              {reauthPending
                ? 'Waiting for authorization…'
                : definition.oauthProvider
                  ? `Reconnect with ${definition.name}`
                  : `Reconnect ${definition.name}`}
            </button>
          )}
        </div>
      )}

      {needsReconnect && !autoDisabled && (
        <div
          className="mb-3 rounded-lg border border-amber-300 dark:border-amber-800/60 bg-amber-50 dark:bg-amber-900/15 p-3 text-xs"
          title="The stored OAuth refresh token expired or was revoked. Reconnect to restore syncing."
        >
          <div className="flex items-start gap-1.5 text-amber-800 dark:text-amber-300">
            <AlertTriangle className="h-3.5 w-3.5 flex-shrink-0 mt-0.5" />
            <div className="min-w-0">
              <p className="font-semibold mb-0.5">Reconnect needed</p>
              <p className="text-amber-700 dark:text-amber-200/90">
                {definition.name}'s access expired or was revoked. Events to this integration are paused until you sign in again.
              </p>
            </div>
          </div>
          {isManager && (
            <button
              onClick={definition.oauthProvider ? startReauth : onReconnect}
              disabled={reauthPending}
              className="mt-2 w-full text-xs font-semibold bg-amber-600 hover:bg-amber-700 text-white transition px-3 py-1.5 rounded-md disabled:opacity-50 inline-flex items-center justify-center gap-1.5"
            >
              <ExternalLink className="h-3 w-3" />
              {reauthPending
                ? 'Waiting for authorization…'
                : definition.oauthProvider
                  ? `Reconnect with ${definition.name}`
                  : `Reconnect ${definition.name}`}
            </button>
          )}
          {reauthConfigError && (
            <div role="alert" className="mt-2 rounded-md border border-amber-400/70 bg-amber-100/70 dark:bg-amber-900/30 p-2 text-amber-900 dark:text-amber-200">
              <p className="font-semibold">QVO is missing the {reauthConfigError.providerLabel} server credentials.</p>
              <p>
                Ask your platform admin to set{' '}
                {reauthConfigError.missingEnv ? (
                  <code className="font-mono">{reauthConfigError.missingEnv}</code>
                ) : (
                  'the OAuth client credentials'
                )}
                .
                {reauthConfigError.docsUrl && (
                  <>
                    {' '}
                    <a
                      href={reauthConfigError.docsUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="font-semibold underline hover:no-underline inline-flex items-center gap-0.5"
                    >
                      See the setup guide
                      <ExternalLink className="h-3 w-3" />
                    </a>
                  </>
                )}
              </p>
            </div>
          )}
        </div>
      )}

      {syncError && errorMessage && (
        <div
          className="mb-3 rounded-lg border border-red-200 dark:border-red-900/40 bg-red-50 dark:bg-red-900/10 p-2.5 text-xs"
          title={errorMessage}
        >
          <div className="flex items-start gap-1.5 text-red-700 dark:text-red-400">
            <AlertCircle className="h-3.5 w-3.5 flex-shrink-0 mt-0.5" />
            <div className="min-w-0">
              <p className="font-medium mb-0.5">
                {authError ? 'Authorization expired' : 'Last sync failed'}
              </p>
              <p className="font-mono text-red-600 dark:text-red-300 break-all line-clamp-2">
                {truncatedError}
              </p>
              {connector.lastSyncErrorAt && (
                <p className="text-[10px] text-red-500/80 dark:text-red-400/70 mt-1">
                  {formatSyncTime(connector.lastSyncErrorAt)}
                </p>
              )}
            </div>
          </div>
          {authError && isManager && definition.oauthProvider && (
            <button
              onClick={startReauth}
              disabled={reauthPending}
              className="mt-2 w-full text-xs font-medium bg-primary text-white hover:bg-primary-hover transition px-3 py-1.5 rounded-md disabled:opacity-50 inline-flex items-center justify-center gap-1.5"
            >
              <ExternalLink className="h-3 w-3" />
              {reauthPending ? 'Waiting for authorization…' : `Reconnect with ${definition.name}`}
            </button>
          )}
        </div>
      )}

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
  oauthAvailability,
}: {
  definition: ConnectorDefinition;
  isManager: boolean;
  onConnect: () => void;
  oauthAvailability?: OAuthProviderAvailability;
}) {
  const oauthUnavailable = Boolean(
    definition.oauthProvider && oauthAvailability && oauthAvailability.available === false,
  );
  const docsUrl = oauthAvailability?.docsUrl || definition.docsUrl;
  const providerLabel = oauthAvailability?.providerLabel || definition.name;

  return (
    <div
      data-provider={definition.provider}
      className="bg-surface border border-border rounded-xl p-5 shadow-sm hover:shadow-md hover:border-primary/30 transition-all flex flex-col"
    >
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

      {oauthUnavailable && (
        <div
          role="status"
          className="mb-3 rounded-lg border border-amber-300 dark:border-amber-800/60 bg-amber-50 dark:bg-amber-900/15 p-2.5 text-xs"
          title={
            oauthAvailability?.missingEnv
              ? `Platform admin needs to set ${oauthAvailability.missingEnv} on the server.`
              : `${providerLabel} OAuth client credentials are missing on the server.`
          }
        >
          <div className="flex items-start gap-1.5 text-amber-800 dark:text-amber-300">
            <AlertTriangle className="h-3.5 w-3.5 flex-shrink-0 mt-0.5" />
            <div className="min-w-0">
              <p className="font-semibold mb-0.5">Server credentials needed</p>
              <p className="text-amber-700 dark:text-amber-200/90">
                QVO is missing the {providerLabel} OAuth client credentials. Ask your platform admin to set{' '}
                {oauthAvailability?.missingEnv ? (
                  <code className="font-mono">{oauthAvailability.missingEnv}</code>
                ) : (
                  'the OAuth client credentials'
                )}{' '}
                before connecting.
                {docsUrl && (
                  <>
                    {' '}
                    <a
                      href={docsUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="font-semibold underline hover:no-underline inline-flex items-center gap-0.5"
                    >
                      See the setup guide
                      <ExternalLink className="h-3 w-3" />
                    </a>
                  </>
                )}
              </p>
            </div>
          </div>
        </div>
      )}

      {isManager && (
        <button
          onClick={onConnect}
          disabled={oauthUnavailable}
          aria-disabled={oauthUnavailable}
          title={oauthUnavailable ? `${providerLabel} OAuth isn't configured on this server yet.` : undefined}
          className="w-full text-sm font-medium bg-primary text-white hover:bg-primary-hover transition px-4 py-2 rounded-lg inline-flex items-center justify-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-primary"
        >
          <Plug className="h-4 w-4" />
          {oauthUnavailable ? 'Unavailable' : 'Connect'}
        </button>
      )}
    </div>
  );
}

const SUGGESTED_FIRST = ['hubspot', 'google-calendar', 'slack'];

interface OutageAlert {
  id: string;
  integrationId: string;
  integrationName: string | null;
  provider: string | null;
  connectorType: string | null;
  type: string;
  channel: 'email' | 'sms';
  title: string | null;
  message: string | null;
  createdAt: string;
  recipientCount: number | null;
  inAppRecipientCount: number;
  outageMinutes: number | null;
  firstFailedAt: string | null;
  errorMessage: string | null;
  smsAttempted: number | null;
  smsSucceeded: number | null;
  twilioConfigured: boolean | null;
  dispatchId: string | null;
}

interface OutageAlertRecipient {
  userId: string | null;
  name: string | null;
  email: string | null;
  phone: string | null;
  deliveryStatus: string;
  deliveryError: string | null;
  twilioStatusCode: number | null;
  dispatchedAt: string;
}

interface OutageAlertIntegrationContext {
  id: string;
  name: string | null;
  provider: string | null;
  connectorType: string | null;
  lastSyncAt: string | null;
  lastSyncStatus: string | null;
  lastSyncError: string | null;
  lastSyncErrorAt: string | null;
}

interface OutageAlertDetail extends OutageAlert {
  reconnectLink: string | null;
  recipientsAvailable: boolean;
  recipients: OutageAlertRecipient[];
  integration: OutageAlertIntegrationContext | null;
}

function formatOutageMinutes(minutes: number | null): string | null {
  if (minutes === null || !Number.isFinite(minutes) || minutes < 0) return null;
  if (minutes < 1) return '<1 min';
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  if (hours < 24) {
    return remainder ? `${hours}h ${remainder}m` : `${hours}h`;
  }
  const days = Math.floor(hours / 24);
  const hrLeft = hours % 24;
  return hrLeft ? `${days}d ${hrLeft}h` : `${days}d`;
}

function formatExactTimestamp(iso: string): string {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

function providerLabelFromAlert(alert: OutageAlert): string {
  if (alert.integrationName) return alert.integrationName;
  if (alert.provider) {
    const def = CONNECTOR_DEFINITIONS.find((d) => d.provider === alert.provider);
    if (def) return def.name;
    return alert.provider.charAt(0).toUpperCase() + alert.provider.slice(1);
  }
  return 'Integration';
}

function OutageAlertHistory({ connectors }: { connectors: Connector[] }) {
  const PAGE_SIZE = 10;
  const [page, setPage] = useState(1);
  const [integrationFilter, setIntegrationFilter] = useState<string>('');
  const [selectedAlertId, setSelectedAlertId] = useState<string | null>(null);

  // Reset back to page 1 whenever the integration filter changes so admins
  // don't end up looking at an empty page that no longer exists for the
  // narrower result set.
  useEffect(() => {
    setPage(1);
  }, [integrationFilter]);

  const { data, isLoading, isFetching, isError, refetch } = useQuery({
    queryKey: ['connector-outage-alerts', page, integrationFilter],
    queryFn: () => {
      const params = new URLSearchParams();
      params.set('page', String(page));
      params.set('limit', String(PAGE_SIZE));
      if (integrationFilter) params.set('integrationId', integrationFilter);
      return api.get<{ alerts: OutageAlert[]; total: number; limit: number; offset: number }>(
        `/connectors/alerts?${params.toString()}`,
      );
    },
    placeholderData: (prev) => prev,
  });

  const alerts = data?.alerts ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  // Build the filter dropdown from both currently-connected integrations
  // and any integrationIds we've seen in the alert history. This lets
  // admins still filter to disconnected/deleted integrations whose alert
  // trail is in scrollback. Use a Map keyed by integrationId so the live
  // connector record always wins over the alert-derived label.
  const filterOptionMap = new Map<string, string>();
  for (const alert of alerts) {
    if (!alert.integrationId) continue;
    filterOptionMap.set(
      alert.integrationId,
      alert.integrationName || alert.provider || alert.integrationId,
    );
  }
  for (const c of connectors) {
    filterOptionMap.set(c.integrationId, c.name || c.provider);
  }
  const filterableConnectors = [...filterOptionMap.entries()]
    .map(([integrationId, label]) => ({ integrationId, label }))
    .sort((a, b) => a.label.localeCompare(b.label));
  const filterIsActive = integrationFilter !== '';

  return (
    <div className="bg-surface border border-border rounded-xl p-5">
      <div className="flex items-start justify-between gap-3 mb-4 flex-wrap">
        <div className="min-w-0">
          <h2 className="text-lg font-semibold text-text-primary flex items-center gap-2">
            <ShieldAlert className="h-5 w-5 text-amber-600 dark:text-amber-400" />
            Outage alert history
          </h2>
          <p className="text-xs text-text-secondary mt-1 max-w-xl">
            Recent connector failure escalations sent to your admins. SMS escalations only fire after a revenue-critical integration has been failing for over an hour.
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <label className="text-xs text-text-secondary inline-flex items-center gap-1.5">
            <span className="sr-only">Filter by integration</span>
            <select
              value={integrationFilter}
              onChange={(e) => setIntegrationFilter(e.target.value)}
              className="text-xs px-2.5 py-1.5 rounded-md border border-border bg-surface text-text-primary focus:outline-none focus:ring-2 focus:ring-primary/40"
              aria-label="Filter outage alerts by integration"
            >
              <option value="">All integrations</option>
              {filterableConnectors.map((c) => (
                <option key={c.integrationId} value={c.integrationId}>
                  {c.label}
                </option>
              ))}
            </select>
          </label>
          {filterIsActive && (
            <button
              onClick={() => setIntegrationFilter('')}
              className="text-xs font-medium px-2.5 py-1.5 rounded-md border border-border text-text-secondary hover:bg-surface-hover transition"
            >
              Clear
            </button>
          )}
          <button
            onClick={() => refetch()}
            disabled={isFetching}
            className="inline-flex items-center gap-1.5 text-xs font-medium px-2.5 py-1.5 rounded-md border border-border text-text-secondary hover:bg-surface-hover transition disabled:opacity-50"
          >
            <RefreshCw className={`h-3 w-3 ${isFetching ? 'animate-spin' : ''}`} />
            Refresh
          </button>
        </div>
      </div>

      {isLoading ? (
        <div className="text-sm text-text-secondary py-6 text-center">Loading alert history…</div>
      ) : isError ? (
        <div className="text-sm text-red-600 dark:text-red-400 py-6 text-center">
          Couldn't load alert history. Try refreshing.
        </div>
      ) : alerts.length === 0 ? (
        <div className="text-sm text-text-secondary py-8 text-center border border-dashed border-border rounded-lg">
          {filterIsActive
            ? 'No outage alerts for this integration yet.'
            : "No outage alerts have been sent. We'll log every email or SMS escalation here so you can audit who got paged."}
        </div>
      ) : (
        <>
          <div className="overflow-x-auto -mx-1">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left text-text-secondary border-b border-border">
                  <th className="font-medium py-2 px-2">When</th>
                  <th className="font-medium py-2 px-2">Integration</th>
                  <th className="font-medium py-2 px-2">Channel</th>
                  <th className="font-medium py-2 px-2">First failed</th>
                  <th className="font-medium py-2 px-2">Outage</th>
                  <th className="font-medium py-2 px-2">Recipients</th>
                  <th className="font-medium py-2 px-2">In-app</th>
                  <th className="font-medium py-2 px-2">Delivery</th>
                </tr>
              </thead>
              <tbody>
                {alerts.map((alert) => {
                  const isSms = alert.channel === 'sms';
                  const provider = alert.provider ?? '';
                  const def = CONNECTOR_DEFINITIONS.find((d) => d.provider === provider);
                  const outage = formatOutageMinutes(alert.outageMinutes);
                  const recipientCount = alert.recipientCount ?? alert.inAppRecipientCount;
                  let deliveryNode: ReactNode;
                  if (isSms) {
                    if (alert.twilioConfigured === false) {
                      deliveryNode = (
                        <span
                          className="inline-flex items-center gap-1 text-amber-700 dark:text-amber-400"
                          title="Twilio credentials are not configured on this environment, so the SMS was logged only — no message was actually sent. Add TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and TWILIO_SMS_FROM to enable real delivery."
                        >
                          <AlertTriangle className="h-3 w-3" /> Twilio not configured
                        </span>
                      );
                    } else {
                      const succeeded = alert.smsSucceeded ?? 0;
                      const attempted = alert.smsAttempted ?? 0;
                      const allOk = attempted > 0 && succeeded === attempted;
                      const partial = succeeded > 0 && succeeded < attempted;
                      deliveryNode = (
                        <span
                          className={`inline-flex items-center gap-1 ${
                            allOk
                              ? 'text-green-700 dark:text-green-400'
                              : partial
                                ? 'text-amber-700 dark:text-amber-400'
                                : 'text-red-700 dark:text-red-400'
                          }`}
                          title={
                            allOk
                              ? `Twilio accepted all ${succeeded} SMS sends.`
                              : partial
                                ? `Twilio accepted ${succeeded} of ${attempted} SMS sends — see server logs for failures.`
                                : `Twilio rejected every SMS send (${attempted} attempted).`
                          }
                        >
                          {allOk ? (
                            <CheckCircle2 className="h-3 w-3" />
                          ) : (
                            <AlertCircle className="h-3 w-3" />
                          )}
                          {succeeded}/{attempted} sent
                        </span>
                      );
                    }
                  } else {
                    deliveryNode = (
                      <span
                        className="inline-flex items-center gap-1 text-text-secondary"
                        title="Email is dispatched best-effort to each admin. Per-send delivery failures are recorded in server logs."
                      >
                        <Mail className="h-3 w-3" /> Emailed
                      </span>
                    );
                  }
                  return (
                    <tr
                      key={alert.id}
                      className="border-b border-border/60 last:border-b-0 align-top cursor-pointer hover:bg-surface-hover focus-within:bg-surface-hover"
                      onClick={() => setSelectedAlertId(alert.id)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          setSelectedAlertId(alert.id);
                        }
                      }}
                      tabIndex={0}
                      role="button"
                      aria-label={`View timeline for ${providerLabelFromAlert(alert)} alert sent ${formatSyncTime(alert.createdAt)}`}
                    >
                      <td
                        className="py-2.5 px-2 text-text-primary whitespace-nowrap"
                        title={formatExactTimestamp(alert.createdAt)}
                      >
                        {formatSyncTime(alert.createdAt)}
                      </td>
                      <td className="py-2.5 px-2">
                        <div className="flex items-center gap-2 min-w-0">
                          {def ? <BrandLogo provider={def.logoId} size={16} /> : null}
                          <span className="text-text-primary font-medium truncate">
                            {providerLabelFromAlert(alert)}
                          </span>
                        </div>
                        {alert.errorMessage && (
                          <div
                            className="text-[11px] text-text-secondary mt-0.5 max-w-xs truncate"
                            title={alert.errorMessage}
                          >
                            {alert.errorMessage}
                          </div>
                        )}
                      </td>
                      <td className="py-2.5 px-2">
                        <span
                          className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full font-medium ${
                            isSms
                              ? 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400'
                              : 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400'
                          }`}
                        >
                          {isSms ? (
                            <MessageSquare className="h-3 w-3" />
                          ) : (
                            <Mail className="h-3 w-3" />
                          )}
                          {isSms ? 'SMS' : 'Email'}
                        </span>
                      </td>
                      <td
                        className="py-2.5 px-2 text-text-primary whitespace-nowrap"
                        title={alert.firstFailedAt ? formatExactTimestamp(alert.firstFailedAt) : undefined}
                      >
                        {alert.firstFailedAt ? (
                          formatSyncTime(alert.firstFailedAt)
                        ) : (
                          <span className="text-text-secondary">—</span>
                        )}
                      </td>
                      <td className="py-2.5 px-2 text-text-primary whitespace-nowrap">
                        {outage ?? <span className="text-text-secondary">—</span>}
                      </td>
                      <td
                        className="py-2.5 px-2 text-text-primary whitespace-nowrap"
                        title={
                          isSms
                            ? `${recipientCount} admin${recipientCount === 1 ? '' : 's'} targeted by SMS at dispatch.`
                            : `${recipientCount} admin${recipientCount === 1 ? '' : 's'} emailed at dispatch.`
                        }
                      >
                        <span className="inline-flex items-center gap-1">
                          {isSms ? (
                            <MessageSquare className="h-3 w-3 text-text-secondary" />
                          ) : (
                            <Mail className="h-3 w-3 text-text-secondary" />
                          )}
                          {recipientCount}
                        </span>
                      </td>
                      <td
                        className="py-2.5 px-2 text-text-primary whitespace-nowrap"
                        title={`${alert.inAppRecipientCount} admin${alert.inAppRecipientCount === 1 ? '' : 's'} received the in-app notification badge.`}
                      >
                        <span className="inline-flex items-center gap-1">
                          <ShieldAlert className="h-3 w-3 text-text-secondary" />
                          {alert.inAppRecipientCount}
                        </span>
                      </td>
                      <td className="py-2.5 px-2">{deliveryNode}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {totalPages > 1 && (
            <div className="flex items-center justify-between mt-4 text-xs text-text-secondary">
              <span>
                Showing {(page - 1) * PAGE_SIZE + 1}–{Math.min(page * PAGE_SIZE, total)} of {total}
              </span>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  disabled={page === 1}
                  className="px-2.5 py-1 rounded-md border border-border hover:bg-surface-hover disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  Previous
                </button>
                <span>
                  Page {page} / {totalPages}
                </span>
                <button
                  onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                  disabled={page >= totalPages}
                  className="px-2.5 py-1 rounded-md border border-border hover:bg-surface-hover disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  Next
                </button>
              </div>
            </div>
          )}
        </>
      )}

      <OutageAlertDetailPanel
        alertId={selectedAlertId}
        onClose={() => setSelectedAlertId(null)}
      />
    </div>
  );
}

function statusBadge(status: string): { label: string; className: string; Icon: typeof CheckCircle2 } {
  switch (status) {
    case 'sent':
      return {
        label: 'Sent',
        className: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400',
        Icon: CheckCircle2,
      };
    case 'failed':
      return {
        label: 'Failed',
        className: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400',
        Icon: AlertCircle,
      };
    case 'skipped':
      return {
        label: 'Skipped',
        className: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400',
        Icon: AlertTriangle,
      };
    default:
      return {
        label: status,
        className: 'bg-surface-hover text-text-secondary',
        Icon: AlertCircle,
      };
  }
}

function OutageAlertDetailPanel({
  alertId,
  onClose,
}: {
  alertId: string | null;
  onClose: () => void;
}) {
  const open = alertId !== null;

  // Encode the composite alert id (`integrationId:type:timestamp`) — the
  // colons round-trip cleanly through Express path params, but encoding
  // keeps us safe against any future id format changes.
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['connector-outage-alert-detail', alertId],
    enabled: open,
    queryFn: () =>
      api.get<OutageAlertDetail>(
        `/connectors/alerts/${encodeURIComponent(alertId as string)}`,
      ),
  });

  return (
    <Modal
      open={open}
      onClose={onClose}
      ariaLabel="Outage alert details"
      containerClassName="fixed inset-0 z-[90] flex items-stretch justify-end"
      panelClassName="relative w-full max-w-xl h-full bg-surface border-l border-border shadow-2xl overflow-y-auto"
    >
      <div className="sticky top-0 z-10 flex items-start justify-between gap-3 p-5 bg-surface border-b border-border">
        <div className="min-w-0">
          <h3 className="text-base font-semibold text-text-primary flex items-center gap-2">
            <ShieldAlert className="h-5 w-5 text-amber-600 dark:text-amber-400" />
            Outage alert timeline
          </h3>
          <p className="text-xs text-text-secondary mt-1">
            Who was paged, what failed, and whether each message actually delivered.
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close outage alert details"
          className="p-1.5 rounded-md text-text-secondary hover:bg-surface-hover hover:text-text-primary transition shrink-0"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {isLoading ? (
        <div className="p-6 text-sm text-text-secondary">Loading alert details…</div>
      ) : isError || !data ? (
        <div className="p-6 text-sm text-red-600 dark:text-red-400">
          Couldn't load alert details.{' '}
          {error instanceof Error ? error.message : null}
        </div>
      ) : (
        <OutageAlertDetailBody detail={data} />
      )}
    </Modal>
  );
}

function OutageAlertDetailBody({ detail }: { detail: OutageAlertDetail }) {
  const isSms = detail.channel === 'sms';
  const def = detail.provider
    ? CONNECTOR_DEFINITIONS.find((d) => d.provider === detail.provider)
    : undefined;
  const providerLabel = providerLabelFromAlert(detail);
  const outage = formatOutageMinutes(detail.outageMinutes);

  return (
    <div className="p-5 space-y-5">
      {/* Header card with provider + channel badge + when */}
      <div className="bg-surface-hover/40 border border-border rounded-lg p-4">
        <div className="flex items-center gap-3">
          {def ? <BrandLogo provider={def.logoId} size={28} /> : null}
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-sm font-semibold text-text-primary">
                {providerLabel}
              </span>
              <span
                className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium ${
                  isSms
                    ? 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400'
                    : 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400'
                }`}
              >
                {isSms ? <MessageSquare className="h-3 w-3" /> : <Mail className="h-3 w-3" />}
                {isSms ? 'SMS escalation' : 'Email alert'}
              </span>
            </div>
            <div className="text-xs text-text-secondary mt-1">
              Dispatched {formatExactTimestamp(detail.createdAt)}
            </div>
          </div>
        </div>
      </div>

      {/* Timeline: first failed -> dispatched -> outage duration */}
      <div className="space-y-2">
        <h4 className="text-xs font-semibold text-text-primary uppercase tracking-wide">
          Timeline
        </h4>
        <dl className="text-sm space-y-1.5">
          <div className="flex items-baseline justify-between gap-3">
            <dt className="text-text-secondary">First failed</dt>
            <dd className="text-text-primary text-right">
              {detail.firstFailedAt
                ? formatExactTimestamp(detail.firstFailedAt)
                : <span className="text-text-secondary">Unknown</span>}
            </dd>
          </div>
          <div className="flex items-baseline justify-between gap-3">
            <dt className="text-text-secondary">Alert sent</dt>
            <dd className="text-text-primary text-right">
              {formatExactTimestamp(detail.createdAt)}
            </dd>
          </div>
          <div className="flex items-baseline justify-between gap-3">
            <dt className="text-text-secondary">Outage at dispatch</dt>
            <dd className="text-text-primary text-right">
              {outage ?? <span className="text-text-secondary">Unknown</span>}
            </dd>
          </div>
        </dl>
      </div>

      {/* Original error message */}
      {detail.errorMessage && (
        <div className="space-y-2">
          <h4 className="text-xs font-semibold text-text-primary uppercase tracking-wide">
            Error message
          </h4>
          <pre className="text-xs text-text-primary bg-surface-hover border border-border rounded-md p-3 whitespace-pre-wrap break-words font-mono">
            {detail.errorMessage}
          </pre>
        </div>
      )}

      {/* Connector context: latest sync state */}
      <div className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <h4 className="text-xs font-semibold text-text-primary uppercase tracking-wide">
            Connector context
          </h4>
          {detail.integrationId && (
            <a
              href={`/connectors${detail.provider ? `?provider=${encodeURIComponent(detail.provider)}` : ''}`}
              className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
            >
              View connector <ExternalLink className="h-3 w-3" />
            </a>
          )}
        </div>
        {detail.integration ? (
          <dl className="text-xs space-y-1.5 bg-surface-hover/40 border border-border rounded-md p-3">
            <div className="flex items-baseline justify-between gap-3">
              <dt className="text-text-secondary">Latest sync attempt</dt>
              <dd className="text-text-primary text-right">
                {detail.integration.lastSyncAt
                  ? formatExactTimestamp(detail.integration.lastSyncAt)
                  : <span className="text-text-secondary">No sync recorded</span>}
              </dd>
            </div>
            <div className="flex items-baseline justify-between gap-3">
              <dt className="text-text-secondary">Latest sync status</dt>
              <dd className="text-text-primary text-right">
                {detail.integration.lastSyncStatus ?? (
                  <span className="text-text-secondary">—</span>
                )}
              </dd>
            </div>
            <div className="flex items-baseline justify-between gap-3">
              <dt className="text-text-secondary">Latest sync error at</dt>
              <dd className="text-text-primary text-right">
                {detail.integration.lastSyncErrorAt
                  ? formatExactTimestamp(detail.integration.lastSyncErrorAt)
                  : <span className="text-text-secondary">—</span>}
              </dd>
            </div>
            {detail.integration.lastSyncError && (
              <div className="pt-2 border-t border-border">
                <dt className="text-text-secondary mb-1">Latest sync error</dt>
                <dd>
                  <pre className="text-[11px] text-text-primary bg-surface border border-border rounded p-2 whitespace-pre-wrap break-words font-mono">
                    {detail.integration.lastSyncError}
                  </pre>
                </dd>
              </div>
            )}
          </dl>
        ) : (
          <div className="text-xs text-text-secondary border border-dashed border-border rounded-md p-3">
            The original integration row has been deleted. The audit trail is
            preserved here, but live sync context is no longer available.
          </div>
        )}
      </div>

      {/* Recipients */}
      <div className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <h4 className="text-xs font-semibold text-text-primary uppercase tracking-wide">
            Recipients ({detail.recipients.length})
          </h4>
          {isSms && detail.twilioConfigured === false && (
            <span className="inline-flex items-center gap-1 text-[11px] text-amber-700 dark:text-amber-400">
              <AlertTriangle className="h-3 w-3" /> Twilio not configured
            </span>
          )}
        </div>
        {!detail.recipientsAvailable ? (
          <div className="text-xs text-text-secondary border border-dashed border-border rounded-md p-3">
            Per-recipient delivery data is only recorded for outage alerts
            sent after this feature shipped. Older alerts only carry the
            aggregate counts shown in the table.
          </div>
        ) : detail.recipients.length === 0 ? (
          <div className="text-xs text-text-secondary border border-dashed border-border rounded-md p-3">
            No per-recipient rows on file for this dispatch.
          </div>
        ) : (
          <ul className="space-y-2">
            {detail.recipients.map((recipient, idx) => {
              const badge = statusBadge(recipient.deliveryStatus);
              const Icon = badge.Icon;
              const contact = isSms ? recipient.phone : recipient.email;
              return (
                <li
                  key={`${recipient.userId ?? 'anon'}-${idx}`}
                  className="border border-border rounded-md p-3 bg-surface"
                >
                  <div className="flex items-start justify-between gap-3 flex-wrap">
                    <div className="min-w-0">
                      <div className="text-sm font-medium text-text-primary">
                        {recipient.name ?? contact ?? 'Unknown recipient'}
                      </div>
                      {contact && recipient.name ? (
                        <div className="text-xs text-text-secondary mt-0.5 truncate">
                          {contact}
                        </div>
                      ) : null}
                      {/* Show the secondary contact (email if SMS row, phone if email row) when present */}
                      {isSms && recipient.email ? (
                        <div className="text-[11px] text-text-secondary mt-0.5">
                          {recipient.email}
                        </div>
                      ) : null}
                    </div>
                    <span
                      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium ${badge.className}`}
                    >
                      <Icon className="h-3 w-3" />
                      {badge.label}
                      {isSms && recipient.twilioStatusCode != null
                        ? ` · HTTP ${recipient.twilioStatusCode}`
                        : ''}
                    </span>
                  </div>
                  {recipient.deliveryError && (
                    <div className="mt-2 text-[11px] text-red-700 dark:text-red-400 break-words">
                      {recipient.deliveryError}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {/* SMS aggregate context (kept for parity with the table view) */}
      {isSms && (
        <div className="text-xs text-text-secondary">
          Twilio accepted{' '}
          <span className="text-text-primary font-medium">
            {detail.smsSucceeded ?? 0}
          </span>{' '}
          of{' '}
          <span className="text-text-primary font-medium">
            {detail.smsAttempted ?? 0}
          </span>{' '}
          SMS sends for this dispatch.
        </div>
      )}
    </div>
  );
}

interface SchedulingDriftAgent {
  id: string;
  name: string;
  scheduling_provider: string | null;
}

interface SchedulingDriftPhone {
  id: string;
  phone_number: string;
  friendly_name: string | null;
  scheduling_provider: string | null;
}

const SCHEDULING_PROVIDER_LABELS: Record<string, string> = {
  'google-calendar': 'Google Calendar',
  'outlook-calendar': 'Outlook Calendar',
};

function formatSchedulingProvider(provider: string): string {
  return SCHEDULING_PROVIDER_LABELS[provider] ?? provider;
}

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

  const { data: oauthAvailabilityData } = useQuery({
    queryKey: ['connectors', 'oauth-availability'],
    queryFn: () => api.get<OAuthAvailabilityResponse>('/connectors/oauth/availability'),
    staleTime: 5 * 60_000,
  });

  const oauthAvailability = oauthAvailabilityData?.providers;
  const location = useLocation();

  const { data: agentsData } = useQuery({
    queryKey: ['agents', 'scheduling-drift'],
    queryFn: () => api.get<{ agents: SchedulingDriftAgent[] }>('/agents?limit=100'),
  });

  const { data: phoneNumbersData } = useQuery({
    queryKey: ['phone-numbers', 'scheduling-drift'],
    queryFn: () => api.get<{ phoneNumbers: SchedulingDriftPhone[] }>('/phone-numbers?limit=100'),
  });

  useEffect(() => {
    if (isLoading) return;
    if (typeof window === 'undefined') return;
    const params = new URLSearchParams(window.location.search);
    const targetId = params.get('integration');
    const targetProvider = params.get('provider');
    if (!targetId && !targetProvider) return;
    const escapeAttr = (value: string) =>
      typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
        ? CSS.escape(value)
        : value.replace(/[^a-zA-Z0-9_-]/g, '');
    let el: HTMLElement | null = null;
    if (targetId) {
      const list = data?.connectors ?? [];
      const match = list.find((c) => c.integrationId === targetId);
      if (match) {
        const def = CONNECTOR_DEFINITIONS.find((d) => d.provider === match.provider);
        if (def) setConnectTarget(def);
      }
      el = document.querySelector<HTMLElement>(
        `[data-integration-id="${escapeAttr(targetId)}"]`,
      );
    } else if (targetProvider) {
      el = document.querySelector<HTMLElement>(
        `[data-provider="${escapeAttr(targetProvider)}"]`,
      );
    }
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el.classList.add(
        'ring-2',
        'ring-amber-400',
        'ring-offset-2',
        'ring-offset-surface',
        'transition-shadow',
      );
      window.setTimeout(() => {
        el?.classList.remove(
          'ring-2',
          'ring-amber-400',
          'ring-offset-2',
          'ring-offset-surface',
          'transition-shadow',
        );
      }, 2400);
    }
    params.delete('integration');
    params.delete('provider');
    const next = params.toString();
    window.history.replaceState({}, '', `${window.location.pathname}${next ? `?${next}` : ''}`);
  }, [isLoading, data, location.search]);

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

  const reconnectNeededDefs = useMemo(
    () =>
      connectedDefs.filter(
        (def) => findConnector(def)?.lastSyncStatus === 'needs_reconnect',
      ),
    [connectedDefs, connectors],
  );

  const enabledSchedulingProviders = useMemo(
    () =>
      new Set(
        connectors.filter((c) => c.connectorType === 'scheduling' && c.isEnabled).map((c) => c.provider),
      ),
    [connectors],
  );

  const schedulingDriftAgents = useMemo(
    () =>
      (agentsData?.agents ?? []).filter(
        (a) => !!a.scheduling_provider && !enabledSchedulingProviders.has(a.scheduling_provider),
      ),
    [agentsData, enabledSchedulingProviders],
  );

  const schedulingDriftPhones = useMemo(
    () =>
      (phoneNumbersData?.phoneNumbers ?? []).filter(
        (p) => !!p.scheduling_provider && !enabledSchedulingProviders.has(p.scheduling_provider),
      ),
    [phoneNumbersData, enabledSchedulingProviders],
  );

  const scrollToConnector = (integrationId: string) => {
    if (typeof document === 'undefined') return;
    const escaped = typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
      ? CSS.escape(integrationId)
      : integrationId.replace(/[^a-zA-Z0-9_-]/g, '');
    const el = document.querySelector<HTMLElement>(`[data-integration-id="${escaped}"]`);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };

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
      <PageHeader
        title="Integrations"
        description="Connect your tools in one click. Events flow automatically to all active integrations."
      />

      {(schedulingDriftAgents.length > 0 || schedulingDriftPhones.length > 0) && (
        <div
          role="alert"
          className="rounded-xl border border-amber-300 dark:border-amber-800/60 bg-amber-50 dark:bg-amber-900/15 p-4"
        >
          <div className="flex items-start gap-3">
            <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-300">
              <AlertTriangle className="h-4 w-4" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold text-amber-900 dark:text-amber-200">
                Some agents and phone numbers point to a calendar that isn't connected
              </p>
              <p className="text-xs text-amber-800/90 dark:text-amber-200/80 mt-1">
                Appointments routed through them won't sync until you reconnect the calendar or pick a different one in the agent / phone-number settings.
              </p>
              {schedulingDriftAgents.length > 0 && (
                <div className="mt-2.5">
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-amber-700 dark:text-amber-300">
                    Agents ({schedulingDriftAgents.length})
                  </p>
                  <ul className="mt-1 text-xs text-amber-900 dark:text-amber-100 space-y-0.5">
                    {schedulingDriftAgents.map((a) => (
                      <li key={a.id}>
                        <span className="font-medium">{a.name}</span>{' '}
                        <span className="text-amber-800/80 dark:text-amber-200/80">
                          → {formatSchedulingProvider(a.scheduling_provider!)} (not connected)
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {schedulingDriftPhones.length > 0 && (
                <div className="mt-2.5">
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-amber-700 dark:text-amber-300">
                    Phone numbers ({schedulingDriftPhones.length})
                  </p>
                  <ul className="mt-1 text-xs text-amber-900 dark:text-amber-100 space-y-0.5">
                    {schedulingDriftPhones.map((p) => (
                      <li key={p.id}>
                        <span className="font-medium">{p.friendly_name || p.phone_number}</span>{' '}
                        <span className="text-amber-800/80 dark:text-amber-200/80">
                          → {formatSchedulingProvider(p.scheduling_provider!)} (not connected)
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {reconnectNeededDefs.length > 0 && (
        <div
          role="alert"
          className="rounded-xl border border-amber-300 dark:border-amber-800/60 bg-amber-50 dark:bg-amber-900/15 p-4"
        >
          <div className="flex items-start gap-3">
            <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-300">
              <AlertTriangle className="h-4 w-4" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold text-amber-900 dark:text-amber-200">
                {reconnectNeededDefs.length === 1
                  ? `${reconnectNeededDefs[0].name} needs to be reconnected`
                  : `${reconnectNeededDefs.length} integrations need to be reconnected`}
              </p>
              <p className="text-xs text-amber-800/90 dark:text-amber-200/80 mt-1">
                Their stored access expired or was revoked, so events are paused until you sign in again.
              </p>
              <div className="mt-2.5 flex flex-wrap gap-2">
                {reconnectNeededDefs.map((def) => {
                  const c = findConnector(def);
                  if (!c) return null;
                  return (
                    <button
                      key={def.id}
                      onClick={() => scrollToConnector(c.integrationId)}
                      className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-white dark:bg-amber-900/40 text-amber-800 dark:text-amber-200 border border-amber-300 dark:border-amber-700/60 hover:bg-amber-100 dark:hover:bg-amber-900/60 transition"
                    >
                      <BrandLogo provider={def.logoId} size={14} />
                      {def.name}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      )}

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
                {suggested.map((def) => {
                  const avail = def.oauthProvider ? oauthAvailability?.[def.oauthProvider] : undefined;
                  const oauthUnavailable = Boolean(def.oauthProvider && avail && avail.available === false);
                  return (
                    <button
                      key={def.id}
                      onClick={() => setConnectTarget(def)}
                      disabled={oauthUnavailable}
                      aria-disabled={oauthUnavailable}
                      title={
                        oauthUnavailable
                          ? `${avail?.providerLabel ?? def.name} OAuth isn't configured on this server yet — ask your platform admin to set ${avail?.missingEnv ?? 'the OAuth client credentials'}.`
                          : undefined
                      }
                      className="inline-flex items-center gap-2 px-3.5 py-2 rounded-lg border border-border bg-surface hover:border-primary/40 hover:bg-surface-hover transition text-sm font-medium text-text-primary disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:border-border disabled:hover:bg-surface"
                    >
                      <BrandLogo provider={def.logoId} size={20} />
                      {oauthUnavailable ? `${def.name} unavailable` : `Connect ${def.name}`}
                    </button>
                  );
                })}
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
                  aria-label="Search integrations"
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
                    oauthAvailability={
                      def.oauthProvider ? oauthAvailability?.[def.oauthProvider] : undefined
                    }
                  />
                ))}
              </div>
            )}
          </div>

          <OutageAlertHistory connectors={data?.connectors ?? []} />

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
