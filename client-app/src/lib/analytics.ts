type AnalyticsEvent = {
  category: string;
  action: string;
  label?: string;
  value?: number;
  metadata?: Record<string, string | number | boolean>;
};

function emit(event: AnalyticsEvent) {
  if (typeof window !== 'undefined' && process.env.NODE_ENV !== 'test') {
    console.log(
      `[Analytics] ${event.category}/${event.action}`,
      event.label ? `label=${event.label}` : '',
      event.value !== undefined ? `value=${event.value}` : '',
      event.metadata ? JSON.stringify(event.metadata) : '',
    );
  }
}

export function trackPageView(page: string) {
  emit({ category: 'navigation', action: 'page_view', label: page });
}

export function trackDemoInteraction(action: string, agentType?: string, durationSeconds?: number) {
  emit({
    category: 'demo',
    action,
    label: agentType,
    value: durationSeconds,
    metadata: agentType ? { agentType } : undefined,
  });
}

export function trackSignupConversion(plan: string, step: string) {
  emit({ category: 'signup', action: step, label: plan });
}

export function trackVerticalEngagement(vertical: string, action: string) {
  emit({ category: 'vertical', action, label: vertical });
}

export function trackCTAClick(ctaText: string, page: string, position?: string) {
  emit({
    category: 'cta',
    action: 'click',
    label: ctaText,
    metadata: { page, position: position ?? 'unknown' },
  });
}

export function trackFeatureView(feature: string) {
  emit({ category: 'features', action: 'view', label: feature });
}
