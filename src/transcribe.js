// Speech-to-text for incoming voice notes.
//
// Any OpenAI-compatible `/audio/transcriptions` endpoint works — OpenAI itself,
// Groq, or a whisper server on localhost — so point `voice.baseUrl` at whichever
// you use. It's a single multipart POST, so the zero-dependency rule holds.
import fs from 'node:fs';
import path from 'node:path';
import { multipartPost, sanitizeFilename } from './util.js';

// Whisper-style endpoints pick a decoder from the filename extension, so the
// extension Telegram gave us is authoritative and the sender's declared mime
// type is only a fallback. (Telegram voice notes are .oga/Opus.)
const AUDIO_TYPES = {
  '.oga': 'audio/ogg',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.mp3': 'audio/mpeg',
  '.mpga': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.mp4': 'audio/mp4',
  '.wav': 'audio/wav',
  '.webm': 'audio/webm',
  '.flac': 'audio/flac',
};

export const VOICE_SETUP_HINT = [
  "I can't transcribe voice messages yet — no speech-to-text endpoint is configured.",
  '',
  'Pick one:',
  '  • Set OPENAI_API_KEY in the environment the bridge runs in.',
  '  • Or run a local whisper server and set "voice": { "baseUrl":',
  '    "http://127.0.0.1:8000/v1" } in ~/.aside-remote/config.json. A loopback',
  '    endpoint needs no API key, and your audio never leaves the machine.',
].join('\n');

// The key may live in the config file (like the bot token) or in the
// environment (preferred: it never touches disk).
export function transcriptionKey(cfg = {}) {
  return cfg.apiKey || process.env[cfg.apiKeyEnv || 'OPENAI_API_KEY'] || null;
}

// A self-hosted whisper on loopback needs no key, so a local baseUrl is itself
// sufficient configuration. Anything remote still requires one.
export function isLocalEndpoint(cfg = {}) {
  try {
    const u = new URL(cfg.baseUrl || 'https://api.openai.com/v1');
    return ['localhost', '127.0.0.1', '::1', '[::1]'].includes(u.hostname);
  } catch { return false; }
}

export function isTranscriptionConfigured(cfg = {}) {
  if (cfg.enabled === false) return false;
  return !!transcriptionKey(cfg) || isLocalEndpoint(cfg);
}

// Transcribe an audio/video file to text. Returns '' when the endpoint heard
// nothing (silence, or a note the user recorded by accident).
export async function transcribe(filePath, cfg = {}, mimeType) {
  const key = transcriptionKey(cfg);
  if (!key && !isLocalEndpoint(cfg)) throw new Error('no speech-to-text API key configured');

  const buffer = await fs.promises.readFile(filePath);
  const ext = path.extname(filePath).toLowerCase();
  const base = String(cfg.baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '');

  const res = await multipartPost(`${base}/audio/transcriptions`, {
    headers: key ? { Authorization: `Bearer ${key}` } : {},
    fields: {
      model: cfg.model || 'whisper-1',
      response_format: 'json',
      // Both optional: null fields are dropped by multipartPost.
      language: cfg.language || null,
      prompt: cfg.prompt || null,
    },
    files: [{
      field: 'file',
      filename: sanitizeFilename(path.basename(filePath), `audio${ext || '.ogg'}`),
      contentType: AUDIO_TYPES[ext] || mimeType || 'application/octet-stream',
      buffer,
    }],
    timeoutMs: cfg.timeoutMs ?? 120000,
  });

  if (!res.ok) {
    const detail = res.data?.error?.message || res.data?.raw || `HTTP ${res.status}`;
    throw new Error(String(detail).slice(0, 300));
  }
  return String(res.data?.text || '').trim();
}
