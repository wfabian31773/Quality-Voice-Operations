import { useState, useEffect } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { api, setToken } from '../lib/api';
import { KeyRound, CheckCircle, XCircle, Loader2 } from 'lucide-react';

interface InvitationInfo {
  email: string;
  role: string;
  tenantName: string;
  inviterEmail: string;
  expiresAt: string;
}

export default function AcceptInvite() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const token = searchParams.get('token');

  const [invitation, setInvitation] = useState<InvitationInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');

  useEffect(() => {
    if (!token) {
      setError('Invalid invitation link. No token provided.');
      setLoading(false);
      return;
    }

    api.get<InvitationInfo>(`/auth/invite-info?token=${encodeURIComponent(token)}`)
      .then((info) => {
        setInvitation(info);
        setLoading(false);
      })
      .catch((err) => {
        setError(err.message || 'This invitation is invalid or has expired.');
        setLoading(false);
      });
  }, [token]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!token) return;

    if (password.length < 8) {
      setError('Password must be at least 8 characters.');
      return;
    }
    if (password !== confirmPassword) {
      setError('Passwords do not match.');
      return;
    }

    setSubmitting(true);
    setError(null);

    try {
      const result = await api.post<{
        token: string;
        userId: string;
        email: string;
        role: string;
        tenantId: string;
      }>('/auth/accept-invite', { token, password });

      setToken(result.token);
      setSuccess(true);
      setTimeout(() => navigate('/'), 2000);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to accept invitation.';
      setError(msg);
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <div className="w-full max-w-md">
        <div className="flex justify-center mb-6">
          <div className="p-3 rounded-xl bg-primary-light">
            <KeyRound className="h-8 w-8 text-primary" />
          </div>
        </div>

        <h1 className="text-2xl font-bold text-center text-text-primary mb-2">
          Accept Invitation
        </h1>

        {loading && (
          <div className="flex justify-center py-8">
            <Loader2 className="h-6 w-6 animate-spin text-primary" />
          </div>
        )}

        {!loading && error && !invitation && (
          <div className="bg-surface border border-border rounded-xl p-6 text-center">
            <XCircle className="h-10 w-10 text-red-500 mx-auto mb-3" />
            <p className="text-text-secondary">{error}</p>
            <button
              onClick={() => navigate('/login')}
              className="mt-4 text-sm text-primary hover:underline"
            >
              Go to login
            </button>
          </div>
        )}

        {success && (
          <div className="bg-surface border border-border rounded-xl p-6 text-center">
            <CheckCircle className="h-10 w-10 text-green-500 mx-auto mb-3" />
            <p className="text-text-primary font-medium">Account activated!</p>
            <p className="text-text-secondary text-sm mt-1">Redirecting to dashboard...</p>
          </div>
        )}

        {!loading && invitation && !success && (
          <div className="bg-surface border border-border rounded-xl p-6 shadow-sm">
            <p className="text-sm text-text-secondary mb-4">
              You've been invited to join <strong>{invitation.tenantName}</strong> as a{' '}
              <strong>{invitation.role}</strong>.
            </p>

            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-text-primary mb-1">Email</label>
                <input
                  type="email"
                  value={invitation.email}
                  disabled
                  className="w-full px-3 py-2 rounded-lg bg-gray-100 dark:bg-gray-800 border border-border text-text-secondary"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-text-primary mb-1">Password</label>
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Choose a password (min 8 chars)"
                  className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-text-primary focus:ring-2 focus:ring-primary/50 focus:border-transparent"
                  required
                  minLength={8}
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-text-primary mb-1">Confirm Password</label>
                <input
                  type="password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  placeholder="Confirm your password"
                  className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-text-primary focus:ring-2 focus:ring-primary/50 focus:border-transparent"
                  required
                  minLength={8}
                />
              </div>

              {error && (
                <p className="text-sm text-red-500">{error}</p>
              )}

              <button
                type="submit"
                disabled={submitting}
                className="w-full py-2.5 bg-primary hover:bg-primary-hover text-white rounded-lg font-medium disabled:opacity-60 flex items-center justify-center gap-2"
              >
                {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
                {submitting ? 'Activating...' : 'Set Password & Join'}
              </button>
            </form>
          </div>
        )}
      </div>
    </div>
  );
}
