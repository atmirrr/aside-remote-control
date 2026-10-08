// Tests for /stop (abort what is running) and for the queue's "send now"
// button, which steers a waiting message into the running task.
//
// Three layers are covered, because the feature only works if all three hold:
//   1. Agent.run() actually interrupts a real child process when its signal fires.
//   2. Bridge routes /stop to that signal, drops queued work, and reports it.
//   3. The Telegram poll loop keeps reading updates *while* a task runs -- without
//      that, /stop could never be delivered until the task it aborts had finished.
//
// Run with an isolated state dir so the real ~/.aside-remote is never touched:
//   ASIDE_REMOTE_HOME=$(mktemp -d) node --test test/stop.test.mjs
//
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { Bridge } from '../src/bridge.js';
import { TelegramChannel } from '../src/channels/telegram.js';
import { Agent } from '../src/agent.js';
import { history, HOME, PTY_DRIVER } from '../src/config.js';

if (!process.env.ASIDE_REMOTE_HOME) {
  throw new Error('Set ASIDE_REMOTE_HOME to a temp dir before running these tests.');
}
fs.mkdirSync(HOME, { recursive: true });
function resetState() {
  fs.writeFileSync(path.join(HOME, 'sessions.json'), '{}');
  fs.writeFileSync(path.join(HOME, 'history.json'), '{}');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Wait for a condition rather than guessing a fixed delay, so these stay
// reliable on a loaded machine.
async function until(fn, ms = 3000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await sleep(5);
  }
  return false;
}

function makeChannel(authorized = ['1', '2']) {
  return {
    id: 'test-chan',
    sentText: [],
    typings: 0,
    isAuthorized(chatId) { return authorized.includes(String(chatId)); },
    async sendText(_chatId, t) { this.sentText.push(t); },
    async sendTyping() { this.typings++; },
    async sendImages() {},
  };
}

function makeBridge(runHandler, agentCfg = {}) {
  const bridge = new Bridge({ agent: { command: 'unused', ...agentCfg }, channels: [] });
  bridge.agent = { run: runHandler };
  return bridge;
}

const abortedResult = {
  text: '[aside-remote] Task stopped on request.',
  raw: 'partial transcript',
  sessionId: null,
  code: -4,
  error: true,
  aborted: true,
};

// A stub agent that hangs until its abort signal fires, mimicking the real
// resolve-on-abort contract in Agent.run. `record.runs` collects one entry per
// call so concurrent tasks can be told apart.
function hangingAgent(record) {
  record.runs = [];
  return (opts) => new Promise((resolve) => {
    const run = { prompt: opts.prompt, signal: opts.signal, done: false };
    record.runs.push(run);
    const finish = () => { run.done = true; resolve(abortedResult); };
    // Mirrors src/agent.js: a signal can already be aborted by the time the
    // agent is reached, and then the event has been and gone.
    if (opts.signal?.aborted) finish();
    else opts.signal.addEventListener('abort', finish, { once: true });
  });
}

const running = (bridge, chatId) => bridge.activeTasks(chatId).length;

// =====================  Agent.run: real process  =============================

test('agent: an aborted run kills the child and reports aborted', async () => {
  const agent = new Agent({ command: 'sleep', newArgs: [], wrapper: [], timeoutMs: 30000, idleTimeoutMs: 0 });
  const controller = new AbortController();
  const started = Date.now();
  const p = agent.run({ prompt: '30', signal: controller.signal });
  await sleep(150); // let it actually spawn
  controller.abort();
  const res = await p;
  assert.equal(res.aborted, true);
  assert.equal(res.code, -4);
  assert.match(res.text, /stopped on request/i);
  // Well inside the 5s SIGKILL grace: it died on the signal, not the fallback.
  assert.ok(Date.now() - started < 4000, `took too long: ${Date.now() - started}ms`);
});

test('agent: a second abort is a no-op and the run resolves once', async () => {
  const agent = new Agent({ command: 'sleep', newArgs: [], wrapper: [], timeoutMs: 30000, idleTimeoutMs: 0 });
  const controller = new AbortController();
  const p = agent.run({ prompt: '30', signal: controller.signal });
  await sleep(100);
  controller.abort();
  controller.abort();
  const res = await p;
  assert.equal(res.aborted, true);
});

test('agent: a run with no signal is unaffected', async () => {
  const agent = new Agent({ command: 'echo', newArgs: [], wrapper: [], timeoutMs: 10000, idleTimeoutMs: 0 });
  const res = await agent.run({ prompt: 'hello' });
  assert.equal(res.code, 0);
  assert.equal(res.aborted, undefined);
  assert.match(res.text, /hello/);
});

test('agent: a signal already aborted before the run starts stops it immediately', async () => {
  const agent = new Agent({ command: 'sleep', newArgs: [], wrapper: [], timeoutMs: 30000, idleTimeoutMs: 0 });
  const controller = new AbortController();
  controller.abort();
  const res = await agent.run({ prompt: '30', signal: controller.signal });
  assert.equal(res.aborted, true);
});

// The pty path is what actually runs in production on macOS: the stop arrives as
// a real Ctrl-C through the terminal rather than as a signal to the wrapper.
const ptyUsable = process.platform === 'darwin'
  && spawnSync('python3', ['-c', 'import pty, select, fcntl, termios, struct'], { stdio: 'ignore' }).status === 0;

test('agent: Ctrl-C through the pty stops the child', { skip: !ptyUsable && 'python3 pty driver unavailable' }, async () => {
  const agent = new Agent({
    command: 'sleep',
    newArgs: [],
    wrapper: ['python3', '-c', PTY_DRIVER],
    timeoutMs: 30000,
    idleTimeoutMs: 0,
    autoApprove: true,
    approvePromptRegex: 'never-matches-this',
  });
  const controller = new AbortController();
  const started = Date.now();
  const p = agent.run({ prompt: '30', signal: controller.signal });
  await sleep(400); // let python fork the pty and exec sleep
  controller.abort();
  const res = await p;
  assert.equal(res.aborted, true);
  assert.equal(res.code, -4);
  // Under the grace window means the 0x03 landed as a real SIGINT.
  assert.ok(Date.now() - started < 4000, `SIGKILL fallback was used: ${Date.now() - started}ms`);
});

// =====================  Bridge: the /stop command  ===========================

test('/stop with nothing running says so', async () => {
  resetState();
  const ch = makeChannel();
  const bridge = makeBridge(async () => ({ text: 'x', code: 0 }));
  await bridge.handleMessage(ch, { chatId: '1', text: '/stop', from: 'u' });
  assert.deepEqual(ch.sentText, ['Nothing is running right now.']);
});

test('/stop aborts the running task and reports it', async () => {
  resetState();
  const ch = makeChannel();
  const rec = {};
  const bridge = makeBridge(hangingAgent(rec));

  const task = bridge.handleMessage(ch, { chatId: '1', text: 'a long task', from: 'u' });
  assert.ok(await until(() => running(bridge, '1') === 1), 'task never registered as running');
  assert.equal(rec.runs[0].signal.aborted, false);

  await bridge.handleMessage(ch, { chatId: '1', text: '/stop', from: 'u' });
  assert.equal(rec.runs[0].signal.aborted, true, 'the agent signal was not aborted');
  await task;

  assert.ok(ch.sentText.some((t) => /Stopping the current task/.test(t)), ch.sentText.join(' | '));
  assert.equal(ch.sentText.at(-1), '\u{1F6D1} Stopped.');
  assert.equal(running(bridge, '1'), 0, 'the in-flight entry was not released');
});

test('/stop is case-insensitive and ignored from an unauthorized chat', async () => {
  resetState();
  const ch = makeChannel(['1']);
  const rec = {};
  const bridge = makeBridge(hangingAgent(rec));

  const task = bridge.handleMessage(ch, { chatId: '1', text: 'work', from: 'u' });
  assert.ok(await until(() => running(bridge, '1') === 1));

  await bridge.handleMessage(ch, { chatId: '999', text: '/STOP', from: 'x' });
  assert.equal(rec.runs[0].signal.aborted, false, 'an unauthorized chat managed to stop the task');

  await bridge.handleMessage(ch, { chatId: '1', text: '  /STOP  ', from: 'u' });
  assert.equal(rec.runs[0].signal.aborted, true, 'uppercase /STOP was not recognised');
  await task;
});

test('/stop also drops tasks still waiting in the queue', async () => {
  resetState();
  const ch = makeChannel();
  const rec = {};
  const bridge = makeBridge(hangingAgent(rec));

  const first = bridge.handleMessage(ch, { chatId: '1', text: 'first', from: 'u' });
  assert.ok(await until(() => running(bridge, '1') === 1));
  const second = bridge.handleMessage(ch, { chatId: '1', text: 'second', from: 'u' });

  await bridge.handleMessage(ch, { chatId: '1', text: '/stop', from: 'u' });
  await Promise.all([first, second]);

  // Only the first task ever reached the agent; the queued one never started.
  assert.equal(rec.runs.length, 1, `agent ran ${rec.runs.length} times, expected 1`);
  assert.equal(running(bridge, '1'), 0);
});

test('a task sent after /stop runs normally', async () => {
  resetState();
  const ch = makeChannel();
  const rec = {};
  const bridge = makeBridge(hangingAgent(rec));

  const first = bridge.handleMessage(ch, { chatId: '1', text: 'first', from: 'u' });
  assert.ok(await until(() => running(bridge, '1') === 1));
  await bridge.handleMessage(ch, { chatId: '1', text: '/stop', from: 'u' });
  await first;

  bridge.agent = { run: async () => ({ text: 'done', raw: 'done', sessionId: null, code: 0, error: false }) };
  await bridge.handleMessage(ch, { chatId: '1', text: 'next one', from: 'u' });
  assert.equal(ch.sentText.at(-1), 'done');
});

test('/stop only touches the chat it came from', async () => {
  resetState();
  const ch = makeChannel(['1', '2']);
  const rec = {};
  const bridge = makeBridge(hangingAgent(rec));

  const a = bridge.handleMessage(ch, { chatId: '1', text: 'task A', from: 'u' });
  const b = bridge.handleMessage(ch, { chatId: '2', text: 'task B', from: 'v' });
  assert.ok(await until(() => running(bridge, '1') === 1 && running(bridge, '2') === 1));

  await bridge.handleMessage(ch, { chatId: '1', text: '/stop', from: 'u' });
  await a;
  assert.equal(running(bridge, '2'), 1, 'the other chat was stopped too');

  await bridge.handleMessage(ch, { chatId: '2', text: '/stop', from: 'v' });
  await b;
});

test('a stopped task leaves no half-answer in the conversation history', async () => {
  resetState();
  const ch = makeChannel();
  const rec = {};
  const bridge = makeBridge(hangingAgent(rec));

  const task = bridge.handleMessage(ch, { chatId: '1', text: 'remember this', from: 'u' });
  assert.ok(await until(() => running(bridge, '1') === 1));
  await bridge.handleMessage(ch, { chatId: '1', text: '/stop', from: 'u' });
  await task;

  assert.deepEqual(history.get(ch.id, '1'), []);
});

test('/help documents /stop', async () => {
  resetState();
  const ch = makeChannel();
  const bridge = makeBridge(async () => ({ text: 'x', code: 0 }));
  await bridge.handleMessage(ch, { chatId: '1', text: '/help', from: 'u' });
  assert.match(ch.sentText[0], /\/stop/);
});

// ============  the queue notice and its "send now" button  ==================
//
// A message that arrives while something is running waits its turn and goes in
// on its own when the running task ends. Its notice carries one button, "send
// now", which steers it into the running task instead. Either way the notice
// is deleted once the button is moot: nothing is said in chat.

// A channel that records button payloads and supports in-place edits and
// deletes, which the plain makeChannel() above deliberately does not (having
// editText turns on streaming and changes what lands in sentText). Paired with
// stream:false so the reply path stays the simple one these assertions expect.
function makeBtnChannel(authorized = ['1', '2']) {
  return {
    id: 'test-chan',
    sentText: [],
    buttons: [],       // opts.buttons for each sendText, aligned with sentText
    edits: [],         // { messageId, text }
    deleted: [],       // message ids
    nextId: 1,
    typings: 0,
    isAuthorized(chatId) { return authorized.includes(String(chatId)); },
    async sendText(_chatId, t, opts = {}) {
      this.sentText.push(t);
      this.buttons.push(opts.buttons || null);
      return this.nextId++;
    },
    async editText(_chatId, messageId, t) { this.edits.push({ messageId, text: t }); return true; },
    async deleteMessage(_chatId, messageId) { this.deleted.push(messageId); return true; },
    async sendTyping() { this.typings++; },
    async sendImages() {},
  };
}

// Like hangingAgent, but each run can also be released on demand, so a test can
// let the queue drain naturally instead of only ever aborting it. Runs announce
// a session id (like the real CLI) unless opts.silent is set.
function gatedAgent(record, { announce = true } = {}) {
  record.runs = [];
  record.steers = [];
  const handler = (opts) => new Promise((resolve) => {
    const run = {
      prompt: opts.prompt,
      signal: opts.signal,
      sessionId: opts.sessionId,
      release: () => resolve({ text: 'done', raw: 'done', code: 0, sessionId: opts.sessionId || 'SESSIONabcdefgh1' }),
    };
    record.runs.push(run);
    if (announce && !opts.sessionId) opts.onSession?.('SESSIONabcdefgh1');
    if (opts.signal?.aborted) resolve(abortedResult);
    else opts.signal?.addEventListener('abort', () => resolve(abortedResult), { once: true });
  });
  handler.steer = async (id, text) => { record.steers.push({ id, text }); return { ok: true, out: 'ok  running', err: '', notFound: false }; };
  return handler;
}
function makeGatedBridge(rec, agentOpts, cfg = {}) {
  const handler = gatedAgent(rec, agentOpts);
  const bridge = makeBridge(handler, { stream: false, ...cfg });
  bridge.agent = { run: handler, steer: handler.steer };
  return bridge;
}

// The button payload of the most recent message that carried one.
function lastButton(ch) {
  for (let i = ch.buttons.length - 1; i >= 0; i--) if (ch.buttons[i]?.length) return ch.buttons[i][0];
  return null;
}
const noticeId = (ch) => {
  for (let i = ch.buttons.length - 1; i >= 0; i--) if (ch.buttons[i]?.length) return i + 1;
  return null;
};

test('a first message starts straight away, with no queue notice or button', async () => {
  resetState();
  const ch = makeBtnChannel();
  const rec = {};
  const bridge = makeBridge(hangingAgent(rec), { stream: false });

  const main = bridge.handleMessage(ch, { chatId: '1', text: 'only one', from: 'u' });
  assert.ok(await until(() => rec.runs.length === 1), 'the first task did not start');
  assert.ok(!ch.sentText.some((t) => t === 'Queued'), ch.sentText.join(' | '));
  assert.equal(lastButton(ch), null, 'a lone task should not offer a send now button');

  await bridge.handleMessage(ch, { chatId: '1', text: '/stop', from: 'u' });
  await main;
});

test('a message sent while a task runs is queued with a bare notice and a "send now" button', async () => {
  resetState();
  const ch = makeBtnChannel();
  const rec = {};
  const bridge = makeBridge(hangingAgent(rec), { stream: false });

  const main = bridge.handleMessage(ch, { chatId: '1', text: 'the long one', from: 'u' });
  assert.ok(await until(() => running(bridge, '1') === 1));

  const second = bridge.handleMessage(ch, { chatId: '1', text: 'quick question', from: 'u' });
  assert.ok(await until(() => bridge.pendingFor('1').length === 1), 'the task was never queued');
  assert.equal(ch.sentText.at(-1), 'Queued');
  assert.equal(lastButton(ch).text, 'send now');
  assert.match(lastButton(ch).data, /^steer:\d+$/);
  // It really is waiting: only the first task ever reached the agent.
  await sleep(30);
  assert.equal(rec.runs.length, 1, 'the queued task started without being asked to');

  await bridge.handleMessage(ch, { chatId: '1', text: '/stop', from: 'u' });
  await Promise.all([main, second]);
});

test('tapping "send now" steers the queued message into the running task and deletes the notice', async () => {
  resetState();
  const ch = makeBtnChannel();
  const rec = {};
  const bridge = makeGatedBridge(rec);

  const main = bridge.handleMessage(ch, { chatId: '1', text: 'the long one', from: 'u' });
  assert.ok(await until(() => running(bridge, '1') === 1));
  const second = bridge.handleMessage(ch, { chatId: '1', text: 'use the csv instead', from: 'u' });
  assert.ok(await until(() => bridge.pendingFor('1').length === 1));
  const nid = noticeId(ch);
  const sentBefore = ch.sentText.length;

  await bridge.handleAction(ch, { chatId: '1', messageId: nid, data: lastButton(ch).data, from: 'u' });

  assert.deepEqual(rec.steers, [{ id: 'SESSIONabcdefgh1', text: 'use the csv instead' }]);
  assert.equal(bridge.pendingFor('1').length, 0, 'the steered message stayed in the pending map');
  assert.deepEqual(ch.deleted, [nid], 'the notice was not deleted');
  assert.equal(ch.sentText.length, sentBefore, 'something was said after the tap');
  assert.equal(ch.edits.length, 0, 'the notice was edited instead of deleted');
  // Nothing else ran: the message went into the running task, not the agent.
  assert.equal(rec.runs.length, 1);
  assert.equal(running(bridge, '1'), 1);

  rec.runs[0].release();
  await Promise.all([main, second]);
  // The queued task's slot in the chain is a no-op now; it must not run later.
  await sleep(30);
  assert.equal(rec.runs.length, 1, 'the steered message also ran as a task');
  // The steered text is part of the session, so it is in the fallback history.
  assert.match(history.get(ch.id, '1').map((t) => t.text).join(' | '), /use the csv instead/);
});

test('"send now" waits for the running task to announce its id', async () => {
  resetState();
  const ch = makeBtnChannel();
  const rec = {};
  const bridge = makeGatedBridge(rec, { announce: false });

  const main = bridge.handleMessage(ch, { chatId: '1', text: 'the long one', from: 'u' });
  assert.ok(await until(() => running(bridge, '1') === 1));
  const second = bridge.handleMessage(ch, { chatId: '1', text: 'correction', from: 'u' });
  assert.ok(await until(() => bridge.pendingFor('1').length === 1));

  const tap = bridge.handleAction(ch, { chatId: '1', messageId: noticeId(ch), data: lastButton(ch).data, from: 'u' });
  await sleep(150);
  assert.equal(rec.steers.length, 0, 'steered before the id was known');
  // The id arrives late; the pending tap picks it up.
  bridge.activeTasks('1')[0].sessionId = 'SESSIONabcdefgh1';
  await tap;
  assert.equal(rec.steers.length, 1);
  assert.equal(bridge.pendingFor('1').length, 0);

  rec.runs[0].release();
  await Promise.all([main, second]);
});

test('a queued task that reaches its turn runs normally and its notice is deleted', async () => {
  resetState();
  const ch = makeBtnChannel();
  const rec = {};
  const bridge = makeGatedBridge(rec);

  const main = bridge.handleMessage(ch, { chatId: '1', text: 'main task', from: 'u' });
  assert.ok(await until(() => rec.runs.length === 1));
  const second = bridge.handleMessage(ch, { chatId: '1', text: 'waited its turn', from: 'u' });
  assert.ok(await until(() => bridge.pendingFor('1').length === 1));
  const nid = noticeId(ch);

  rec.runs[0].release(); // the queue drains on its own
  assert.ok(await until(() => rec.runs.length === 2), 'the queued task never started');
  assert.match(rec.runs[1].prompt, /waited its turn/);
  // It waited, so it resumes the chat's session rather than starting fresh.
  assert.equal(rec.runs[1].sessionId, 'SESSIONabcdefgh1');
  assert.equal(bridge.pendingFor('1').length, 0);
  assert.deepEqual(ch.deleted, [nid], 'the notice was not deleted');
  assert.equal(ch.edits.length, 0, 'the notice was edited instead of deleted');
  assert.equal(rec.steers.length, 0);

  rec.runs[1].release();
  await Promise.all([main, second]);
  assert.match(history.get(ch.id, '1').map((t) => t.text).join(' | '), /waited its turn/);
});

test('tapping "send now" after the task already started only clears the stale notice', async () => {
  resetState();
  const ch = makeBtnChannel();
  const rec = {};
  const bridge = makeGatedBridge(rec);

  const main = bridge.handleMessage(ch, { chatId: '1', text: 'main task', from: 'u' });
  assert.ok(await until(() => rec.runs.length === 1));
  const second = bridge.handleMessage(ch, { chatId: '1', text: 'second task', from: 'u' });
  assert.ok(await until(() => bridge.pendingFor('1').length === 1));
  const btn = lastButton(ch);
  const nid = noticeId(ch);

  rec.runs[0].release();
  assert.ok(await until(() => rec.runs.length === 2), 'the queued task never started');
  const sentBefore = ch.sentText.length;

  // The button is now stale. Tapping it must not steer or run anything.
  await bridge.handleAction(ch, { chatId: '1', messageId: nid, data: btn.data, from: 'u' });
  await sleep(30);
  assert.equal(rec.runs.length, 2, 'a stale tap started the task a second time');
  assert.equal(rec.steers.length, 0, 'a stale tap steered');
  assert.equal(ch.sentText.length, sentBefore, 'a stale tap said something');
  assert.ok(ch.deleted.includes(nid));

  rec.runs[1].release();
  await Promise.all([main, second]);
});

test('/stop retires queued buttons and a later tap cannot resurrect the task', async () => {
  resetState();
  const ch = makeBtnChannel();
  const rec = {};
  const bridge = makeBridge(hangingAgent(rec), { stream: false });

  const main = bridge.handleMessage(ch, { chatId: '1', text: 'main task', from: 'u' });
  assert.ok(await until(() => running(bridge, '1') === 1));
  const second = bridge.handleMessage(ch, { chatId: '1', text: 'queued task', from: 'u' });
  assert.ok(await until(() => bridge.pendingFor('1').length === 1));
  const btn = lastButton(ch);

  await bridge.handleMessage(ch, { chatId: '1', text: '/stop', from: 'u' });
  assert.equal(bridge.pendingFor('1').length, 0, '/stop left a live pending task behind');
  assert.equal(ch.deleted.length, 1, 'the queued notice was not deleted');
  assert.equal(ch.edits.length, 0, 'the notice was edited instead of deleted');

  await bridge.handleAction(ch, { chatId: '1', messageId: 99, data: btn.data, from: 'u' });
  await sleep(30);
  assert.equal(rec.runs.length, 1, 'a tap after /stop resurrected the cancelled task');

  await Promise.all([main, second]);
  assert.equal(running(bridge, '1'), 0);
});

test('/stop reports and aborts every concurrent task at once', async () => {
  resetState();
  const ch = makeBtnChannel();
  const rec = {};
  const bridge = makeBridge(hangingAgent(rec), { stream: false });

  const main = bridge.handleMessage(ch, { chatId: '1', text: 'main', from: 'u' });
  assert.ok(await until(() => running(bridge, '1') === 1));
  const second = bridge.handleMessage(ch, { chatId: '1', text: '/btw side', from: 'u' });
  assert.ok(await until(() => running(bridge, '1') === 2));
  assert.ok(await until(() => rec.runs.length === 2), 'the /btw task never reached the agent');

  await bridge.handleMessage(ch, { chatId: '1', text: '/stop', from: 'u' });
  assert.ok(rec.runs.every((r) => r.signal.aborted), 'not every task was aborted');
  await Promise.all([main, second]);

  assert.ok(ch.sentText.some((t) => /Stopping 2 running tasks/.test(t)), ch.sentText.join(' | '));
});

// The queue advances the moment the running task ends, so "pending but nothing
// active" is only ever a handoff race, not a steady state reachable by sending
// messages. The branch is still worth covering, so drive it directly.
test('/stop with only a queued task and nothing running says what it dropped', async () => {
  resetState();
  const ch = makeBtnChannel();
  const bridge = makeBridge(async () => ({ text: 'x', code: 0 }));

  let cancelledWith = null;
  bridge.pending.set(99, {
    chatId: '1',
    seq: 99,
    sendNow: async () => 'x',
    cancel: async (why) => { cancelledWith = why; bridge.pending.delete(99); },
  });
  assert.equal(bridge.pendingFor('1').length, 1);
  assert.equal(running(bridge, '1'), 0, 'nothing should be running');

  await bridge.handleMessage(ch, { chatId: '1', text: '/stop', from: 'u' });

  assert.match(ch.sentText.at(-1), /Nothing was running\. Dropped 1 queued task\./);
  assert.equal(cancelledWith, 'Dropped by /stop.', 'the queued task was not cancelled');
  assert.equal(bridge.pendingFor('1').length, 0, 'the pending entry was not retired');
});

test('/help documents the send now button and /btw', async () => {
  resetState();
  const ch = makeChannel();
  const bridge = makeBridge(async () => ({ text: 'x', code: 0 }));
  await bridge.handleMessage(ch, { chatId: '1', text: '/help', from: 'u' });
  assert.match(ch.sentText[0], /send now/);
  assert.match(ch.sentText[0], /\/btw/);
});

// ==========================  /btw: the typed form  ===========================
// Same promotion the button does, but decided up front by the sender instead of
// after a queue notice appears.

test('/btw runs alongside the current task instead of queueing', async () => {
  resetState();
  const ch = makeChannel();
  const rec = {};
  const bridge = makeBridge(hangingAgent(rec), { stream: false });

  const main = bridge.handleMessage(ch, { chatId: '1', text: 'the long one', from: 'u' });
  assert.ok(await until(() => running(bridge, '1') === 1));

  const side = bridge.handleMessage(ch, { chatId: '1', text: '/btw quick question', from: 'u' });
  assert.ok(await until(() => running(bridge, '1') === 2), '/btw did not run alongside');
  assert.ok(await until(() => rec.runs.length === 2), '/btw never reached the agent');
  assert.equal(bridge.pendingFor('1').length, 0, '/btw should never enter the queue');

  await bridge.handleMessage(ch, { chatId: '1', text: '/stop', from: 'u' });
  await Promise.all([main, side]);
  assert.equal(running(bridge, '1'), 0);
});

test('/btw strips its own prefix before the agent sees the task', async () => {
  resetState();
  const ch = makeChannel();
  const rec = {};
  const bridge = makeBridge(hangingAgent(rec), { stream: false });

  const main = bridge.handleMessage(ch, { chatId: '1', text: 'main', from: 'u' });
  assert.ok(await until(() => rec.runs.length === 1));
  const side = bridge.handleMessage(ch, { chatId: '1', text: '/btw check my email', from: 'u' });
  assert.ok(await until(() => rec.runs.length === 2));

  assert.match(rec.runs[1].prompt, /check my email/);
  assert.ok(!/\/btw/.test(rec.runs[1].prompt), `the prefix leaked to the agent: ${rec.runs[1].prompt}`);

  await bridge.handleMessage(ch, { chatId: '1', text: '/stop', from: 'u' });
  await Promise.all([main, side]);
});

test('/btw gets a fresh session and stays out of the chat history', async () => {
  resetState();
  const ch = makeChannel();
  const rec = {};
  const bridge = makeBridge(gatedAgent(rec), { stream: false });

  const main = bridge.handleMessage(ch, { chatId: '1', text: 'main task', from: 'u' });
  assert.ok(await until(() => rec.runs.length === 1));
  const side = bridge.handleMessage(ch, { chatId: '1', text: '/btw side task', from: 'u' });
  assert.ok(await until(() => rec.runs.length === 2));

  // Two live CLI runs must not share one session id, or the transcripts interleave.
  assert.equal(rec.runs[1].sessionId, null, '/btw reused the chat session');

  rec.runs[1].release();
  rec.runs[0].release();
  await Promise.all([main, side]);

  const turns = history.get(ch.id, '1').map((t) => t.text).join(' | ');
  assert.match(turns, /main task/, 'the ordinary task should still be recorded');
  assert.ok(!/side task/.test(turns), `/btw leaked into history: ${turns}`);
});

test('/btw with nothing running is an ordinary task, keeping session and history', async () => {
  resetState();
  const ch = makeChannel();
  const rec = { runs: [] };
  // Resolves immediately and reports a session id, so the next task has a
  // session to either resume (ordinary) or ignore (isolated).
  const bridge = makeBridge(async (opts) => {
    rec.runs.push({ prompt: opts.prompt, sessionId: opts.sessionId });
    return { text: 'done', sessionId: 'sess-1', code: 0 };
  }, { stream: false });

  // First task establishes the chat's session.
  await bridge.handleMessage(ch, { chatId: '1', text: 'first task', from: 'u' });
  assert.equal(rec.runs.length, 1);

  // Nothing is running now, so /btw has no one to collide with and behaves
  // like any normal message: same session, recorded in history.
  await bridge.handleMessage(ch, { chatId: '1', text: '/btw solo task', from: 'u' });
  assert.equal(rec.runs.length, 2);
  assert.equal(rec.runs[1].sessionId, 'sess-1', 'a lone /btw should stay on the chat session');

  const turns = history.get(ch.id, '1').map((t) => t.text).join(' | ');
  assert.match(turns, /solo task/, 'a lone /btw should be recorded in history');
});

test('bare /btw with no task explains itself and starts nothing', async () => {
  resetState();
  const ch = makeChannel();
  const rec = {};
  const bridge = makeBridge(hangingAgent(rec), { stream: false });

  await bridge.handleMessage(ch, { chatId: '1', text: '/btw', from: 'u' });
  assert.match(ch.sentText[0], /Add the task after \/btw/);
  assert.equal(running(bridge, '1'), 0);
  assert.equal(rec.runs.length, 0, 'a bare /btw should not reach the agent');
});

test('/stop aborts /btw tasks too', async () => {
  resetState();
  const ch = makeChannel();
  const rec = {};
  const bridge = makeBridge(hangingAgent(rec), { stream: false });

  const main = bridge.handleMessage(ch, { chatId: '1', text: 'main', from: 'u' });
  assert.ok(await until(() => running(bridge, '1') === 1));
  const a = bridge.handleMessage(ch, { chatId: '1', text: '/btw one', from: 'u' });
  const b = bridge.handleMessage(ch, { chatId: '1', text: '/btw two', from: 'u' });
  assert.ok(await until(() => running(bridge, '1') === 3), 'expected three concurrent tasks');

  await bridge.handleMessage(ch, { chatId: '1', text: '/stop', from: 'u' });
  await Promise.all([main, a, b]);
  assert.equal(running(bridge, '1'), 0, '/stop left a /btw task running');
  assert.ok(ch.sentText.some((t) => /Stopping 3 running tasks/.test(t)), JSON.stringify(ch.sentText));
});

// =====================  Telegram: the poll loop stays live  ==================

test('telegram: a running task does not block the next update from being read', async () => {
  const ch = new TelegramChannel({ id: 'tg', type: 'telegram', token: 'x' });
  const controller = new AbortController();
  const updates = [
    { update_id: 1, message: { message_id: 1, chat: { id: 1 }, text: 'a long task', from: { username: 'u' } } },
    { update_id: 2, message: { message_id: 2, chat: { id: 1 }, text: '/stop', from: { username: 'u' } } },
  ];
  let polls = 0;
  ch.call = async (method) => {
    if (method !== 'getUpdates') return { ok: true, result: [] };
    polls++;
    if (polls === 1) return { ok: true, result: [] };            // startup drain
    if (polls === 2) return { ok: true, result: [updates[0]] };
    if (polls === 3) return { ok: true, result: [updates[1]] };
    await sleep(20);
    return { ok: true, result: [] };
  };

  const seen = [];
  let release;
  const held = new Promise((r) => { release = r; });
  const run = ch.start({
    signal: controller.signal,
    onMessage: async (m) => { seen.push(m.text); if (seen.length === 1) await held; },
    onAction: async () => {},
  });

  // The first handler is still hanging; the second update must arrive anyway.
  const bothSeen = await until(() => seen.length === 2);
  release();
  controller.abort();
  await run;

  assert.ok(bothSeen, `poll loop blocked on the running task; saw: ${JSON.stringify(seen)}`);
  assert.deepEqual(seen, ['a long task', '/stop']);
});
