import { useState, useEffect } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api } from '../lib/api';
import {
  CheckCircle2, Circle, Phone, MessageSquare, BookOpen,
  Mic, TestTube, Rocket, ChevronRight, ArrowLeft, Lock,
  Save, AlertCircle, Loader2, Settings2,
} from 'lucide-react';
import { PageHeader } from '../components/ui';

interface ChecklistStep {
  key: string;
  label: string;
  description: string;
  completed: boolean;
  completedAt: string | null;
  link: string;
  order: number;
}

interface ChecklistState {
  steps: ChecklistStep[];
  completedCount: number;
  totalCount: number;
  allComplete: boolean;
}

interface FieldSchema {
  key: string;
  label: string;
  type: 'text' | 'textarea' | 'select' | 'number' | 'toggle' | 'json';
  locked: boolean;
  lockReason?: string;
  options?: { value: string; label: string }[];
  group: string;
  groupTitle: string;
}

interface CustomizationSchema {
  customizableFields: FieldSchema[];
  lockedFields: FieldSchema[];
}

interface Installation {
  id: string;
  template_name: string;
  template_slug: string;
  agent_name: string;
  agent_id: string;
  agent_type: string;
  installed_version: string;
}

const STEP_ICONS: Record<string, typeof Phone> = {
  assign_phone: Phone,
  enable_widget: MessageSquare,
  attach_knowledge: BookOpen,
  customize_greeting: Mic,
  test_call: TestTube,
  publish_agent: Rocket,
};

function StepCard({
  step,
  installationId,
  onComplete,
}: {
  step: ChecklistStep;
  installationId: string;
  onComplete: (stepKey: string) => void;
}) {
  const { t } = useTranslation();
  const Icon = STEP_ICONS[step.key] ?? Circle;
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const stepActionLabel = (key: string) => {
    const fallback = t('post_install.actions.go');
    return t(`post_install.actions.${key}`, { defaultValue: fallback });
  };

  const apiActionSteps = new Set(['assign_phone', 'enable_widget', 'publish_agent']);
  const hasApiAction = apiActionSteps.has(step.key);
  const isCustomizeTab = step.key === 'customize_greeting';
  const hasNavLink = !!step.link && !hasApiAction && !isCustomizeTab;
  const isManualComplete = !hasApiAction && !isCustomizeTab && !hasNavLink;

  const handleApiAction = async () => {
    setLoading(true);
    setError(null);
    try {
      if (step.key === 'assign_phone') {
        await api.post(`/marketplace/installations/${installationId}/assign-phone`, {});
      } else if (step.key === 'enable_widget') {
        await api.post(`/marketplace/installations/${installationId}/enable-widget`, {});
      } else if (step.key === 'publish_agent') {
        await api.post(`/marketplace/installations/${installationId}/publish-agent`, {});
      }
      onComplete(step.key);
    } catch (err) {
      const msg = err instanceof Error ? err.message : t('post_install.step_card.action_failed');
      setError(msg);
    }
    setLoading(false);
  };

  const handleMarkComplete = () => {
    onComplete(step.key);
  };

  return (
    <div
      className={`bg-surface border rounded-xl p-5 transition-all ${
        step.completed
          ? 'border-green-300 dark:border-green-700 bg-green-50/50 dark:bg-green-900/10'
          : 'border-border hover:border-primary/40 hover:shadow-sm'
      }`}
    >
      <div className="flex items-start gap-4">
        <div className={`mt-0.5 shrink-0 ${step.completed ? 'text-green-600 dark:text-green-400' : 'text-text-muted'}`}>
          {step.completed ? (
            <CheckCircle2 className="h-6 w-6" />
          ) : (
            <div className="h-6 w-6 rounded-full border-2 border-current flex items-center justify-center">
              <Icon className="h-3.5 w-3.5" />
            </div>
          )}
        </div>
        <div className="flex-1 min-w-0">
          <h3 className={`text-sm font-semibold ${step.completed ? 'text-green-700 dark:text-green-400' : 'text-text-primary'}`}>
            {step.label}
          </h3>
          <p className="text-xs text-text-muted mt-0.5">{step.description}</p>
          {step.completed && step.completedAt && (
            <p className="text-xs text-green-600 dark:text-green-400 mt-1">
              {t('post_install.step_card.completed_at', { date: new Date(step.completedAt).toLocaleDateString() })}
            </p>
          )}
          {error && (
            <p className="text-xs text-danger mt-1 flex items-center gap-1">
              <AlertCircle className="h-3 w-3" /> {error}
            </p>
          )}
        </div>
        {!step.completed && (
          <div className="shrink-0 flex items-center gap-2">
            {isCustomizeTab ? (
              <>
                <button
                  onClick={() => {
                    const el = document.querySelector('[data-tab="customize"]');
                    if (el instanceof HTMLElement) el.click();
                  }}
                  className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-primary hover:text-primary-hover transition"
                >
                  {t('post_install.step_card.customize')} <ChevronRight className="h-3.5 w-3.5" />
                </button>
                <button
                  onClick={handleMarkComplete}
                  className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-text-secondary hover:text-text-primary border border-border rounded-lg hover:bg-surface-hover transition"
                >
                  <CheckCircle2 className="h-3.5 w-3.5" /> {t('post_install.step_card.done')}
                </button>
              </>
            ) : hasNavLink ? (
              <>
                <Link
                  to={step.link}
                  className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-primary hover:text-primary-hover transition"
                >
                  {stepActionLabel(step.key)} <ChevronRight className="h-3.5 w-3.5" />
                </Link>
                <button
                  onClick={handleMarkComplete}
                  className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-text-secondary hover:text-text-primary border border-border rounded-lg hover:bg-surface-hover transition"
                >
                  <CheckCircle2 className="h-3.5 w-3.5" /> {t('post_install.step_card.done')}
                </button>
              </>
            ) : hasApiAction ? (
              <button
                onClick={handleApiAction}
                disabled={loading}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-primary text-white rounded-lg hover:bg-primary-hover disabled:opacity-50 transition"
              >
                {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                {stepActionLabel(step.key)}
              </button>
            ) : (
              <button
                onClick={handleMarkComplete}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-primary text-white rounded-lg hover:bg-primary-hover transition"
              >
                {t(`post_install.actions.${step.key}`, { defaultValue: t('post_install.actions.mark_complete') })}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function CustomizationForm({
  installationId,
  locale,
  onGreetingSaved,
}: {
  installationId: string;
  locale: string;
  onGreetingSaved: () => void;
}) {
  const { t } = useTranslation();
  // Locale is part of the cache key so a language switch refetches localized
  // labels/lock reasons/group titles instead of reusing stale English copy.
  const { data, isLoading } = useQuery({
    queryKey: ['customization-schema', installationId, locale],
    queryFn: () =>
      api.get<{
        schema: CustomizationSchema;
        currentValues: Record<string, unknown>;
        agentId: string;
        agentType: string;
      }>(
        `/marketplace/installations/${installationId}/customization-schema?locale=${encodeURIComponent(locale)}`,
      ),
  });

  const [form, setForm] = useState<Record<string, unknown>>({});
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (data?.currentValues) {
      setForm(data.currentValues);
    }
  }, [data]);

  const saveMutation = useMutation({
    mutationFn: async (updates: Record<string, unknown>) => {
      return api.patch(`/marketplace/installations/${installationId}/customize`, updates);
    },
    onSuccess: () => {
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
      if (form.welcome_greeting && String(form.welcome_greeting).trim().length > 0) {
        onGreetingSaved();
      }
    },
    onError: (err: Error) => {
      setError(err.message);
    },
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-6 w-6 animate-spin text-text-muted" />
      </div>
    );
  }

  if (!data) return null;

  const { schema } = data;
  const groupOrder = ['general', 'voice', 'workflow', 'escalation', 'knowledge'];
  // Anything outside the known order sorts after it but is still rendered.
  const groupRank = (g: string) => {
    const idx = groupOrder.indexOf(g);
    return idx === -1 ? groupOrder.length : idx;
  };
  const allFields = [...schema.customizableFields, ...schema.lockedFields].sort(
    (a, b) => groupRank(a.group) - groupRank(b.group),
  );

  // Build sections in the canonical order, then append any extra groups that
  // came back from the server (manifest-declared ad-hoc groups) so unknown
  // values aren't silently dropped from the form.
  const knownGroupSections = groupOrder.map((group) => {
    const fields = allFields.filter((f) => f.group === group);
    return { group, title: fields[0]?.groupTitle ?? group, fields };
  });
  const knownGroupSet = new Set(groupOrder);
  const extraGroups = Array.from(new Set(allFields.map((f) => f.group))).filter(
    (g) => !knownGroupSet.has(g),
  );
  const extraGroupSections = extraGroups.map((group) => {
    const fields = allFields.filter((f) => f.group === group);
    return { group, title: fields[0]?.groupTitle ?? group, fields };
  });
  const fieldsByGroup = [...knownGroupSections, ...extraGroupSections].filter(
    (g) => g.fields.length > 0,
  );

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const updates: Record<string, unknown> = {};
    for (const field of schema.customizableFields) {
      if (form[field.key] !== data.currentValues[field.key]) {
        updates[field.key] = form[field.key];
      }
    }
    if (Object.keys(updates).length === 0) {
      setError(t('post_install.customization.no_changes'));
      setTimeout(() => setError(null), 2000);
      return;
    }
    setError(null);
    saveMutation.mutate(updates);
  };

  const renderField = (field: FieldSchema) => {
    const value = form[field.key] ?? '';

    if (field.locked) {
      return (
        <div key={field.key} className="space-y-1.5">
          <div className="flex items-center gap-2">
            <label className="block text-sm font-medium text-text-primary">{field.label}</label>
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400">
              <Lock className="h-3 w-3" /> {t('post_install.customization.template_locked')}
            </span>
          </div>
          {field.type === 'textarea' ? (
            <textarea
              value={String(value)}
              readOnly
              rows={3}
              className="w-full px-3 py-2 rounded-lg border border-border bg-surface-secondary text-text-secondary text-sm cursor-not-allowed opacity-60 resize-none"
            />
          ) : (
            <input
              value={typeof value === 'object' ? JSON.stringify(value) : String(value)}
              readOnly
              className="w-full px-3 py-2 rounded-lg border border-border bg-surface-secondary text-text-secondary text-sm cursor-not-allowed opacity-60"
            />
          )}
          {field.lockReason && (
            <p className="text-xs text-amber-600 dark:text-amber-400">{field.lockReason}</p>
          )}
        </div>
      );
    }

    const onChange = (v: unknown) => setForm((f) => ({ ...f, [field.key]: v }));

    if (field.type === 'select' && field.options) {
      return (
        <div key={field.key} className="space-y-1.5">
          <label className="block text-sm font-medium text-text-primary">{field.label}</label>
          <select
            value={String(value)}
            onChange={(e) => onChange(e.target.value)}
            className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-text-primary text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
          >
            {field.options.map((opt) => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
        </div>
      );
    }

    if (field.type === 'textarea') {
      return (
        <div key={field.key} className="space-y-1.5">
          <label className="block text-sm font-medium text-text-primary">{field.label}</label>
          <textarea
            value={String(value)}
            onChange={(e) => onChange(e.target.value)}
            rows={3}
            className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-text-primary text-sm focus:outline-none focus:ring-2 focus:ring-primary/30 resize-y"
          />
        </div>
      );
    }

    if (field.type === 'number') {
      return (
        <div key={field.key} className="space-y-1.5">
          <label className="block text-sm font-medium text-text-primary">{field.label}: {String(value)}</label>
          <input
            type="range"
            min="0"
            max="1"
            step="0.1"
            value={Number(value) || 0.7}
            onChange={(e) => onChange(parseFloat(e.target.value))}
            className="w-full"
          />
        </div>
      );
    }

    if (field.type === 'json') {
      const jsonStr = typeof value === 'object' && value !== null ? JSON.stringify(value, null, 2) : String(value || '{}');
      return (
        <div key={field.key} className="space-y-1.5">
          <label className="block text-sm font-medium text-text-primary">{field.label}</label>
          <textarea
            value={jsonStr}
            onChange={(e) => {
              try {
                onChange(JSON.parse(e.target.value));
              } catch {
                onChange(e.target.value);
              }
            }}
            rows={4}
            className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-text-primary text-sm font-mono focus:outline-none focus:ring-2 focus:ring-primary/30 resize-y"
          />
        </div>
      );
    }

    return (
      <div key={field.key} className="space-y-1.5">
        <label className="block text-sm font-medium text-text-primary">{field.label}</label>
        <input
          value={String(value)}
          onChange={(e) => onChange(e.target.value)}
          className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-text-primary text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
        />
      </div>
    );
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      {fieldsByGroup.map((group) => (
        <section key={group.group} className="space-y-4">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-text-muted">
            {group.title}
          </h3>
          <div className="space-y-5">
            {group.fields.map(renderField)}
          </div>
        </section>
      ))}

      {error && (
        <div className="flex items-center gap-2 text-sm text-danger">
          <AlertCircle className="h-4 w-4 shrink-0" />
          {error}
        </div>
      )}
      {saved && (
        <div className="flex items-center gap-2 text-sm text-green-600 dark:text-green-400">
          <CheckCircle2 className="h-4 w-4 shrink-0" />
          {t('post_install.customization.saved')}
        </div>
      )}

      <div className="flex justify-end pt-2">
        <button
          type="submit"
          disabled={saveMutation.isPending}
          className="inline-flex items-center gap-1.5 px-4 py-2 bg-primary hover:bg-primary-hover text-white text-sm font-medium rounded-lg disabled:opacity-50 transition"
        >
          <Save className="h-4 w-4" />
          {saveMutation.isPending ? t('post_install.customization.saving') : t('post_install.customization.save')}
        </button>
      </div>
    </form>
  );
}

export default function PostInstallSetup() {
  const { t, i18n } = useTranslation();
  const { installationId } = useParams<{ installationId: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [activeTab, setActiveTab] = useState<'checklist' | 'customize'>('checklist');

  // Included as a query param so the server returns localized labels, and
  // in the cache key so a language switch refetches instead of reusing stale copy.
  const checklistLocale = i18n.language || 'en';

  const { data: installData } = useQuery({
    queryKey: ['installation-detail', installationId],
    queryFn: () => api.get<{ installations: Installation[] }>('/marketplace/installations'),
    select: (data) => data.installations.find((i: Installation) => i.id === installationId),
    enabled: !!installationId,
  });

  const { data: checklistData, isLoading: checklistLoading } = useQuery({
    queryKey: ['checklist', installationId, checklistLocale],
    queryFn: () =>
      api.get<{ checklist: ChecklistState }>(
        `/marketplace/installations/${installationId}/checklist?locale=${encodeURIComponent(checklistLocale)}`,
      ),
    enabled: !!installationId,
  });

  const markCompleteMutation = useMutation({
    mutationFn: (stepKey: string) =>
      api.patch(
        `/marketplace/installations/${installationId}/checklist?locale=${encodeURIComponent(checklistLocale)}`,
        { stepKey, completed: true },
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['checklist', installationId] });
    },
  });

  const handleStepComplete = (stepKey: string) => {
    markCompleteMutation.mutate(stepKey);
  };

  const handleGreetingSaved = () => {
    markCompleteMutation.mutate('customize_greeting');
  };

  const checklist = checklistData?.checklist;
  const progressPct = checklist ? Math.round((checklist.completedCount / checklist.totalCount) * 100) : 0;

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      <PageHeader
        icon={<Settings2 className="h-5 w-5" />}
        title={t('post_install.title')}
        description={
          installData
            ? t('post_install.subtitle_with_template', {
                templateName:
                  installData.template_name ?? installData.agent_name ?? t('post_install.agent_fallback'),
              })
            : t('post_install.subtitle_default')
        }
        breadcrumbs={(
          <button
            onClick={() => navigate('/marketplace/updates')}
            className="inline-flex items-center gap-1 hover:text-text-primary"
          >
            <ArrowLeft className="h-3.5 w-3.5" /> {t('actions.back', { defaultValue: 'Back' })}
          </button>
        )}
      />

      {checklist && (
        <div className="bg-surface border border-border rounded-xl p-5">
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm font-medium text-text-primary">{t('post_install.progress')}</span>
            <span className="text-sm font-semibold text-primary">{checklist.completedCount}/{checklist.totalCount}</span>
          </div>
          <div className="w-full bg-surface-hover rounded-full h-2.5">
            <div
              className="bg-primary h-2.5 rounded-full transition-all duration-500"
              style={{ width: `${progressPct}%` }}
            />
          </div>
          {checklist.allComplete && (
            <p className="text-xs text-green-600 dark:text-green-400 mt-2 font-medium">
              {t('post_install.all_complete')}
            </p>
          )}
        </div>
      )}

      <div className="flex border-b border-border">
        <button
          onClick={() => setActiveTab('checklist')}
          className={`px-4 py-2.5 text-sm font-medium border-b-2 transition ${
            activeTab === 'checklist'
              ? 'border-primary text-primary'
              : 'border-transparent text-text-secondary hover:text-text-primary'
          }`}
        >
          {t('post_install.tabs.checklist')}
        </button>
        <button
          data-tab="customize"
          onClick={() => setActiveTab('customize')}
          className={`px-4 py-2.5 text-sm font-medium border-b-2 transition inline-flex items-center gap-1.5 ${
            activeTab === 'customize'
              ? 'border-primary text-primary'
              : 'border-transparent text-text-secondary hover:text-text-primary'
          }`}
        >
          <Settings2 className="h-3.5 w-3.5" /> {t('post_install.tabs.customize')}
        </button>
      </div>

      {activeTab === 'checklist' ? (
        <div className="space-y-3">
          {checklistLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-6 w-6 animate-spin text-text-muted" />
            </div>
          ) : checklist ? (
            checklist.steps.map((step) => (
              <StepCard
                key={step.key}
                step={step}
                installationId={installationId!}
                onComplete={handleStepComplete}
              />
            ))
          ) : (
            <div className="text-center py-12 text-text-muted">
              {t('post_install.not_found')}
            </div>
          )}
        </div>
      ) : (
        <div className="bg-surface border border-border rounded-xl p-6">
          <div className="mb-5">
            <h2 className="text-lg font-semibold text-text-primary">{t('post_install.customization.title')}</h2>
            <p className="text-sm text-text-muted mt-0.5">
              {t('post_install.customization.subtitle')}
            </p>
          </div>
          {installationId && (
            <CustomizationForm
              installationId={installationId}
              locale={checklistLocale}
              onGreetingSaved={handleGreetingSaved}
            />
          )}
        </div>
      )}
    </div>
  );
}
