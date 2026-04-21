import { useMemo, type ReactElement } from 'react';

export type BrandLogoId =
  | 'hubspot'
  | 'google-calendar'
  | 'slack'
  | 'twilio'
  | 'zapier'
  | 'webhook'
  | 'custom-ticketing'
  | 'salesforce'
  | 'pipedrive'
  | 'outlook-calendar'
  | 'quickbooks'
  | 'stripe';

interface BrandLogoProps {
  provider: string;
  size?: number;
  className?: string;
  rounded?: boolean;
}

function HubSpotLogo({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <path
        d="M22.5 12.4V8.7a2.7 2.7 0 1 0-2 0v3.7a7.6 7.6 0 0 0-3.6 1.6L7.2 6.6a3 3 0 1 0-1.2 1.6l9.5 7.4a7.6 7.6 0 0 0 .12 8.6l-2.9 2.9a2.5 2.5 0 1 0 1.5 1.4l2.85-2.85a7.6 7.6 0 1 0 5.43-13.25Zm-1 11.6a3.95 3.95 0 1 1 0-7.9 3.95 3.95 0 0 1 0 7.9Z"
        fill="#FF7A59"
      />
    </svg>
  );
}

function GoogleCalendarLogo({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <path d="M23 7H9a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2Z" fill="#fff" />
      <path d="M23 25h2a2 2 0 0 0 2-2v-2h-4v4Z" fill="#EA4335" />
      <path d="M27 11V9a2 2 0 0 0-2-2h-2v4h4Z" fill="#1967D2" />
      <path d="M9 25H7v-2h2v2Zm-2-4h-2V9a2 2 0 0 1 2-2h2v14H7Z" fill="#FBBC04" />
      <path d="M27 11h-4V7H9v4H5v10h4v4h14v-4h4V11Z" fill="#fff" />
      <path d="M23 11H9v10h14V11Z" fill="#fff" />
      <path d="M27 11h-4v10h4V11ZM9 21H5v-4h4v4Z" fill="#FBBC04" />
      <text
        x="16"
        y="19"
        textAnchor="middle"
        fontFamily="'Segoe UI', Roboto, sans-serif"
        fontSize="7"
        fontWeight="700"
        fill="#1A73E8"
      >
        31
      </text>
    </svg>
  );
}

function SlackLogo({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <path d="M9.6 19.5a2.5 2.5 0 1 1-2.5-2.5h2.5v2.5Zm1.3 0a2.5 2.5 0 1 1 5 0v6.4a2.5 2.5 0 1 1-5 0v-6.4Z" fill="#E01E5A" />
      <path d="M13.4 9.6a2.5 2.5 0 1 1 2.5-2.5v2.5h-2.5Zm0 1.3a2.5 2.5 0 1 1 0 5H7a2.5 2.5 0 1 1 0-5h6.4Z" fill="#36C5F0" />
      <path d="M22.4 13.4a2.5 2.5 0 1 1 2.5 2.5h-2.5v-2.5Zm-1.3 0a2.5 2.5 0 1 1-5 0V7a2.5 2.5 0 1 1 5 0v6.4Z" fill="#2EB67D" />
      <path d="M18.6 22.4a2.5 2.5 0 1 1-2.5 2.5v-2.5h2.5Zm0-1.3a2.5 2.5 0 1 1 0-5H25a2.5 2.5 0 1 1 0 5h-6.4Z" fill="#ECB22E" />
    </svg>
  );
}

function TwilioLogo({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <circle cx="16" cy="16" r="13" fill="#F22F46" />
      <circle cx="12" cy="12" r="2.4" fill="#fff" />
      <circle cx="20" cy="12" r="2.4" fill="#fff" />
      <circle cx="12" cy="20" r="2.4" fill="#fff" />
      <circle cx="20" cy="20" r="2.4" fill="#fff" />
    </svg>
  );
}

function ZapierLogo({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <circle cx="16" cy="16" r="14" fill="#FF4F00" />
      <path
        d="M18.4 16a8.6 8.6 0 0 1-.55 3.05 8.6 8.6 0 0 1-3.05.55h-.02a8.6 8.6 0 0 1-3.05-.55A8.6 8.6 0 0 1 11.18 16c0-1.07.2-2.1.55-3.05a8.6 8.6 0 0 1 3.05-.55h.02c1.07 0 2.1.2 3.05.55.35.95.55 1.98.55 3.05Zm6.6-1.5h-5.27l3.73-3.73a9.66 9.66 0 0 0-1.7-2.13 9.66 9.66 0 0 0-2.13-1.7l-3.73 3.73V5.4a9.6 9.6 0 0 0-2.4 0v5.27L9.77 6.94a9.66 9.66 0 0 0-2.13 1.7 9.66 9.66 0 0 0-1.7 2.13l3.73 3.73H4.4a9.6 9.6 0 0 0 0 2.4h5.27l-3.73 3.73c.5.78 1.07 1.5 1.7 2.13a9.66 9.66 0 0 0 2.13 1.7l3.73-3.73v5.27a9.6 9.6 0 0 0 2.4 0v-5.27l3.73 3.73a9.66 9.66 0 0 0 2.13-1.7 9.66 9.66 0 0 0 1.7-2.13l-3.73-3.73h5.27a9.6 9.6 0 0 0 0-2.4Z"
        fill="#fff"
      />
    </svg>
  );
}

function SalesforceLogo({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <path
        d="M13.4 9.4a4.6 4.6 0 0 1 8 1.7 4.4 4.4 0 0 1 1.8-.4 4.5 4.5 0 0 1 4.4 5.4 4.5 4.5 0 0 1-1.6 8.7 4.5 4.5 0 0 1-1.7-.34 3.7 3.7 0 0 1-6.7 1.05 4.6 4.6 0 0 1-7.8-1.4 3.6 3.6 0 0 1-1 .14 3.7 3.7 0 0 1-1.4-7.1 4.4 4.4 0 0 1 4-5.6 4.4 4.4 0 0 1 2 .5 4.6 4.6 0 0 1 0-2.7Z"
        fill="#00A1E0"
      />
    </svg>
  );
}

function PipedriveLogo({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <rect width="32" height="32" rx="6" fill="#1A1A1A" />
      <path
        d="M17.6 9c-1.7 0-3 .65-3.85 1.6.05-.45.05-.95-.05-1.4H10c.05.65.1 1.4.1 2.35V25h3.6v-5.65c.7.55 1.7.9 3 .9 3.05 0 5.4-2.4 5.4-5.7 0-3.35-2.05-5.55-4.5-5.55Zm-1 8.55c-1.55 0-2.7-1.15-2.7-3 0-1.85 1.15-3 2.7-3 1.55 0 2.65 1.15 2.65 3 0 1.85-1.1 3-2.65 3Z"
        fill="#26292C"
      />
      <path
        d="M17.6 9c-1.7 0-3 .65-3.85 1.6.05-.45.05-.95-.05-1.4H10c.05.65.1 1.4.1 2.35V25h3.6v-5.65c.7.55 1.7.9 3 .9 3.05 0 5.4-2.4 5.4-5.7 0-3.35-2.05-5.55-4.5-5.55Zm-1 8.55c-1.55 0-2.7-1.15-2.7-3 0-1.85 1.15-3 2.7-3 1.55 0 2.65 1.15 2.65 3 0 1.85-1.1 3-2.65 3Z"
        fill="#fff"
      />
    </svg>
  );
}

function OutlookCalendarLogo({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <rect x="4" y="7" width="24" height="18" rx="2" fill="#0364B8" />
      <rect x="4" y="11" width="24" height="14" rx="2" fill="#0078D4" />
      <rect x="4" y="11" width="14" height="14" rx="1" fill="#fff" />
      <path
        d="M11 13.5c-2.2 0-3.7 1.7-3.7 4.5s1.5 4.5 3.7 4.5 3.7-1.7 3.7-4.5-1.5-4.5-3.7-4.5Zm0 7.3c-1.2 0-1.95-1.05-1.95-2.8s.75-2.8 1.95-2.8 1.95 1.05 1.95 2.8-.75 2.8-1.95 2.8Z"
        fill="#0078D4"
      />
      <rect x="18" y="13" width="9" height="2" fill="#fff" opacity=".25" />
      <rect x="18" y="17" width="9" height="2" fill="#fff" opacity=".25" />
      <rect x="18" y="21" width="9" height="2" fill="#fff" opacity=".25" />
    </svg>
  );
}

function QuickBooksLogo({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <circle cx="16" cy="16" r="13" fill="#2CA01C" />
      <text
        x="16"
        y="21"
        textAnchor="middle"
        fontFamily="'Segoe UI', Roboto, sans-serif"
        fontSize="15"
        fontWeight="700"
        fill="#fff"
      >
        qb
      </text>
    </svg>
  );
}

function StripeLogo({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <rect width="32" height="32" rx="6" fill="#635BFF" />
      <path
        d="M17.05 13.6c0-.7.6-.97 1.55-.97 1.4 0 3.15.42 4.55 1.17v-4.3a12.1 12.1 0 0 0-4.55-.83c-3.7 0-6.18 1.93-6.18 5.17 0 5.05 6.95 4.25 6.95 6.42 0 .82-.72 1.1-1.72 1.1-1.5 0-3.45-.62-5-1.45v4.35c1.7.73 3.43 1.05 5 1.05 3.8 0 6.4-1.87 6.4-5.15 0-5.45-7-4.5-7-6.55Z"
        fill="#fff"
      />
    </svg>
  );
}

function WebhookLogo({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <rect width="32" height="32" rx="6" fill="#C73A63" />
      <path
        d="M11.4 19.7a3.6 3.6 0 1 0 4.2 5.2h6.8a2.6 2.6 0 1 0 0-2H14.4a1.6 1.6 0 1 1-1.45-2.27l-1.55-.93Zm10.85-2.5a3.6 3.6 0 0 0-3.05 1.7l-3.4-5.65a2.6 2.6 0 1 0-1.72 1.03l3.4 5.65a3.6 3.6 0 1 0 4.77-2.73Zm-9.7-3.7a2.6 2.6 0 1 0-1.95 4.55l-3.4 5.65a3.6 3.6 0 1 0 1.7 1.05l3.4-5.65a2.6 2.6 0 1 0 .25-5.6Z"
        fill="#fff"
      />
    </svg>
  );
}

function CustomTicketingLogo({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <rect width="32" height="32" rx="6" fill="#475569" />
      <path
        d="M6 13a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v2a2 2 0 0 0 0 4v2a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2v-2a2 2 0 0 0 0-4v-2Zm14 0v6h2v-6h-2Z"
        fill="#fff"
      />
    </svg>
  );
}

const LOGO_MAP: Record<string, (props: { size: number }) => ReactElement> = {
  hubspot: HubSpotLogo,
  'google-calendar': GoogleCalendarLogo,
  google: GoogleCalendarLogo,
  slack: SlackLogo,
  twilio: TwilioLogo,
  'twilio-sms': TwilioLogo,
  zapier: ZapierLogo,
  webhook: WebhookLogo,
  'custom-ticketing': CustomTicketingLogo,
  salesforce: SalesforceLogo,
  pipedrive: PipedriveLogo,
  'outlook-calendar': OutlookCalendarLogo,
  outlook: OutlookCalendarLogo,
  quickbooks: QuickBooksLogo,
  stripe: StripeLogo,
};

function FallbackLogo({ size, label }: { size: number; label: string }) {
  const initials = label
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('');
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <rect width="32" height="32" rx="6" fill="currentColor" opacity=".1" />
      <text
        x="16"
        y="20"
        textAnchor="middle"
        fontFamily="'Segoe UI', Roboto, sans-serif"
        fontSize="12"
        fontWeight="700"
        fill="currentColor"
      >
        {initials || '?'}
      </text>
    </svg>
  );
}

export default function BrandLogo({ provider, size = 32, className = '', rounded = true }: BrandLogoProps) {
  const Logo = useMemo(() => LOGO_MAP[provider], [provider]);
  const containerClass = `inline-flex items-center justify-center bg-white dark:bg-white/95 ${
    rounded ? 'rounded-lg' : ''
  } shadow-sm ring-1 ring-black/5 ${className}`;
  const padding = Math.max(2, Math.round(size * 0.08));
  return (
    <span
      className={containerClass}
      style={{ width: size + padding * 2, height: size + padding * 2, padding }}
    >
      {Logo ? <Logo size={size} /> : <FallbackLogo size={size} label={provider} />}
    </span>
  );
}
