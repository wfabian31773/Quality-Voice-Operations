import { useState, useEffect, useCallback } from 'react';
import { api } from '../lib/api';
import { Key, Plus, Trash2, Copy, Check, AlertTriangle } from 'lucide-react';

interface ApiKeyRecord {
  id: string;
  name: string;
  keyPrefix: string;
  scopes: string[];
  lastUsedAt: string | null;
  expiresAt: string | null;
  createdAt: string;
}

export default function ApiKeys() {
  const [keys, setKeys] = useState<ApiKeyRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [newKeyName, setNewKeyName] = useState('');
  const [newKeyExpiry, setNewKeyExpiry] = useState('');
  const [creating, setCreating] = useState(false);
  const [plaintextKey, setPlaintextKey] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchKeys = useCallback(async () => {
    try {
      const data = await api.get<{ keys: ApiKeyRecord[] }>('/settings/api-keys');
      setKeys(data.keys);
    } catch {
      setError('Failed to load API keys');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchKeys();
  }, [fetchKeys]);

  const handleCreate = async () => {
    if (!newKeyName.trim()) return;
    setCreating(true);
    setError(null);
    try {
      const data = await api.post<{ key: ApiKeyRecord; plaintextKey: string }>('/settings/api-keys', {
        name: newKeyName.trim(),
        expiresAt: newKeyExpiry || undefined,
      });
      setPlaintextKey(data.plaintextKey);
      setKeys((prev) => [data.key, ...prev]);
      setNewKeyName('');
      setNewKeyExpiry('');
      setShowCreate(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create API key');
    } finally {
      setCreating(false);
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await api.delete(`/settings/api-keys/${id}`);
      setKeys((prev) => prev.filter((k) => k.id !== id));
    } catch {
      setError('Failed to revoke API key');
    }
  };

  const handleCopy = () => {
    if (plaintextKey) {
      navigator.clipboard.writeText(plaintextKey);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-heading">API Keys</h1>
          <p className="text-sm text-muted mt-1">
            Manage API keys for programmatic access to the platform
          </p>
        </div>
        <button
          onClick={() => setShowCreate(true)}
          className="flex items-center gap-2 px-4 py-2 bg-primary text-white rounded-lg hover:bg-primary/90 transition-colors text-sm font-medium"
        >
          <Plus className="h-4 w-4" />
          Create API Key
        </button>
      </div>

      {error && (
        <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg p-3 text-sm text-red-700 dark:text-red-300">
          {error}
        </div>
      )}

      {plaintextKey && (
        <div className="bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 rounded-lg p-4">
          <div className="flex items-start gap-3">
            <AlertTriangle className="h-5 w-5 text-yellow-600 dark:text-yellow-400 shrink-0 mt-0.5" />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-yellow-800 dark:text-yellow-200 mb-2">
                Copy your API key now. It won't be shown again.
              </p>
              <div className="flex items-center gap-2">
                <code className="flex-1 bg-white dark:bg-gray-800 px-3 py-2 rounded border border-yellow-300 dark:border-yellow-700 text-sm font-mono break-all">
                  {plaintextKey}
                </code>
                <button
                  onClick={handleCopy}
                  className="shrink-0 p-2 rounded-lg bg-yellow-100 dark:bg-yellow-800 hover:bg-yellow-200 dark:hover:bg-yellow-700 transition-colors"
                >
                  {copied ? <Check className="h-4 w-4 text-green-600" /> : <Copy className="h-4 w-4 text-yellow-700 dark:text-yellow-300" />}
                </button>
              </div>
              <button
                onClick={() => setPlaintextKey(null)}
                className="mt-2 text-xs text-yellow-700 dark:text-yellow-400 hover:underline"
              >
                Dismiss
              </button>
            </div>
          </div>
        </div>
      )}

      {showCreate && (
        <div className="bg-surface border border-border rounded-lg p-4 space-y-4">
          <h3 className="font-semibold text-heading">Create New API Key</h3>
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label className="block text-sm font-medium text-muted mb-1">Name</label>
              <input
                type="text"
                value={newKeyName}
                onChange={(e) => setNewKeyName(e.target.value)}
                placeholder="e.g., CRM Integration"
                className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-heading text-sm"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-muted mb-1">Expiry (optional)</label>
              <input
                type="date"
                value={newKeyExpiry}
                onChange={(e) => setNewKeyExpiry(e.target.value)}
                className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-heading text-sm"
              />
            </div>
          </div>
          <div className="flex gap-2 justify-end">
            <button
              onClick={() => { setShowCreate(false); setNewKeyName(''); setNewKeyExpiry(''); }}
              className="px-4 py-2 text-sm font-medium text-muted hover:text-heading transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={handleCreate}
              disabled={!newKeyName.trim() || creating}
              className="px-4 py-2 bg-primary text-white rounded-lg hover:bg-primary/90 transition-colors text-sm font-medium disabled:opacity-50"
            >
              {creating ? 'Creating...' : 'Create Key'}
            </button>
          </div>
        </div>
      )}

      <div className="bg-surface border border-border rounded-lg overflow-hidden">
        <table className="w-full">
          <thead>
            <tr className="border-b border-border bg-surface-secondary">
              <th className="text-left px-4 py-3 text-xs font-medium text-muted uppercase">Name</th>
              <th className="text-left px-4 py-3 text-xs font-medium text-muted uppercase">Key Prefix</th>
              <th className="text-left px-4 py-3 text-xs font-medium text-muted uppercase hidden sm:table-cell">Created</th>
              <th className="text-left px-4 py-3 text-xs font-medium text-muted uppercase hidden md:table-cell">Last Used</th>
              <th className="text-left px-4 py-3 text-xs font-medium text-muted uppercase hidden md:table-cell">Expires</th>
              <th className="text-right px-4 py-3 text-xs font-medium text-muted uppercase">Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={6} className="px-4 py-12 text-center text-sm text-muted">
                  Loading...
                </td>
              </tr>
            ) : keys.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-4 py-12 text-center">
                  <Key className="h-8 w-8 text-muted mx-auto mb-2" />
                  <p className="text-sm text-muted">No API keys yet</p>
                </td>
              </tr>
            ) : (
              keys.map((key) => (
                <tr key={key.id} className="border-b border-border last:border-0 hover:bg-surface-secondary/50">
                  <td className="px-4 py-3 text-sm font-medium text-heading">{key.name}</td>
                  <td className="px-4 py-3 text-sm font-mono text-muted">{key.keyPrefix}...</td>
                  <td className="px-4 py-3 text-sm text-muted hidden sm:table-cell">
                    {new Date(key.createdAt).toLocaleDateString()}
                  </td>
                  <td className="px-4 py-3 text-sm text-muted hidden md:table-cell">
                    {key.lastUsedAt ? new Date(key.lastUsedAt).toLocaleDateString() : 'Never'}
                  </td>
                  <td className="px-4 py-3 text-sm text-muted hidden md:table-cell">
                    {key.expiresAt ? new Date(key.expiresAt).toLocaleDateString() : 'Never'}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <button
                      onClick={() => handleDelete(key.id)}
                      className="p-1.5 rounded-lg text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors"
                      title="Revoke key"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <div className="bg-surface-secondary border border-border rounded-lg p-4">
        <h3 className="font-semibold text-heading text-sm mb-2">API Usage</h3>
        <p className="text-xs text-muted mb-3">
          Use your API key in the Authorization header to access the public API:
        </p>
        <code className="block bg-surface px-3 py-2 rounded border border-border text-xs font-mono text-heading break-all">
          curl -H "Authorization: Bearer vai_your_key_here" {window.location.origin}/api/v1/calls
        </code>
        <p className="text-xs text-muted mt-3">
          Available endpoints: GET /api/v1/calls, GET /api/v1/calls/:id, GET /api/v1/campaigns,
          GET /api/v1/campaigns/:id/analytics, POST /api/v1/campaigns/:id/contacts
        </p>
      </div>
    </div>
  );
}
