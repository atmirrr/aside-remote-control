// Text-to-speech for outgoing replies: OpenAI-compatible /audio/speech.
import http from 'node:http';
import https from 'node:https';
import { transcriptionKey, isLocalEndpoint } from './util.js';

// Minimal request that returns the raw response body (JSON helpers can't:
// TTS payloads are audio bytes and local endpoints may be plain http).
function requestBuffer(urlStr, { method = 'GET', headers = {}, body, timeoutMs = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const mod = u.protocol === 'http:' ? http : https;
    const req = mod.request({
      method,
      hostname: u.hostname,
      port: u.port || (u.protocol === 'http:' ? 80 : 443),
      path: u.pathname + u.search,
      headers,
    }, (res) => {
      const chunks = [];
      res.on('data', (d) => chunks.push(d));
      res.on('end', () => resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, buffer: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`Request timed out after ${timeoutMs}ms`)));
    if (body != null) req.write(body);
    req.end();
  });
}

// Speak text, resolving with the audio buffer (opus). Throws on failure —
// callers treat TTS errors as warnings only.
export async function speak(text, cfg = {}) {
  const base = String(cfg.baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '');
  const key = transcriptionKey(cfg);
  const url = new URL(`${base}/audio/speech`);
  // Never put an API key on a cleartext non-loopback connection.
  const cleartextRemote = url.protocol === 'http:' && !isLocalEndpoint(cfg);
  const res = await requestBuffer(url.toString(), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(key && !cleartextRemote ? { Authorization: `Bearer ${key}` } : {}),
    },
    body: JSON.stringify({
      model: cfg.model || 'tts-1',
      voice: cfg.voice || 'alloy',
      input: String(text),
      response_format: 'opus',
    }),
    timeoutMs: cfg.timeoutMs ?? 120000,
  });
  if (!res.ok || !res.buffer.length) {
    let detail = `HTTP ${res.status}`;
    try {
      const parsed = JSON.parse(res.buffer.toString('utf8'));
      detail = parsed?.error?.message || detail;
    } catch { /* not JSON */ }
    throw new Error(String(detail).slice(0, 300));
  }
  return res.buffer;
}
