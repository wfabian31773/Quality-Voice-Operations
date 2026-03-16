import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { ArrowUpCircle, AlertTriangle, CheckCircle, ChevronDown, ChevronRight, RefreshCw } from 'lucide-react';

interface ChangelogEntry {
  version: string;
  changeType: string;
  summary: string;
  details: string | null;
  createdAt: string;
}

interface AvailableUpdate {
  installationId: string;
  templateId: string;
  templateSlug: string;
  templateName: string;
  installedVersion: string;
  availableVersion: string;
  upgradeType: 'major' | 'minor' | 'patch';
  isMajor: boolean;
  changelog: ChangelogEntry[];
  requiresConfirmation: boolean;
}

function UpgradeTypeBadge({ type }: { type: string }) {
  const colors: Record<string, string> = {
    major: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400',
    minor: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400',
    patch: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400',
  };
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${colors[type] ?? 'bg-gray-100 text-gray-600'}`}>
      {type}
    </span>
  );
}

function ChangeTypeBadge({ type }: { type: string }) {
  const colors: Record<string, string> = {
    added: 'text-green-600 dark:text-green-400',
    changed: 'text-blue-600 dark:text-blue-400',
    fixed: 'text-yellow-600 dark:text-yellow-400',
    removed: 'text-red-600 dark:text-red-400',
    deprecated: 'text-orange-600 dark:text-orange-400',
    security: 'text-purple-600 dark:text-purple-400',
  };
  return (
    <span className={`text-xs font-medium uppercase ${colors[type] ?? 'text-gray-500'}`}>
      {type}
    </span>
  );
}

function UpdateCard({ update, onUpgrade, isUpgrading }: {
  update: AvailableUpdate;
  onUpgrade: (id: string, confirmed: boolean) => void;
  isUpgrading: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);

  const handleUpgrade = () => {
    if (update.requiresConfirmation && !showConfirm) {
      setShowConfirm(true);
      return;
    }
    onUpgrade(update.installationId, update.requiresConfirmation);
    setShowConfirm(false);
  };

  return (
    <div className="bg-surface border border-border rounded-xl overflow-hidden">
      <div className="px-5 py-4 flex items-center justify-between">
        <div className="flex items-center gap-4">
          <div className="p-2 rounded-lg bg-primary/10">
            <ArrowUpCircle className="h-5 w-5 text-primary" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h3 className="font-semibold">{update.templateName}</h3>
              <UpgradeTypeBadge type={update.upgradeType} />
            </div>
            <p className="text-sm text-muted mt-0.5">
              {update.installedVersion} → {update.availableVersion}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setExpanded(!expanded)}
            className="px-3 py-1.5 text-sm text-muted hover:text-foreground rounded-lg hover:bg-surface-secondary transition-colors"
          >
            {expanded ? (
              <span className="flex items-center gap-1"><ChevronDown className="h-4 w-4" /> Hide Changes</span>
            ) : (
              <span className="flex items-center gap-1"><ChevronRight className="h-4 w-4" /> View Changes</span>
            )}
          </button>
          <button
            onClick={handleUpgrade}
            disabled={isUpgrading}
            className="px-4 py-1.5 text-sm font-medium bg-primary text-white rounded-lg hover:bg-primary/90 disabled:opacity-50 transition-colors"
          >
            {isUpgrading ? 'Upgrading...' : 'Update'}
          </button>
        </div>
      </div>

      {update.isMajor && (
        <div className="px-5 py-2 bg-amber-50 dark:bg-amber-900/20 border-t border-amber-200 dark:border-amber-800 flex items-center gap-2">
          <AlertTriangle className="h-4 w-4 text-amber-500" />
          <span className="text-sm text-amber-700 dark:text-amber-400">
            Major version upgrade — may include breaking changes. Review changelog before updating.
          </span>
        </div>
      )}

      {showConfirm && (
        <div className="px-5 py-3 bg-red-50 dark:bg-red-900/20 border-t border-red-200 dark:border-red-800">
          <p className="text-sm text-red-700 dark:text-red-400 mb-2">
            This is a major version upgrade that may include breaking changes. Are you sure you want to proceed?
          </p>
          <div className="flex gap-2">
            <button
              onClick={handleUpgrade}
              disabled={isUpgrading}
              className="px-3 py-1.5 text-sm font-medium bg-red-600 text-white rounded-lg hover:bg-red-700 disabled:opacity-50"
            >
              {isUpgrading ? 'Upgrading...' : 'Confirm Upgrade'}
            </button>
            <button
              onClick={() => setShowConfirm(false)}
              className="px-3 py-1.5 text-sm text-muted hover:text-foreground rounded-lg hover:bg-surface-secondary"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {expanded && update.changelog.length > 0 && (
        <div className="border-t border-border px-5 py-3">
          <h4 className="text-sm font-medium text-muted mb-2">Changelog</h4>
          <div className="space-y-2">
            {update.changelog.map((entry, i) => (
              <div key={i} className="flex items-start gap-3 text-sm">
                <ChangeTypeBadge type={entry.changeType} />
                <div>
                  <span className="text-foreground">{entry.summary}</span>
                  {entry.details && (
                    <p className="text-muted text-xs mt-0.5">{entry.details}</p>
                  )}
                  <span className="text-xs text-muted ml-2">v{entry.version}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {expanded && update.changelog.length === 0 && (
        <div className="border-t border-border px-5 py-3 text-sm text-muted">
          No detailed changelog available for this update.
        </div>
      )}
    </div>
  );
}

export default function UpdateCenter() {
  const queryClient = useQueryClient();

  const { data, isLoading, refetch } = useQuery({
    queryKey: ['marketplace-updates'],
    queryFn: () => api.get<{ updates: AvailableUpdate[] }>('/marketplace/updates'),
  });

  const upgradeMutation = useMutation({
    mutationFn: ({ id, confirmed }: { id: string; confirmed: boolean }) =>
      api.post(`/marketplace/installations/${id}/upgrade`, { confirmed }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['marketplace-updates'] });
    },
  });

  const updates = data?.updates ?? [];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <ArrowUpCircle className="h-6 w-6 text-primary" />
          <div>
            <h1 className="text-2xl font-bold">Update Center</h1>
            <p className="text-sm text-muted">Manage template updates for your installed agents</p>
          </div>
        </div>
        <button
          onClick={() => refetch()}
          className="flex items-center gap-2 px-3 py-2 text-sm border border-border rounded-lg hover:bg-surface-secondary transition-colors"
        >
          <RefreshCw className="h-4 w-4" />
          Check for Updates
        </button>
      </div>

      {upgradeMutation.isError && (
        <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg px-4 py-3 text-sm text-red-700 dark:text-red-400">
          {(upgradeMutation.error as Error).message}
        </div>
      )}

      {upgradeMutation.isSuccess && (
        <div className="bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 rounded-lg px-4 py-3 text-sm text-green-700 dark:text-green-400 flex items-center gap-2">
          <CheckCircle className="h-4 w-4" />
          Template upgraded successfully!
        </div>
      )}

      {isLoading ? (
        <div className="text-center py-16 text-muted">Checking for available updates...</div>
      ) : updates.length === 0 ? (
        <div className="bg-surface border border-border rounded-xl p-12 text-center">
          <CheckCircle className="h-12 w-12 text-green-500 mx-auto mb-3" />
          <h3 className="text-lg font-semibold mb-1">All up to date</h3>
          <p className="text-muted text-sm">All your installed templates are on the latest version.</p>
        </div>
      ) : (
        <div className="space-y-4">
          <p className="text-sm text-muted">
            {updates.length} update{updates.length !== 1 ? 's' : ''} available
          </p>
          {updates.map((update) => (
            <UpdateCard
              key={update.installationId}
              update={update}
              onUpgrade={(id, confirmed) => upgradeMutation.mutate({ id, confirmed })}
              isUpgrading={upgradeMutation.isPending}
            />
          ))}
        </div>
      )}
    </div>
  );
}
