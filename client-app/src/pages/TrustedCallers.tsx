import { useEffect, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Plus,
  RefreshCw,
  ShieldCheck,
  ShieldAlert,
  ShieldQuestion,
  CheckCircle2,
  X,
  Trash2,
  RotateCw,
  Clock,
  Building2,
  ChevronLeft,
  ChevronRight,
} from 'lucide-react';
import { api } from '../lib/api';
import { useRole } from '../lib/useRole';
import EmptyState from '../components/EmptyState';
import Modal from '../components/Modal';

type CallerStatus = 'pending' | 'verified' | 'failed' | 'rotated';
type AttestationLevel = 'A' | 'B' | 'C';
type CallerHealthStatus =
  | 'healthy'
  | 'expiring_soon'
  | 'expired'
  | 'revoked'
  | 'unknown';

interface TrustedCaller {
  id: string;
  phoneNumber: string;
  friendlyName: string | null;
  status: CallerStatus;
  attestationLevel: AttestationLevel | null;
  twilioValidationSid: string | null;
  twilioCallerSid: string | null;
  trustHubProfileSid: string | null;
  trustProductSid: string | null;
  brandSid: string | null;
  verificationCode: string | null;
  verificationExpiresAt: string | null;
  verifiedAt: string | null;
  rotatedAt: string | null;
  rotatedToId: string | null;
  registeredByUserId: string | null;
  notes: string | null;
  expiresAt: string | null;
  lastHealthCheckAt: string | null;
  lastHealthStatus: CallerHealthStatus | null;
  lastHealthMessage: string | null;
  expiryAlertSentAt: string | null;
  metadata?: { trustHub?: TrustHubSnapshot } | null;
  createdAt: string;
  updatedAt: string;
}

interface RegisterResponse {
  caller: TrustedCaller;
  validationCode: string | null;
  message: string;
}

interface RotateResponse {
  retired: TrustedCaller;
  replacement: TrustedCaller;
  validationCode: string | null;
}

interface TrustHubResource {
  sid: string | null;
  status: string | null;
  failureReason?: string | null;
  validUntil?: string | null;
}

interface TrustHubSnapshot {
  customerProfile: TrustHubResource;
  trustProduct: TrustHubResource;
  brand: TrustHubResource | null;
  businessInfoEndUserSid: string | null;
  addressEndUserSid: string | null;
  representativeEndUserSid: string | null;
  lastSubmittedAt?: string;
}

interface TrustHubSubmitResponse {
  caller: TrustedCaller;
  trustHub: TrustHubSnapshot;
  message: string;
}

const REGISTRATION_ID_TYPES = [
  { value: 'EIN', label: 'EIN — US Employer Identification Number' },
  { value: 'DUNS', label: 'DUNS — Dun & Bradstreet number' },
  { value: 'CCN', label: 'CCN — Canadian Corporation Number' },
  { value: 'CBN', label: 'CBN — Canadian Business Number' },
  { value: 'VAT', label: 'VAT — European VAT registration' },
  { value: 'Other', label: 'Other' },
];

const INDUSTRY_OPTIONS = [
  'AUTOMOTIVE', 'AGRICULTURE', 'BANKING', 'CONSTRUCTION', 'CONSUMER',
  'EDUCATION', 'ENGINEERING', 'ENERGY', 'OIL_AND_GAS',
  'FAST_MOVING_CONSUMER_GOODS', 'FINANCIAL', 'FINTECH', 'FOOD_AND_BEVERAGE',
  'GOVERNMENT', 'HEALTHCARE', 'HOSPITALITY', 'INSURANCE', 'LEGAL',
  'MANUFACTURING', 'MEDIA', 'ONLINE', 'PROFESSIONAL_SERVICES',
  'RAW_MATERIALS', 'REAL_ESTATE', 'RELIGION', 'RETAIL', 'JEWELRY',
  'TECHNOLOGY', 'TELECOMMUNICATIONS', 'TRANSPORTATION', 'TRAVEL',
  'ELECTRONICS', 'NOT_FOR_PROFIT',
];

export function normalizeTrustHubStatus(status: string | null | undefined): string {
  const s = (status ?? '').toLowerCase().replace(/_/g, '-');
  if (!s) return '';
  if (s === 'twilio-approved' || s === 'approved') return 'twilio-approved';
  if (s === 'twilio-rejected' || s === 'rejected' || s === 'failed') return 'twilio-rejected';
  if (s === 'in-review') return 'in-review';
  if (s === 'pending-review' || s === 'pending') return 'pending-review';
  if (s === 'draft') return 'draft';
  return s;
}

export function isTrustHubTerminal(status: string | null | undefined): boolean {
  const n = normalizeTrustHubStatus(status);
  return n === 'twilio-approved' || n === 'twilio-rejected';
}

function trustHubBadgeClass(status: string | null | undefined): string {
  const s = normalizeTrustHubStatus(status);
  if (s === 'twilio-approved') return 'bg-success/10 text-success';
  if (s === 'twilio-rejected') return 'bg-danger/10 text-danger';
  if (s === 'pending-review' || s === 'in-review') return 'bg-warning/10 text-warning';
  return 'bg-text-muted/10 text-text-muted';
}

export function aggregateTrustHubStatus(
  statuses: Array<string | null | undefined>,
): string {
  const present = statuses.map(normalizeTrustHubStatus).filter((s) => s.length > 0);
  if (present.length === 0) return 'draft';
  if (present.some((s) => s === 'twilio-rejected')) return 'twilio-rejected';
  if (present.some((s) => s === 'in-review')) return 'in-review';
  if (present.some((s) => s === 'pending-review')) return 'pending-review';
  if (present.some((s) => s === 'draft')) return 'draft';
  if (present.every((s) => s === 'twilio-approved')) return 'twilio-approved';
  return present[0];
}

function prettyTrustHubStatus(status: string | null | undefined): string {
  const s = normalizeTrustHubStatus(status);
  if (s === 'twilio-approved') return 'Approved';
  if (s === 'twilio-rejected') return 'Rejected';
  if (s === 'pending-review') return 'Pending review';
  if (s === 'in-review') return 'In review';
  if (s === 'draft') return 'Draft';
  return status ?? '—';
}

const STATUS_STYLES: Record<CallerStatus, { label: string; color: string; Icon: typeof ShieldCheck }> = {
  verified: { label: 'Verified', color: 'bg-success/10 text-success', Icon: ShieldCheck },
  pending: { label: 'Pending', color: 'bg-warning/10 text-warning', Icon: ShieldQuestion },
  failed: { label: 'Failed', color: 'bg-danger/10 text-danger', Icon: ShieldAlert },
  rotated: { label: 'Rotated', color: 'bg-text-muted/10 text-text-muted', Icon: RotateCw },
};

/**
 * Compute the human-readable expiry badge for a caller. Returns `null` when
 * we have nothing useful to render — either because the row is not in the
 * `verified` lifecycle state (badge would be misleading) or because the
 * weekly health scheduler hasn't recorded any data for it yet.
 *
 * Color states:
 *   - red    → revoked or already expired (carriers will downgrade)
 *   - amber  → expiring within EXPIRING_SOON_THRESHOLD_DAYS (14 days)
 *   - green  → healthy with a known `expiresAt` date in the future
 *   - muted  → unknown status (Twilio creds missing, transient error)
 *
 * Returning a tuple keeps the rendering site tiny and the test surface flat.
 */
function expiryBadge(caller: TrustedCaller): {
  label: string;
  className: string;
  Icon: typeof Clock;
  title: string;
} | null {
  if (caller.status !== 'verified') return null;

  const status = caller.lastHealthStatus;
  if (!status) return null;

  const detail = caller.lastHealthMessage ?? '';

  if (status === 'revoked') {
    return {
      label: 'Revoked',
      className: 'bg-danger/10 text-danger',
      Icon: ShieldAlert,
      title: detail || 'Twilio no longer reports this caller as verified.',
    };
  }
  if (status === 'expired') {
    return {
      label: 'Expired',
      className: 'bg-danger/10 text-danger',
      Icon: Clock,
      title:
        detail ||
        (caller.expiresAt
          ? `Expired ${new Date(caller.expiresAt).toLocaleString()}`
          : 'Carrier attestation has expired.'),
    };
  }

  // Compute days remaining if we have an expiresAt — covers both
  // `expiring_soon` (always within 14 days) and `healthy` (only if the
  // server recorded an explicit `valid_until`).
  const daysRemaining = caller.expiresAt
    ? Math.max(
        0,
        Math.ceil((new Date(caller.expiresAt).getTime() - Date.now()) / (24 * 60 * 60 * 1000)),
      )
    : null;

  if (status === 'expiring_soon') {
    const label = daysRemaining !== null ? `Expires in ${daysRemaining}d` : 'Expiring soon';
    return {
      label,
      className: 'bg-warning/10 text-warning',
      Icon: Clock,
      title:
        detail ||
        (caller.expiresAt
          ? `Expires ${new Date(caller.expiresAt).toLocaleString()}`
          : 'Re-register before attestation lapses.'),
    };
  }

  if (status === 'healthy' && daysRemaining !== null) {
    return {
      label: `Expires in ${daysRemaining}d`,
      className: 'bg-success/10 text-success',
      Icon: ShieldCheck,
      title: caller.expiresAt
        ? `Expires ${new Date(caller.expiresAt).toLocaleString()}`
        : 'Healthy.',
    };
  }

  if (status === 'unknown') {
    return {
      label: 'Unknown',
      className: 'bg-text-muted/10 text-text-muted',
      Icon: ShieldQuestion,
      title: detail || 'Health check did not run — Twilio credentials may be unset.',
    };
  }

  // status === 'healthy' with no expiresAt: nothing actionable to surface.
  return null;
}

function formatPhone(e164: string): string {
  const cleaned = e164.replace(/[^\d+]/g, '');
  if (cleaned.startsWith('+1') && cleaned.length === 12) {
    const d = cleaned.slice(2);
    return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
  }
  return e164;
}

function RegisterModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (resp: RegisterResponse) => void;
}) {
  const [form, setForm] = useState({
    phoneNumber: '+1',
    friendlyName: '',
    notes: '',
    trustHubProfileSid: '',
    trustProductSid: '',
    brandSid: '',
  });
  const [error, setError] = useState('');

  const mutation = useMutation({
    mutationFn: () =>
      api.post<RegisterResponse>('/trusted-callers', {
        phoneNumber: form.phoneNumber.trim(),
        friendlyName: form.friendlyName.trim() || undefined,
        notes: form.notes.trim() || undefined,
        trustHubProfileSid: form.trustHubProfileSid.trim() || undefined,
        trustProductSid: form.trustProductSid.trim() || undefined,
        brandSid: form.brandSid.trim() || undefined,
      }),
    onSuccess: (resp) => {
      onCreated(resp);
      onClose();
    },
    onError: (err: Error) => setError(err.message),
  });

  return (
    <Modal open onClose={onClose} ariaLabel="Register Verified Caller ID" panelClassName="bg-surface border border-border rounded-xl shadow-lg w-full max-w-lg max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between px-6 py-4 border-b border-border">
          <h2 className="text-lg font-semibold text-text-primary">Register Verified Caller ID</h2>
          <button onClick={onClose} aria-label="Close" className="text-text-muted hover:text-text-primary">
            <X className="h-5 w-5" />
          </button>
        </div>
        <form
          className="p-6 space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            setError('');
            mutation.mutate();
          }}
        >
          {error && <div className="bg-danger/10 text-danger text-sm px-3 py-2 rounded-lg">{error}</div>}
          <div>
            <label className="block text-sm font-medium text-text-primary mb-1">Phone Number (E.164)</label>
            <input
              type="tel"
              required
              value={form.phoneNumber}
              onChange={(e) => setForm((f) => ({ ...f, phoneNumber: e.target.value }))}
              placeholder="+12125550123"
              className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-text-primary text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
            />
            <p className="text-xs text-text-muted mt-1">
              Twilio will call this number. Answer it and enter the validation code shown after submitting.
            </p>
          </div>
          <div>
            <label className="block text-sm font-medium text-text-primary mb-1">Friendly Name</label>
            <input
              type="text"
              value={form.friendlyName}
              onChange={(e) => setForm((f) => ({ ...f, friendlyName: e.target.value }))}
              placeholder="Sales Outbound"
              className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-text-primary text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
            />
          </div>
          <details className="border border-border rounded-lg">
            <summary className="cursor-pointer px-3 py-2 text-sm font-medium text-text-secondary">
              Trust Hub / STIR-SHAKEN (optional)
            </summary>
            <div className="space-y-3 p-3 border-t border-border">
              <p className="text-xs text-text-muted">
                Paste the SIDs of an approved Twilio Trust Hub Customer Profile, Trust Product (BU…) and brand
                registration (BN…) so carriers attest A under STIR/SHAKEN. Leave blank if you only have entry-level
                caller ID validation today.
              </p>
              <div>
                <label className="block text-xs font-medium text-text-primary mb-1">Customer Profile SID</label>
                <input
                  type="text"
                  value={form.trustHubProfileSid}
                  onChange={(e) => setForm((f) => ({ ...f, trustHubProfileSid: e.target.value }))}
                  placeholder="BUxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
                  className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-text-primary text-xs font-mono focus:outline-none focus:ring-2 focus:ring-primary/30"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-text-primary mb-1">Trust Product SID</label>
                <input
                  type="text"
                  value={form.trustProductSid}
                  onChange={(e) => setForm((f) => ({ ...f, trustProductSid: e.target.value }))}
                  placeholder="BUxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
                  className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-text-primary text-xs font-mono focus:outline-none focus:ring-2 focus:ring-primary/30"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-text-primary mb-1">Brand Registration SID</label>
                <input
                  type="text"
                  value={form.brandSid}
                  onChange={(e) => setForm((f) => ({ ...f, brandSid: e.target.value }))}
                  placeholder="BNxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
                  className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-text-primary text-xs font-mono focus:outline-none focus:ring-2 focus:ring-primary/30"
                />
              </div>
            </div>
          </details>
          <div>
            <label className="block text-sm font-medium text-text-primary mb-1">Notes</label>
            <textarea
              rows={2}
              value={form.notes}
              onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
              className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-text-primary text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
            />
          </div>
          <div className="flex justify-end gap-3 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-sm font-medium text-text-secondary hover:text-text-primary"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={mutation.isPending}
              className="px-4 py-2 bg-primary hover:bg-primary-hover text-white text-sm font-medium rounded-lg disabled:opacity-50"
            >
              {mutation.isPending ? 'Registering…' : 'Register & Start Verification'}
            </button>
          </div>
        </form>
    </Modal>
  );
}

function VerifyModal({
  caller,
  onClose,
  onVerified,
}: {
  caller: TrustedCaller;
  onClose: () => void;
  onVerified: () => void;
}) {
  const [attestation, setAttestation] = useState<AttestationLevel | ''>('');
  const [trustHubProfileSid, setTrustHubProfileSid] = useState(caller.trustHubProfileSid ?? '');
  const [trustProductSid, setTrustProductSid] = useState(caller.trustProductSid ?? '');
  const [brandSid, setBrandSid] = useState(caller.brandSid ?? '');
  const [error, setError] = useState('');

  const mutation = useMutation({
    mutationFn: () =>
      api.post<{ caller: TrustedCaller }>(`/trusted-callers/${caller.id}/verify`, {
        attestationLevel: attestation || undefined,
        trustHubProfileSid: trustHubProfileSid.trim() || undefined,
        trustProductSid: trustProductSid.trim() || undefined,
        brandSid: brandSid.trim() || undefined,
      }),
    onSuccess: () => {
      onVerified();
      onClose();
    },
    onError: (err: Error) => setError(err.message),
  });

  return (
    <Modal open onClose={onClose} ariaLabel="Confirm Verification" panelClassName="bg-surface border border-border rounded-xl shadow-lg w-full max-w-lg">
        <div className="flex items-center justify-between px-6 py-4 border-b border-border">
          <h2 className="text-lg font-semibold text-text-primary">Confirm Verification — {formatPhone(caller.phoneNumber)}</h2>
          <button onClick={onClose} aria-label="Close" className="text-text-muted hover:text-text-primary">
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="p-6 space-y-4">
          {error && <div className="bg-danger/10 text-danger text-sm px-3 py-2 rounded-lg">{error}</div>}
          <p className="text-sm text-text-secondary">
            Use this once Twilio confirms the validation call (or after you've finished a Trust Hub product
            review). The attestation level is what carriers will broadcast under STIR/SHAKEN.
          </p>
          <div>
            <label className="block text-sm font-medium text-text-primary mb-1">Attestation Level</label>
            <select
              value={attestation}
              onChange={(e) => setAttestation(e.target.value as AttestationLevel | '')}
              className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-text-primary text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
            >
              <option value="">Use Twilio-reported level</option>
              <option value="A">A — Full Attestation</option>
              <option value="B">B — Partial Attestation</option>
              <option value="C">C — Gateway Attestation</option>
            </select>
          </div>
          <div className="grid grid-cols-1 gap-3">
            <input
              type="text"
              value={trustHubProfileSid}
              onChange={(e) => setTrustHubProfileSid(e.target.value)}
              placeholder="Customer Profile SID (BU…)"
              className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-text-primary text-xs font-mono focus:outline-none focus:ring-2 focus:ring-primary/30"
            />
            <input
              type="text"
              value={trustProductSid}
              onChange={(e) => setTrustProductSid(e.target.value)}
              placeholder="Trust Product SID (BU…)"
              className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-text-primary text-xs font-mono focus:outline-none focus:ring-2 focus:ring-primary/30"
            />
            <input
              type="text"
              value={brandSid}
              onChange={(e) => setBrandSid(e.target.value)}
              placeholder="Brand SID (BN…)"
              className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-text-primary text-xs font-mono focus:outline-none focus:ring-2 focus:ring-primary/30"
            />
          </div>
          <div className="flex justify-end gap-3 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-sm font-medium text-text-secondary hover:text-text-primary"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={mutation.isPending}
              onClick={() => {
                setError('');
                mutation.mutate();
              }}
              className="px-4 py-2 bg-success hover:opacity-90 text-white text-sm font-medium rounded-lg disabled:opacity-50"
            >
              {mutation.isPending ? 'Confirming…' : 'Mark Verified'}
            </button>
          </div>
        </div>
    </Modal>
  );
}

function RotateModal({
  caller,
  onClose,
  onRotated,
}: {
  caller: TrustedCaller;
  onClose: () => void;
  onRotated: (resp: RotateResponse) => void;
}) {
  const [phoneNumber, setPhoneNumber] = useState('+1');
  const [friendlyName, setFriendlyName] = useState(caller.friendlyName ?? '');
  const [notes, setNotes] = useState(`Rotated from ${caller.phoneNumber}`);
  const [error, setError] = useState('');

  const mutation = useMutation({
    mutationFn: () =>
      api.post<RotateResponse>(`/trusted-callers/${caller.id}/rotate`, {
        phoneNumber: phoneNumber.trim(),
        friendlyName: friendlyName.trim() || undefined,
        notes: notes.trim() || undefined,
      }),
    onSuccess: (resp) => {
      onRotated(resp);
      onClose();
    },
    onError: (err: Error) => setError(err.message),
  });

  return (
    <Modal open onClose={onClose} ariaLabel="Rotate Caller ID" panelClassName="bg-surface border border-border rounded-xl shadow-lg w-full max-w-lg">
        <div className="flex items-center justify-between px-6 py-4 border-b border-border">
          <h2 className="text-lg font-semibold text-text-primary">Rotate Caller ID</h2>
          <button onClick={onClose} aria-label="Close" className="text-text-muted hover:text-text-primary">
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="p-6 space-y-4">
          {error && <div className="bg-danger/10 text-danger text-sm px-3 py-2 rounded-lg">{error}</div>}
          <p className="text-sm text-text-secondary">
            The current number <span className="font-mono">{caller.phoneNumber}</span> will be marked as rotated
            (kept for audit) and replaced by the new number. The replacement starts in <em>pending</em> status
            until verified.
          </p>
          <div>
            <label className="block text-sm font-medium text-text-primary mb-1">New Phone Number (E.164)</label>
            <input
              type="tel"
              value={phoneNumber}
              onChange={(e) => setPhoneNumber(e.target.value)}
              placeholder="+12125559900"
              className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-text-primary text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-text-primary mb-1">Friendly Name</label>
            <input
              type="text"
              value={friendlyName}
              onChange={(e) => setFriendlyName(e.target.value)}
              className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-text-primary text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-text-primary mb-1">Notes</label>
            <textarea
              rows={2}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-text-primary text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
            />
          </div>
          <div className="flex justify-end gap-3 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-sm font-medium text-text-secondary hover:text-text-primary"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={mutation.isPending}
              onClick={() => {
                setError('');
                mutation.mutate();
              }}
              className="px-4 py-2 bg-primary hover:bg-primary-hover text-white text-sm font-medium rounded-lg disabled:opacity-50"
            >
              {mutation.isPending ? 'Rotating…' : 'Rotate'}
            </button>
          </div>
        </div>
    </Modal>
  );
}

interface TrustHubFormState {
  legalName: string;
  websiteUrl: string;
  businessRegistrationNumber: string;
  businessRegistrationIdType: string;
  businessIndustry: string;
  businessIdentityType: string;
  notificationEmail: string;
  street: string;
  street2: string;
  city: string;
  region: string;
  postalCode: string;
  isoCountry: string;
  contactFirstName: string;
  contactLastName: string;
  contactEmail: string;
  contactPhone: string;
  contactJobTitle: string;
  brandEnabled: boolean;
  brandType: string;
}

const EMPTY_TRUST_HUB_FORM: TrustHubFormState = {
  legalName: '',
  websiteUrl: 'https://',
  businessRegistrationNumber: '',
  businessRegistrationIdType: 'EIN',
  businessIndustry: 'PROFESSIONAL_SERVICES',
  businessIdentityType: 'direct_customer',
  notificationEmail: '',
  street: '',
  street2: '',
  city: '',
  region: '',
  postalCode: '',
  isoCountry: 'US',
  contactFirstName: '',
  contactLastName: '',
  contactEmail: '',
  contactPhone: '+1',
  contactJobTitle: '',
  brandEnabled: false,
  brandType: 'STANDARD',
};

function validateTrustHubStep(form: TrustHubFormState, step: number): string | null {
  if (step === 0) {
    if (!form.legalName.trim()) return 'Enter the registered legal business name.';
    if (!/^https?:\/\/.+/.test(form.websiteUrl.trim())) return 'Enter a valid website URL (https://…).';
    if (!form.businessRegistrationNumber.trim()) return 'Enter the business registration / EIN number.';
    if (!form.notificationEmail.includes('@')) return 'Enter the email Twilio should use for notifications.';
  }
  if (step === 1) {
    if (!form.street.trim()) return 'Street address is required.';
    if (!form.city.trim()) return 'City is required.';
    if (!form.region.trim()) return 'State / region is required.';
    if (!form.postalCode.trim()) return 'Postal code is required.';
    if (form.isoCountry.trim().length !== 2) return 'Country must be a 2-letter ISO code (e.g. US, CA).';
  }
  if (step === 2) {
    if (!form.contactFirstName.trim() || !form.contactLastName.trim()) return 'Contact name is required.';
    if (!form.contactEmail.includes('@')) return 'Contact email is required.';
    if (!/^\+[1-9]\d{7,14}$/.test(form.contactPhone.trim())) return 'Contact phone must be in E.164 format (e.g. +12125550123).';
    if (!form.contactJobTitle.trim()) return 'Contact job title is required.';
  }
  return null;
}

function TrustHubWizard({
  caller,
  onClose,
  onSubmitted,
}: {
  caller: TrustedCaller;
  onClose: () => void;
  onSubmitted: (resp: TrustHubSubmitResponse) => void;
}) {
  const [step, setStep] = useState(0);
  const [form, setForm] = useState<TrustHubFormState>(() => ({
    ...EMPTY_TRUST_HUB_FORM,
    notificationEmail: '',
    legalName: caller.friendlyName ?? '',
  }));
  const [error, setError] = useState('');
  const totalSteps = 4;

  const update = <K extends keyof TrustHubFormState>(key: K, value: TrustHubFormState[K]) => {
    setForm((f) => ({ ...f, [key]: value }));
  };

  const mutation = useMutation({
    mutationFn: () =>
      api.post<TrustHubSubmitResponse>(`/trusted-callers/${caller.id}/trust-hub`, {
        profile: {
          legalName: form.legalName.trim(),
          websiteUrl: form.websiteUrl.trim(),
          businessRegistrationNumber: form.businessRegistrationNumber.trim(),
          businessRegistrationIdType: form.businessRegistrationIdType,
          businessIndustry: form.businessIndustry,
          businessIdentityType: form.businessIdentityType,
          notificationEmail: form.notificationEmail.trim(),
          address: {
            street: form.street.trim(),
            street2: form.street2.trim() || undefined,
            city: form.city.trim(),
            region: form.region.trim(),
            postalCode: form.postalCode.trim(),
            isoCountry: form.isoCountry.trim().toUpperCase(),
          },
          contact: {
            firstName: form.contactFirstName.trim(),
            lastName: form.contactLastName.trim(),
            email: form.contactEmail.trim(),
            phoneNumber: form.contactPhone.trim(),
            jobTitle: form.contactJobTitle.trim(),
          },
        },
        brand: form.brandEnabled
          ? { enabled: true, brandType: form.brandType }
          : { enabled: false },
      }),
    onSuccess: (resp) => {
      onSubmitted(resp);
      onClose();
    },
    onError: (err: Error) => setError(err.message),
  });

  const advance = () => {
    const issue = validateTrustHubStep(form, step);
    if (issue) {
      setError(issue);
      return;
    }
    setError('');
    setStep((s) => Math.min(s + 1, totalSteps - 1));
  };

  const back = () => {
    setError('');
    setStep((s) => Math.max(0, s - 1));
  };

  const stepTitles = ['Business Info', 'Address', 'Authorized Contact', 'Review & Submit'];

  return (
    <Modal
      open
      onClose={onClose}
      ariaLabel="Register Trust Hub"
      panelClassName="bg-surface border border-border rounded-xl shadow-lg w-full max-w-2xl max-h-[92vh] overflow-y-auto"
    >
      <div className="flex items-center justify-between px-6 py-4 border-b border-border">
        <div>
          <h2 className="text-lg font-semibold text-text-primary flex items-center gap-2">
            <Building2 className="h-5 w-5 text-primary" />
            Register Trust Hub — {formatPhone(caller.phoneNumber)}
          </h2>
          <p className="text-xs text-text-muted mt-1">
            Step {step + 1} of {totalSteps}: {stepTitles[step]}
          </p>
        </div>
        <button onClick={onClose} aria-label="Close" className="text-text-muted hover:text-text-primary">
          <X className="h-5 w-5" />
        </button>
      </div>

      <div className="px-6 pt-3">
        <div className="flex gap-1.5">
          {stepTitles.map((title, i) => (
            <div
              key={title}
              className={`h-1 flex-1 rounded ${i <= step ? 'bg-primary' : 'bg-border'}`}
              title={title}
            />
          ))}
        </div>
      </div>

      <div className="p-6 space-y-4">
        {error && <div className="bg-danger/10 text-danger text-sm px-3 py-2 rounded-lg">{error}</div>}

        {step === 0 && (
          <div className="space-y-3">
            <p className="text-sm text-text-secondary">
              Twilio's Trust Hub creates a Customer Profile bundle that lists your registered business so
              carriers can attest A under STIR/SHAKEN.
            </p>
            <div>
              <label className="block text-sm font-medium text-text-primary mb-1">Legal Business Name</label>
              <input
                type="text"
                value={form.legalName}
                onChange={(e) => update('legalName', e.target.value)}
                placeholder="Acme Plumbing & Heating, Inc."
                className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-text-primary text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-text-primary mb-1">Website URL</label>
              <input
                type="url"
                value={form.websiteUrl}
                onChange={(e) => update('websiteUrl', e.target.value)}
                placeholder="https://acmeplumbing.com"
                className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-text-primary text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-sm font-medium text-text-primary mb-1">Registration ID Type</label>
                <select
                  value={form.businessRegistrationIdType}
                  onChange={(e) => update('businessRegistrationIdType', e.target.value)}
                  className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-text-primary text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
                >
                  {REGISTRATION_ID_TYPES.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-text-primary mb-1">Registration Number</label>
                <input
                  type="text"
                  value={form.businessRegistrationNumber}
                  onChange={(e) => update('businessRegistrationNumber', e.target.value)}
                  placeholder="12-3456789"
                  className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-text-primary text-sm font-mono focus:outline-none focus:ring-2 focus:ring-primary/30"
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-sm font-medium text-text-primary mb-1">Industry</label>
                <select
                  value={form.businessIndustry}
                  onChange={(e) => update('businessIndustry', e.target.value)}
                  className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-text-primary text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
                >
                  {INDUSTRY_OPTIONS.map((opt) => (
                    <option key={opt} value={opt}>
                      {opt.replace(/_/g, ' ')}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-text-primary mb-1">Identity Type</label>
                <select
                  value={form.businessIdentityType}
                  onChange={(e) => update('businessIdentityType', e.target.value)}
                  className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-text-primary text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
                >
                  <option value="direct_customer">Direct Customer</option>
                  <option value="isv_reseller_or_partner">ISV / Reseller / Partner</option>
                </select>
              </div>
            </div>
            <div>
              <label className="block text-sm font-medium text-text-primary mb-1">Notification Email</label>
              <input
                type="email"
                value={form.notificationEmail}
                onChange={(e) => update('notificationEmail', e.target.value)}
                placeholder="compliance@acmeplumbing.com"
                className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-text-primary text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
              />
            </div>
          </div>
        )}

        {step === 1 && (
          <div className="space-y-3">
            <p className="text-sm text-text-secondary">
              Use the address that matches your business registration. Twilio shares this with carriers when
              they audit attestation.
            </p>
            <div>
              <label className="block text-sm font-medium text-text-primary mb-1">Street</label>
              <input
                type="text"
                value={form.street}
                onChange={(e) => update('street', e.target.value)}
                className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-text-primary text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-text-primary mb-1">Suite / Apt</label>
              <input
                type="text"
                value={form.street2}
                onChange={(e) => update('street2', e.target.value)}
                className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-text-primary text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-sm font-medium text-text-primary mb-1">City</label>
                <input
                  type="text"
                  value={form.city}
                  onChange={(e) => update('city', e.target.value)}
                  className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-text-primary text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-text-primary mb-1">State / Region</label>
                <input
                  type="text"
                  value={form.region}
                  onChange={(e) => update('region', e.target.value)}
                  className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-text-primary text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-sm font-medium text-text-primary mb-1">Postal Code</label>
                <input
                  type="text"
                  value={form.postalCode}
                  onChange={(e) => update('postalCode', e.target.value)}
                  className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-text-primary text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-text-primary mb-1">ISO Country</label>
                <input
                  type="text"
                  value={form.isoCountry}
                  maxLength={2}
                  onChange={(e) => update('isoCountry', e.target.value.toUpperCase())}
                  className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-text-primary text-sm font-mono focus:outline-none focus:ring-2 focus:ring-primary/30"
                />
              </div>
            </div>
          </div>
        )}

        {step === 2 && (
          <div className="space-y-3">
            <p className="text-sm text-text-secondary">
              Twilio's compliance team reaches out to this contact if they need clarification. Provide a real
              person who can sign attestations.
            </p>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-sm font-medium text-text-primary mb-1">First Name</label>
                <input
                  type="text"
                  value={form.contactFirstName}
                  onChange={(e) => update('contactFirstName', e.target.value)}
                  className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-text-primary text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-text-primary mb-1">Last Name</label>
                <input
                  type="text"
                  value={form.contactLastName}
                  onChange={(e) => update('contactLastName', e.target.value)}
                  className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-text-primary text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
                />
              </div>
            </div>
            <div>
              <label className="block text-sm font-medium text-text-primary mb-1">Job Title</label>
              <input
                type="text"
                value={form.contactJobTitle}
                onChange={(e) => update('contactJobTitle', e.target.value)}
                placeholder="Director of Operations"
                className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-text-primary text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-text-primary mb-1">Email</label>
              <input
                type="email"
                value={form.contactEmail}
                onChange={(e) => update('contactEmail', e.target.value)}
                className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-text-primary text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-text-primary mb-1">Phone (E.164)</label>
              <input
                type="tel"
                value={form.contactPhone}
                onChange={(e) => update('contactPhone', e.target.value)}
                placeholder="+12125550123"
                className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-text-primary text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
              />
            </div>
            <div className="border border-border rounded-lg p-3 space-y-2">
              <label className="flex items-center gap-2 text-sm text-text-primary">
                <input
                  type="checkbox"
                  checked={form.brandEnabled}
                  onChange={(e) => update('brandEnabled', e.target.checked)}
                  className="rounded border-border text-primary focus:ring-primary/30"
                />
                Also register an A2P 10DLC brand for SMS
              </label>
              {form.brandEnabled && (
                <div>
                  <label className="block text-xs font-medium text-text-secondary mb-1">Brand Type</label>
                  <select
                    value={form.brandType}
                    onChange={(e) => update('brandType', e.target.value)}
                    className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-text-primary text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
                  >
                    <option value="STANDARD">Standard</option>
                    <option value="STARTER">Starter (low volume)</option>
                    <option value="SOLE_PROPRIETOR">Sole Proprietor</option>
                  </select>
                </div>
              )}
            </div>
          </div>
        )}

        {step === 3 && (
          <div className="space-y-3 text-sm">
            <p className="text-text-secondary">
              Review the bundle below. Submitting will create the Twilio Customer Profile and Trust Product,
              then submit them for carrier review. You can come back and resubmit if Twilio rejects the bundle.
            </p>
            <div className="border border-border rounded-lg divide-y divide-border">
              <ReviewRow label="Legal name" value={form.legalName} />
              <ReviewRow label="Website" value={form.websiteUrl} />
              <ReviewRow
                label="Registration"
                value={`${form.businessRegistrationIdType} ${form.businessRegistrationNumber}`}
              />
              <ReviewRow label="Industry" value={form.businessIndustry.replace(/_/g, ' ')} />
              <ReviewRow label="Identity" value={form.businessIdentityType.replace(/_/g, ' ')} />
              <ReviewRow label="Notification email" value={form.notificationEmail} />
              <ReviewRow
                label="Address"
                value={`${form.street}${form.street2 ? `, ${form.street2}` : ''}, ${form.city}, ${form.region} ${form.postalCode}, ${form.isoCountry}`}
              />
              <ReviewRow
                label="Contact"
                value={`${form.contactFirstName} ${form.contactLastName} (${form.contactJobTitle}) — ${form.contactEmail} / ${form.contactPhone}`}
              />
              <ReviewRow
                label="A2P brand"
                value={form.brandEnabled ? `Enabled — ${form.brandType}` : 'Skipped'}
              />
            </div>
            <p className="text-xs text-text-muted">
              Twilio bills per Customer Profile and Brand Registration. Re-submitting after a rejection reuses
              the same bundle, so you only pay once.
            </p>
          </div>
        )}

        <div className="flex justify-between gap-3 pt-2">
          <button
            type="button"
            onClick={step === 0 ? onClose : back}
            className="px-4 py-2 text-sm font-medium text-text-secondary hover:text-text-primary inline-flex items-center gap-1"
          >
            {step === 0 ? 'Cancel' : (
              <>
                <ChevronLeft className="h-4 w-4" /> Back
              </>
            )}
          </button>
          {step < totalSteps - 1 ? (
            <button
              type="button"
              onClick={advance}
              className="px-4 py-2 bg-primary hover:bg-primary-hover text-white text-sm font-medium rounded-lg inline-flex items-center gap-1"
            >
              Next <ChevronRight className="h-4 w-4" />
            </button>
          ) : (
            <button
              type="button"
              disabled={mutation.isPending}
              onClick={() => {
                setError('');
                mutation.mutate();
              }}
              className="px-4 py-2 bg-primary hover:bg-primary-hover text-white text-sm font-medium rounded-lg disabled:opacity-50"
            >
              {mutation.isPending ? 'Submitting…' : 'Submit to Twilio'}
            </button>
          )}
        </div>
      </div>
    </Modal>
  );
}

function ReviewRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start justify-between gap-3 px-3 py-2">
      <span className="text-xs uppercase tracking-wide text-text-muted">{label}</span>
      <span className="text-sm text-text-primary text-right break-words max-w-[60%]">{value || '—'}</span>
    </div>
  );
}

export default function TrustedCallers() {
  const { isManager } = useRole();
  const canManage = isManager;
  const queryClient = useQueryClient();

  const [showRegister, setShowRegister] = useState(false);
  const [verifyTarget, setVerifyTarget] = useState<TrustedCaller | null>(null);
  const [rotateTarget, setRotateTarget] = useState<TrustedCaller | null>(null);
  const [trustHubTarget, setTrustHubTarget] = useState<TrustedCaller | null>(null);
  const [includeRotated, setIncludeRotated] = useState(false);
  const [lastValidationCode, setLastValidationCode] = useState<{ code: string; phone: string } | null>(null);

  const { data, isLoading, error } = useQuery({
    queryKey: ['trusted-callers', includeRotated],
    queryFn: () =>
      api.get<{ callers: TrustedCaller[] }>(
        `/trusted-callers${includeRotated ? '?includeRotated=true' : ''}`,
      ),
  });

  const callers = data?.callers ?? [];

  const pendingTrustHubIds = callers
    .filter((c) => {
      const snap = c.metadata?.trustHub;
      if (!snap) return false;
      const statuses = [
        snap.customerProfile?.status,
        snap.trustProduct?.status,
        snap.brand?.status,
      ].filter((s): s is string => typeof s === 'string');
      return statuses.length > 0 && statuses.some((s) => !isTrustHubTerminal(s));
    })
    .map((c) => c.id)
    .sort()
    .join(',');

  useEffect(() => {
    if (!pendingTrustHubIds) return;
    const ids = pendingTrustHubIds.split(',');
    let cancelled = false;
    const poll = async () => {
      await Promise.all(
        ids.map((id) => api.get(`/trusted-callers/${id}/trust-hub`).catch(() => null)),
      );
      if (!cancelled) queryClient.invalidateQueries({ queryKey: ['trusted-callers'] });
    };
    void poll();
    const interval = setInterval(() => { void poll(); }, 30_000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [pendingTrustHubIds, queryClient]);

  const syncMutation = useMutation({
    mutationFn: (id: string) => api.post(`/trusted-callers/${id}/sync`, {}),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['trusted-callers'] }),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/trusted-callers/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['trusted-callers'] }),
  });

  return (
    <div className="p-6 space-y-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-text-primary flex items-center gap-2">
            <ShieldCheck className="h-6 w-6 text-primary" />
            Trusted Callers
          </h1>
          <p className="text-sm text-text-secondary mt-1 max-w-2xl">
            Verified caller IDs that outbound campaigns can use as their{' '}
            <span className="font-mono">From</span> number. Once registered with a Twilio Trust Hub product,
            carriers attest A under STIR/SHAKEN so calls don't get tagged as spam.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-2 text-xs text-text-secondary">
            <input
              type="checkbox"
              checked={includeRotated}
              onChange={(e) => setIncludeRotated(e.target.checked)}
              className="rounded border-border text-primary focus:ring-primary/30"
            />
            Show rotated history
          </label>
          {canManage && (
            <button
              onClick={() => setShowRegister(true)}
              className="inline-flex items-center gap-1.5 px-4 py-2 bg-primary hover:bg-primary-hover text-white text-sm font-medium rounded-lg"
            >
              <Plus className="h-4 w-4" /> Register Number
            </button>
          )}
        </div>
      </header>

      {lastValidationCode && (
        <div className="border border-warning/40 bg-warning/10 text-text-primary rounded-lg p-4 flex items-start gap-3">
          <Clock className="h-5 w-5 text-warning mt-0.5 flex-shrink-0" />
          <div className="text-sm space-y-1">
            <p>
              Twilio is calling <span className="font-mono">{lastValidationCode.phone}</span>. Answer the call
              and enter:
            </p>
            <p className="text-2xl font-mono font-semibold tracking-widest">{lastValidationCode.code}</p>
            <p className="text-xs text-text-muted">
              The code expires in 10 minutes. Once Twilio confirms, click <em>Sync</em> on the row to mark it
              verified.
            </p>
          </div>
          <button
            onClick={() => setLastValidationCode(null)}
            className="ml-auto text-text-muted hover:text-text-primary"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      {isLoading && <div className="text-text-muted text-sm">Loading…</div>}
      {error && (
        <div className="bg-danger/10 text-danger text-sm px-4 py-3 rounded-lg">
          Failed to load trusted callers: {(error as Error).message}
        </div>
      )}

      {!isLoading && callers.length === 0 && (
        <EmptyState
          icon={ShieldCheck}
          title="No verified caller IDs yet"
          description="Outbound campaigns will fall back to the platform default number until you register one. Carriers may flag those calls as spam."
          primaryAction={canManage ? { label: 'Register Number', onClick: () => setShowRegister(true), icon: Plus } : undefined}
        />
      )}

      {callers.length > 0 && (
        <div className="border border-border rounded-xl overflow-hidden bg-surface">
          <table className="w-full text-sm">
            <thead className="bg-surface-hover text-text-secondary text-xs uppercase tracking-wide">
              <tr>
                <th className="px-4 py-3 text-left">Number</th>
                <th className="px-4 py-3 text-left">Status</th>
                <th className="px-4 py-3 text-left">Attestation</th>
                <th className="px-4 py-3 text-left">Trust Hub</th>
                <th className="px-4 py-3 text-left">Health</th>
                <th className="px-4 py-3 text-left">Verified At</th>
                <th className="px-4 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {callers.map((caller) => {
                const status = STATUS_STYLES[caller.status];
                return (
                  <tr key={caller.id} className="hover:bg-surface-hover/50">
                    <td className="px-4 py-3">
                      <div className="font-medium text-text-primary">{formatPhone(caller.phoneNumber)}</div>
                      {caller.friendlyName && (
                        <div className="text-xs text-text-muted">{caller.friendlyName}</div>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex items-center gap-1.5 px-2 py-1 rounded text-xs font-medium ${status.color}`}>
                        <status.Icon className="h-3 w-3" />
                        {status.label}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-text-secondary">
                      {caller.attestationLevel ? (
                        <span className="font-mono">{caller.attestationLevel}</span>
                      ) : (
                        <span className="text-text-muted">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      {(() => {
                        const snap = caller.metadata?.trustHub ?? null;
                        if (!snap && !caller.trustProductSid) {
                          return <span className="text-text-muted text-xs">Not registered</span>;
                        }
                        const cpStatus = snap?.customerProfile.status ?? null;
                        const tpStatus = snap?.trustProduct.status ?? null;
                        const brandStatus = snap?.brand?.status ?? null;
                        const overall = aggregateTrustHubStatus([cpStatus, tpStatus, brandStatus]);
                        return (
                          <div className="flex flex-col gap-1">
                            <span
                              className={`inline-flex items-center gap-1.5 px-2 py-1 rounded text-xs font-medium ${trustHubBadgeClass(overall)}`}
                              title={
                                snap
                                  ? `Customer Profile: ${prettyTrustHubStatus(cpStatus)}\nTrust Product: ${prettyTrustHubStatus(tpStatus)}${snap.brand ? `\nBrand: ${prettyTrustHubStatus(snap.brand.status)}` : ''}`
                                  : 'SIDs entered manually'
                              }
                            >
                              <ShieldCheck className="h-3 w-3" />
                              {snap ? prettyTrustHubStatus(overall) : 'Manual SIDs'}
                            </span>
                            {snap?.trustProduct.failureReason && (
                              <span className="text-xs text-danger" title={snap.trustProduct.failureReason}>
                                Reason: {snap.trustProduct.failureReason.slice(0, 40)}…
                              </span>
                            )}
                          </div>
                        );
                      })()}
                    </td>
                    <td className="px-4 py-3">
                      {(() => {
                        const badge = expiryBadge(caller);
                        if (!badge) {
                          return <span className="text-text-muted text-xs">—</span>;
                        }
                        return (
                          <span
                            className={`inline-flex items-center gap-1.5 px-2 py-1 rounded text-xs font-medium ${badge.className}`}
                            title={badge.title}
                          >
                            <badge.Icon className="h-3 w-3" />
                            {badge.label}
                          </span>
                        );
                      })()}
                    </td>
                    <td className="px-4 py-3 text-text-muted text-xs">
                      {caller.verifiedAt ? new Date(caller.verifiedAt).toLocaleString() : '—'}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <div className="inline-flex items-center gap-1">
                        {caller.status === 'pending' && (
                          <>
                            <button
                              onClick={() => syncMutation.mutate(caller.id)}
                              className="p-1.5 text-text-secondary hover:text-text-primary"
                              title="Sync status from Twilio"
                            >
                              <RefreshCw className="h-4 w-4" />
                            </button>
                            {canManage && (
                              <button
                                onClick={() => setVerifyTarget(caller)}
                                className="p-1.5 text-success hover:opacity-80"
                                title="Mark verified"
                              >
                                <CheckCircle2 className="h-4 w-4" />
                              </button>
                            )}
                          </>
                        )}
                        {canManage && caller.status !== 'rotated' && (
                          <button
                            onClick={() => setTrustHubTarget(caller)}
                            className="p-1.5 text-text-secondary hover:text-primary"
                            title={
                              caller.metadata?.trustHub
                                ? 'Resubmit Trust Hub registration'
                                : 'Register Trust Hub bundle'
                            }
                          >
                            <Building2 className="h-4 w-4" />
                          </button>
                        )}
                        {canManage && caller.status === 'verified' && (
                          <button
                            onClick={() => setRotateTarget(caller)}
                            className="p-1.5 text-text-secondary hover:text-primary"
                            title="Rotate to a new number"
                          >
                            <RotateCw className="h-4 w-4" />
                          </button>
                        )}
                        {canManage && caller.status !== 'rotated' && (
                          <button
                            onClick={() => {
                              if (window.confirm(`Delete verified caller ID ${caller.phoneNumber}?`)) {
                                deleteMutation.mutate(caller.id);
                              }
                            }}
                            className="p-1.5 text-text-secondary hover:text-danger"
                            title="Delete"
                          >
                            <Trash2 className="h-4 w-4" />
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {showRegister && (
        <RegisterModal
          onClose={() => setShowRegister(false)}
          onCreated={(resp) => {
            queryClient.invalidateQueries({ queryKey: ['trusted-callers'] });
            if (resp.validationCode) {
              setLastValidationCode({ code: resp.validationCode, phone: resp.caller.phoneNumber });
            }
          }}
        />
      )}
      {verifyTarget && (
        <VerifyModal
          caller={verifyTarget}
          onClose={() => setVerifyTarget(null)}
          onVerified={() => queryClient.invalidateQueries({ queryKey: ['trusted-callers'] })}
        />
      )}
      {rotateTarget && (
        <RotateModal
          caller={rotateTarget}
          onClose={() => setRotateTarget(null)}
          onRotated={(resp) => {
            queryClient.invalidateQueries({ queryKey: ['trusted-callers'] });
            if (resp.validationCode) {
              setLastValidationCode({ code: resp.validationCode, phone: resp.replacement.phoneNumber });
            }
          }}
        />
      )}
      {trustHubTarget && (
        <TrustHubWizard
          caller={trustHubTarget}
          onClose={() => setTrustHubTarget(null)}
          onSubmitted={() => queryClient.invalidateQueries({ queryKey: ['trusted-callers'] })}
        />
      )}
    </div>
  );
}
