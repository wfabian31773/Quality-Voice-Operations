import { useState } from 'react';
import { useAuthStore } from '../stores/authStore';

export default function PhoneVerification({ onVerified }: { onVerified?: () => void }) {
  const { token } = useAuthStore();
  const [step, setStep] = useState<'input' | 'verify'>('input');
  const [phoneNumber, setPhoneNumber] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);

  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
  };

  async function sendCode() {
    setError('');
    setLoading(true);
    try {
      const res = await fetch('/api/auth/send-phone-verification', {
        method: 'POST',
        headers,
        body: JSON.stringify({ phoneNumber }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || 'Failed to send code');
        return;
      }
      setStep('verify');
    } catch {
      setError('Failed to send verification code');
    } finally {
      setLoading(false);
    }
  }

  async function verifyCode() {
    setError('');
    setLoading(true);
    try {
      const res = await fetch('/api/auth/verify-phone', {
        method: 'POST',
        headers,
        body: JSON.stringify({ code }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || 'Verification failed');
        return;
      }
      setSuccess(true);
      onVerified?.();
    } catch {
      setError('Verification failed');
    } finally {
      setLoading(false);
    }
  }

  if (success) {
    return (
      <div className="p-4 bg-green-50 dark:bg-green-900/20 rounded-lg text-green-700 dark:text-green-300 text-sm">
        Phone number verified successfully.
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {step === 'input' ? (
        <>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
            Phone Number
          </label>
          <input
            type="tel"
            value={phoneNumber}
            onChange={(e) => setPhoneNumber(e.target.value)}
            placeholder="+1 (555) 000-0000"
            className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white"
          />
          <button
            onClick={sendCode}
            disabled={loading || !phoneNumber}
            className="w-full py-2 px-4 bg-teal-600 hover:bg-teal-700 disabled:opacity-50 text-white rounded-lg font-medium transition-colors"
          >
            {loading ? 'Sending...' : 'Send Verification Code'}
          </button>
        </>
      ) : (
        <>
          <p className="text-sm text-gray-600 dark:text-gray-400">
            Enter the 6-digit code sent to {phoneNumber}
          </p>
          <input
            type="text"
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
            placeholder="000000"
            maxLength={6}
            className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-center text-2xl tracking-widest"
          />
          <button
            onClick={verifyCode}
            disabled={loading || code.length !== 6}
            className="w-full py-2 px-4 bg-teal-600 hover:bg-teal-700 disabled:opacity-50 text-white rounded-lg font-medium transition-colors"
          >
            {loading ? 'Verifying...' : 'Verify Code'}
          </button>
          <button
            onClick={() => { setStep('input'); setCode(''); }}
            className="w-full py-2 px-4 text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white text-sm"
          >
            Change phone number
          </button>
        </>
      )}
      {error && (
        <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
      )}
    </div>
  );
}
