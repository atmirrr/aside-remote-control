// M8: TTS voice-out and whisper.cpp local STT.
import test from 'node:test';
import { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { makeBridge, waitFor } from './helpers.mjs';
import { stripMarkdown, capSpoken, transcriptionKey, isLocalEndpoint } from '../src/util.js';
import { speak } from '../src/tts.js';
import { transcribe, isTranscriptionConfigured } from '../src/transcribe.js';
import { HOME } from '../src/config.js';

beforeEach(() => {
  writeFileSync(path.join(HOME, 'settings.json'), '{}');
  writeFileSync(path.join(HOME, 'history.json'), '{}');
  writeFileSync(path.join(HOME, 'sessions.json'), '{}');
});

const sentHas = (ch, re) => ch.sent.some((s) => re.test(String(s.text)));

// ---- text helpers ----
test('stripMarkdown and capSpoken', () => {
  assert.equal(stripMarkdown('**bold** and *ital* and `code` and [link](https://x.y)'), 'bold and ital and code and link');
  assert.equal(capSpoken('short text', 1000), 'short text');
  const long = 'First sentence. Second sentence here. Third one too.';
  assert.equal(capSpoken(long, 30), 'First sentence.', 'cuts at a sentence boundary');
  assert.equal(capSpoken('no punctuation anywhere', 10), 'no punctua', 'no boundary found: hard cut');
});

test('key/local helpers moved to util (back-compat re-export)', () => {
  assert.equal(transcriptionKey({ apiKey: 'k' }), 'k');
  assert.equal(transcriptionKey({ apiKeyEnv: 'M8_TEST_KEY', apiKey: null }), process.env.M8_TEST_KEY ?? null);
  assert.equal(isLocalEndpoint({ baseUrl: 'http://127.0.0.1:8000/v1' }), true);
  assert.equal(isLocalEndpoint({ baseUrl: 'http://localhost:9/v1' }), true);
  assert.equal(isLocalEndpoint({ baseUrl: 'https://api.openai.com/v1' }), false);
});

// ---- TTS over HTTP ----
function startTtsServer() {
  return new Promise((resolve) => {
    const seen = [];
    const srv = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        seen.push({ url: req.url, auth: req.headers.authorization || null, body: JSON.parse(body || '{}') });
        res.writeHead(200, { 'content-type': 'audio/ogg' });
        res.end(Buffer.from([0x4f, 0x67, 0x67, 0x53]));
      });
    });
    srv.listen(0, '127.0.0.1', () => resolve({ srv, seen, port: srv.address().port }));
  });
}

test('speak() posts to /audio/speech and returns the opus bytes', async () => {
  const { srv, seen, port } = await startTtsServer();
  try {
    const buf = await speak('hello there', { baseUrl: `http://127.0.0.1:${port}/v1`, model: 'tts-1', voice: 'alloy' });
    assert.deepEqual([...buf], [0x4f, 0x67, 0x67, 0x53]);
    const req = seen[0];
    assert.equal(req.url, '/v1/audio/speech');
    assert.deepEqual(req.body, { model: 'tts-1', voice: 'alloy', input: 'hello there', response_format: 'opus' });
    assert.equal(req.auth, null, 'loopback needs no Authorization header');
  } finally {
    srv.close();
  }
});

test('speak() failure rejects and the caller treats it as a warning', async () => {
  await assert.rejects(() => speak('x', { baseUrl: 'http://127.0.0.1:1/v1', timeoutMs: 500 }));
});

// ---- /voice + bridge wiring ----
test('/voice on makes the bridge speak the answer (text still sent in full)', async () => {
  const { bridge, channel } = makeBridge({ fakeAside: { lines: ['Answer: **hello** world'] }, agent: { context: false } });
  bridge.config.tts = { enabled: true, baseUrl: 'http://127.0.0.1:1/v1', model: 'tts-1', voice: 'alloy', maxChars: 1500 };
  bridge.speak = async () => Buffer.from([0x4f, 0x67, 0x67, 0x53]);
  await bridge.handleMessage(channel, { chatId: 1, text: '/voice on', from: 'u' });
  assert.ok(sentHas(channel, /Voice replies on/));
  await bridge.handleMessage(channel, { chatId: 1, text: 'say hi', from: 'u' });
  assert.equal(channel.voices.length, 1, 'one voice note sent');
  assert.deepEqual([...channel.voices[0].buffer], [0x4f, 0x67, 0x67, 0x53]);
  assert.ok(sentHas(channel, /hello.*world/), 'text still sent in full');
});

test('/voice off (default) never speaks, and tts failure is only a warning', async () => {
  const a = makeBridge({ fakeAside: { lines: ['Answer: ok'] }, agent: { context: false } });
  a.bridge.config.tts = { enabled: true, baseUrl: 'http://127.0.0.1:1/v1' };
  a.bridge.speak = async () => Buffer.from('x');
  await a.bridge.handleMessage(a.channel, { chatId: 1, text: 'say hi', from: 'u' });
  assert.equal(a.channel.voices.length, 0, 'chat voice off by default');

  const b = makeBridge({ fakeAside: { lines: ['Answer: ok'] }, agent: { context: false } });
  b.bridge.config.tts = { enabled: true, baseUrl: 'http://127.0.0.1:1/v1' };
  b.bridge.speak = async () => { throw new Error('tts down'); };
  await b.bridge.handleMessage(b.channel, { chatId: 1, text: '/voice on', from: 'u' });
  await b.bridge.handleMessage(b.channel, { chatId: 1, text: 'say hi', from: 'u' });
  assert.ok(sentHas(b.channel, /ok/), 'text still delivered when tts fails');
  assert.equal(b.channel.voices.length, 0);
});

// ---- whisper.cpp STT ----
const FFMPEG = path.join(path.dirname(new URL(import.meta.url).pathname), 'fixtures', 'stub-ffmpeg.mjs');
const WHISPER = path.join(path.dirname(new URL(import.meta.url).pathname), 'fixtures', 'stub-whisper.mjs');

test('whisper-cpp engine: ffmpeg convert + whisper-cli, temp files removed', async () => {
  const inFile = path.join(HOME, 'note.ogg');
  writeFileSync(inFile, 'fake-ogg');
  const log = path.join(HOME, 'whisper-argv.log');
  process.env.STUB_WHISPER_LOGFILE = log;
  process.env.STUB_WHISPER_OUTPUT = 'the spoken words';
  const cfg = {
    engine: 'whisper-cpp',
    whisperCpp: { bin: WHISPER, model: '/tmp/model.bin', ffmpeg: FFMPEG, extraArgs: ['--no-timestamps'] },
    timeoutMs: 5000,
  };
  assert.equal(isTranscriptionConfigured(cfg), true);
  const text = await transcribe(inFile, cfg, 'audio/ogg');
  assert.equal(text, 'the spoken words');
  const argv = JSON.parse(readFileSync(log, 'utf8'));
  assert.ok(argv.includes('-m') && argv.includes('/tmp/model.bin'));
  assert.ok(argv.includes('-f'));
  assert.ok(argv.includes('-nt') && argv.includes('-np'));
  assert.ok(argv.includes('--no-timestamps'));
  const leftovers = readFileSync(path.join(HOME, 'note.ogg'), 'utf8') === 'fake-ogg';
  assert.ok(leftovers, 'input untouched');
  const wavs = await import('node:fs').then((fs) => fs.readdirSync(HOME).filter((f) => f.endsWith('.wav')));
  assert.deepEqual(wavs, [], 'temp wav removed');
  delete process.env.STUB_WHISPER_LOGFILE;
  delete process.env.STUB_WHISPER_OUTPUT;
});

test('whisper-cpp: unconfigured model and ffmpeg failures flow into the transcription error path', async () => {
  await assert.rejects(
    () => transcribe(path.join(HOME, 'nope.ogg'), { engine: 'whisper-cpp', whisperCpp: { bin: WHISPER, model: null, ffmpeg: FFMPEG } }, 'audio/ogg'),
    /model/,
  );
  process.env.STUB_FFMPEG_FAIL = '1';
  await assert.rejects(
    () => transcribe(path.join(HOME, 'nope2.ogg'), { engine: 'whisper-cpp', whisperCpp: { bin: WHISPER, model: '/tmp/m.bin', ffmpeg: FFMPEG }, timeoutMs: 5000 }, 'audio/ogg'),
    /ffmpeg|convert/i,
  );
  delete process.env.STUB_FFMPEG_FAIL;
});

test('isTranscriptionConfigured understands both engines', () => {
  assert.equal(isTranscriptionConfigured({ engine: 'http', baseUrl: 'http://127.0.0.1:1/v1' }), true);
  assert.equal(isTranscriptionConfigured({ engine: 'http', baseUrl: 'https://api.openai.com/v1' }), false, 'remote http engine needs a key');
  assert.equal(isTranscriptionConfigured({ engine: 'whisper-cpp', whisperCpp: { bin: 'x', model: null } }), false);
  assert.equal(isTranscriptionConfigured({ engine: 'whisper-cpp', whisperCpp: { bin: 'x', model: 'm' } }), true);
  assert.equal(isTranscriptionConfigured({ engine: 'whisper-cpp', enabled: false, whisperCpp: { bin: 'x', model: 'm' } }), false);
});
