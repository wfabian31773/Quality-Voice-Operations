import type { SVGProps } from 'react';

type IconProps = SVGProps<SVGSVGElement>;

const base = (props: IconProps) => ({
  width: 24,
  height: 24,
  viewBox: '0 0 24 24',
  fill: 'none',
  xmlns: 'http://www.w3.org/2000/svg',
  'aria-hidden': true,
  focusable: false,
  ...props,
});

export function VoiceAgentIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path
        d="M4 7.5C4 6.12 5.12 5 6.5 5h11A2.5 2.5 0 0 1 20 7.5v6A2.5 2.5 0 0 1 17.5 16H10l-4 3.5V16H6.5A2.5 2.5 0 0 1 4 13.5v-6Z"
        fill="currentColor"
        fillOpacity="0.18"
      />
      <path
        d="M8.5 10.5v2M11.5 8.5v6M14.5 9.5v4M17.5 10.5v2"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function MegaphoneIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path
        d="M5 10v4l9 4V6l-9 4Z"
        fill="currentColor"
        fillOpacity="0.18"
      />
      <path
        d="M5 10v4l9 4V6L5 10Zm0 0H4a2 2 0 0 0-2 2 2 2 0 0 0 2 2h1m11-3h2m-1.5-3 1.5-1.5M16.5 15l1.5 1.5"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function IntegrationsIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <circle cx="5" cy="6" r="2.25" fill="currentColor" fillOpacity="0.2" />
      <circle cx="19" cy="6" r="2.25" fill="currentColor" fillOpacity="0.2" />
      <circle cx="12" cy="18" r="2.5" fill="currentColor" fillOpacity="0.2" />
      <path
        d="M5 6h14M6 8l5 8M18 8l-5 8"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
      <circle cx="5" cy="6" r="2.25" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="19" cy="6" r="2.25" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="12" cy="18" r="2.5" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

export function AlwaysOnIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <circle cx="12" cy="12" r="8.5" fill="currentColor" fillOpacity="0.15" />
      <circle cx="12" cy="12" r="8.5" stroke="currentColor" strokeWidth="1.6" />
      <path
        d="M12 7.5V12l3 2"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M15.5 16.5c.6.4 1 .9 1 1.4 0 1-1.6 1.6-3.6 1.6S9.3 18.9 9.3 17.9c0-.5.4-1 1-1.4"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        opacity="0.65"
      />
    </svg>
  );
}

export function SmsFollowupIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path
        d="M3.5 6.5C3.5 5.4 4.4 4.5 5.5 4.5h11A2 2 0 0 1 18.5 6.5v6a2 2 0 0 1-2 2h-7l-4 3.5v-3.5h-.5a2 2 0 0 1-2-2v-6Z"
        fill="currentColor"
        fillOpacity="0.18"
      />
      <path
        d="M3.5 6.5C3.5 5.4 4.4 4.5 5.5 4.5h11A2 2 0 0 1 18.5 6.5v6a2 2 0 0 1-2 2h-7l-4 3.5v-3.5h-.5a2 2 0 0 1-2-2v-6Z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      <path
        d="m8 9.8 2.4 2.4L15 7.6"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="20" cy="17" r="2.5" fill="currentColor" />
    </svg>
  );
}

export function AnalyticsIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <rect x="3.5" y="13" width="3.5" height="7" rx="0.8" fill="currentColor" fillOpacity="0.25" />
      <rect x="10.25" y="9" width="3.5" height="11" rx="0.8" fill="currentColor" fillOpacity="0.25" />
      <rect x="17" y="5" width="3.5" height="15" rx="0.8" fill="currentColor" fillOpacity="0.25" />
      <path
        d="M4 11.5 11 7l4.5 2.5L21 4"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="21" cy="4" r="1.4" fill="currentColor" />
    </svg>
  );
}

export function VoiceEngineIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path
        d="M12 3a4 4 0 0 0-4 4v6a4 4 0 0 0 8 0V7a4 4 0 0 0-4-4Z"
        fill="currentColor"
        fillOpacity="0.18"
      />
      <path
        d="M12 3a4 4 0 0 0-4 4v6a4 4 0 0 0 8 0V7a4 4 0 0 0-4-4Z"
        stroke="currentColor"
        strokeWidth="1.6"
      />
      <path
        d="M5 12.5a7 7 0 0 0 14 0M12 19.5V22M9 22h6"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
      <path
        d="M11 8.5v3M13 7.5v5"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        opacity="0.55"
      />
    </svg>
  );
}

export function AutomationIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <circle cx="12" cy="12" r="3.2" fill="currentColor" fillOpacity="0.25" />
      <path
        d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
      <circle cx="12" cy="12" r="3.2" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

export function DashboardIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <rect x="3" y="3" width="18" height="18" rx="3" fill="currentColor" fillOpacity="0.12" />
      <rect x="3" y="3" width="18" height="18" rx="3" stroke="currentColor" strokeWidth="1.5" />
      <rect x="6" y="13" width="3" height="5" rx="0.8" fill="currentColor" />
      <rect x="10.5" y="10" width="3" height="8" rx="0.8" fill="currentColor" />
      <rect x="15" y="7" width="3" height="11" rx="0.8" fill="currentColor" fillOpacity="0.55" />
    </svg>
  );
}

export function CustomizationIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <rect x="3.5" y="6" width="17" height="2" rx="1" fill="currentColor" fillOpacity="0.25" />
      <rect x="3.5" y="11" width="17" height="2" rx="1" fill="currentColor" fillOpacity="0.25" />
      <rect x="3.5" y="16" width="17" height="2" rx="1" fill="currentColor" fillOpacity="0.25" />
      <circle cx="9" cy="7" r="2.4" fill="currentColor" />
      <circle cx="15" cy="12" r="2.4" fill="currentColor" />
      <circle cx="7" cy="17" r="2.4" fill="currentColor" />
      <circle cx="9" cy="7" r="2.4" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="15" cy="12" r="2.4" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="7" cy="17" r="2.4" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  );
}

export function ApiIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path
        d="M11 3.5h2a3 3 0 0 1 3 3v2h2.5a1.5 1.5 0 0 1 1.5 1.5v3a1.5 1.5 0 0 1-1.5 1.5h-1a2.5 2.5 0 0 0 0 5H16v.5a3 3 0 0 1-3 3h-2v-2.5a2.5 2.5 0 1 0-5 0v2.5H4a1 1 0 0 1-1-1v-4h2.5a2.5 2.5 0 0 0 0-5H3V8.5A1.5 1.5 0 0 1 4.5 7H8V6.5a3 3 0 0 1 3-3Z"
        fill="currentColor"
        fillOpacity="0.18"
      />
      <path
        d="M11 3.5h2a3 3 0 0 1 3 3v2h2.5a1.5 1.5 0 0 1 1.5 1.5v3a1.5 1.5 0 0 1-1.5 1.5h-1a2.5 2.5 0 0 0 0 5H16v.5a3 3 0 0 1-3 3h-2v-2.5a2.5 2.5 0 1 0-5 0v2.5H4a1 1 0 0 1-1-1v-4h2.5a2.5 2.5 0 0 0 0-5H3V8.5A1.5 1.5 0 0 1 4.5 7H8V6.5a3 3 0 0 1 3-3Z"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function SecurityIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path
        d="M12 3 4 6v6c0 4.5 3.4 8.4 8 9.5 4.6-1.1 8-5 8-9.5V6l-8-3Z"
        fill="currentColor"
        fillOpacity="0.18"
      />
      <path
        d="M12 3 4 6v6c0 4.5 3.4 8.4 8 9.5 4.6-1.1 8-5 8-9.5V6l-8-3Z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <path
        d="m8.5 12 2.5 2.5 4.5-4.5"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
