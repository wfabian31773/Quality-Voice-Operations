import { useState } from 'react';
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
} from 'lucide-react';
import { api } from '../lib/api';
import { useRole } from '../lib/useRole';
import EmptyState from '../components/EmptyState';

type CallerStatus = 'pending' | 'verified' | 'failed' | 'rotated';
type AttestationLevel = 'A' | 'B' | 'C';

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

const STATUS_STYLES: Record<CallerStatus, { label: string; color: string; Icon: typeof ShieldCheck }> = {
  verified: { label: 'Verified', color: 'bg-success/10 text-success', Icon: ShieldCheck },
  pending: { label: 'Pending', color: 'bg-warning/10 text-warning', Icon: ShieldQuestion },
  failed: { label: 'Failed', color: 'bg-danger/10 text-danger', Icon: ShieldAlert },
  rotated: { label: 'Rotated', color: 'bg-text-muted/10 text-text-muted', Icon: RotateCw },
};

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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4">
      <div className="bg-surface border border-border rounded-xl shadow-lg w-full max-w-lg max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between px-6 py-4 border-b border-border">
          <h2 className="text-lg font-semibold text-text-primary">Register Verified Caller ID</h2>
          <button onClick={onClose} className="text-text-muted hover:text-text-primary">
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
      </div>
    </div>
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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4">
      <div className="bg-surface border border-border rounded-xl shadow-lg w-full max-w-lg">
        <div className="flex items-center justify-between px-6 py-4 border-b border-border">
          <h2 className="text-lg font-semibold text-text-primary">Confirm Verification — {formatPhone(caller.phoneNumber)}</h2>
          <button onClick={onClose} className="text-text-muted hover:text-text-primary">
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
      </div>
    </div>
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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4">
      <div className="bg-surface border border-border rounded-xl shadow-lg w-full max-w-lg">
        <div className="flex items-center justify-between px-6 py-4 border-b border-border">
          <h2 className="text-lg font-semibold text-text-primary">Rotate Caller ID</h2>
          <button onClick={onClose} className="text-text-muted hover:text-text-primary">
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
      </div>
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
                      {caller.trustProductSid ? (
                        <CheckCircle2 className="h-4 w-4 text-success" />
                      ) : (
                        <span className="text-text-muted text-xs">Not registered</span>
                      )}
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
    </div>
  );
}
