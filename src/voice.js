// ElevenLabs text-to-speech for voice mode (see agent.voice in config.js).
// Zero-dependency: plain https, resolves to the audio as a Buffer. MP3 is
// requested because every ElevenLabs plan can produce it and Telegram voice
// notes accept it directly, so no transcoding step is needed.
import https from 'node:https';

export function synthesizeVoice({ apiKey, voiceId, modelId, text, timeoutMs = 60000 }) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ text, model_id: modelId });
    const req = https.request({
      method: 'POST',
      hostname: 'api.elevenlabs.io',
      path: `/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_44100_128`,
      headers: {
        'xi-api-key': apiKey,
        'Content-Type': 'application/json',
        Accept: 'audio/mpeg',
        'Content-Length': Buffer.byteLength(payload),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (d) => chunks.push(d));
      res.on('end', () => {
        const body = Buffer.concat(chunks);
        if (res.statusCode >= 200 && res.statusCode < 300) return resolve(body);
        // Error bodies are JSON ({"detail":{"status","message"}}); surface the message.
        let detail = body.toString('utf8').slice(0, 300);
        try { const d = JSON.parse(detail).detail; detail = d?.message || d?.status || detail; } catch {}
        reject(new Error(`ElevenLabs TTS ${res.statusCode}: ${detail}`));
      });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`ElevenLabs TTS timed out after ${timeoutMs}ms`)));
    req.write(payload);
    req.end();
  });
}
