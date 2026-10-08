// Tests for the channel control surface: the slash-command operations as plain
// calls (Bridge.controlFor), the per-message routing report (onRouted), and the
// `notice` tag on bridge-generated messages.
//
// These exist for channels that cannot type "/stop" or tap a button and say
// things in their own words - a voice channel answers the request that carried
// an utterance, and speaks every message it is handed. Telegram keeps its exact
// behaviour; the slash commands now sit on top of the same calls.
//
//   ASIDE_REMOTE_HOME=$(mktemp -d) node --test test/control.test.mjs
//
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { Bridge } from '../src/bridge.js';
import { history, sessions, HOME } from '../src/config.js';

if (!process.env.ASIDE_REMOTE_HOME) {
  throw new Error('Set ASIDE_REMOTE_HOME to a temp dir before running these tests.');
}
fs.mkdirSync(HOME, { recursive: true });
function resetState() {
  fs.writeFileSync(path.join(HOME, 'sessions.json'), '{}');
  fs.writeFileSync(path.join(HOME, 'history.json'), '{}');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 3000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await sleep(5);
  }
  return false;
}

const SID = 'SESSIONabcdefgh1';
const aborted = { text: '[aside-remote] Task stopped on request.', raw: 'partial', sessionId: null, code: -4, error: true, aborted: true };

// Records every message with its opts, so notice tags can be checked.
function makeChannel(authorized = ['1', '2']) {
  return {
    id: 'test-chan',
    sent: [],                // { text, opts }
    get sentText() { return this.sent.map((m) => m.text); },
    nextId: 1,
    isAuthorized(chatId) { return authorized.includes(String(chatId)); },
    async sendText(_chatId, text, opts = {}) { this.sent.push({ text, opts }); return this.nextId++; },
    async deleteMessage() { return true; },
    async sendTyping() {},
    async sendImages() {},
  };
}

// Runs hang until released or aborted; a fresh run announces SID (after
// `announceDelayMs` if given), like the real CLI. steer() records its input.
function gatedAgent(rec, { announceDelayMs = 0, steerOk = true } = {}) {
  rec.runs = [];
  rec.steers = [];
  return {
    run: (opts) => new Promise((resolve) => {
      const run = {
        prompt: opts.prompt,
        sessionId: opts.sessionId,
        onStall: opts.onStall,
        release: (extra = {}) => resolve({ text: 'done', raw: 'done', code: 0, sessionId: opts.sessionId || SID, ...extra }),
      };
      rec.runs.push(run);
      if (!opts.sessionId) {
        if (announceDelayMs) setTimeout(() => opts.onSession?.(SID), announceDelayMs);
        else opts.onSession?.(SID);
      }
      if (opts.signal?.aborted) resolve(aborted);
      else opts.signal?.addEventListener('abort', () => resolve(aborted), { once: true });
    }),
    steer: async (id, text) => {
      rec.steers.push({ id, text });
      return steerOk
        ? { ok: true, out: 'ok  running', err: '', notFound: false }
        : { ok: false, out: '', err: 'refused', notFound: false };
    },
    sessionStatus: async (id) => (id === SID ? { id, status: 'running', title: 'Gyms in Almada' } : null),
  };
}

function makeBridge(rec, { agentOpts = {} } = {}) {
  const cfg = { agent: { command: 'unused', context: true, stream: false }, channels: [] };
  const bridge = new Bridge(cfg);
  bridge.agent = gatedAgent(rec, agentOpts);
  return bridge;
}

// handleMessage with an onRouted spy. Resolves { done, outcome } where `done`
// is the handleMessage promise (it settles only when the task does).
async function send(bridge, ch, text, chatId = '1') {
  let outcome;
  const done = bridge.handleMessage(ch, { chatId, text, from: 'u', onRouted: (o) => { outcome = o; } });
  await until(() => outcome !== undefined);
  return { done, outcome };
}

// ============  onRouted  ===================================================

test('onRouted: a first message reports started, synchronously', async () => {
  resetState();
  const ch = makeChannel();
  const rec = {};
  const bridge = makeBridge(rec);
  let outcome;
  const done = bridge.handleMessage(ch, { chatId: '1', text: 'hello', from: 'u', onRouted: (o) => { outcome = o; } });
  // Before anything is awaited: a voice channel can answer its request at once.
  assert.deepEqual(outcome, { kind: 'started' });
  await until(() => rec.runs.length === 1);
  rec.runs[0].release();
  await done;
});

test('onRouted: messages that have to wait report queued, with how many are ahead', async () => {
  resetState();
  const ch = makeChannel();
  const rec = {};
  const bridge = makeBridge(rec);
  const first = await send(bridge, ch, 'find gyms');
  await until(() => rec.runs.length === 1);
  const second = await send(bridge, ch, 'and the weather');
  const third = await send(bridge, ch, 'and a taxi');
  assert.deepEqual(second.outcome, { kind: 'queued', ahead: 1 });
  assert.deepEqual(third.outcome, { kind: 'queued', ahead: 2 });
  // Its queue notice says what it is, for channels that cannot show the button.
  const notices = ch.sent.filter((m) => m.opts.notice === 'queued');
  assert.equal(notices.length, 2);
  assert.equal(notices[0].text, 'Queued');
  assert.match(notices[0].opts.buttons[0].data, /^steer:\d+$/);
  for (let i = 0; i < 3; i++) {
    await until(() => rec.runs.length === i + 1);
    rec.runs[i].release();
  }
  await Promise.all([first.done, second.done, third.done]);
});

test('onRouted: commands report command, unauthorized chats report blocked', async () => {
  resetState();
  const ch = makeChannel(['1']);
  const bridge = makeBridge({});
  const status = await send(bridge, ch, '/status');
  assert.deepEqual(status.outcome, { kind: 'command' });
  await status.done;
  const blocked = await send(bridge, ch, 'hi', '9');
  assert.deepEqual(blocked.outcome, { kind: 'blocked' });
  await blocked.done;
});

// ============  control surface  ============================================

test('control.state and control.status describe the chat as data', async () => {
  resetState();
  const ch = makeChannel();
  const rec = {};
  const bridge = makeBridge(rec);
  const control = bridge.controlFor(ch);
  assert.deepEqual(control.state('1'), { sessionId: null, running: 0, runningMs: 0, queued: 0 });
  assert.equal((await control.status('1')).live, undefined, 'no session yet: nothing to ask Aside about');

  const first = await send(bridge, ch, 'find gyms');
  await until(() => rec.runs.length === 1);
  const second = await send(bridge, ch, 'then the weather');
  await sleep(20);
  const s = await control.status('1');
  assert.equal(s.sessionId, SID);
  assert.equal(s.running, 1);
  assert.equal(s.queued, 1);
  assert.ok(s.runningMs >= 0);
  assert.deepEqual(s.live, { id: SID, status: 'running', title: 'Gyms in Almada' });

  rec.runs[0].release();
  await until(() => rec.runs.length === 2);
  rec.runs[1].release();
  await Promise.all([first.done, second.done]);
});

test('control.stop aborts what runs, drops what waits, and tags the closing message', async () => {
  resetState();
  const ch = makeChannel();
  const rec = {};
  const bridge = makeBridge(rec);
  const control = bridge.controlFor(ch);
  const first = await send(bridge, ch, 'long task');
  await until(() => rec.runs.length === 1);
  const second = await send(bridge, ch, 'queued task');

  const r = await control.stop('1', 'voice');
  assert.equal(r.stopped, 1);
  assert.equal(r.dropped, 1);
  assert.ok(r.runningMs >= 0);
  await Promise.all([first.done, second.done]);
  assert.equal(rec.runs.length, 1, 'the dropped task never ran');
  const closing = ch.sent.at(-1);
  assert.equal(closing.text, '🛑 Stopped.');
  assert.equal(closing.opts.notice, 'stopped', 'a channel that already acknowledged the stop can skip this');

  // Nothing left: a second stop finds nothing.
  assert.deepEqual(await control.stop('1', 'voice'), { stopped: 0, dropped: 0, runningMs: 0 });
});

test('/stop keeps its exact chat wording on top of stopChat', async () => {
  resetState();
  const ch = makeChannel();
  const rec = {};
  const bridge = makeBridge(rec);
  const first = await send(bridge, ch, 'long task');
  await until(() => rec.runs.length === 1);
  await bridge.handleMessage(ch, { chatId: '1', text: '/stop', from: 'u' });
  await first.done;
  // The aborted task's own closing message may already have landed after it.
  assert.ok(ch.sentText.some((t) => /^🛑 Stopping the current task \(running \d+s\)\.\.\.$/.test(t)), ch.sentText.join(' | '));
  await bridge.handleMessage(ch, { chatId: '1', text: '/stop', from: 'u' });
  assert.equal(ch.sentText.at(-1), 'Nothing is running right now.');
});

test('control.steer puts an instruction into the running task, or says why not', async () => {
  resetState();
  const ch = makeChannel();
  const rec = {};
  const bridge = makeBridge(rec);
  const control = bridge.controlFor(ch);
  assert.deepEqual(await control.steer('1', 'use the csv', 'voice'), { ok: false, reason: 'nothing-running' });

  const first = await send(bridge, ch, 'build the report');
  await until(() => rec.runs.length === 1);
  const r = await control.steer('1', 'use the csv', 'voice');
  assert.equal(r.ok, true);
  assert.deepEqual(rec.steers, [{ id: SID, text: 'use the csv' }]);
  assert.ok(history.get('test-chan', '1').some((m) => m.role === 'user' && m.text === 'use the csv'),
    'the steered text is part of the conversation');
  rec.runs[0].release();
  await first.done;
});

test('control.steer can wait for a task that has not announced its session yet', async () => {
  resetState();
  const ch = makeChannel();
  const rec = {};
  const bridge = makeBridge(rec, { agentOpts: { announceDelayMs: 300 } });
  const control = bridge.controlFor(ch);
  const first = await send(bridge, ch, 'build the report');
  await until(() => rec.runs.length === 1);
  // No wait: the id is not known yet.
  assert.deepEqual(await control.steer('1', 'faster', 'voice'), { ok: false, reason: 'no-session' });
  const r = await control.steer('1', 'use the csv', 'voice', { waitMs: 2000 });
  assert.equal(r.ok, true);
  assert.deepEqual(rec.steers, [{ id: SID, text: 'use the csv' }]);
  rec.runs[0].release();
  await first.done;
});

test('/steer keeps its exact chat wording on top of steerChat', async () => {
  resetState();
  const ch = makeChannel();
  const rec = {};
  const bridge = makeBridge(rec, { agentOpts: { steerOk: false } });
  await bridge.handleMessage(ch, { chatId: '1', text: '/steer faster', from: 'u' });
  assert.equal(ch.sentText.at(-1), 'Nothing is running to steer. Send it as a normal message and it runs next.');
  const first = await send(bridge, ch, 'build the report');
  await until(() => rec.runs.length === 1);
  await bridge.handleMessage(ch, { chatId: '1', text: '/steer faster', from: 'u' });
  assert.equal(ch.sentText.at(-1), "Couldn't steer it: refused");
  rec.runs[0].release();
  await first.done;
});

test('control calls are held to the channel allowlist', async () => {
  resetState();
  const ch = makeChannel(['1']);
  const control = makeBridge({}).controlFor(ch);
  assert.throws(() => control.state('9'), /not authorized/);
  await assert.rejects(control.stop('9'), /not authorized/);
  assert.throws(() => control.reset('9'), /not authorized/);
});

// ============  reset while a task runs  ====================================

test('control.reset while a task runs: finishing does not undo the reset', async () => {
  resetState();
  const ch = makeChannel();
  const rec = {};
  const bridge = makeBridge(rec);
  const control = bridge.controlFor(ch);
  const first = await send(bridge, ch, 'find gyms');
  await until(() => rec.runs.length === 1);
  assert.equal(sessions.get('test-chan', '1'), SID);

  assert.deepEqual(control.reset('1'), { running: 1 });
  rec.runs[0].release({ text: 'Fitness Hut', raw: 'Fitness Hut' });
  await first.done;
  assert.equal(sessions.get('test-chan', '1'), null, 'the old session came back when the task finished');
  assert.deepEqual(history.get('test-chan', '1'), [], 'the old exchange came back when the task finished');

  // So the next message really starts fresh.
  const next = await send(bridge, ch, 'hello again');
  await until(() => rec.runs.length === 2);
  assert.equal(rec.runs[1].sessionId, null);
  rec.runs[1].release();
  await next.done;
  assert.equal(sessions.get('test-chan', '1'), SID, 'tasks after the reset keep their session as usual');
});

test('/new while a task runs gets the same guarantee', async () => {
  resetState();
  const ch = makeChannel();
  const rec = {};
  const bridge = makeBridge(rec);
  const first = await send(bridge, ch, 'find gyms');
  await until(() => rec.runs.length === 1);
  await bridge.handleMessage(ch, { chatId: '1', text: '/new', from: 'u' });
  assert.equal(ch.sentText.at(-1), 'Started a fresh session. Send your task.');
  rec.runs[0].release();
  await first.done;
  assert.equal(sessions.get('test-chan', '1'), null);
});

// ============  stall notice tag  ===========================================

test('the stall notice carries its kind and age alongside the Stop button', async () => {
  resetState();
  const ch = makeChannel();
  const rec = {};
  const bridge = makeBridge(rec);
  const first = await send(bridge, ch, 'long one');
  await until(() => rec.runs.length === 1);
  await rec.runs[0].onStall({ kind: 'idle', idleMs: 420000, elapsedMs: 430000 });
  const notice = ch.sent.at(-1);
  assert.equal(notice.opts.notice, 'stall');
  assert.equal(notice.opts.stallKind, 'idle');
  assert.equal(notice.opts.elapsedMs, 430000);
  assert.match(notice.opts.buttons[0].data, /^kill:\d+$/);
  assert.equal(bridge.activeTasks('1').length, 1, 'reporting a stall ends nothing');
  rec.runs[0].release();
  await first.done;
});
