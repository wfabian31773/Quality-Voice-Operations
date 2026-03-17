import { useState } from 'react';
import { Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { api, setToken } from '../lib/api';
import { LogIn, UserPlus } from 'lucide-react';

export default function Login() {
  const [searchParams] = useSearchParams();
  const [mode, setMode] = useState<'login' | 'signup'>(
    searchParams.get('mode') === 'signup' ? 'signup' : 'login'
  );
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [plan, setPlan] = useState(searchParams.get('plan') || 'starter');
  const [error, setError] = useState(searchParams.get('cancelled') ? 'Checkout was cancelled. You can try again.' : '');
  const [loading, setLoading] = useState(false);
  const { login, user } = useAuth();
  const navigate = useNavigate();

  function getLandingPath(u: { isPlatformAdmin?: boolean; role: string }) {
    if (u.isPlatformAdmin) return '/admin/dashboard';
    if (u.role === 'operations_manager') return '/ops/monitor';
    return '/dashboard';
  }

  if (user) {
    return <Navigate to={getLandingPath(user)} replace />;
  }

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await login(email, password);
      const currentUser = useAuth.getState().user;
      if (currentUser) {
        navigate(getLandingPath(currentUser));
      } else {
        navigate('/dashboard');
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Login failed');
    } finally {
      setLoading(false);
    }
  };

  const handleSignup = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const res = await api.post<{ checkoutUrl: string; token: string }>('/auth/signup', { name, email, password, plan });
      if (res.token) {
        setToken(res.token);
      }
      if (res.checkoutUrl) {
        window.location.href = res.checkoutUrl;
      } else {
        setError('Failed to initiate checkout');
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Signup failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-surface-secondary px-4">
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-12 h-12 rounded-xl bg-primary text-white mb-4">
            {mode === 'login' ? <LogIn className="h-6 w-6" /> : <UserPlus className="h-6 w-6" />}
          </div>
          <h1 className="text-2xl font-bold text-text-primary font-display">Quality Voice Operations</h1>
          <p className="text-sm text-text-secondary mt-1">
            {mode === 'login' ? 'Sign in to your account' : 'Create your account'}
          </p>
        </div>

        <form
          onSubmit={mode === 'login' ? handleLogin : handleSignup}
          className="bg-surface rounded-xl border border-border p-6 space-y-4 shadow-sm"
        >
          {error && (
            <div className="bg-red-50 dark:bg-red-900/20 text-danger text-sm px-3 py-2 rounded-lg">
              {error}
            </div>
          )}

          {mode === 'signup' && (
            <div>
              <label className="block text-sm font-medium text-text-primary mb-1.5">Company Name</label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
                className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-text-primary text-sm focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary transition"
                placeholder="Acme Corp"
              />
            </div>
          )}

          <div>
            <label className="block text-sm font-medium text-text-primary mb-1.5">Email</label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-text-primary text-sm focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary transition"
              placeholder="you@company.com"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-text-primary mb-1.5">Password</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={mode === 'signup' ? 8 : undefined}
              className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-text-primary text-sm focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary transition"
              placeholder={mode === 'signup' ? 'Min 8 characters' : 'Enter your password'}
            />
          </div>

          {mode === 'signup' && (
            <div>
              <label className="block text-sm font-medium text-text-primary mb-1.5">Plan</label>
              <select
                value={plan}
                onChange={(e) => setPlan(e.target.value)}
                className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-text-primary text-sm focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary transition"
              >
                <option value="starter">Starter</option>
                <option value="pro">Pro</option>
                <option value="enterprise">Enterprise</option>
              </select>
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full bg-primary hover:bg-primary-hover text-white font-medium py-2.5 px-4 rounded-lg text-sm transition-colors disabled:opacity-50"
          >
            {loading
              ? mode === 'login'
                ? 'Signing in...'
                : 'Creating account...'
              : mode === 'login'
                ? 'Sign In'
                : 'Sign Up & Choose Plan'}
          </button>

          <div className="text-center text-sm text-text-secondary pt-1">
            {mode === 'login' ? (
              <>
                Don't have an account?{' '}
                <button type="button" onClick={() => { setMode('signup'); setError(''); }} className="text-primary hover:underline font-medium">
                  Sign up
                </button>
              </>
            ) : (
              <>
                Already have an account?{' '}
                <button type="button" onClick={() => { setMode('login'); setError(''); }} className="text-primary hover:underline font-medium">
                  Sign in
                </button>
              </>
            )}
          </div>
        </form>
      </div>
    </div>
  );
}
