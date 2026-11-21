// Speech output with real AI voices (OpenAI, ElevenLabs). Keys live only in
// data/secrets.json (file mode 600), never in the map state and never in bot runs.
import { tr } from '../core/i18n.ts';
import { readFileSync, writeFileSync, existsSync, chmodSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { DATA_DIR } from './store.ts';

const SECRETS = join(DATA_DIR, 'secrets.json');
const CACHE = join(DATA_DIR, 'tts-cache');

export interface TtsSettings {
  provider: 'system' | 'openai' | 'elevenlabs';
  readAloud: 'aus' | 'stimme' | 'immer'; // default: aus (off)
  voice: string; // OpenAI: nova, shimmer, …; ElevenLabs: voice id
  openaiKey?: string;
  elevenKey?: string;
}

export const OPENAI_VOICES = ['nova', 'shimmer', 'coral', 'sage', 'alloy', 'ash', 'ballad', 'echo', 'fable', 'onyx', 'verse'];
// Public ElevenLabs voices (multilingual with eleven_multilingual_v2)
export const ELEVEN_VOICES: [string, string][] = [
  ['21m00Tcm4TlvDq8ikWAM', 'Rachel'], ['EXAVITQu4vr4xnSDxMaL', 'Sarah'], ['XrExE9yKIg1WjnnlVkGX', 'Matilda'],
  ['pNInz6obpgDQGcFmaJgB', 'Adam'], ['onwK4e9ZLuTAKqWW03F9', 'Daniel'], ['TX3LPaxmHKxFdv7VOQHJ', 'Liam'],
];

export function readTts(): TtsSettings {
  try { return { provider: 'system', voice: '', readAloud: 'aus', ...JSON.parse(readFileSync(SECRETS, 'utf8')).tts }; }
  catch { return { provider: 'system', voice: '', readAloud: 'aus' }; }
}

const mask = (k?: string) => (k ? `••••${k.slice(-4)}` : '');

export function publicTts() {
  const t = readTts();
  return { provider: t.provider, voice: t.voice, readAloud: t.readAloud, openaiKey: mask(t.openaiKey), elevenKey: mask(t.elevenKey), openaiVoices: OPENAI_VOICES, elevenVoices: ELEVEN_VOICES };
}

export function saveTts(patch: Partial<TtsSettings>) {
  mkdirSync(DATA_DIR, { recursive: true });
  let all: Record<string, unknown> = {};
  try { all = JSON.parse(readFileSync(SECRETS, 'utf8')); } catch { /* new */ }
  const cur = readTts();
  const next: TtsSettings = { ...cur };
  if (patch.provider) next.provider = patch.provider;
  if (typeof patch.voice === 'string') next.voice = patch.voice;
  if (patch.readAloud && ['aus', 'stimme', 'immer'].includes(patch.readAloud)) next.readAloud = patch.readAloud;
  // empty fields or masked values do not overwrite stored keys
  if (patch.openaiKey && !patch.openaiKey.startsWith('••••')) next.openaiKey = patch.openaiKey.trim();
  if (patch.elevenKey && !patch.elevenKey.startsWith('••••')) next.elevenKey = patch.elevenKey.trim();
  all.tts = next;
  writeFileSync(SECRETS, JSON.stringify(all, null, 2));
  chmodSync(SECRETS, 0o600);
  return publicTts();
}

/** Returns MP3 or null (then the browser speaks with the system voice). */
export async function synth(text: string): Promise<{ mp3: Buffer } | { error: string } | null> {
  const t = readTts();
  if (t.provider === 'system') return null;
  const clean = text.replace(/[*`#_>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 1500);
  if (!clean) return null;
  mkdirSync(CACHE, { recursive: true });
  const key = createHash('sha256').update(`${t.provider}|${t.voice}|${clean}`).digest('hex').slice(0, 24);
  const file = join(CACHE, `${key}.mp3`);
  if (existsSync(file)) return { mp3: readFileSync(file) };
  let r: Response;
  if (t.provider === 'openai') {
    if (!t.openaiKey) return { error: tr('Kein OpenAI-Schlüssel hinterlegt (Regeln → Vorlesestimme).', 'No OpenAI key stored (Rules → Read-aloud voice).') };
    r = await fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: { Authorization: `Bearer ${t.openaiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-4o-mini-tts', voice: t.voice || 'nova', input: clean, response_format: 'mp3',
        instructions: tr('Sprich natürlich und warm auf Deutsch, in ruhigem Gesprächstempo, wie ein kompetenter Kollege.', 'Speak naturally and warmly in English, at a calm conversational pace, like a competent colleague.') }),
    });
  } else {
    if (!t.elevenKey) return { error: tr('Kein ElevenLabs-Schlüssel hinterlegt (Regeln → Vorlesestimme).', 'No ElevenLabs key stored (Rules → Read-aloud voice).') };
    r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${t.voice || ELEVEN_VOICES[0][0]}?output_format=mp3_44100_128`, {
      method: 'POST',
      headers: { 'xi-api-key': t.elevenKey, 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
      body: JSON.stringify({ text: clean, model_id: 'eleven_multilingual_v2' }),
    });
  }
  if (!r.ok) return { error: `${t.provider}: ${r.status} ${(await r.text()).slice(0, 200)}` };
  const mp3 = Buffer.from(await r.arrayBuffer());
  writeFileSync(file, mp3);
  return { mp3 };
}
