import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import {
  Code2, Package, Upload, CheckCircle, XCircle, Clock,
  BarChart3, Star, Download, DollarSign, ChevronRight,
  AlertCircle, FileText, BookOpen, Terminal, Puzzle,
} from 'lucide-react';

interface Submission {
  id: string;
  developerId: string;
  developerName: string;
  developerEmail: string;
  packageName: string;
  packageSlug: string;
  marketplaceCategory: string;
  description: string;
  shortDescription: string | null;
  version: string;
  priceModel: string;
  priceCents: number;
  manifest: Record<string, unknown>;
  status: string;
  reviewNotes: string | null;
  reviewedBy: string | null;
  reviewedAt: string | null;
  templateId: string | null;
  createdAt: string;
  updatedAt: string;
}

interface DeveloperStats {
  totalSubmissions: number;
  publishedCount: number;
  totalInstalls: number;
  totalRevenue: number;
  avgRating: number;
}

interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

const CATEGORY_OPTIONS = [
  { value: 'vertical_agent', label: 'AI Agent Template' },
  { value: 'workflow_package', label: 'Workflow Package' },
  { value: 'integration_connector', label: 'Integration Connector' },
  { value: 'prompt_pack', label: 'Prompt Pack' },
  { value: 'analytics_pack', label: 'Analytics Pack' },
];

const PRICE_MODEL_OPTIONS = [
  { value: 'free', label: 'Free' },
  { value: 'one_time', label: 'One-Time Purchase' },
  { value: 'monthly_subscription', label: 'Monthly Subscription' },
  { value: 'usage_based', label: 'Usage-Based' },
];

const STATUS_COLORS: Record<string, string> = {
  draft: 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-400',
  submitted: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400',
  in_review: 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400',
  approved: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400',
  rejected: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400',
  published: 'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400',
};

function StatusBadge({ status }: { status: string }) {
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium capitalize ${STATUS_COLORS[status] ?? STATUS_COLORS.draft}`}>
      {status === 'in_review' ? 'In Review' : status}
    </span>
  );
}

function StatCard({ icon: Icon, label, value, suffix }: {
  icon: typeof Package;
  label: string;
  value: number | string;
  suffix?: string;
}) {
  return (
    <div className="bg-surface border border-border rounded-xl p-4">
      <div className="flex items-center gap-2 mb-2">
        <Icon className="h-4 w-4 text-primary" />
        <span className="text-xs text-text-muted">{label}</span>
      </div>
      <p className="text-2xl font-bold text-text-primary">
        {value}{suffix}
      </p>
    </div>
  );
}

function SubmissionForm({ onSuccess }: { onSuccess: () => void }) {
  const [form, setForm] = useState({
    developerName: '',
    developerEmail: '',
    packageName: '',
    packageSlug: '',
    marketplaceCategory: 'vertical_agent',
    description: '',
    shortDescription: '',
    version: '1.0.0',
    priceModel: 'free',
    priceCents: 0,
  });

  const [manifestJson, setManifestJson] = useState('{\n  "supportedChannels": ["voice"],\n  "requiredTools": [],\n  "configSchema": {}\n}');
  const [validation, setValidation] = useState<ValidationResult | null>(null);

  const validateMutation = useMutation({
    mutationFn: () => {
      let manifest = {};
      try {
        manifest = JSON.parse(manifestJson);
      } catch {
        return Promise.resolve({ validation: { valid: false, errors: ['Invalid JSON in manifest'], warnings: [] } });
      }
      return api.post<{ validation: ValidationResult }>('/marketplace/developer/submissions/validate', {
        ...form,
        manifest,
      });
    },
    onSuccess: (data) => {
      setValidation(data?.validation ?? null);
    },
  });

  const submitMutation = useMutation({
    mutationFn: () => {
      const manifest = JSON.parse(manifestJson);
      return api.post('/marketplace/developer/submissions', {
        ...form,
        priceCents: form.priceModel === 'free' ? 0 : form.priceCents,
        manifest,
      });
    },
    onSuccess: () => {
      onSuccess();
    },
  });

  const updateField = (key: string, value: string | number) => {
    if (key === 'packageName') {
      const strValue = String(value);
      setForm((prev) => ({
        ...prev,
        packageName: strValue,
        packageSlug: strValue.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
      }));
    } else if (key === 'priceCents') {
      setForm((prev) => ({ ...prev, priceCents: Number(value) }));
    } else {
      setForm((prev) => ({ ...prev, [key]: String(value) }));
    }
  };

  return (
    <div className="bg-surface border border-border rounded-xl p-6 space-y-5">
      <h2 className="text-lg font-semibold text-text-primary flex items-center gap-2">
        <Upload className="h-5 w-5 text-primary" />
        Submit a Package
      </h2>

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label className="block text-sm font-medium text-text-primary mb-1">Developer Name</label>
          <input
            value={form.developerName}
            onChange={(e) => updateField('developerName', e.target.value)}
            className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-text-primary text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
            placeholder="Your name or company"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-text-primary mb-1">Email</label>
          <input
            type="email"
            value={form.developerEmail}
            onChange={(e) => updateField('developerEmail', e.target.value)}
            className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-text-primary text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
            placeholder="developer@example.com"
          />
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label className="block text-sm font-medium text-text-primary mb-1">Package Name</label>
          <input
            value={form.packageName}
            onChange={(e) => updateField('packageName', e.target.value)}
            className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-text-primary text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
            placeholder="My Amazing Agent"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-text-primary mb-1">Slug</label>
          <input
            value={form.packageSlug}
            onChange={(e) => updateField('packageSlug', e.target.value)}
            className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-text-primary text-sm focus:outline-none focus:ring-2 focus:ring-primary/30 font-mono"
            placeholder="my-amazing-agent"
          />
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label className="block text-sm font-medium text-text-primary mb-1">Category</label>
          <select
            value={form.marketplaceCategory}
            onChange={(e) => updateField('marketplaceCategory', e.target.value)}
            className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-text-primary text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
          >
            {CATEGORY_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-sm font-medium text-text-primary mb-1">Version</label>
          <input
            value={form.version}
            onChange={(e) => updateField('version', e.target.value)}
            className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-text-primary text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
            placeholder="1.0.0"
          />
        </div>
      </div>

      <div>
        <label className="block text-sm font-medium text-text-primary mb-1">Short Description</label>
        <input
          value={form.shortDescription}
          onChange={(e) => updateField('shortDescription', e.target.value)}
          className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-text-primary text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
          placeholder="A brief one-line summary"
          maxLength={200}
        />
      </div>

      <div>
        <label className="block text-sm font-medium text-text-primary mb-1">Description</label>
        <textarea
          value={form.description}
          onChange={(e) => updateField('description', e.target.value)}
          rows={4}
          className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-text-primary text-sm focus:outline-none focus:ring-2 focus:ring-primary/30 resize-y"
          placeholder="Detailed description of your package..."
        />
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label className="block text-sm font-medium text-text-primary mb-1">Pricing Model</label>
          <select
            value={form.priceModel}
            onChange={(e) => updateField('priceModel', e.target.value)}
            className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-text-primary text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
          >
            {PRICE_MODEL_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
        </div>
        {form.priceModel !== 'free' && (
          <div>
            <label className="block text-sm font-medium text-text-primary mb-1">Price (USD)</label>
            <input
              type="number"
              min="0"
              step="0.01"
              value={(form.priceCents / 100).toFixed(2)}
              onChange={(e) => updateField('priceCents', Math.round(parseFloat(e.target.value || '0') * 100))}
              className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-text-primary text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
              placeholder="9.99"
            />
          </div>
        )}
      </div>

      <div>
        <label className="block text-sm font-medium text-text-primary mb-1">Package Manifest (JSON)</label>
        <textarea
          value={manifestJson}
          onChange={(e) => setManifestJson(e.target.value)}
          rows={8}
          className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-text-primary text-xs font-mono focus:outline-none focus:ring-2 focus:ring-primary/30 resize-y"
        />
      </div>

      {validation && (
        <div className={`p-4 rounded-lg border ${validation.valid ? 'bg-green-50 dark:bg-green-900/10 border-green-200 dark:border-green-800' : 'bg-red-50 dark:bg-red-900/10 border-red-200 dark:border-red-800'}`}>
          <p className={`text-sm font-medium ${validation.valid ? 'text-green-700 dark:text-green-400' : 'text-red-700 dark:text-red-400'}`}>
            {validation.valid ? 'Validation passed' : 'Validation failed'}
          </p>
          {validation.errors.map((err, i) => (
            <p key={i} className="text-xs text-red-600 dark:text-red-400 mt-1 flex items-start gap-1">
              <XCircle className="h-3 w-3 mt-0.5 shrink-0" /> {err}
            </p>
          ))}
          {validation.warnings.map((warn, i) => (
            <p key={i} className="text-xs text-yellow-600 dark:text-yellow-400 mt-1 flex items-start gap-1">
              <AlertCircle className="h-3 w-3 mt-0.5 shrink-0" /> {warn}
            </p>
          ))}
        </div>
      )}

      {submitMutation.error && (
        <p className="text-sm text-danger">{(submitMutation.error as Error).message}</p>
      )}

      <div className="flex justify-end gap-3">
        <button
          onClick={() => validateMutation.mutate()}
          disabled={validateMutation.isPending}
          className="px-4 py-2 text-sm font-medium text-text-secondary border border-border rounded-lg hover:bg-surface-hover transition disabled:opacity-50"
        >
          {validateMutation.isPending ? 'Validating...' : 'Validate'}
        </button>
        <button
          onClick={() => submitMutation.mutate()}
          disabled={submitMutation.isPending || !form.packageName || !form.description}
          className="px-4 py-2 text-sm font-medium bg-primary text-white rounded-lg hover:bg-primary-hover transition disabled:opacity-50 inline-flex items-center gap-2"
        >
          <Upload className="h-4 w-4" />
          {submitMutation.isPending ? 'Submitting...' : 'Submit for Review'}
        </button>
      </div>
    </div>
  );
}

function SubmissionsList() {
  const { data, isLoading } = useQuery({
    queryKey: ['developer-submissions'],
    queryFn: () => api.get<{ submissions: Submission[]; total: number }>('/marketplace/developer/submissions'),
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="animate-spin h-6 w-6 border-2 border-primary border-t-transparent rounded-full" />
      </div>
    );
  }

  const submissions = data?.submissions ?? [];

  if (submissions.length === 0) {
    return (
      <div className="bg-surface border border-border rounded-xl p-8 text-center">
        <Package className="h-10 w-10 text-text-muted mx-auto mb-2" />
        <p className="text-text-secondary">No submissions yet.</p>
        <p className="text-xs text-text-muted mt-1">Submit your first package using the form above.</p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {submissions.map((sub) => (
        <div key={sub.id} className="bg-surface border border-border rounded-xl p-4">
          <div className="flex items-start justify-between">
            <div>
              <div className="flex items-center gap-2 mb-1">
                <h3 className="text-sm font-semibold text-text-primary">{sub.packageName}</h3>
                <StatusBadge status={sub.status} />
              </div>
              <p className="text-xs text-text-muted">
                {sub.packageSlug} &middot; v{sub.version} &middot; {sub.marketplaceCategory.replace('_', ' ')}
              </p>
              {sub.shortDescription && (
                <p className="text-xs text-text-secondary mt-1">{sub.shortDescription}</p>
              )}
            </div>
            <div className="text-right text-xs text-text-muted">
              {new Date(sub.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
            </div>
          </div>
          {sub.reviewNotes && (
            <div className="mt-2 p-2 bg-surface-hover rounded text-xs text-text-secondary">
              <span className="font-medium">Review notes:</span> {sub.reviewNotes}
            </div>
          )}
          {sub.status === 'published' && sub.templateId && (
            <div className="mt-2 flex items-center gap-1 text-xs text-green-600 dark:text-green-400">
              <CheckCircle className="h-3 w-3" />
              Published to marketplace
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function DocumentationSection() {
  return (
    <div className="space-y-4">
      <div className="bg-surface border border-border rounded-xl p-6">
        <div className="flex items-center gap-2 mb-4">
          <BookOpen className="h-5 w-5 text-primary" />
          <h2 className="text-lg font-semibold text-text-primary">SDK Documentation</h2>
        </div>
        <div className="space-y-4 text-sm text-text-secondary">
          <div>
            <h3 className="font-medium text-text-primary mb-1">Package Manifest Structure</h3>
            <p>Every marketplace package requires a JSON manifest that describes its capabilities, requirements, and configuration schema.</p>
            <pre className="mt-2 p-3 bg-surface-hover rounded-lg text-xs font-mono overflow-x-auto">{`{
  "supportedChannels": ["voice", "sms", "web"],
  "requiredTools": ["calendar", "crm"],
  "optionalTools": ["email-sender"],
  "configSchema": {
    "customizable": ["name", "voice", "greeting"],
    "locked": ["type", "model"]
  },
  "agentType": "inbound",
  "defaultVoice": "sage",
  "defaultLanguage": "en",
  "minPlan": "starter",
  "tags": ["healthcare", "scheduling"]
}`}</pre>
          </div>

          <div>
            <h3 className="font-medium text-text-primary mb-1">Package Categories</h3>
            <div className="grid gap-2 sm:grid-cols-2 mt-2">
              <div className="p-3 border border-border rounded-lg">
                <p className="font-medium text-text-primary text-xs">AI Agent Templates</p>
                <p className="text-xs text-text-muted mt-0.5">Full agent configurations for specific industries or use cases</p>
              </div>
              <div className="p-3 border border-border rounded-lg">
                <p className="font-medium text-text-primary text-xs">Workflow Packages</p>
                <p className="text-xs text-text-muted mt-0.5">Standalone automation playbooks (lead qualification, scheduling, etc.)</p>
              </div>
              <div className="p-3 border border-border rounded-lg">
                <p className="font-medium text-text-primary text-xs">Integration Connectors</p>
                <p className="text-xs text-text-muted mt-0.5">Third-party connectors (HubSpot, Salesforce, Zendesk, etc.)</p>
              </div>
              <div className="p-3 border border-border rounded-lg">
                <p className="font-medium text-text-primary text-xs">Prompt Packs</p>
                <p className="text-xs text-text-muted mt-0.5">Optimized prompt sets for specific use cases</p>
              </div>
            </div>
          </div>

          <div>
            <h3 className="font-medium text-text-primary mb-1">Revenue Share</h3>
            <p>Developers receive 70% of all paid marketplace sales. Revenue is tracked in real-time and payouts are processed monthly.</p>
          </div>
        </div>
      </div>

      <div className="bg-surface border border-border rounded-xl p-6">
        <div className="flex items-center gap-2 mb-4">
          <Terminal className="h-5 w-5 text-primary" />
          <h2 className="text-lg font-semibold text-text-primary">API Reference</h2>
        </div>
        <div className="space-y-3 text-sm">
          <div className="p-3 border border-border rounded-lg">
            <div className="flex items-center gap-2 mb-1">
              <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400">POST</span>
              <code className="text-xs font-mono text-text-primary">/api/marketplace/developer/submissions</code>
            </div>
            <p className="text-xs text-text-muted">Submit a new package for review</p>
          </div>
          <div className="p-3 border border-border rounded-lg">
            <div className="flex items-center gap-2 mb-1">
              <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400">POST</span>
              <code className="text-xs font-mono text-text-primary">/api/marketplace/developer/submissions/validate</code>
            </div>
            <p className="text-xs text-text-muted">Validate a package manifest before submission</p>
          </div>
          <div className="p-3 border border-border rounded-lg">
            <div className="flex items-center gap-2 mb-1">
              <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400">GET</span>
              <code className="text-xs font-mono text-text-primary">/api/marketplace/developer/submissions</code>
            </div>
            <p className="text-xs text-text-muted">List your submissions and their review status</p>
          </div>
          <div className="p-3 border border-border rounded-lg">
            <div className="flex items-center gap-2 mb-1">
              <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400">GET</span>
              <code className="text-xs font-mono text-text-primary">/api/marketplace/developer/stats</code>
            </div>
            <p className="text-xs text-text-muted">Get your developer dashboard statistics</p>
          </div>
        </div>
      </div>

      <div className="bg-surface border border-border rounded-xl p-6">
        <div className="flex items-center gap-2 mb-4">
          <FileText className="h-5 w-5 text-primary" />
          <h2 className="text-lg font-semibold text-text-primary">Submission Guidelines</h2>
        </div>
        <div className="space-y-2 text-sm text-text-secondary">
          <div className="flex items-start gap-2">
            <CheckCircle className="h-4 w-4 text-green-500 shrink-0 mt-0.5" />
            <p>Package name must be at least 3 characters and descriptive</p>
          </div>
          <div className="flex items-start gap-2">
            <CheckCircle className="h-4 w-4 text-green-500 shrink-0 mt-0.5" />
            <p>Description must be at least 20 characters explaining functionality</p>
          </div>
          <div className="flex items-start gap-2">
            <CheckCircle className="h-4 w-4 text-green-500 shrink-0 mt-0.5" />
            <p>Slug must use only lowercase letters, numbers, and hyphens</p>
          </div>
          <div className="flex items-start gap-2">
            <CheckCircle className="h-4 w-4 text-green-500 shrink-0 mt-0.5" />
            <p>Version must follow semantic versioning (e.g., 1.0.0)</p>
          </div>
          <div className="flex items-start gap-2">
            <CheckCircle className="h-4 w-4 text-green-500 shrink-0 mt-0.5" />
            <p>Manifest must include valid JSON with required fields</p>
          </div>
          <div className="flex items-start gap-2">
            <AlertCircle className="h-4 w-4 text-yellow-500 shrink-0 mt-0.5" />
            <p>All submissions undergo platform admin review before publication</p>
          </div>
        </div>
      </div>
    </div>
  );
}

type DeveloperView = 'dashboard' | 'submit' | 'docs';

export default function DeveloperPortal() {
  const queryClient = useQueryClient();
  const [activeView, setActiveView] = useState<DeveloperView>('dashboard');

  const { data: stats } = useQuery({
    queryKey: ['developer-stats'],
    queryFn: () => api.get<DeveloperStats>('/marketplace/developer/stats'),
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Code2 className="h-6 w-6 text-primary" />
          <div>
            <h1 className="text-2xl font-bold text-text-primary">Developer Portal</h1>
            <p className="text-sm text-text-secondary">Build, submit, and manage marketplace packages</p>
          </div>
        </div>
      </div>

      <div className="flex gap-2 border-b border-border">
        {([
          { key: 'dashboard', label: 'Dashboard', icon: BarChart3 },
          { key: 'submit', label: 'Submit Package', icon: Upload },
          { key: 'docs', label: 'Documentation', icon: BookOpen },
        ] as const).map(({ key, label, icon: Icon }) => (
          <button
            key={key}
            onClick={() => setActiveView(key)}
            className={`px-4 py-2.5 text-sm font-medium transition-colors border-b-2 -mb-px inline-flex items-center gap-1.5 ${
              activeView === key ? 'border-primary text-primary' : 'border-transparent text-text-muted hover:text-text-primary'
            }`}
          >
            <Icon className="h-4 w-4" />
            {label}
          </button>
        ))}
      </div>

      {activeView === 'dashboard' && (
        <div className="space-y-6">
          {stats && (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <StatCard icon={Package} label="Total Submissions" value={stats.totalSubmissions} />
              <StatCard icon={CheckCircle} label="Published" value={stats.publishedCount} />
              <StatCard icon={Download} label="Total Installs" value={stats.totalInstalls} />
              <StatCard
                icon={DollarSign}
                label="Total Revenue"
                value={`$${(stats.totalRevenue / 100).toFixed(2)}`}
              />
            </div>
          )}

          {stats && stats.avgRating > 0 && (
            <div className="bg-surface border border-border rounded-xl p-4 flex items-center gap-3">
              <Star className="h-5 w-5 text-amber-400" />
              <span className="text-sm text-text-primary font-medium">Average Rating: {stats.avgRating.toFixed(1)}/5</span>
            </div>
          )}

          <div>
            <h2 className="text-lg font-semibold text-text-primary mb-3">Your Submissions</h2>
            <SubmissionsList />
          </div>
        </div>
      )}

      {activeView === 'submit' && (
        <SubmissionForm
          onSuccess={() => {
            queryClient.invalidateQueries({ queryKey: ['developer-submissions'] });
            queryClient.invalidateQueries({ queryKey: ['developer-stats'] });
            setActiveView('dashboard');
          }}
        />
      )}

      {activeView === 'docs' && <DocumentationSection />}
    </div>
  );
}
