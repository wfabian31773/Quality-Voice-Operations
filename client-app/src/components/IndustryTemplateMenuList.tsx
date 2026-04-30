import {
  type BuilderT,
  type IndustryTemplate,
} from '../lib/industryTemplates';
import { type IndustryTemplateKey } from '../lib/agentBuilderI18n';
import { TemplatePreview } from './TemplatePreview';

const RTL_LANGUAGE_PREFIXES = ['ar', 'he', 'fa', 'ur'];

function isRtlLanguage(language?: string): boolean {
  if (!language) return false;
  const lower = language.toLowerCase();
  return RTL_LANGUAGE_PREFIXES.some((prefix) => lower === prefix || lower.startsWith(`${prefix}-`));
}

export interface IndustryTemplateMenuListProps {
  templates: IndustryTemplate[];
  t: BuilderT;
  onSelect: (template: IndustryTemplate) => void;
  onHover?: (key: IndustryTemplateKey | null) => void;
  /** Optional locale tag for the rendered subtree. Used to set `dir="rtl"` for Arabic-script languages. */
  language?: string;
}

/**
 * Renders the scrollable list of industry templates inside the Agent Builder
 * picker dropdown. Each row is a focusable menuitem that triggers `onSelect`
 * with the chosen template. `onHover` lets the parent show a side-panel
 * preview for the focused/hovered row.
 */
export function IndustryTemplateMenuList({
  templates,
  t,
  onSelect,
  onHover,
  language,
}: IndustryTemplateMenuListProps) {
  const rtl = isRtlLanguage(language);
  return (
    <div
      role="menu"
      aria-label={t('templates')}
      data-testid="industry-template-menu"
      dir={rtl ? 'rtl' : undefined}
      lang={language}
      className="max-h-[420px] overflow-y-auto"
    >
      {templates.map((tpl) => (
        <button
          key={tpl.key}
          type="button"
          role="menuitem"
          data-template-key={tpl.key}
          onClick={() => {
            onHover?.(null);
            onSelect(tpl);
          }}
          onMouseEnter={() => onHover?.(tpl.key)}
          onFocus={() => onHover?.(tpl.key)}
          onBlur={() => onHover?.(null)}
          className="flex items-center gap-3 w-full text-left px-3 py-2 text-xs text-text-primary hover:bg-surface-hover focus:bg-surface-hover focus:outline-none transition"
        >
          <div className="flex-shrink-0 w-12 h-9 rounded border border-border bg-surface-secondary overflow-hidden">
            <TemplatePreview
              nodes={tpl.nodes}
              edges={tpl.edges}
              width={48}
              height={36}
              ariaLabel={t('templatePreviewAria', { label: tpl.label })}
            />
          </div>
          <div className="flex-1 min-w-0">
            <div className="truncate font-medium" data-testid={`template-label-${tpl.key}`}>
              {tpl.label}
            </div>
            <div
              className="text-[10px] text-text-secondary leading-snug line-clamp-2"
              data-testid={`template-description-${tpl.key}`}
            >
              {tpl.description}
            </div>
            <div className="text-[10px] text-text-muted mt-0.5">
              {t('templateStepsLabel', {
                nodes: tpl.nodes.length,
                edges: tpl.edges.length,
              })}
            </div>
          </div>
        </button>
      ))}
    </div>
  );
}
