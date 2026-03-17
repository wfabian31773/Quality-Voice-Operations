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

let _visitorId: string | null = null;

function getVisitorId(): string {
  if (_visitorId) return _visitorId;
  if (typeof window === 'undefined') return 'ssr';
  const stored = localStorage.getItem('qvo_visitor_id');
  if (stored) {
    _visitorId = stored;
    return stored;
  }
  const id = `v_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  localStorage.setItem('qvo_visitor_id', id);
  _visitorId = id;
  return id;
}

export function getUtmParams(): Record<string, string> {
  if (typeof window === 'undefined') return {};
  const params = new URLSearchParams(window.location.search);
  const utm: Record<string, string> = {};
  for (const key of ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term']) {
    const val = params.get(key);
    if (val) utm[key.replace('utm_', '')] = val;
  }
  if (Object.keys(utm).length > 0) {
    sessionStorage.setItem('qvo_utm', JSON.stringify(utm));
  } else {
    const cached = sessionStorage.getItem('qvo_utm');
    if (cached) return JSON.parse(cached);
  }
  return utm;
}

export function captureUtmOnLoad(): void {
  getUtmParams();
  getAttributionLandingPage();
}

function getAttributionLandingPage(): string {
  if (typeof window === 'undefined') return '/';
  const stored = sessionStorage.getItem('qvo_attribution_landing');
  if (stored) return stored;
  const current = window.location.pathname;
  sessionStorage.setItem('qvo_attribution_landing', current);
  return current;
}

export { getVisitorId };

export function trackConversionEvent(
  stage: string,
  landingPage?: string,
  metadata?: Record<string, unknown>,
): void {
  const visitorId = getVisitorId();
  const utm = getUtmParams();
  const attributionPage = getAttributionLandingPage();
  const currentPage = landingPage ?? (typeof window !== 'undefined' ? window.location.pathname : '/');

  emit({
    category: 'conversion',
    action: stage,
    label: currentPage,
    metadata: { visitorId, ...utm, attributionPage },
  });

  if (typeof window !== 'undefined') {
    fetch('/api/conversion/event', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        visitorId,
        stage,
        landingPage: attributionPage,
        utm: Object.keys(utm).length > 0 ? utm : undefined,
        metadata: { ...metadata, currentPage },
      }),
    }).catch(() => {});
  }
}
