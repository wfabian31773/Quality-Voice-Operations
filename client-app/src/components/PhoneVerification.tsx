import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { getToken } from '../lib/api';

export default function PhoneVerification({ onVerified }: { onVerified?: () => void }) {
  const { t } = useTranslation('tenant');
  const [step, setStep] = useState<'input' | 'verify'>('input');
  const [phoneNumber, setPhoneNumber] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);

  const buildHeaders = (): Record<string, string> => {
    const token = getToken();
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    return headers;
  };

  async function sendCode() {
    setError('');
    setLoading(true);
    try {
      const res = await fetch('/api/auth/send-phone-verification', {
        method: 'POST',
        headers: buildHeaders(),
        body: JSON.stringify({ phoneNumber }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || t('phone_verification.send_failed'));
        return;
      }
      setStep('verify');
    } catch {
      setError(t('phone_verification.send_request_failed'));
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
        headers: buildHeaders(),
        body: JSON.stringify({ code }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || t('phone_verification.verify_failed'));
        return;
      }
      setSuccess(true);
      onVerified?.();
    } catch {
      setError(t('phone_verification.verify_failed'));
    } finally {
      setLoading(false);
    }
  }

  if (success) {
    return (
      <div className="p-4 bg-success-light dark:bg-success rounded-lg text-success dark:text-success text-sm">
        {t('phone_verification.success')}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {step === 'input' ? (
        <>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
            {t('phone_verification.phone_label')}
          </label>
          <input
            type="tel"
            value={phoneNumber}
            onChange={(e) => setPhoneNumber(e.target.value)}
            placeholder={t('phone_verification.phone_placeholder')}
            className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white"
          />
          <button
            onClick={sendCode}
            disabled={loading || !phoneNumber}
            className="w-full py-2 px-4 bg-teal-600 hover:bg-teal-700 disabled:opacity-50 text-white rounded-lg font-medium transition-colors"
          >
            {loading ? t('phone_verification.sending') : t('phone_verification.send_code')}
          </button>
        </>
      ) : (
        <>
          <p className="text-sm text-gray-600 dark:text-gray-400">
            {t('phone_verification.code_intro', { phone: phoneNumber })}
          </p>
          <input
            type="text"
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
            placeholder={t('phone_verification.code_placeholder')}
            maxLength={6}
            className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-center text-2xl tracking-widest"
          />
          <button
            onClick={verifyCode}
            disabled={loading || code.length !== 6}
            className="w-full py-2 px-4 bg-teal-600 hover:bg-teal-700 disabled:opacity-50 text-white rounded-lg font-medium transition-colors"
          >
            {loading ? t('phone_verification.verifying') : t('phone_verification.verify_code')}
          </button>
          <button
            onClick={() => { setStep('input'); setCode(''); }}
            className="w-full py-2 px-4 text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white text-sm"
          >
            {t('phone_verification.change_number')}
          </button>
        </>
      )}
      {error && (
        <p className="text-sm text-danger dark:text-danger">{error}</p>
      )}
    </div>
  );
}
