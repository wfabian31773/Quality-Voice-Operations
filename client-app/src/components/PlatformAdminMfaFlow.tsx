import { useEffect, useState } from 'react';
import { KeyRound, Loader2, ShieldCheck } from 'lucide-react';
import { api } from '../lib/api';

interface Props {
  mode: 'setup' | 'challenge';
  flowToken: string;
  onComplete: (token: string) => void;
}

interface SetupDetails {
  secret: string;
  otpauthUri: string;
  expiresAt: string;
}

export default function PlatformAdminMfaFlow({ mode, flowToken, onComplete }: Props) {
  const [setup, setSetup] = useState<SetupDetails | null>(null);
  const [code, setCode] = useState('');
  const [useRecovery, setUseRecovery] = useState(false);
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  const [completedToken, setCompletedToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(mode === 'setup');
  const [error, setError] = useState('');

  useEffect(() => {
    if (mode !== 'setup') return;
    let cancelled = false;
    setLoading(true);
    api.post<SetupDetails>('/auth/mfa/setup/start', { mfaSetupToken: flowToken })
      .then((result) => {
        if (!cancelled) setSetup(result);
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError(reason instanceof Error ? reason.message : 'Unable to start MFA setup.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [flowToken, mode]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError('');
    setLoading(true);
    try {
      if (mode === 'setup') {
        const result = await api.post<{ token: string; recoveryCodes: string[] }>('/auth/mfa/setup/confirm', {
          mfaSetupToken: flowToken,
          code,
        });
        setCompletedToken(result.token);
        setRecoveryCodes(result.recoveryCodes);
      } else {
        const result = await api.post<{ token: string }>('/auth/mfa/challenge', {
          mfaChallengeToken: flowToken,
          ...(useRecovery ? { recoveryCode: code.trim().toUpperCase() } : { code }),
        });
        onComplete(result.token);
      }
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : 'MFA verification failed.');
    } finally {
      setLoading(false);
    }
  }

  if (recoveryCodes && completedToken) {
    return (
      <section className="bg-surface rounded-xl border border-border p-6 space-y-4 shadow-sm" aria-labelledby="mfa-recovery-heading">
        <ShieldCheck className="h-8 w-8 text-success" aria-hidden="true" />
        <div>
          <h2 id="mfa-recovery-heading" className="text-lg font-semibold text-text-primary">Save your recovery codes</h2>
          <p className="text-sm text-text-secondary mt-1">
            Each code works once. Store them in a secure password manager; they will not be shown again.
          </p>
        </div>
        <ul className="grid grid-cols-1 sm:grid-cols-2 gap-2 rounded-lg bg-surface-secondary border border-border p-3 font-mono text-sm text-text-primary">
          {recoveryCodes.map((recoveryCode) => <li key={recoveryCode}>{recoveryCode}</li>)}
        </ul>
        <button
          type="button"
          onClick={() => onComplete(completedToken)}
          className="w-full bg-primary hover:bg-primary-hover text-white font-medium py-2.5 px-4 rounded-lg text-sm"
        >
          I saved these recovery codes
        </button>
      </section>
    );
  }

  return (
    <section className="bg-surface rounded-xl border border-border p-6 space-y-4 shadow-sm" aria-labelledby="mfa-heading">
      <div className="flex items-center gap-3">
        <KeyRound className="h-6 w-6 text-primary" aria-hidden="true" />
        <div>
          <h2 id="mfa-heading" className="text-lg font-semibold text-text-primary">
            {mode === 'setup' ? 'Secure your administrator account' : 'Administrator verification'}
          </h2>
          <p className="text-sm text-text-secondary">
            {mode === 'setup'
              ? 'Platform administrators must enroll an authenticator before privileged access is granted.'
              : 'Enter a current authenticator code to continue.'}
          </p>
        </div>
      </div>

      {error && <div role="alert" className="bg-danger-light text-danger text-sm px-3 py-2 rounded-lg">{error}</div>}

      {mode === 'setup' && setup && (
        <div className="space-y-3 text-sm">
          <p className="text-text-secondary">Add this account in your authenticator app using the setup link or manual key.</p>
          <a className="inline-flex text-primary hover:underline font-medium" href={setup.otpauthUri}>Open authenticator setup</a>
          <div>
            <div className="text-xs font-medium text-text-muted mb-1">Manual setup key</div>
            <code className="block break-all rounded-lg bg-surface-secondary border border-border p-3 text-text-primary">{setup.secret}</code>
          </div>
        </div>
      )}

      {loading && mode === 'setup' && !setup ? (
        <div className="flex justify-center py-6"><Loader2 className="h-6 w-6 animate-spin text-primary" aria-label="Loading MFA setup" /></div>
      ) : (
        <form onSubmit={submit} className="space-y-4">
          <div>
            <label htmlFor="platform-admin-mfa-code" className="block text-sm font-medium text-text-primary mb-1.5">
              {useRecovery ? 'Recovery code' : 'Authenticator code'}
            </label>
            <input
              id="platform-admin-mfa-code"
              value={code}
              onChange={(event) => setCode(useRecovery
                ? event.target.value.toUpperCase().slice(0, 11)
                : event.target.value.replace(/\D/gu, '').slice(0, 6))}
              inputMode={useRecovery ? 'text' : 'numeric'}
              autoComplete="one-time-code"
              pattern={useRecovery ? '[A-Z0-9]{5}-[A-Z0-9]{5}' : '\\d{6}'}
              required
              className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-text-primary text-sm tracking-widest"
            />
          </div>
          <button
            type="submit"
            disabled={loading || (useRecovery ? code.length !== 11 : code.length !== 6)}
            className="w-full bg-primary hover:bg-primary-hover text-white font-medium py-2.5 px-4 rounded-lg text-sm disabled:opacity-50"
          >
            {loading ? 'Verifying…' : mode === 'setup' ? 'Enable MFA' : 'Verify and sign in'}
          </button>
          {mode === 'challenge' && (
            <button
              type="button"
              onClick={() => { setUseRecovery((value) => !value); setCode(''); setError(''); }}
              className="w-full text-sm text-primary hover:underline"
            >
              {useRecovery ? 'Use an authenticator code' : 'Use a recovery code'}
            </button>
          )}
        </form>
      )}
    </section>
  );
}
