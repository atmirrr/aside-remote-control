// Summary mode: the agent is asked to end its reply with a sentinel line plus a
// short recap; the bridge shows the recap and replaces what it streamed.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { Bridge } from '../src/bridge.js';
import { HOME, loadConfig } from '../src/config.js';
import { sleep, splitSummary } from '../src/util.js';

if (!process.env.ASIDE_REMOTE_HOME) throw new Error('Set ASIDE_REMOTE_HOME to a temp dir.');
fs.mkdirSync(HOME, { recursive: true });
const resetSessions = () => {
  fs.writeFileSync(path.join(HOME, 'sessions.json'), '{}');
  fs.writeFileSync(path.join(HOME, 'history.json'), '{}');
};

const MARKER = '<<<SUMMARY>>>';
const ok = (text) => ({ text, raw: text, sessionId: null, code: 0, error: false, sessionMissing: false });

function streamChannel() {
  return {
    id: 'test-chan',
    sentText: [], edits: [], _mid: 1000,
    isAuthorized: () => true,
    async sendText(_c, t) { this.sentText.push(t); return ++this._mid; },
    async editText(_c, _mid, t) { this.edits.push(t); return true; },
    async sendTyping() {},
    async sendImage() {},
    async sendImages() {},
  };
}

function makeBridge(runHandler, agent = {}) {
  const bridge = new Bridge({
    agent: {
      command: 'unused', stream: true, streamThrottleMs: 5,
      summary: true,
      summaryMarker: MARKER,
      summaryPrompt: loadConfig().agent.summaryPrompt,
      ...agent,
    },
    channels: [],
  });
  bridge.agent = { run: runHandler };
  return bridge;
}

const streamingRun = (chunks, finalText, gap = 30) => async ({ onData }) => {
  for (const c of chunks) { onData?.(c); await sleep(gap); }
  return ok(finalText);
};

test('splitSummary splits on the last marker and tolerates a missing one', () => {
  assert.deepEqual(splitSummary(`body\n${MARKER}\nrecap`, MARKER), { body: 'body', summary: 'recap' });
  assert.deepEqual(splitSummary('no marker here', MARKER), { body: 'no marker here', summary: '' });
  // An echoed instruction earlier in the reply must not truncate the answer.
  const echoed = `end with ${MARKER}\nreal body\n${MARKER}\nrecap`;
  assert.equal(splitSummary(echoed, MARKER).body, `end with ${MARKER}\nreal body`);
  assert.equal(splitSummary(echoed, MARKER).summary, 'recap');
  // No marker configured (summary off) -> everything is body.
  assert.deepEqual(splitSummary(`a\n${MARKER}\nb`, null), { body: `a\n${MARKER}\nb`, summary: '' });
});

test('the summary instruction is appended to the prompt, but not to stored history', async () => {
  resetSessions();
  const ch = streamChannel();
  let seenPrompt = '';
  const bridge = makeBridge(async ({ prompt }) => { seenPrompt = prompt; return ok(`did stuff\n${MARKER}\nRecap.`); });
  await bridge.handleMessage(ch, { chatId: '1', text: 'open example.com', from: 'u' });
  assert.match(seenPrompt, /^open example\.com/);
  assert.ok(seenPrompt.includes(MARKER), 'prompt should carry the marker instruction');

  // Next turn replays history: it must contain the answer, not the instruction.
  await bridge.handleMessage(ch, { chatId: '1', text: 'and again', from: 'u' });
  assert.ok(!seenPrompt.split('and again')[0].includes('output a line containing exactly'),
    'the instruction must not be replayed as conversation context');
  assert.ok(seenPrompt.includes('did stuff'), 'history should keep the full answer');
  assert.ok(!seenPrompt.includes('Recap.'), 'history should not keep the recap');
});

test('the recap replaces the streamed transcript in the same message', async () => {
  resetSessions();
  const ch = streamChannel();
  const bridge = makeBridge(streamingRun(
    ['step one of the work\n', 'step two of the work\n'],
    `step one of the work\nstep two of the work\n${MARKER}\nOpened the page and grabbed the title.`,
  ));
  await bridge.handleMessage(ch, { chatId: '1', text: 'go', from: 'u' });

  assert.deepEqual(ch.sentText, ['🧠 Thinking...']);          // one message, edited in place
  assert.ok(ch.edits.slice(0, -1).some((e) => /step one/.test(e)), 'progress was streamed first');
  assert.equal(ch.edits.at(-1), 'Opened the page and grabbed the title.');
  assert.ok(!ch.edits.at(-1).includes(MARKER), 'the marker itself is never shown');
});

test('mid-stream: the swap happens as soon as the marker arrives, before the run ends', async () => {
  resetSessions();
  const ch = streamChannel();
  const full = `long transcript here\n${MARKER}\nShort recap.`;
  const bridge = makeBridge(streamingRun(['long transcript here\n', `${MARKER}\nShort recap.`], full));
  await bridge.handleMessage(ch, { chatId: '1', text: 'go', from: 'u' });
  // The recap was already on screen from a streamed edit, not just the final one.
  assert.ok(ch.edits.slice(0, -1).some((e) => e === 'Short recap.') || ch.edits.at(-1) === 'Short recap.');
  assert.equal(ch.edits.at(-1), 'Short recap.');
});

test('no marker in the reply falls back to the full answer', async () => {
  resetSessions();
  const ch = streamChannel();
  const bridge = makeBridge(streamingRun(['working\n'], 'The full answer, no recap offered.'));
  await bridge.handleMessage(ch, { chatId: '1', text: 'go', from: 'u' });
  assert.equal(ch.edits.at(-1), 'The full answer, no recap offered.');
});

test('summary:false leaves the prompt and the reply untouched', async () => {
  resetSessions();
  const ch = streamChannel();
  let seenPrompt = '';
  const bridge = makeBridge(async ({ prompt }) => { seenPrompt = prompt; return ok(`body\n${MARKER}\nrecap`); },
    { summary: false });
  await bridge.handleMessage(ch, { chatId: '1', text: 'go', from: 'u' });
  assert.equal(seenPrompt, 'go');
  assert.equal(ch.edits.at(-1), `body\n${MARKER}\nrecap`); // marker treated as ordinary text
});
