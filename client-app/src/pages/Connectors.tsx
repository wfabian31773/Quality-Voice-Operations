import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { Plus, Trash2, Plug, X } from 'lucide-react';
import { useRole } from '../lib/useRole';

interface Connector {
  integrationId: string;
  connectorType: string;
  provider: string;
  name: string;
  isEnabled: boolean;
  configKeys: string[];
}

const CONNECTOR_TYPES = ['crm', 'scheduling', 'ticketing', 'sms', 'email', 'ehr', 'webhook', 'custom'] as const;

type ConnectorType = typeof CONNECTOR_TYPES[number];

interface CredentialField {
  key: string;
  label: string;
  type: 'text' | 'password';
  placeholder: string;
}

const CONNECTOR_FIELDS: Record<ConnectorType, CredentialField[]> = {
  crm: [
    { key: 'api_key', label: 'API Key', type: 'password', placeholder: 'Enter API key' },
    { key: 'instance_url', label: 'Instance URL', type: 'text', placeholder: 'https://your-crm.com' },
  ],
  scheduling: [
    { key: 'client_id', label: 'Client ID', type: 'text', placeholder: 'OAuth Client ID' },
    { key: 'client_secret', label: 'Client Secret', type: 'password', placeholder: 'OAuth Client Secret' },
    { key: 'refresh_token', label: 'Refresh Token', type: 'password', placeholder: 'OAuth Refresh Token' },
  ],
  ticketing: [
    { key: 'api_key', label: 'API Key', type: 'password', placeholder: 'Enter API key' },
    { key: 'base_url', label: 'Base URL', type: 'text', placeholder: 'https://api.ticketing.com' },
    { key: 'project_id', label: 'Project ID', type: 'text', placeholder: 'Project or workspace ID' },
  ],
  sms: [
    { key: 'account_sid', label: 'Account SID', type: 'text', placeholder: 'ACxxx...' },
    { key: 'auth_token', label: 'Auth Token', type: 'password', placeholder: 'Auth token' },
    { key: 'from_number', label: 'From Number', type: 'text', placeholder: '+15551234567' },
  ],
  email: [
    { key: 'smtp_host', label: 'SMTP Host', type: 'text', placeholder: 'smtp.example.com' },
    { key: 'smtp_port', label: 'SMTP Port', type: 'text', placeholder: '587' },
    { key: 'username', label: 'Username', type: 'text', placeholder: 'user@example.com' },
    { key: 'password', label: 'Password', type: 'password', placeholder: 'SMTP password' },
  ],
  ehr: [
    { key: 'api_key', label: 'API Key', type: 'password', placeholder: 'Enter API key' },
    { key: 'base_url', label: 'Base URL', type: 'text', placeholder: 'https://ehr.example.com/api' },
    { key: 'tenant_id', label: 'Tenant ID', type: 'text', placeholder: 'EHR tenant identifier' },
  ],
  webhook: [
    { key: 'endpoint_url', label: 'Webhook URL', type: 'text', placeholder: 'https://hooks.example.com/notify' },
    { key: 'secret', label: 'Signing Secret', type: 'password', placeholder: 'Webhook signing secret' },
  ],
  custom: [
    { key: 'api_key', label: 'API Key', type: 'password', placeholder: 'Enter API key' },
    { key: 'endpoint_url', label: 'Endpoint URL', type: 'text', placeholder: 'https://api.service.com' },
  ],
};

interface ConnectorFormData {
  connectorType: ConnectorType;
  provider: string;
  name: string;
  credentials: Record<string, string>;
  isEnabled: boolean;
}

function AddConnectorModal({ onClose }: { onClose: () => void }) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState<ConnectorFormData>({
    connectorType: 'crm',
    provider: '',
    name: '',
    credentials: {},
    isEnabled: true,
  });

  const mutation = useMutation({
    mutationFn: (data: ConnectorFormData) => api.post('/connectors', data),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['connectors'] }); onClose(); },
  });

  const fields = CONNECTOR_FIELDS[form.connectorType];

  const setCred = (key: string, val: string) =>
    setForm((f) => ({ ...f, credentials: { ...f.credentials, [key]: val } }));

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4">
      <div className="bg-surface border border-border rounded-xl shadow-lg w-full max-w-md max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <h2 className="text-lg font-semibold text-text-primary">Add Connector</h2>
          <button onClick={onClose}><X className="h-5 w-5 text-text-secondary" /></button>
        </div>
        <form onSubmit={(e) => { e.preventDefault(); mutation.mutate(form); }} className="p-5 space-y-4">
          <div>
            <label className="block text-sm font-medium text-text-primary mb-1">Type</label>
            <select value={form.connectorType}
              onChange={(e) => setForm((f) => ({ ...f, connectorType: e.target.value as ConnectorType, credentials: {} }))}
              className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-text-primary text-sm">
              {CONNECTOR_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-text-primary mb-1">Provider</label>
            <input value={form.provider} onChange={(e) => setForm((f) => ({ ...f, provider: e.target.value }))} required
              placeholder={form.connectorType === 'crm' ? 'e.g. Salesforce, HubSpot' : `e.g. ${form.connectorType} provider`}
              className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-text-primary text-sm focus:outline-none focus:ring-2 focus:ring-primary/30" />
          </div>
          <div>
            <label className="block text-sm font-medium text-text-primary mb-1">Name</label>
            <input value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} required placeholder="My CRM Connector"
              className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-text-primary text-sm focus:outline-none focus:ring-2 focus:ring-primary/30" />
          </div>

          <div className="border-t border-border pt-4">
            <p className="text-sm font-medium text-text-primary mb-3">Credentials</p>
            <div className="space-y-3">
              {fields.map((field) => (
                <div key={field.key}>
                  <label className="block text-xs font-medium text-text-secondary mb-1">{field.label}</label>
                  <input
                    type={field.type}
                    value={form.credentials[field.key] ?? ''}
                    onChange={(e) => setCred(field.key, e.target.value)}
                    placeholder={field.placeholder}
                    className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-text-primary text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
                  />
                </div>
              ))}
            </div>
          </div>

          {mutation.error && <p className="text-danger text-sm">{(mutation.error as Error).message}</p>}
          <div className="flex justify-end gap-3 pt-2">
            <button type="button" onClick={onClose} className="px-4 py-2 text-sm font-medium text-text-secondary rounded-lg border border-border hover:bg-surface-hover transition">Cancel</button>
            <button type="submit" disabled={mutation.isPending}
              className="px-4 py-2 text-sm font-medium bg-primary text-white rounded-lg hover:bg-primary-hover transition disabled:opacity-50">
              {mutation.isPending ? 'Saving...' : 'Add'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

export default function Connectors() {
  const [showAdd, setShowAdd] = useState(false);
  const queryClient = useQueryClient();
  const { isManager } = useRole();

  const { data, isLoading } = useQuery({
    queryKey: ['connectors'],
    queryFn: () => api.get<{ connectors: Connector[]; total: number }>('/connectors?limit=100'),
  });

  const deleteMut = useMutation({
    mutationFn: (integrationId: string) => api.delete(`/connectors/${integrationId}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['connectors'] }),
  });

  const connectors = data?.connectors ?? [];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-text-primary">Connectors</h1>
          <p className="text-sm text-text-secondary mt-1">Integrate external services with your voice platform</p>
        </div>
        {isManager && (
          <button onClick={() => setShowAdd(true)}
            className="inline-flex items-center gap-2 bg-primary hover:bg-primary-hover text-white text-sm font-medium px-4 py-2.5 rounded-lg transition">
            <Plus className="h-4 w-4" /> Add Connector
          </button>
        )}
      </div>

      {isLoading ? (
        <div className="text-center py-12 text-text-secondary">Loading...</div>
      ) : connectors.length === 0 ? (
        <div className="bg-surface border border-border rounded-xl p-12 text-center">
          <Plug className="h-12 w-12 text-text-muted mx-auto mb-3" />
          <p className="text-text-secondary">No connectors configured</p>
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {connectors.map((c) => (
            <div key={c.integrationId} className="bg-surface border border-border rounded-xl p-5 shadow-sm">
              <div className="flex items-start justify-between mb-2">
                <div>
                  <h3 className="font-semibold text-text-primary">{c.name}</h3>
                  <p className="text-xs text-text-secondary mt-0.5">{c.connectorType} &middot; {c.provider}</p>
                </div>
                <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${c.isEnabled ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400' : 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400'}`}>
                  {c.isEnabled ? 'Active' : 'Disabled'}
                </span>
              </div>
              {isManager && (
                <div className="flex justify-end pt-3 border-t border-border">
                  <button onClick={() => { if (confirm('Delete this connector?')) deleteMut.mutate(c.integrationId); }}
                    className="text-text-secondary hover:text-danger text-xs font-medium inline-flex items-center gap-1 transition">
                    <Trash2 className="h-3.5 w-3.5" /> Delete
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {showAdd && <AddConnectorModal onClose={() => setShowAdd(false)} />}
    </div>
  );
}
