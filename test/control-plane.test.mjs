// M2: control plane — non-blocking dispatch, queue, cancel, shutdown.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { Bridge } from '../src/bridge.js';
import { Channel } from '../src/channels/base.js';
import { registerChannel } from '../src/channels/index.js';
import { HOME } from '../src/config.js';
import { makeBridge, makeChannel, waitFor, FAKE_ASIDE } from './helpers.mjs';

const logLines = (argvLog) => () => {
  try { return readFileSync(argvLog, 'utf8').trim().split('\n').filter(Boolean).length; } catch { return 0; }
};
const lastSent = (ch) => String(ch.sent.at(-1)?.text ?? '');

// A channel whose start() drives onMessage like a real poll loop would.
class LoopChannel extends Channel {
  static type = 'loop';
  static label = 'Loop';
  constructor(cfg) {
    super(cfg);
    this.feed = [];
    this.sent = [];
    this.onMessageReturns = [];
    LoopChannel.last = this;
  }
  async sendText(chatId, text) { this.sent.push({ chatId, text }); }
  async start({ onMessage, signal }) {
    while (!signal.aborted) {
      const m = this.feed.shift();
      if (m) this.onMessageReturns.push(onMessage(m));
      else await new Promise((r) => setTimeout(r, 10));
    }
  }
}
registerChannel(LoopChannel);

function loopBridge({ hang = true, spawnChild = null } = {}) {
  const argvLog = path.join(HOME, `fake-aside-loop-${Math.random().toString(36).slice(2)}.log`);
  process.env.FAKE_ASIDE = JSON.stringify({ argvLog, hang, spawnChild });
  process.env.FAKE_ASIDE_STATE = path.join(HOME, 'fake-aside-loop-state.json');
  const config = {
    version: 1,
    agent: {
      command: FAKE_ASIDE, wrapper: [], newArgs: [],
      continueArgs: ['--session', '{session}'],
      sessionRegex: 'created new session: ([A-Za-z0-9_-]+)',
      timeoutMs: 10000, idleTimeoutMs: 0, stream: false,
      context: false, contextMaxChars: 2000, maxConcurrent: 1, maxQueuePerChat: 5,
    },
    voice: { enabled: false },
    attachments: { enabled: false },
    commands: { menu: true, hidden: [] },
    channels: [{ id: 'loop', type: 'loop', label: 'L', allowedChatIds: [] }],
  };
  return { bridge: new Bridge(config), argvLog };
}

test('/cancel kills a hanging task and its grandchild', async () => {
  const gcFile = path.join(HOME, 'grandchild.pid');
  const { bridge, channel, argvLog } = makeBridge({ fakeAside: { hang: true, spawnChild: gcFile } });
  const p = bridge.handleMessage(channel, { chatId: 1, text: 'long task', from: 'u' });
  assert.ok(await waitFor(() => existsSync(gcFile), { timeoutMs: 5000 }), 'task should have spawned a grandchild');
  const gcPid = Number(readFileSync(gcFile, 'utf8').trim());
  await bridge.handleMessage(channel, { chatId: 1, text: '/cancel', from: 'u' });
  assert.ok(channel.sent.some((s) => /🛑 Cancelled \(ran \d+s\)\./.test(String(s.text))), `cancel reply missing in: ${JSON.stringify(channel.sent)}`);
  await p;
  assert.ok(channel.sent.some((s) => String(s.text) === '🛑 Cancelled.'), 'task final message is the cancelled marker');
  const dead = await waitFor(() => { try { process.kill(gcPid, 0); return false; } catch { return true; } }, { timeoutMs: 5000 });
  assert.ok(dead, `grandchild ${gcPid} should be dead`);
});

test('three messages from one chat run in order with queued notices', async () => {
  const { bridge, channel, argvLog } = makeBridge({ fakeAside: { lines: ['done'], delayMs: 40 }, agent: { context: false } });
  const p1 = bridge.handleMessage(channel, { chatId: 1, text: 'one', from: 'u' });
  const p2 = bridge.handleMessage(channel, { chatId: 1, text: 'two', from: 'u' });
  const p3 = bridge.handleMessage(channel, { chatId: 1, text: 'three', from: 'u' });
  await Promise.all([p1, p2, p3]);
  const prompts = readFileSync(argvLog, 'utf8').trim().split('\n').map((l) => JSON.parse(l).at(-1));
  assert.deepEqual(prompts, ['one', 'two', 'three']);
  assert.ok(channel.sent.some((s) => String(s.text) === '⏳ Queued (#1)'));
  assert.ok(channel.sent.some((s) => String(s.text) === '⏳ Queued (#2)'));
});

test('queue overflow refuses with the cap and a hint', async () => {
  const { bridge, channel } = makeBridge({ fakeAside: { hang: true }, agent: { maxQueuePerChat: 2 } });
  const p1 = bridge.handleMessage(channel, { chatId: 1, text: 'a', from: 'u' });
  const p2 = bridge.handleMessage(channel, { chatId: 1, text: 'b', from: 'u' });
  const p3 = bridge.handleMessage(channel, { chatId: 1, text: 'c', from: 'u' });
  const p4 = bridge.handleMessage(channel, { chatId: 1, text: 'd', from: 'u' });
  await p4;
  assert.ok(channel.sent.some((s) => String(s.text) === 'Queue is full (2). /cancel to clear.'));
  await bridge.handleMessage(channel, { chatId: 1, text: '/cancel', from: 'u' });
  await Promise.all([p1, p2, p3]);
});

test('cap=1 serializes two chats; cap=2 runs them in parallel', async () => {
  const a = makeBridge({ fakeAside: { hang: true } });
  const chB = makeChannel();
  const pA = a.bridge.handleMessage(a.channel, { chatId: 'A', text: 'a', from: 'u' });
  const pB = a.bridge.handleMessage(chB, { chatId: 'B', text: 'b', from: 'u' });
  assert.ok(await waitFor(() => logLines(a.argvLog)() >= 1, { timeoutMs: 5000 }));
  assert.equal(logLines(a.argvLog)(), 1, 'only chat A runs under cap=1');
  assert.ok(chB.sent.some((s) => String(s.text).startsWith('⏳ Queued')));
  await a.bridge.handleMessage(a.channel, { chatId: 'A', text: '/cancel', from: 'u' });
  await pB;
  assert.equal(logLines(a.argvLog)(), 2, 'chat B runs after A is cancelled');
  await pA;

  const b = makeBridge({ fakeAside: { hang: true }, agent: { maxConcurrent: 2 } });
  const c1 = makeChannel();
  const c2 = makeChannel();
  const q1 = b.bridge.handleMessage(c1, { chatId: 'X', text: 'x', from: 'u' });
  const q2 = b.bridge.handleMessage(c2, { chatId: 'Y', text: 'y', from: 'u' });
  assert.ok(await waitFor(() => logLines(b.argvLog)() === 2, { timeoutMs: 5000 }), 'both chats run under cap=2');
  await b.bridge.handleMessage(c1, { chatId: 'X', text: '/cancel', from: 'u' });
  await b.bridge.handleMessage(c2, { chatId: 'Y', text: '/cancel', from: 'u' });
  await Promise.all([q1, q2]);
});

test('/cancel with only queued items drops them', async () => {
  const { bridge, channel, argvLog } = makeBridge({ fakeAside: { hang: true } });
  const chB = makeChannel();
  const pA = bridge.handleMessage(channel, { chatId: 'A', text: 'a', from: 'u' });
  const pB = bridge.handleMessage(chB, { chatId: 'B', text: 'b', from: 'u' });
  assert.ok(await waitFor(() => logLines(argvLog)() === 1));
  await bridge.handleMessage(chB, { chatId: 'B', text: '/cancel', from: 'u' });
  assert.match(lastSent(chB), /Dropped 1 queued\./);
  await bridge.handleMessage(channel, { chatId: 'A', text: '/cancel', from: 'u' });
  await Promise.all([pA, pB]);
});

test('/queue lists pending items and /queue clear drops them', async () => {
  const { bridge, channel } = makeBridge({ fakeAside: { hang: true } });
  const chB = makeChannel();
  const pA = bridge.handleMessage(channel, { chatId: 'A', text: 'a', from: 'u' });
  const pB1 = bridge.handleMessage(chB, { chatId: 'B', text: 'b-one', from: 'u' });
  const pB2 = bridge.handleMessage(chB, { chatId: 'B', text: 'b-two', from: 'u' });
  assert.ok(await waitFor(() => chB.sent.some((s) => String(s.text).startsWith('⏳ Queued')), { timeoutMs: 5000 }));
  await bridge.handleMessage(chB, { chatId: 'B', text: '/queue', from: 'u' });
  assert.match(lastSent(chB), /#1 \d+s: b-one/);
  assert.match(lastSent(chB), /#2 \d+s: b-two/);
  await bridge.handleMessage(chB, { chatId: 'B', text: '/queue clear', from: 'u' });
  assert.match(lastSent(chB), /Dropped 2 queued\./);
  await bridge.handleMessage(channel, { chatId: 'A', text: '/cancel', from: 'u' });
  await Promise.all([pA, pB1, pB2]);
});

test('/new mid-task cancels the running task first and leaves no history', async () => {
  const { bridge, channel, home, argvLog } = makeBridge({ fakeAside: { hang: true } });
  const p = bridge.handleMessage(channel, { chatId: 1, text: 'task', from: 'u' });
  assert.ok(await waitFor(() => logLines(argvLog)() === 1));
  await bridge.handleMessage(channel, { chatId: 1, text: '/new', from: 'u' });
  assert.ok(channel.sent.some((s) => /Started a fresh session\./.test(String(s.text))), `fresh-session reply missing in: ${JSON.stringify(channel.sent)}`);
  await p;
  assert.ok(channel.sent.some((s) => String(s.text) === '🛑 Cancelled.'));
  let hist = {};
  try { hist = JSON.parse(readFileSync(path.join(home, 'history.json'), 'utf8')); } catch {}
  assert.ok(!hist['test:1'], 'cancelled turn must leave no history');
});

test('/status gains running/queued lines but keeps the session first line', async () => {
  const { bridge, channel, argvLog } = makeBridge({ fakeAside: { hang: true } });
  const chB = makeChannel();
  const pA = bridge.handleMessage(channel, { chatId: 'A', text: 'running-task', from: 'u' });
  const pB = bridge.handleMessage(chB, { chatId: 'B', text: 'queued-task', from: 'u' });
  assert.ok(await waitFor(() => logLines(argvLog)() === 1));
  await bridge.handleMessage(chB, { chatId: 'B', text: '/status', from: 'u' });
  assert.match(lastSent(chB), /No active session yet\. Send a task to start one\./, 'first line unchanged');
  assert.match(lastSent(chB), /Queued: 1/);
  await bridge.handleMessage(channel, { chatId: 'A', text: '/status', from: 'u' });
  assert.match(lastSent(channel), /Running: \d+s — running-task/);
  await bridge.handleMessage(channel, { chatId: 'A', text: '/cancel', from: 'u' });
  await Promise.all([pA, pB]);
});

test('bridge.start: onMessage returns undefined and shutdown aborts running tasks', async () => {
  const gcFile = path.join(HOME, 'grandchild-loop.pid');
  const { bridge, argvLog } = loopBridge({ hang: true, spawnChild: gcFile });
  const startP = bridge.start();
  assert.ok(await waitFor(() => !!LoopChannel.last, { timeoutMs: 5000 }), 'loop channel should be created');
  const ch = LoopChannel.last;
  ch.feed.push({ chatId: 1, text: 'hang task', from: 'u' });
  assert.ok(await waitFor(() => logLines(argvLog)() === 1), 'task should spawn');
  assert.equal(ch.onMessageReturns[0], undefined, 'onMessage must not return the task promise');

  const origExit = process.exit;
  let exitCode = null;
  process.exit = (c) => { exitCode = c; };
  try {
    process.emit('SIGINT');
    process.emit('SIGINT'); // second signal exits immediately
    assert.ok(await waitFor(() => ch.sent.some((s) => String(s.text) === '🛑 Cancelled.'), { timeoutMs: 5000 }));
    assert.ok(await waitFor(() => exitCode !== null, { timeoutMs: 5000 }));
    assert.equal(exitCode, 0);
    const dead = await waitFor(() => { try { process.kill(Number(readFileSync(gcFile, 'utf8').trim()), 0); return false; } catch { return true; } }, { timeoutMs: 5000 });
    assert.ok(dead, 'shutdown must kill the grandchild');
    await startP;
  } finally {
    process.exit = origExit;
    process.removeAllListeners('SIGINT');
    process.removeAllListeners('SIGTERM');
  }
});
