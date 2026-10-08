// Speech-to-text for incoming voice notes.
//
// Any OpenAI-compatible `/audio/transcriptions` endpoint works — OpenAI itself,
// Groq, or a whisper server on localhost — so point `voice.baseUrl` at whichever
// you use. It's a single multipart POST, so the zero-dependency rule holds.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { multipartPost, sanitizeFilename, transcriptionKey, isLocalEndpoint } from './util.js';

// Back-compat re-exports (the key helpers moved to util.js in M8).
export { transcriptionKey, isLocalEndpoint };

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

export function isTranscriptionConfigured(cfg = {}) {
  if (cfg.enabled === false) return false;
  if (cfg.engine === 'whisper-cpp') {
    const w = cfg.whisperCpp || {};
    return !!(w.model && (w.bin || true));
  }
  return !!transcriptionKey(cfg) || isLocalEndpoint(cfg);
}

// Local whisper.cpp path: ffmpeg to 16k mono WAV, then whisper-cli.
async function transcribeWhisperCpp(filePath, cfg = {}) {
  const w = cfg.whisperCpp || {};
  const bin = w.bin || 'whisper-cli';
  const ffmpeg = w.ffmpeg || 'ffmpeg';
  const model = w.model;
  if (!model) throw new Error('whisper-cpp model is not configured (voice.whisperCpp.model)');
  const wav = path.join(os.tmpdir(), `aside-remote-${Date.now()}-${Math.random().toString(36).slice(2)}.wav`);
  const run = (cmd, args) => new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: cfg.timeoutMs ?? 120000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${path.basename(cmd)} failed: ${(err.message || '').split('\n')[0]}`));
      else resolve({ stdout: String(stdout), stderr: String(stderr) });
    });
  });
  try {
    await run(ffmpeg, ['-i', filePath, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', wav]);
    const r = await run(bin, ['-m', model, '-f', wav, '-nt', '-np', ...(w.extraArgs || [])]);
    return r.stdout.trim();
  } finally {
    await fs.promises.rm(wav, { force: true }).catch(() => {});
  }
}

// Transcribe an audio/video file to text. Returns '' when the endpoint heard
// nothing (silence, or a note the user recorded by accident).
export async function transcribe(filePath, cfg = {}, mimeType) {
  if (cfg.engine === 'whisper-cpp') return transcribeWhisperCpp(filePath, cfg);
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
