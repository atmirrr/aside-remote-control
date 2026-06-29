// In-process tests for live streaming (edit-message-in-place).
// Run with: ASIDE_REMOTE_HOME=$(mktemp -d) node --test test/
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { Bridge } from '../src/bridge.js';
import { HOME } from '../src/config.js';
import { sleep } from '../src/util.js';

if (!process.env.ASIDE_REMOTE_HOME) throw new Error('Set ASIDE_REMOTE_HOME to a temp dir.');
fs.mkdirSync(HOME, { recursive: true });
const resetSessions = () => {
  fs.writeFileSync(path.join(HOME, 'sessions.json'), '{}');
  fs.writeFileSync(path.join(HOME, 'history.json'), '{}');
};

const ok = (text) => ({ text, sessionId: null, code: 0, error: false, sessionMissing: false });

// Channel that supports editing (streaming-capable).
function streamChannel() {
  return {
    id: 'test-chan',
    sentText: [], edits: [], typings: 0, images: [], _mid: 1000,
    isAuthorized: () => true,
    async sendText(_c, t) { this.sentText.push(t); return ++this._mid; },
    async editText(_c, _mid, t) { this.edits.push(t); return true; },
    async sendTyping() { this.typings++; },
    async sendImage(_c, p) { this.images.push(p); },
  };
}

// Channel with no editText -> streaming must fall back to a final sendText.
function plainChannel() {
  return {
    id: 'test-chan',
    sentText: [], typings: 0, images: [],
    isAuthorized: () => true,
    async sendText(_c, t) { this.sentText.push(t); }, // returns undefined (no id)
    async sendTyping() { this.typings++; },
    async sendImage() {},
  };
}

function makeBridge(runHandler, agent = {}) {
  const bridge = new Bridge({ agent: { command: 'unused', stream: true, streamThrottleMs: 5, ...agent }, channels: [] });
  bridge.agent = { run: runHandler };
  return bridge;
}

// Agent that emits onData chunks with delays (so the throttle fires between them).
function streamingRun(chunks, finalText, gap = 30) {
  return async ({ onData }) => {
    for (const c of chunks) { onData?.(c); await sleep(gap); }
    return ok(finalText);
  };
}

test('streaming edits one message progressively and lands the final result there', async () => {
  resetSessions();
  const ch = streamChannel();
  const bridge = makeBridge(streamingRun(['working step one\n', 'working step two\n'], 'Final answer: 42'));
  await bridge.handleMessage(ch, { chatId: '1', text: 'do it', from: 'u' });

  // Only the placeholder was *sent*; the result arrived via edits, not a new message.
  assert.deepEqual(ch.sentText, ['🧠 Thinking...']);
  assert.ok(ch.edits.length >= 2, `expected progressive edits, got ${ch.edits.length}`);
  assert.equal(ch.edits.at(-1), 'Final answer: 42'); // final landed in the edited message
  // Edits are monotonic progress: an intermediate edit showed partial output.
  assert.ok(ch.edits.slice(0, -1).some((e) => /working step/.test(e)));
});

test('streaming falls back to a single final message when the channel cannot edit', async () => {
  resetSessions();
  const ch = plainChannel();
  const bridge = makeBridge(streamingRun(['partial\n'], 'the answer'));
  await bridge.handleMessage(ch, { chatId: '1', text: 'go', from: 'u' });
  assert.deepEqual(ch.sentText, ['🧠 Thinking...', 'the answer']);
});

test('stream:false disables streaming even on an edit-capable channel', async () => {
  resetSessions();
  const ch = streamChannel();
  const bridge = makeBridge(streamingRun(['partial\n'], 'done'), { stream: false });
  await bridge.handleMessage(ch, { chatId: '1', text: 'go', from: 'u' });
  assert.equal(ch.edits.length, 0);
  assert.deepEqual(ch.sentText, ['🧠 Thinking...', 'done']);
});

test('long streamed output: first chunk edits the message, overflow is sent as follow-ups', async () => {
  resetSessions();
  const ch = streamChannel();
  const finalText = 'A'.repeat(3000) + '\n' + 'B'.repeat(3000); // > 3900 -> 2 chunks
  const bridge = makeBridge(streamingRun(['…\n'], finalText));
  await bridge.handleMessage(ch, { chatId: '1', text: 'go', from: 'u' });
  // First chunk landed via edit; the remainder went out as a normal message.
  assert.ok(ch.edits.at(-1).startsWith('A'));
  assert.ok(ch.sentText.length >= 2, 'overflow chunk should be a follow-up message');
  assert.ok(ch.sentText.at(-1).startsWith('B'));
});

test('streaming still attaches image artifacts from the final output', async () => {
  resetSessions();
  const ch = streamChannel();
  const bridge = makeBridge(streamingRun(['rendering\n'], 'saved to /tmp/out.png'));
  await bridge.handleMessage(ch, { chatId: '1', text: 'screenshot', from: 'u' });
  assert.deepEqual(ch.images, ['/tmp/out.png']);
});

test('a fast task with no streamed deltas still ends with the answer in the message', async () => {
  resetSessions();
  const ch = streamChannel();
  // No onData chunks at all (agent answers instantly).
  const bridge = makeBridge(async () => ok('4'));
  await bridge.handleMessage(ch, { chatId: '1', text: 'what is 2+2', from: 'u' });
  assert.deepEqual(ch.sentText, ['🧠 Thinking...']);
  assert.equal(ch.edits.at(-1), '4');
});
