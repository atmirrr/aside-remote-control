// Tests for the manual kill button, which replaced the automatic timeout kill.
//
// A timeout used to SIGKILL the agent. From outside the process a long quiet
// browser step and a genuinely wedged one look identical, so that kill threw
// away real work every time it guessed wrong. Now a cap firing only reports,
// the task keeps running, and the chat gets a plain "taking longer than usual"
// notice with a "Stop" button.
//
// Two layers, because the feature only works if both hold:
//   1. Agent.run() reports on a cap instead of killing, and the child survives.
//   2. Bridge turns that report into a button, and the tap aborts exactly the
//      one task it was raised for.
//
// Run with an isolated state dir so the real ~/.aside-remote is never touched:
//   ASIDE_REMOTE_HOME=$(mktemp -d) node --test test/killbutton.test.mjs
//
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { Bridge } from '../src/bridge.js';
import { Agent } from '../src/agent.js';
import { HOME } from '../src/config.js';

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

// A shell script as the "agent", so a test can control exactly when the child
// emits output and when it exits.
const shAgent = (cfg = {}) => new Agent({
  command: 'sh', newArgs: ['-c'], wrapper: [], timeoutMs: 30000, idleTimeoutMs: 0, ...cfg,
});

// =====================  Agent.run: caps report, child lives  =================

test('agent: an idle cap reports instead of killing, and the task still finishes', async () => {
  const agent = shAgent({ idleTimeoutMs: 120 });
  const stalls = [];
  // Silent for 400ms, then exits cleanly. The old code killed this at 120ms.
  const res = await agent.run({ prompt: 'sleep 0.4; echo done', onStall: (s) => stalls.push(s) });

  assert.equal(stalls.length, 1, 'the silence should have been reported once');
  assert.equal(stalls[0].kind, 'idle');
  assert.equal(stalls[0].idleMs, 120);
  assert.ok(stalls[0].elapsedMs >= 120, 'the notice carries how long the task has been running');
  // The point of the whole change: it was not killed.
  assert.equal(res.code, 0);
  assert.equal(res.stalled, undefined);
  assert.match(res.text, /done/);
});

test('agent: a long stall is reported once, not once per idle window', async () => {
  const agent = shAgent({ idleTimeoutMs: 80 });
  const stalls = [];
  // Silent for ~5 idle windows.
  const res = await agent.run({ prompt: 'sleep 0.45; echo ok', onStall: (s) => stalls.push(s) });

  assert.equal(stalls.length, 1, 'one notice per silent stretch, not a repeating alarm');
  assert.equal(res.code, 0);
});

test('agent: output resumes, then a fresh stall raises a fresh notice', async () => {
  const agent = shAgent({ idleTimeoutMs: 100 });
  const stalls = [];
  // quiet -> output -> quiet again: two separate stalls, so two notices.
  const res = await agent.run({ prompt: 'sleep 0.25; echo tick; sleep 0.35', onStall: (s) => stalls.push(s) });

  assert.equal(stalls.length, 2, 'output re-arms the guard so a later stall is reported again');
  assert.equal(res.code, 0);
});

test('agent: the hard cap also reports instead of killing', async () => {
  const agent = shAgent({ timeoutMs: 120, idleTimeoutMs: 0 });
  const stalls = [];
  const res = await agent.run({ prompt: 'sleep 0.4; echo survived', onStall: (s) => stalls.push(s) });

  assert.equal(stalls.length, 1);
  assert.equal(stalls[0].kind, 'timeout');
  assert.equal(stalls[0].limitMs, 120);
  assert.equal(res.code, 0);
  assert.match(res.text, /survived/);
});

test('agent: killOnTimeout restores the old automatic kill on both caps', async () => {
  const idle = await shAgent({ idleTimeoutMs: 120, killOnTimeout: true })
    .run({ prompt: 'sleep 5' });
  assert.equal(idle.code, -3);
  assert.equal(idle.stalled, true);

  const hard = await shAgent({ timeoutMs: 120, idleTimeoutMs: 0, killOnTimeout: true })
    .run({ prompt: 'sleep 5' });
  assert.equal(hard.code, -2);
  assert.match(hard.text, /timed out/i);
});

test('agent: a throwing onStall hook cannot break the run', async () => {
  const agent = shAgent({ idleTimeoutMs: 100 });
  const res = await agent.run({
    prompt: 'sleep 0.35; echo fine',
    onStall: () => { throw new Error('hook exploded'); },
  });
  assert.equal(res.code, 0);
  assert.match(res.text, /fine/);
});

// =====================  Bridge: the button  ==================================

function makeBtnChannel(authorized = ['1', '2']) {
  return {
    id: 'test-chan',
    sentText: [],
    buttons: [],       // opts.buttons per sendText, aligned with sentText
    edits: [],         // { messageId, text }
    nextId: 1,
    isAuthorized(chatId) { return authorized.includes(String(chatId)); },
    async sendText(_chatId, t, opts = {}) {
      this.sentText.push(t);
      this.buttons.push(opts.buttons || null);
      return this.nextId++;
    },
    async editText(_chatId, messageId, t) { this.edits.push({ messageId, text: t }); return true; },
    async sendTyping() {},
    async sendImages() {},
  };
}

const abortedResult = {
  text: '[aside-remote] Task stopped on request.',
  raw: 'partial transcript',
  sessionId: null,
  code: -4,
  error: true,
  aborted: true,
};

// Hands each run's onStall hook back to the test, so a stall can be triggered
// on demand rather than by waiting out a real timer.
function stallableAgent(record) {
  record.runs = [];
  return (opts) => new Promise((resolve) => {
    const run = {
      prompt: opts.prompt,
      signal: opts.signal,
      onStall: opts.onStall,
      release: () => resolve({ text: 'done', code: 0 }),
    };
    record.runs.push(run);
    if (opts.signal?.aborted) resolve(abortedResult);
    else opts.signal?.addEventListener('abort', () => resolve(abortedResult), { once: true });
  });
}

function makeBridge(runHandler, agentCfg = {}) {
  const bridge = new Bridge({ agent: { command: 'unused', ...agentCfg }, channels: [] });
  bridge.agent = { run: runHandler };
  return bridge;
}

// The button payload of the most recent message that carried one.
function lastButton(ch) {
  for (let i = ch.buttons.length - 1; i >= 0; i--) if (ch.buttons[i]?.length) return ch.buttons[i][0];
  return null;
}

const kills = (ch) => ch.buttons.filter((b) => b?.[0]?.data?.startsWith('kill:')).length;

test('bridge: a stall posts a notice carrying a kill button', async () => {
  resetState();
  const ch = makeBtnChannel();
  const rec = {};
  const bridge = makeBridge(stallableAgent(rec), { stream: false });

  const main = bridge.handleMessage(ch, { chatId: '1', text: 'long one', from: 'u' });
  assert.ok(await until(() => rec.runs.length === 1));

  await rec.runs[0].onStall({ kind: 'idle', idleMs: 420000, elapsedMs: 430000 });

  const btn = lastButton(ch);
  assert.ok(btn, 'the stall notice should carry a button');
  assert.equal(btn.text, '\u{1F6D1} Stop');
  assert.match(btn.data, /^kill:\d+$/);
  const notice = ch.sentText.at(-1);
  // Plain by design: how long, and that it is still alive. Nothing else.
  assert.equal(notice, '\u23F3 This is taking longer than usual (7m so far). Still running.');
  // The old notice guessed at causes (approval prompts, quiet browser steps).
  // That guessing is what this wording deliberately drops.
  assert.doesNotMatch(notice, /approval|stuck|No output/i);
  // Still going: reporting must not have ended anything.
  assert.equal(bridge.activeTasks('1').length, 1);

  rec.runs[0].release();
  await main;
});

test('bridge: tapping the button kills that task', async () => {
  resetState();
  const ch = makeBtnChannel();
  const rec = {};
  const bridge = makeBridge(stallableAgent(rec), { stream: false });

  const main = bridge.handleMessage(ch, { chatId: '1', text: 'wedged', from: 'u' });
  assert.ok(await until(() => rec.runs.length === 1));
  await rec.runs[0].onStall({ kind: 'idle', idleMs: 420000, elapsedMs: 430000 });

  await bridge.handleAction(ch, { chatId: '1', messageId: 99, data: lastButton(ch).data, from: 'u' });
  await main;

  assert.equal(rec.runs[0].signal.aborted, true, 'the run should have been signalled');
  assert.equal(bridge.activeTasks('1').length, 0);
  assert.ok(ch.edits.some((e) => /Stopping it \(ran \d+s\)/.test(e.text)), 'the tap is acknowledged in place');
  assert.ok(ch.sentText.includes('🛑 Stopped.'), 'the task reports that it stopped');
});

test('bridge: the tap kills only the task it belongs to', async () => {
  resetState();
  const ch = makeBtnChannel();
  const rec = {};
  const bridge = makeBridge(stallableAgent(rec), { stream: false });

  const first = bridge.handleMessage(ch, { chatId: '1', text: 'the stuck one', from: 'u' });
  assert.ok(await until(() => rec.runs.length === 1));
  // /btw runs alongside rather than queueing, so two tasks are live at once.
  const second = bridge.handleMessage(ch, { chatId: '1', text: '/btw the healthy one', from: 'u' });
  assert.ok(await until(() => rec.runs.length === 2));
  assert.equal(bridge.activeTasks('1').length, 2);

  await rec.runs[0].onStall({ kind: 'idle', idleMs: 420000, elapsedMs: 430000 });
  await bridge.handleAction(ch, { chatId: '1', messageId: 99, data: lastButton(ch).data, from: 'u' });
  await first;

  assert.equal(rec.runs[0].signal.aborted, true);
  assert.equal(rec.runs[1].signal.aborted, false, 'the other task keeps running');
  assert.equal(bridge.activeTasks('1').length, 1);

  rec.runs[1].release();
  await second;
});

test('bridge: a tap that lost the race is not an error', async () => {
  resetState();
  const ch = makeBtnChannel();
  const rec = {};
  const bridge = makeBridge(stallableAgent(rec), { stream: false });

  const main = bridge.handleMessage(ch, { chatId: '1', text: 'slow then done', from: 'u' });
  assert.ok(await until(() => rec.runs.length === 1));
  await rec.runs[0].onStall({ kind: 'idle', idleMs: 420000, elapsedMs: 430000 });
  const btn = lastButton(ch);

  // It finishes on its own before the tap lands.
  rec.runs[0].release();
  await main;
  await bridge.handleAction(ch, { chatId: '1', messageId: 99, data: btn.data, from: 'u' });

  assert.ok(ch.edits.some((e) => e.text === 'That task already finished.'));
});

test('bridge: the kill button is retired once the task is over', async () => {
  resetState();
  const ch = makeBtnChannel();
  const rec = {};
  const bridge = makeBridge(stallableAgent(rec), { stream: false });

  const main = bridge.handleMessage(ch, { chatId: '1', text: 'finishes eventually', from: 'u' });
  assert.ok(await until(() => rec.runs.length === 1));
  await rec.runs[0].onStall({ kind: 'idle', idleMs: 420000, elapsedMs: 430000 });
  const noticeId = ch.nextId - 1;

  rec.runs[0].release();
  await main;

  assert.ok(
    ch.edits.some((e) => e.messageId === noticeId && e.text === 'That task is no longer running.'),
    'the notice is edited so a later tap cannot read as still killable',
  );
});

test('bridge: both caps read the same, only the elapsed time differs', async () => {
  resetState();
  const ch = makeBtnChannel();
  const rec = {};
  const bridge = makeBridge(stallableAgent(rec), { stream: false });

  const main = bridge.handleMessage(ch, { chatId: '1', text: 'very long', from: 'u' });
  assert.ok(await until(() => rec.runs.length === 1));
  await rec.runs[0].onStall({ kind: 'timeout', limitMs: 1800000, elapsedMs: 1800000 });

  // Which cap fired is an implementation detail; the reader only needs to know
  // it is slow and that they can stop it. So idle and hard-cap read identically.
  assert.equal(
    ch.sentText.at(-1),
    '\u23F3 This is taking longer than usual (30m so far). Still running.',
  );
  assert.equal(lastButton(ch).text, '\u{1F6D1} Stop');

  rec.runs[0].release();
  await main;
});

test('bridge: the notice counts in seconds while under a minute', async () => {
  resetState();
  const ch = makeBtnChannel();
  const rec = {};
  const bridge = makeBridge(stallableAgent(rec), { stream: false });

  const main = bridge.handleMessage(ch, { chatId: '1', text: 'briefly quiet', from: 'u' });
  assert.ok(await until(() => rec.runs.length === 1));
  await rec.runs[0].onStall({ kind: 'idle', idleMs: 45000, elapsedMs: 45000 });

  assert.equal(
    ch.sentText.at(-1),
    '\u23F3 This is taking longer than usual (45s so far). Still running.',
  );

  rec.runs[0].release();
  await main;
});

test('bridge: an unauthorized chat cannot tap a kill button', async () => {
  resetState();
  const ch = makeBtnChannel(['1']);
  const rec = {};
  const bridge = makeBridge(stallableAgent(rec), { stream: false });

  const main = bridge.handleMessage(ch, { chatId: '1', text: 'mine', from: 'u' });
  assert.ok(await until(() => rec.runs.length === 1));
  await rec.runs[0].onStall({ kind: 'idle', idleMs: 420000, elapsedMs: 430000 });

  await bridge.handleAction(ch, { chatId: '9', messageId: 99, data: lastButton(ch).data, from: 'stranger' });
  assert.equal(rec.runs[0].signal.aborted, false, 'someone else cannot kill this task');
  assert.equal(bridge.activeTasks('1').length, 1);

  rec.runs[0].release();
  await main;
});

test('bridge: a task that never stalls gets no button at all', async () => {
  resetState();
  const ch = makeBtnChannel();
  const rec = {};
  const bridge = makeBridge(stallableAgent(rec), { stream: false });

  const main = bridge.handleMessage(ch, { chatId: '1', text: 'quick', from: 'u' });
  assert.ok(await until(() => rec.runs.length === 1));
  rec.runs[0].release();
  await main;

  assert.equal(kills(ch), 0);
});
