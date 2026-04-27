import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { requireAuth } from '../middleware/auth';
import { createLogger } from '../../../platform/core/logger';
import { objectStorageClient } from '../../replit_integrations/object_storage';

const router = Router();
const logger = createLogger('VOICE_PREVIEW');

const SUPPORTED_VOICES = new Set([
  'alloy', 'ash', 'ballad', 'coral', 'echo', 'fable',
  'onyx', 'nova', 'sage', 'shimmer', 'verse',
]);

const SUPPORTED_LANGUAGES = new Set([
  'en', 'es', 'fr', 'de', 'pt', 'it', 'nl', 'zh', 'ja', 'ko', 'ar', 'hi',
]);

const MAX_GREETING_CHARS = 280;
const TTS_MODEL = 'gpt-4o-mini-tts';
const TTS_FORMAT = 'mp3';
const TTS_CONTENT_TYPE = 'audio/mpeg';

interface CacheEntry {
  audio: Buffer;
  contentType: string;
  cachedAt: number;
}

const CACHE_MAX_ENTRIES = 200;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const cache = new Map<string, CacheEntry>();

function cacheGet(key: string): CacheEntry | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.cachedAt > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  cache.delete(key);
  cache.set(key, entry);
  return entry;
}

function cacheSet(key: string, entry: CacheEntry): void {
  if (cache.has(key)) cache.delete(key);
  cache.set(key, entry);
  while (cache.size > CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

const RATE_LIMIT_PER_MIN = 30;
const rateBuckets = new Map<string, { count: number; resetAt: number }>();

function checkRate(key: string): boolean {
  const now = Date.now();
  const entry = rateBuckets.get(key);
  if (!entry || now > entry.resetAt) {
    rateBuckets.set(key, { count: 1, resetAt: now + 60_000 });
    return true;
  }
  entry.count++;
  return entry.count <= RATE_LIMIT_PER_MIN;
}

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of rateBuckets) {
    if (now > v.resetAt) rateBuckets.delete(k);
  }
}, 60_000).unref?.();

const LANGUAGE_INSTRUCTIONS: Record<string, string> = {
  en: 'Speak in clear, natural English with a warm, professional phone-agent tone.',
  es: 'Habla en español claro y natural con un tono cálido y profesional de agente telefónico.',
  fr: 'Parlez dans un français clair et naturel avec un ton chaleureux et professionnel d\'agent téléphonique.',
  de: 'Sprich klares, natürliches Deutsch mit einem warmen, professionellen Tonfall eines Telefonagenten.',
  pt: 'Fale em português claro e natural com um tom caloroso e profissional de agente de telefone.',
  it: 'Parla in italiano chiaro e naturale con un tono caldo e professionale da agente telefonico.',
  nl: 'Spreek helder, natuurlijk Nederlands met een warme, professionele telefoonagent-toon.',
  zh: '用清晰、自然的中文说话,语气温暖专业,像一位电话客服。',
  ja: '明瞭で自然な日本語で、温かくプロフェッショナルな電話オペレーターの口調で話してください。',
  ko: '명확하고 자연스러운 한국어로, 따뜻하고 전문적인 전화 상담원 톤으로 말하세요.',
  ar: 'تحدث باللغة العربية الواضحة والطبيعية بنبرة دافئة ومهنية كموظف هاتف.',
  hi: 'स्पष्ट और प्राकृतिक हिंदी में बोलें, गर्मजोशी और पेशेवर फोन एजेंट के स्वर में।',
};

const DEFAULT_SAMPLE_GREETINGS: Record<string, string> = {
  en: 'Hi, this is your AI receptionist. How can I help you today?',
  es: 'Hola, soy tu recepcionista virtual. ¿En qué puedo ayudarte hoy?',
  fr: 'Bonjour, je suis votre réceptionniste virtuel. Comment puis-je vous aider aujourd\'hui ?',
  de: 'Hallo, ich bin Ihre KI-Empfangsmitarbeiterin. Wie kann ich Ihnen heute helfen?',
  pt: 'Olá, sou sua recepcionista virtual. Como posso ajudar você hoje?',
  it: 'Ciao, sono la tua receptionist virtuale. Come posso aiutarti oggi?',
  nl: 'Hallo, ik ben uw virtuele receptionist. Hoe kan ik u vandaag helpen?',
  zh: '您好,我是您的 AI 接待员。今天我能为您做些什么?',
  ja: 'こんにちは、AI受付係です。本日はどのようなご用件でしょうか?',
  ko: '안녕하세요, 저는 AI 안내원입니다. 오늘 무엇을 도와드릴까요?',
  ar: 'مرحبًا، أنا موظف الاستقبال الافتراضي. كيف يمكنني مساعدتك اليوم؟',
  hi: 'नमस्ते, मैं आपकी एआई रिसेप्शनिस्ट हूँ। आज मैं आपकी कैसे मदद कर सकती हूँ?',
};

function defaultSampleFor(language: string): string {
  return DEFAULT_SAMPLE_GREETINGS[language] ?? DEFAULT_SAMPLE_GREETINGS.en;
}

function trimGreeting(greeting: string): string {
  const trimmed = greeting.trim().replace(/\s+/g, ' ');
  if (trimmed.length <= MAX_GREETING_CHARS) return trimmed;
  return trimmed.slice(0, MAX_GREETING_CHARS - 1).trimEnd() + '…';
}

function previewHash(voice: string, language: string, greeting: string): string {
  return crypto
    .createHash('sha256')
    .update(`${voice}|${language}|${greeting}`)
    .digest('hex');
}

function previewKey(voice: string, language: string, hash: string): string {
  return `${voice}:${language}:${hash.slice(0, 32)}`;
}

interface ObjectLocation {
  bucketName: string;
  objectName: string;
}

function getObjectLocation(hash: string): ObjectLocation | null {
  const dir = process.env.PRIVATE_OBJECT_DIR;
  if (!dir) return null;
  const trimmed = dir.replace(/\/+$/, '');
  // Namespace under voice-previews/ so this cache isn't co-mingled with
  // other private objects (e.g. dispatch attachments). Each file is keyed
  // purely by the (voice, language, greeting) sha256 hash.
  const fullPath = `${trimmed}/voice-previews/${hash}.${TTS_FORMAT}`;
  const path = fullPath.startsWith('/') ? fullPath.slice(1) : fullPath;
  const parts = path.split('/');
  if (parts.length < 2) return null;
  return {
    bucketName: parts[0],
    objectName: parts.slice(1).join('/'),
  };
}

async function readFromObjectStorage(hash: string): Promise<Buffer | null> {
  const loc = getObjectLocation(hash);
  if (!loc) return null;
  try {
    const file = objectStorageClient.bucket(loc.bucketName).file(loc.objectName);
    const [exists] = await file.exists();
    if (!exists) return null;
    const [buf] = await file.download();
    return buf;
  } catch (err) {
    logger.warn('Voice preview object storage read failed', {
      hash: hash.slice(0, 12),
      error: String(err),
    });
    return null;
  }
}

async function writeToObjectStorage(hash: string, audio: Buffer): Promise<void> {
  const loc = getObjectLocation(hash);
  if (!loc) return;
  try {
    const file = objectStorageClient.bucket(loc.bucketName).file(loc.objectName);
    await file.save(audio, {
      contentType: TTS_CONTENT_TYPE,
      resumable: false,
      metadata: {
        cacheControl: 'private, max-age=31536000',
      },
    });
  } catch (err) {
    logger.warn('Voice preview object storage write failed', {
      hash: hash.slice(0, 12),
      error: String(err),
    });
  }
}

router.post('/agents/voice-preview', requireAuth, async (req: Request, res: Response) => {
  const { tenantId, userId } = req.user!;
  const body = (req.body ?? {}) as {
    voice?: unknown;
    language?: unknown;
    greeting?: unknown;
  };

  const voice = typeof body.voice === 'string' ? body.voice.trim().toLowerCase() : '';
  const language = typeof body.language === 'string' ? body.language.trim().toLowerCase() : '';
  const greetingRaw = typeof body.greeting === 'string' ? body.greeting : '';

  if (!SUPPORTED_VOICES.has(voice)) {
    return res.status(400).json({ error: 'Unsupported voice' });
  }
  if (!SUPPORTED_LANGUAGES.has(language)) {
    return res.status(400).json({ error: 'Unsupported language' });
  }

  // When the caller hasn't provided a greeting yet (e.g. brand-new agent or
  // they just cleared the field), fall back to a short language-aware sample
  // so they can still hear what each voice sounds like.
  const greetingSource = greetingRaw.trim() ? greetingRaw : defaultSampleFor(language);
  const greeting = trimGreeting(greetingSource);

  const rateKey = `${tenantId}:${userId}`;
  if (!checkRate(rateKey)) {
    return res.status(429).json({ error: 'Too many preview requests. Try again in a minute.' });
  }

  const hash = previewHash(voice, language, greeting);
  const key = previewKey(voice, language, hash);

  // Hot tier: in-memory LRU.
  const hot = cacheGet(key);
  if (hot) {
    res.setHeader('Content-Type', hot.contentType);
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.setHeader('X-Voice-Preview-Cache', 'hit');
    return res.send(hot.audio);
  }

  // Warm tier: object storage (survives restarts/deploys).
  const fromStore = await readFromObjectStorage(hash);
  if (fromStore) {
    cacheSet(key, { audio: fromStore, contentType: TTS_CONTENT_TYPE, cachedAt: Date.now() });
    res.setHeader('Content-Type', TTS_CONTENT_TYPE);
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.setHeader('X-Voice-Preview-Cache', 'warm');
    return res.send(fromStore);
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    logger.error('OPENAI_API_KEY not set — cannot synthesize voice preview');
    return res.status(503).json({ error: 'Voice preview is unavailable right now.' });
  }

  try {
    const upstream = await fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: TTS_MODEL,
        voice,
        input: greeting,
        instructions: LANGUAGE_INSTRUCTIONS[language] ?? LANGUAGE_INSTRUCTIONS.en,
        response_format: TTS_FORMAT,
      }),
    });

    if (!upstream.ok) {
      const errText = await upstream.text().catch(() => '');
      logger.error('OpenAI TTS request failed', {
        tenantId,
        voice,
        language,
        status: upstream.status,
        body: errText.slice(0, 500),
      });
      const status = upstream.status === 401 || upstream.status === 403 ? 503 : 502;
      return res.status(status).json({ error: 'Could not synthesize voice preview.' });
    }

    const arrayBuf = await upstream.arrayBuffer();
    const audio = Buffer.from(arrayBuf);
    const contentType = TTS_CONTENT_TYPE;

    cacheSet(key, { audio, contentType, cachedAt: Date.now() });
    // Persist to object storage in the background — never block the response
    // on a slow or flaky write. Errors are logged inside the helper.
    void writeToObjectStorage(hash, audio);

    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.setHeader('X-Voice-Preview-Cache', 'miss');
    return res.send(audio);
  } catch (err) {
    logger.error('Voice preview synthesis error', { tenantId, voice, language, error: String(err) });
    return res.status(502).json({ error: 'Could not synthesize voice preview.' });
  }
});

export default router;
