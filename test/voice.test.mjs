// Voice mode: with summary mode on and an ElevenLabs key set, the recap is
// spoken and delivered as a voice note that replaces the streamed transcript.
// Every failure path must fall back to the text recap.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { Bridge } from '../src/bridge.js';
import { HOME, loadConfig } from '../src/config.js';

if (!process.env.ASIDE_REMOTE_HOME) throw new Error('Set ASIDE_REMOTE_HOME to a temp dir.');
fs.mkdirSync(HOME, { recursive: true });
const resetState = () => {
  fs.writeFileSync(path.join(HOME, 'sessions.json'), '{}');
  fs.writeFileSync(path.join(HOME, 'history.json'), '{}');
};
// Tests control the key explicitly; a key in the developer's shell must not leak in.
delete process.env.ELEVENLABS_API_KEY;

const MARKER = '<<<SUMMARY>>>';
const RECAP = 'All done, two files changed.';
const REPLY = `did the work\n${MARKER}\n${RECAP}`;
const ok = (text) => ({ text, raw: text, sessionId: null, code: 0, error: false, sessionMissing: false });

function voiceChannel({ canDelete = true } = {}) {
  return {
    id: 'test-chan',
    sentText: [], sentOpts: [], edits: [], editOpts: [], voices: [], deleted: [], _mid: 1000,
    isAuthorized: () => true,
    async sendText(_c, t, opts) { this.sentText.push(t); this.sentOpts.push(opts || {}); return ++this._mid; },
    async editText(_c, _mid, t, opts) { this.edits.push(t); this.editOpts.push(opts || {}); return true; },
    async sendVoice(_c, buf, caption = '') { this.voices.push({ buf, caption }); return true; },
    async deleteMessage(_c, mid) { if (!canDelete) return false; this.deleted.push(mid); return true; },
    async sendTyping() {},
    async sendImage() {},
    async sendImages() {},
  };
}

function makeBridge(runHandler, agent = {}, synth) {
  const bridge = new Bridge({
    agent: {
      command: 'unused', stream: true, streamThrottleMs: 5,
      // summary is deliberately NOT set: voice:true must imply it on its own.
      summaryMarker: MARKER, summaryPrompt: loadConfig().agent.summaryPrompt,
      voice: true, voiceApiKey: 'test-key',
      ...agent,
    },
    channels: [],
  });
  bridge.agent = { run: runHandler };
  bridge.synthesize = synth || (async () => Buffer.from('fake-mp3'));
  return bridge;
}

test('the recap arrives as a voice note and the streamed transcript is deleted', async () => {
  resetState();
  const ch = voiceChannel();
  const spoken = [];
  let seenPrompt = '';
  const bridge = makeBridge(
    async ({ prompt }) => { seenPrompt = prompt; return ok(REPLY); },
    {},
    async ({ text }) => { spoken.push(text); return Buffer.from('fake-mp3'); },
  );
  await bridge.handleMessage(ch, { chatId: '1', text: 'go', from: 'u' });

  assert.ok(seenPrompt.includes(MARKER), 'voice alone must request the recap in the prompt');
  assert.deepEqual(spoken, [RECAP], 'only the recap is spoken, marker-free');
  assert.equal(ch.voices.length, 1);
  assert.deepEqual(ch.deleted, [1001], 'the streamed message is replaced by the voice note');
  assert.ok(!ch.edits.some((e) => e.includes(RECAP)), 'the recap must not also land as text');
  assert.deepEqual(ch.sentText, ['🧠 Thinking...'], 'no extra text messages');

  // Follow-ups still replay the full answer, not the spoken recap.
  await bridge.handleMessage(ch, { chatId: '1', text: 'and next', from: 'u' });
  assert.ok(seenPrompt.includes('did the work'), 'history keeps the full answer');
  assert.ok(!seenPrompt.includes(RECAP), 'history does not keep the recap');
});

test('the ELEVENLABS_API_KEY env var works when no key is in the config', async () => {
  resetState();
  const ch = voiceChannel();
  const keys = [];
  const bridge = makeBridge(async () => ok(REPLY), { voiceApiKey: null },
    async ({ apiKey }) => { keys.push(apiKey); return Buffer.from('x'); });
  process.env.ELEVENLABS_API_KEY = 'env-key';
  try {
    await bridge.handleMessage(ch, { chatId: '1', text: 'go', from: 'u' });
  } finally {
    delete process.env.ELEVENLABS_API_KEY;
  }
  assert.deepEqual(keys, ['env-key']);
  assert.equal(ch.voices.length, 1);
});

test('voice on but no key anywhere -> text recap, synthesis never attempted', async () => {
  resetState();
  const ch = voiceChannel();
  let calls = 0;
  const bridge = makeBridge(async () => ok(REPLY), { voiceApiKey: null },
    async () => { calls++; return Buffer.from('x'); });
  await bridge.handleMessage(ch, { chatId: '1', text: 'go', from: 'u' });
  assert.equal(calls, 0);
  assert.equal(ch.voices.length, 0);
  assert.equal(ch.edits.at(-1), RECAP);
});

test('voice: true implies summary mode even when summary is explicitly false', async () => {
  resetState();
  const ch = voiceChannel();
  const bridge = makeBridge(async () => ok(REPLY), { summary: false });
  await bridge.handleMessage(ch, { chatId: '1', text: 'go', from: 'u' });
  assert.equal(ch.voices.length, 1, 'voice needs the recap, so it wins');
  assert.deepEqual(ch.deleted, [1001]);
});

test('no recap in the reply -> no voice, full answer as text', async () => {
  resetState();
  const ch = voiceChannel();
  const bridge = makeBridge(async () => ok('plain answer, no marker'));
  await bridge.handleMessage(ch, { chatId: '1', text: 'go', from: 'u' });
  assert.equal(ch.voices.length, 0);
  assert.equal(ch.edits.at(-1), 'plain answer, no marker');
});

test('synthesis failure falls back to the text recap', async () => {
  resetState();
  const ch = voiceChannel();
  const bridge = makeBridge(async () => ok(REPLY), {},
    async () => { throw new Error('quota exceeded'); });
  await bridge.handleMessage(ch, { chatId: '1', text: 'go', from: 'u' });
  assert.equal(ch.voices.length, 0);
  assert.equal(ch.deleted.length, 0, 'the streamed message must survive a failed voice attempt');
  assert.equal(ch.edits.at(-1), RECAP);
});

test('a channel that cannot deliver the voice note falls back to the text recap', async () => {
  resetState();
  const ch = voiceChannel();
  ch.sendVoice = async () => false;
  const bridge = makeBridge(async () => ok(REPLY));
  await bridge.handleMessage(ch, { chatId: '1', text: 'go', from: 'u' });
  assert.equal(ch.deleted.length, 0);
  assert.equal(ch.edits.at(-1), RECAP);
});

test('when delete is refused, the recap text lands in the streamed message too', async () => {
  resetState();
  const ch = voiceChannel({ canDelete: false });
  const bridge = makeBridge(async () => ok(REPLY));
  await bridge.handleMessage(ch, { chatId: '1', text: 'go', from: 'u' });
  assert.equal(ch.voices.length, 1, 'the voice note still goes out');
  assert.equal(ch.edits.at(-1), RECAP, 'the message is not left showing a stale transcript');
});

test('/voice replies with the current state and a toggle button', async () => {
  resetState();
  const ch = voiceChannel();
  const bridge = makeBridge(async () => ok(REPLY));
  await bridge.handleMessage(ch, { chatId: '1', text: '/voice', from: 'u' });
  assert.match(ch.sentText.at(-1), /ON/);
  const buttons = ch.sentOpts.at(-1).buttons;
  assert.equal(buttons.length, 1);
  assert.equal(buttons[0].data, 'voice:toggle');
  assert.match(buttons[0].text, /ON/);
});

test('tapping the toggle flips voice mode, persists it, and updates the button', async () => {
  resetState();
  const ch = voiceChannel();
  const bridge = makeBridge(async () => ok(REPLY));
  await bridge.handleAction(ch, { chatId: '1', messageId: 7, data: 'voice:toggle', from: 'u' });

  assert.equal(bridge.config.agent.voice, false);
  const disk = JSON.parse(fs.readFileSync(path.join(HOME, 'config.json'), 'utf8'));
  assert.equal(disk.agent.voice, false, 'the flip must survive a restart');
  assert.match(ch.edits.at(-1), /OFF/);
  assert.match(ch.editOpts.at(-1).buttons[0].text, /OFF/);

  // ...and it actually takes effect: the next task gets no voice note.
  await bridge.handleMessage(ch, { chatId: '1', text: 'go', from: 'u' });
  assert.equal(ch.voices.length, 0);

  // Tap again: back on.
  await bridge.handleAction(ch, { chatId: '1', messageId: 7, data: 'voice:toggle', from: 'u' });
  assert.equal(bridge.config.agent.voice, true);
  assert.match(ch.edits.at(-1), /ON/);
});

test('actions from unauthorized chats are ignored', async () => {
  resetState();
  const ch = voiceChannel();
  ch.isAuthorized = () => false;
  const bridge = makeBridge(async () => ok(REPLY));
  await bridge.handleAction(ch, { chatId: '999', messageId: 7, data: 'voice:toggle', from: 'x' });
  assert.equal(bridge.config.agent.voice, true, 'state must not change');
  assert.equal(ch.edits.length, 0);
  assert.equal(ch.sentText.length, 0);
});

test('stream:false -> the voice note is the only reply', async () => {
  resetState();
  const ch = voiceChannel();
  const bridge = makeBridge(async () => ok(REPLY), { stream: false });
  await bridge.handleMessage(ch, { chatId: '1', text: 'go', from: 'u' });
  assert.equal(ch.voices.length, 1);
  assert.deepEqual(ch.sentText, ['🧠 Thinking...'], 'no text answer message');
  assert.equal(ch.edits.length, 0);
});
