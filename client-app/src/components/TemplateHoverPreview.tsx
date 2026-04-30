import { type BuilderT, type IndustryTemplate } from '../lib/industryTemplates';
import { TemplatePreview } from './TemplatePreview';

const RTL_LANGUAGE_PREFIXES = ['ar', 'he', 'fa', 'ur'];

function isRtlLanguage(language?: string): boolean {
  if (!language) return false;
  const lower = language.toLowerCase();
  return RTL_LANGUAGE_PREFIXES.some((prefix) => lower === prefix || lower.startsWith(`${prefix}-`));
}

export interface TemplateHoverPreviewProps {
  template: IndustryTemplate;
  t: BuilderT;
  language?: string;
  /** When true, the hover panel is positioned absolutely. Tests render it standalone with `false`. */
  floating?: boolean;
}

/**
 * Side-panel preview shown when an operator hovers or focuses an industry
 * template in the picker. Renders the template name, description, step
 * counts, and a labelled mini-graph so the operator can see the localized
 * node and edge labels before committing to load the template onto the
 * canvas.
 */
export function TemplateHoverPreview({
  template,
  t,
  language,
  floating = true,
}: TemplateHoverPreviewProps) {
  const rtl = isRtlLanguage(language);
  const positionClasses = floating
    ? 'absolute right-full top-full mt-1 mr-2 w-72 z-30 pointer-events-none'
    : 'w-72';
  return (
    <div
      data-testid="template-hover-preview"
      data-template-key={template.key}
      dir={rtl ? 'rtl' : undefined}
      lang={language}
      aria-hidden={floating ? 'true' : undefined}
      className={`${positionClasses} bg-surface border border-border rounded-lg shadow-xl p-3`}
    >
      <p
        className="text-xs font-semibold text-text-primary mb-1 truncate"
        data-testid="template-hover-label"
      >
        {template.label}
      </p>
      <p
        className="text-[11px] text-text-secondary mb-1 leading-snug"
        data-testid="template-hover-description"
      >
        {template.description}
      </p>
      <p className="text-[10px] text-text-muted mb-2">
        {t('templateStepsLabel', {
          nodes: template.nodes.length,
          edges: template.edges.length,
        })}
      </p>
      <div className="rounded-md border border-border bg-surface-secondary overflow-hidden">
        <TemplatePreview
          nodes={template.nodes}
          edges={template.edges}
          width={264}
          height={200}
          showLabels
          ariaLabel={t('templatePreviewAria', { label: template.label })}
        />
      </div>
    </div>
  );
}
