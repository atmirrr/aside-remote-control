// In-process tests for incoming voice notes and file attachments.
//
// Nothing here touches the network: attachment download() is stubbed to write a
// local file, and the speech-to-text call is swapped out on the Bridge. The
// Telegram-specific tests exercise the pure message-parsing helpers only.
//
// Run with: ASIDE_REMOTE_HOME=$(mktemp -d) node --test test/
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';

import { Bridge } from '../src/bridge.js';
import { HOME, attachmentsDir } from '../src/config.js';
import { TelegramChannel } from '../src/channels/telegram.js';
import { formatBytes, sanitizeFilename, log, multipartPost } from '../src/util.js';
import { transcribe, isTranscriptionConfigured } from '../src/transcribe.js';

if (!process.env.ASIDE_REMOTE_HOME) throw new Error('Set ASIDE_REMOTE_HOME to a temp dir.');
fs.mkdirSync(HOME, { recursive: true });
const resetSessions = () => {
  fs.writeFileSync(path.join(HOME, 'sessions.json'), '{}');
  fs.writeFileSync(path.join(HOME, 'history.json'), '{}');
};

const ok = (text) => ({ text, sessionId: null, code: 0, error: false, sessionMissing: false });

function makeChannel(authorized = ['1']) {
  return {
    id: 'test-chan',
    sentText: [], typings: 0, images: [],
    isAuthorized(chatId) { return authorized.includes(String(chatId)); },
    async sendText(_chatId, t) { this.sentText.push(t); },
    async sendTyping() { this.typings++; },
    async sendImage(_chatId, p) { this.images.push(p); },
  };
}

function makeBridge(runHandler, config = {}) {
  const bridge = new Bridge({ agent: { command: 'unused' }, channels: [], ...config });
  bridge.agent = { run: runHandler };
  return bridge;
}

// A stub attachment: download() writes real bytes to the real destination dir,
// so path/cleanup assertions are meaningful, but no HTTP happens.
function fakeAttachment(kind, name, { contents = 'bytes', mimeType } = {}) {
  return {
    kind, name, mimeType,
    size: contents.length,
    downloads: 0,
    path: null,
    async download(dir, prefix) {
      this.downloads++;
      fs.mkdirSync(dir, { recursive: true });
      this.path = path.join(dir, `${prefix}-${name}`);
      fs.writeFileSync(this.path, contents);
      return this.path;
    },
  };
}

// A key in config means "transcription is configured" without touching the env,
// so these tests behave the same whether or not the dev has OPENAI_API_KEY set.
const WITH_KEY = { voice: { apiKey: 'test-key' } };
const WITHOUT_KEY = { voice: { apiKeyEnv: 'ASIDE_REMOTE_NO_SUCH_ENV_VAR' } };

// =====================  voice notes  ========================================
test('a voice note is transcribed, echoed back, and drives the agent', async () => {
  resetSessions();
  let seenPrompt = null;
  const bridge = makeBridge(async ({ prompt }) => { seenPrompt = prompt; return ok('Opened it.'); }, WITH_KEY);
  bridge.transcribe = async () => 'open my email';

  const ch = makeChannel();
  const voice = fakeAttachment('voice', 'voice.oga', { mimeType: 'audio/ogg' });
  await bridge.handleMessage(ch, { chatId: '1', text: '', attachments: [voice], messageId: 7, from: 'u' });

  assert.equal(seenPrompt, 'open my email'); // the transcript IS the prompt
  assert.ok(ch.sentText.some((t) => t.includes('open my email')), 'transcript should be echoed');
  assert.ok(ch.sentText.includes('Opened it.'));
});

test('the audio file is deleted once it has been transcribed', async () => {
  resetSessions();
  const bridge = makeBridge(async () => ok('done'), WITH_KEY);
  let audioPath = null;
  bridge.transcribe = async (p) => { audioPath = p; assert.ok(fs.existsSync(p)); return 'hello'; };

  const voice = fakeAttachment('voice', 'voice.oga');
  await bridge.handleMessage(makeChannel(), { chatId: '1', text: '', attachments: [voice], messageId: 1, from: 'u' });
  assert.equal(fs.existsSync(audioPath), false, 'voice recordings must not linger on disk');
});

test('the transcript is passed to the agent even when transcription is echoed off', async () => {
  resetSessions();
  let seenPrompt = null;
  const bridge = makeBridge(async ({ prompt }) => { seenPrompt = prompt; return ok('ok'); },
    { voice: { apiKey: 'k', echoTranscript: false } });
  bridge.transcribe = async () => 'do the thing';

  const ch = makeChannel();
  await bridge.handleMessage(ch, { chatId: '1', text: '', attachments: [fakeAttachment('voice', 'v.oga')], messageId: 2, from: 'u' });
  assert.equal(seenPrompt, 'do the thing');
  assert.ok(!ch.sentText.some((t) => t.startsWith('🎙️')), 'echo should be suppressed');
});

test('a voice note with no speech-to-text key returns a setup hint and never runs the agent', async () => {
  resetSessions();
  let called = 0;
  const bridge = makeBridge(async () => { called++; return ok('x'); }, WITHOUT_KEY);

  const ch = makeChannel();
  const voice = fakeAttachment('voice', 'voice.oga');
  await bridge.handleMessage(ch, { chatId: '1', text: '', attachments: [voice], messageId: 3, from: 'u' });

  assert.equal(called, 0);
  assert.equal(voice.downloads, 0, 'must not download audio it cannot read');
  assert.match(ch.sentText.join('\n'), /no speech-to-text endpoint is configured/i);
  assert.match(ch.sentText.join('\n'), /local whisper server/i, 'the hint should offer the keyless local option');
});

test('a failing transcription reports the reason and never runs the agent', async () => {
  resetSessions();
  let called = 0;
  const bridge = makeBridge(async () => { called++; return ok('x'); }, WITH_KEY);
  bridge.transcribe = async () => { throw new Error('Invalid API key'); };

  const ch = makeChannel();
  await bridge.handleMessage(ch, { chatId: '1', text: '', attachments: [fakeAttachment('voice', 'v.oga')], messageId: 4, from: 'u' });
  assert.equal(called, 0);
  assert.match(ch.sentText.join('\n'), /Couldn't transcribe.*Invalid API key/is);
});

test('silence transcribes to nothing and says so instead of running an empty task', async () => {
  resetSessions();
  let called = 0;
  const bridge = makeBridge(async () => { called++; return ok('x'); }, WITH_KEY);
  bridge.transcribe = async () => '';

  const ch = makeChannel();
  await bridge.handleMessage(ch, { chatId: '1', text: '', attachments: [fakeAttachment('voice', 'v.oga')], messageId: 5, from: 'u' });
  assert.equal(called, 0);
  assert.match(ch.sentText.join('\n'), /couldn't make out any speech/i);
});

test('a voice turn stores its transcript in history, so follow-ups resolve', async () => {
  resetSessions();
  const prompts = [];
  const bridge = makeBridge(async ({ prompt }) => { prompts.push(prompt); return ok('Berlin'); }, WITH_KEY);
  bridge.transcribe = async () => 'capital of Germany?';

  const ch = makeChannel();
  await bridge.handleMessage(ch, { chatId: '1', text: '', attachments: [fakeAttachment('voice', 'v.oga')], messageId: 6, from: 'u' });
  await bridge.handleMessage(ch, { chatId: '1', text: 'and France?', from: 'u' });

  assert.ok(prompts[1].includes('capital of Germany?'), 'the spoken turn should replay as context');
  assert.ok(prompts[1].includes('Berlin'));
});

// =====================  file attachments  ===================================
test('an attached file is downloaded and its path handed to the agent', async () => {
  resetSessions();
  let seenPrompt = null;
  const bridge = makeBridge(async ({ prompt }) => { seenPrompt = prompt; return ok('A receipt.'); });

  const ch = makeChannel();
  const doc = fakeAttachment('document', 'receipt.pdf', { contents: '%PDF-1.4', mimeType: 'application/pdf' });
  await bridge.handleMessage(ch, { chatId: '1', text: 'what is this?', attachments: [doc], messageId: 9, from: 'u' });

  assert.ok(seenPrompt.includes('what is this?'), 'the caption is the user message');
  assert.ok(seenPrompt.includes(doc.path), 'the agent needs the local path');
  assert.ok(seenPrompt.includes('application/pdf'));
  assert.ok(fs.existsSync(doc.path), 'non-audio files stay on disk for the agent to open');
});

test('files land under the chat-scoped attachments dir', async () => {
  resetSessions();
  const bridge = makeBridge(async () => ok('ok'));
  const doc = fakeAttachment('document', 'a.txt');
  await bridge.handleMessage(makeChannel(), { chatId: '1', text: '', attachments: [doc], messageId: 11, from: 'u' });
  assert.equal(path.dirname(doc.path), attachmentsDir('test-chan', '1'));
});

// The agent has to be able to READ these files. Aside blocks reads outside its
// permitted folders behind a desktop approval, so operators need to relocate the
// download dir to somewhere it already trusts. Found during a live test.
test('attachments.dir relocates downloads, expanding a leading ~', async () => {
  resetSessions();
  const custom = path.join(HOME, 'custom-inbox');
  const bridge = makeBridge(async () => ok('ok'), { attachments: { dir: custom } });
  const doc = fakeAttachment('document', 'a.txt');
  await bridge.handleMessage(makeChannel(), { chatId: '1', text: '', attachments: [doc], messageId: 30, from: 'u' });
  assert.equal(path.dirname(doc.path), path.join(custom, 'test-chan', '1'));

  assert.equal(attachmentsDir('c', '2', '~/somewhere'), path.join(os.homedir(), 'somewhere', 'c', '2'));
  assert.equal(attachmentsDir('c', '2'), path.join(HOME, 'attachments', 'c', '2')); // default
});

test('a stall on a task with files points at the read-permission fix, not the generic note', async () => {
  resetSessions();
  const genericNote = "[aside-remote] The agent went silent for 120s and looks stuck — most likely it hit a local approval.";
  const bridge = makeBridge(async () => ({
    text: genericNote, raw: 'read_file(...)', sessionId: null, code: -3, error: true, stalled: true, sessionMissing: false,
  }));
  const ch = makeChannel();
  const doc = fakeAttachment('document', 'a.txt');
  await bridge.handleMessage(ch, { chatId: '1', text: 'read it', attachments: [doc], messageId: 31, from: 'u' });

  const joined = ch.sentText.join('\n');
  assert.ok(joined.includes('went silent'), 'the original stall note survives');
  assert.ok(joined.includes('needs read access to'), 'and the attachment-specific cause is named');
  assert.ok(joined.includes(path.dirname(doc.path)), 'naming the actual directory');
});

test('a stall on a task with no files keeps the generic note only', async () => {
  resetSessions();
  const bridge = makeBridge(async () => ({
    text: 'went silent', raw: '', sessionId: null, code: -3, error: true, stalled: true, sessionMissing: false,
  }));
  const ch = makeChannel();
  await bridge.handleMessage(ch, { chatId: '1', text: 'remember my name', from: 'u' });
  assert.ok(!ch.sentText.join('\n').includes('needs read access'), 'no attachments, no attachment advice');
});

test('a file with no caption still produces a usable prompt', async () => {
  resetSessions();
  let seenPrompt = null;
  const bridge = makeBridge(async ({ prompt }) => { seenPrompt = prompt; return ok('ok'); });
  const doc = fakeAttachment('photo', 'photo.jpg', { mimeType: 'image/jpeg' });
  await bridge.handleMessage(makeChannel(), { chatId: '1', text: '', attachments: [doc], messageId: 12, from: 'u' });
  assert.match(seenPrompt, /no message/i);
  assert.ok(seenPrompt.includes(doc.path));
});

test('several files from one album arrive as a single task', async () => {
  resetSessions();
  let runs = 0;
  let seenPrompt = null;
  const bridge = makeBridge(async ({ prompt }) => { runs++; seenPrompt = prompt; return ok('Two cats.'); });
  const a = fakeAttachment('photo', 'one.jpg', { mimeType: 'image/jpeg' });
  const b = fakeAttachment('photo', 'two.jpg', { mimeType: 'image/jpeg' });
  await bridge.handleMessage(makeChannel(), { chatId: '1', text: 'compare these', attachments: [a, b], messageId: 13, from: 'u' });

  assert.equal(runs, 1);
  assert.ok(seenPrompt.includes(a.path) && seenPrompt.includes(b.path));
});

test('a caption and a voice note in one message are both passed through', async () => {
  resetSessions();
  let seenPrompt = null;
  const bridge = makeBridge(async ({ prompt }) => { seenPrompt = prompt; return ok('ok'); }, WITH_KEY);
  bridge.transcribe = async () => 'and summarize it';
  const audio = fakeAttachment('audio', 'note.mp3', { mimeType: 'audio/mpeg' });
  await bridge.handleMessage(makeChannel(), { chatId: '1', text: 'read this', attachments: [audio], messageId: 14, from: 'u' });
  assert.ok(seenPrompt.includes('read this'));
  assert.ok(seenPrompt.includes('and summarize it'));
});

test('a failed download is reported and the agent never runs', async () => {
  resetSessions();
  let called = 0;
  const bridge = makeBridge(async () => { called++; return ok('x'); });
  const doc = fakeAttachment('document', 'big.zip');
  doc.download = async () => { throw new Error('File is larger than 20.0 MB'); };

  const ch = makeChannel();
  await bridge.handleMessage(ch, { chatId: '1', text: '', attachments: [doc], messageId: 15, from: 'u' });
  assert.equal(called, 0);
  assert.match(ch.sentText.join('\n'), /Couldn't download.*larger than/is);
});

test('attachments:{enabled:false} refuses files without downloading them', async () => {
  resetSessions();
  const bridge = makeBridge(async () => ok('x'), { attachments: { enabled: false } });
  const ch = makeChannel();
  const doc = fakeAttachment('document', 'a.txt');
  await bridge.handleMessage(ch, { chatId: '1', text: '', attachments: [doc], messageId: 16, from: 'u' });
  assert.equal(doc.downloads, 0);
  assert.match(ch.sentText.join('\n'), /file attachments are disabled/i);
});

test('voice:{enabled:false} refuses voice without downloading it', async () => {
  resetSessions();
  const bridge = makeBridge(async () => ok('x'), { voice: { enabled: false, apiKey: 'k' } });
  const ch = makeChannel();
  const voice = fakeAttachment('voice', 'v.oga');
  await bridge.handleMessage(ch, { chatId: '1', text: '', attachments: [voice], messageId: 19, from: 'u' });
  assert.equal(voice.downloads, 0);
  assert.match(ch.sentText.join('\n'), /voice messages are disabled/i);
});

// The two switches gate different things: turning off file attachments should
// not silently take voice down with it.
test('the voice and file killswitches are independent', async () => {
  resetSessions();
  let seenPrompt = null;
  const bridge = makeBridge(async ({ prompt }) => { seenPrompt = prompt; return ok('ok'); },
    { attachments: { enabled: false }, voice: { apiKey: 'k' } });
  bridge.transcribe = async () => 'still listening';
  await bridge.handleMessage(makeChannel(), { chatId: '1', text: '', attachments: [fakeAttachment('voice', 'v.oga')], messageId: 20, from: 'u' });
  assert.equal(seenPrompt, 'still listening');
});

// =====================  authorization  ======================================
test('an unauthorized chat never causes an attachment download', async () => {
  resetSessions();
  let called = 0;
  const bridge = makeBridge(async () => { called++; return ok('x'); }, WITH_KEY);
  bridge.transcribe = async () => 'secret plans';

  const ch = makeChannel(['1']); // 999 is not allowed
  const voice = fakeAttachment('voice', 'v.oga');
  await bridge.handleMessage(ch, { chatId: '999', text: '', attachments: [voice], messageId: 17, from: 'mallory' });

  assert.equal(called, 0);
  assert.equal(voice.downloads, 0, 'an unauthorized sender must not get bytes written to our disk');
  assert.match(ch.sentText.join('\n'), /not authorized/i);
});

// =====================  commands vs captions  ===============================
test('a caption that looks like a command is treated as a task, not a command', async () => {
  resetSessions();
  let called = 0;
  const bridge = makeBridge(async () => { called++; return ok('ok'); });
  const ch = makeChannel();
  await bridge.handleMessage(ch, { chatId: '1', text: '/new', attachments: [fakeAttachment('photo', 'p.jpg')], messageId: 18, from: 'u' });
  assert.equal(called, 1, 'a photo captioned "/new" is a task about the photo');
  assert.ok(!ch.sentText.join('\n').includes('fresh session'));
});

test('/help still works when a message carries no attachments', async () => {
  resetSessions();
  const bridge = makeBridge(async () => ok('x'));
  const ch = makeChannel();
  await bridge.handleMessage(ch, { chatId: '1', text: '/help', from: 'u' });
  assert.match(ch.sentText.join('\n'), /voice note/i);
});

// =====================  Telegram message parsing  ===========================
const tg = () => new TelegramChannel({ id: 'tg', token: 'x', label: 'tg' });

test('attachmentsOf: a voice note is recognized', () => {
  const [a] = tg().attachmentsOf({ voice: { file_id: 'f1', file_size: 900, duration: 3, mime_type: 'audio/ogg' } });
  assert.equal(a.kind, 'voice');
  assert.equal(a.fileId, 'f1');
  assert.equal(a.durationSec, 3);
  assert.equal(typeof a.download, 'function');
});

test('attachmentsOf: the largest photo size is chosen', () => {
  const [a] = tg().attachmentsOf({
    photo: [
      { file_id: 'small', file_size: 100 },
      { file_id: 'medium', file_size: 5000 },
      { file_id: 'large', file_size: 90000 },
    ],
  });
  assert.equal(a.kind, 'photo');
  assert.equal(a.fileId, 'large');
  assert.equal(a.mimeType, 'image/jpeg');
});

test('attachmentsOf: a document keeps its name and mime type', () => {
  const [a] = tg().attachmentsOf({ document: { file_id: 'd', file_name: 'report.pdf', mime_type: 'application/pdf', file_size: 12 } });
  assert.equal(a.kind, 'document');
  assert.equal(a.name, 'report.pdf');
  assert.equal(a.mimeType, 'application/pdf');
});

test('attachmentsOf: a plain text message has no attachments', () => {
  assert.deepEqual(tg().attachmentsOf({ text: 'hello' }), []);
});

test('attachmentsOf: stickers and other unsupported media are ignored', () => {
  assert.deepEqual(tg().attachmentsOf({ sticker: { file_id: 's' } }), []);
});

test('bufferAlbum: album parts merge into one message with one caption', async () => {
  const channel = tg();
  const received = [];
  const onMessage = async (m) => { received.push(m); };
  const part = (id, caption) => ({
    chat: { id: 5 }, message_id: id, media_group_id: 'g1', from: { username: 'u' },
    photo: [{ file_id: `p${id}`, file_size: 10 }],
    ...(caption ? { caption } : {}),
  });

  channel.bufferAlbum(part(1, 'look at these'), 'look at these', channel.attachmentsOf(part(1)), onMessage);
  channel.bufferAlbum(part(2), '', channel.attachmentsOf(part(2)), onMessage);
  assert.equal(received.length, 0, 'nothing is emitted while the album is still arriving');

  await new Promise((r) => setTimeout(r, 1800)); // past MEDIA_GROUP_WINDOW_MS
  assert.equal(received.length, 1, 'the album emits exactly one message');
  assert.equal(received[0].attachments.length, 2);
  assert.equal(received[0].text, 'look at these');
  assert.equal(received[0].chatId, 5);
});

// A second bridge on the same token starves this one (Telegram gives each update
// to exactly one getUpdates caller). Found the hard way during a live test: the
// bot looked simply dead. The failure must be visible in the log.
test('a getUpdates conflict is reported, once, instead of retried in silence', async () => {
  const channel = tg();
  const controller = new AbortController();
  const warnings = [];
  const realWarn = log.warn;
  log.warn = (s) => warnings.push(s);

  let polls = 0;
  channel.call = async (method) => {
    if (method !== 'getUpdates') return { ok: true, result: [] };
    if (++polls >= 2) controller.abort(); // drain + one real poll, then stop
    return { ok: false, description: 'Conflict: terminated by other getUpdates request; make sure that only one bot instance is running' };
  };

  try {
    await channel.start({ onMessage: async () => {}, signal: controller.signal });
  } finally {
    log.warn = realWarn;
  }

  assert.ok(warnings.some((w) => /Conflict: terminated by other getUpdates/.test(w)), 'the real reason must be logged');
  assert.ok(warnings.some((w) => /another process is polling this bot token/.test(w)), 'and what to do about it');
  assert.equal(warnings.filter((w) => /getUpdates rejected/.test(w)).length, 1, 'the same error must not spam every retry');
});

// =====================  util helpers  =======================================
test('sanitizeFilename: strips directory traversal and unsafe characters', () => {
  assert.equal(sanitizeFilename('../../.ssh/authorized_keys'), 'authorized_keys');
  assert.equal(sanitizeFilename('my file (1).pdf'), 'my_file_1_.pdf');
  assert.equal(sanitizeFilename('/etc/passwd'), 'passwd');
  assert.equal(sanitizeFilename(''), 'file');
  assert.equal(sanitizeFilename('...'), 'file');
});

test('sanitizeFilename: a CRLF in a name cannot forge MIME headers', () => {
  const name = 'a.png"\r\nContent-Type: text/html\r\n\r\n<script>';
  const safe = sanitizeFilename(name);
  assert.ok(!/[\r\n"]/.test(safe), `still injectable: ${JSON.stringify(safe)}`);
});

test('formatBytes: renders human sizes and tolerates unknowns', () => {
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(2048), '2.0 KB');
  assert.equal(formatBytes(20 * 1024 * 1024), '20 MB');
  assert.equal(formatBytes(undefined), 'unknown size');
});

// =====================  local (self-hosted) whisper  ========================
// A whisper server on loopback needs no TLS and no API key. Anything else does.
test('a loopback baseUrl counts as configured without any API key', () => {
  assert.equal(isTranscriptionConfigured({ baseUrl: 'http://127.0.0.1:8000/v1' }), true);
  assert.equal(isTranscriptionConfigured({ baseUrl: 'http://localhost:8000/v1' }), true);
  assert.equal(isTranscriptionConfigured({ baseUrl: 'http://localhost:8000/v1', enabled: false }), false);
});

test('a remote baseUrl still demands a key', () => {
  assert.equal(isTranscriptionConfigured({ baseUrl: 'https://api.openai.com/v1', apiKeyEnv: 'ASIDE_REMOTE_NO_SUCH_ENV_VAR' }), false);
  assert.equal(isTranscriptionConfigured({ baseUrl: 'https://api.groq.com/openai/v1', apiKey: 'k' }), true);
});

test('multipartPost refuses to send credentials over plain http to a remote host', async () => {
  await assert.rejects(
    () => multipartPost('http://evil.example.com/v1/audio/transcriptions', { fields: {}, files: [] }),
    /refusing to POST credentials over plain http/,
  );
});

test('transcribe works against a plain-http loopback whisper, with no key and no TLS', async () => {
  const seen = {};
  const srv = http.createServer((req, res) => {
    seen.auth = req.headers.authorization;
    seen.ctype = req.headers['content-type'];
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ text: '  hello from localhost  ' }));
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;

  const audio = path.join(HOME, 'probe.ogg');
  fs.writeFileSync(audio, Buffer.from('OggS-probe'));
  const text = await transcribe(audio, { baseUrl: `http://127.0.0.1:${port}/v1`, model: 'tiny.en' }, 'audio/ogg');
  srv.close();

  assert.equal(text, 'hello from localhost');
  assert.equal(seen.auth, undefined, 'no Authorization header when there is no key');
  assert.match(seen.ctype, /^multipart\/form-data; boundary=/);
});
