import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Loader2, Pause, Play, Volume2 } from 'lucide-react';
import {
  getAgentLanguageLabel,
  getRecommendedVoicesForLanguage,
  isVoiceRecommendedForLanguage,
} from '../lib/agentLanguages';
import {
  type AgentBuilderTKey,
  makeBuilderT,
} from '../lib/agentBuilderI18n';

type BuilderT = (
  key: AgentBuilderTKey,
  params?: Record<string, string | number>,
) => string;

export const VOICES = [
  'alloy',
  'ash',
  'ballad',
  'coral',
  'echo',
  'fable',
  'onyx',
  'nova',
  'sage',
  'shimmer',
  'verse',
];

export interface VoicePickerProps {
  voice: string;
  language: string;
  welcomeGreeting: string;
  onChange: (next: string) => void;
  t?: BuilderT;
  labelClassName?: string;
}

export default function VoicePicker({
  voice,
  language,
  welcomeGreeting,
  onChange,
  t: tProp,
  labelClassName,
}: VoicePickerProps) {
  const t = useMemo<BuilderT>(
    () => tProp ?? makeBuilderT(language),
    [tProp, language],
  );
  const recommended = getRecommendedVoicesForLanguage(language);
  const recommendedSet = useMemo(() => new Set(recommended), [recommended]);
  const others = useMemo(
    () => VOICES.filter((v) => !recommendedSet.has(v)),
    [recommendedSet],
  );
  const langLabel = getAgentLanguageLabel(language);
  const isRecommended = isVoiceRecommendedForLanguage(voice, language);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const objectUrlRef = useRef<string | null>(null);
  const [playingVoice, setPlayingVoice] = useState<string | null>(null);
  const [loadingVoice, setLoadingVoice] = useState<string | null>(null);
  const [errorVoice, setErrorVoice] = useState<string | null>(null);

  const greetingTrimmed = welcomeGreeting.trim();
  const usingDefaultSample = greetingTrimmed.length === 0;

  const stopPlayback = useCallback(() => {
    const audio = audioRef.current;
    if (audio) {
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
    }
    if (objectUrlRef.current) {
      URL.revokeObjectURL(objectUrlRef.current);
      objectUrlRef.current = null;
    }
    setPlayingVoice(null);
  }, []);

  useEffect(() => {
    return () => {
      stopPlayback();
      audioRef.current = null;
    };
  }, [stopPlayback]);

  const playPreview = useCallback(
    async (v: string) => {
      if (loadingVoice) return;
      if (playingVoice === v) {
        stopPlayback();
        return;
      }
      stopPlayback();
      setErrorVoice(null);
      setLoadingVoice(v);

      try {
        const token = (() => {
          try {
            return localStorage.getItem('auth_token');
          } catch {
            return null;
          }
        })();
        const headers: Record<string, string> = {
          'Content-Type': 'application/json',
        };
        if (token) headers['Authorization'] = `Bearer ${token}`;

        const res = await fetch('/api/agents/voice-preview', {
          method: 'POST',
          credentials: 'include',
          headers,
          body: JSON.stringify({
            voice: v,
            language,
            greeting: greetingTrimmed,
          }),
        });

        if (!res.ok) {
          setErrorVoice(v);
          setLoadingVoice(null);
          return;
        }

        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        objectUrlRef.current = url;

        let audio = audioRef.current;
        if (!audio) {
          audio = new Audio();
          audioRef.current = audio;
        }
        audio.src = url;
        audio.onended = () => {
          setPlayingVoice((current) => (current === v ? null : current));
          if (objectUrlRef.current === url) {
            URL.revokeObjectURL(url);
            objectUrlRef.current = null;
          }
        };
        audio.onerror = () => {
          setErrorVoice(v);
          setPlayingVoice((current) => (current === v ? null : current));
        };

        await audio.play();
        setPlayingVoice(v);
      } catch {
        setErrorVoice(v);
      } finally {
        setLoadingVoice(null);
      }
    },
    [greetingTrimmed, language, loadingVoice, playingVoice, stopPlayback],
  );

  useEffect(() => {
    stopPlayback();
    setErrorVoice(null);
  }, [language, greetingTrimmed, stopPlayback]);

  const renderRow = (v: string, isInRecommendedGroup: boolean) => {
    const selected = v === voice;
    const isPlaying = playingVoice === v;
    const isLoading = loadingVoice === v;
    const hasError = errorVoice === v;
    const previewLabel = isPlaying
      ? t('voicePreviewStop')
      : t('voicePreviewPlay', { voice: v });
    return (
      <li key={v}>
        <div
          className={`flex items-center gap-2 rounded-lg border px-2 py-1.5 transition ${
            selected
              ? 'border-primary bg-primary/5'
              : 'border-border hover:border-primary/40 hover:bg-surface-hover'
          }`}
        >
          <button
            type="button"
            onClick={() => onChange(v)}
            className="flex-1 flex items-center gap-2 text-left text-sm text-text-primary min-w-0"
            aria-pressed={selected}
          >
            <span
              className={`h-3.5 w-3.5 rounded-full border flex-shrink-0 flex items-center justify-center ${
                selected ? 'border-primary' : 'border-border'
              }`}
              aria-hidden
            >
              {selected && (
                <span className="h-1.5 w-1.5 rounded-full bg-primary" />
              )}
            </span>
            <span className="truncate font-medium capitalize">{v}</span>
            {isInRecommendedGroup && (
              <span
                className="text-amber-500 dark:text-amber-400 text-[10px]"
                aria-hidden
              >
                ★
              </span>
            )}
          </button>
          <button
            type="button"
            onClick={() => playPreview(v)}
            disabled={loadingVoice !== null && loadingVoice !== v}
            aria-label={previewLabel}
            title={previewLabel}
            className={`flex-shrink-0 inline-flex items-center justify-center h-7 w-7 rounded-md border transition ${
              hasError
                ? 'border-red-300 text-red-500 dark:border-red-700'
                : isPlaying
                  ? 'border-primary text-primary bg-primary/10'
                  : 'border-border text-text-secondary hover:text-primary hover:border-primary/50'
            } disabled:opacity-40 disabled:cursor-not-allowed`}
          >
            {isLoading ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : isPlaying ? (
              <Pause className="h-3.5 w-3.5" />
            ) : (
              <Play className="h-3.5 w-3.5" />
            )}
          </button>
        </div>
        {hasError && (
          <p
            className="mt-1 text-[10px] text-red-500 dark:text-red-400"
            role="alert"
          >
            {t('voicePreviewError')}
          </p>
        )}
      </li>
    );
  };

  return (
    <div>
      <label
        className={
          labelClassName ??
          'block text-xs font-medium text-text-secondary mb-1'
        }
      >
        {t('voiceField')}
      </label>
      <div
        className={`rounded-lg border p-2 ${
          !isRecommended
            ? 'border-amber-400 dark:border-amber-600'
            : 'border-border'
        }`}
      >
        <div className="flex items-center gap-1.5 px-1 mb-1.5">
          <Volume2 className="h-3 w-3 text-text-muted" />
          <span className="text-[10px] font-semibold uppercase tracking-wide text-text-muted">
            {t('voiceRecommendedForLang', { language: langLabel })}
          </span>
        </div>
        <ul className="space-y-1">
          {recommended.map((v) => renderRow(v, true))}
        </ul>
        {others.length > 0 && (
          <>
            <div className="flex items-center gap-1.5 px-1 mt-3 mb-1.5">
              <span className="text-[10px] font-semibold uppercase tracking-wide text-text-muted">
                {t('voiceOtherGroupLabel')}
              </span>
            </div>
            <ul className="space-y-1">
              {others.map((v) => renderRow(v, false))}
            </ul>
          </>
        )}
      </div>
      {loadingVoice && (
        <p className="mt-1.5 text-[10px] text-text-muted flex items-center gap-1">
          <Loader2 className="h-3 w-3 animate-spin" />{' '}
          {t('voicePreviewLoading')}
        </p>
      )}
      {usingDefaultSample && (
        <p className="mt-1.5 text-[10px] text-text-muted">
          {t('voicePreviewDefaultSample')}
        </p>
      )}
      {!isRecommended ? (
        <div className="mt-1.5 rounded-md border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-900/20 px-2 py-1.5 space-y-1.5">
          <div className="flex items-start gap-1.5">
            <AlertTriangle className="h-3.5 w-3.5 text-amber-600 dark:text-amber-400 flex-shrink-0 mt-0.5" />
            <p className="text-[11px] text-amber-700 dark:text-amber-300 leading-snug">
              {t('voiceMismatchWarning', {
                voice,
                language: langLabel,
                recommended: recommended.slice(0, 3).join(', '),
              })}
            </p>
          </div>
          {recommended[0] && recommended[0] !== voice && (
            <button
              type="button"
              onClick={() => onChange(recommended[0])}
              className="w-full text-[11px] font-medium text-white bg-amber-600 hover:bg-amber-700 dark:bg-amber-700 dark:hover:bg-amber-600 rounded px-2 py-1 transition"
            >
              {t('voiceSwitchToRecommended', { voice: recommended[0] })}
            </button>
          )}
        </div>
      ) : (
        <p className="text-[10px] text-text-muted mt-1">
          {t('voiceRecommendedHint', { language: langLabel })}
        </p>
      )}
    </div>
  );
}
