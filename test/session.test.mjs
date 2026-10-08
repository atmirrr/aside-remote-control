// Tests for real session continuity and /steer.
//
// The Aside CLI prints "created new session: <id>" as its first output line and
// accepts `aside session resume <id> <prompt>` / `aside session steer <id>
// <prompt>`. Three layers are covered:
//   1. Agent.run() reports the id the moment it is printed (onSession), so the
//      bridge can steer or stop a task that is still running.
//   2. Config defaults use the resume subcommand, and an old config file with
//      the broken `--session` args self-heals on load.
//   3. Bridge resumes the chat's session on follow-ups (no client-side replay),
//      replays history only when it has to start fresh, and routes /steer to
//      the running task's session.
//
// Run with an isolated state dir so the real ~/.aside-remote is never touched:
//   ASIDE_REMOTE_HOME=$(mktemp -d) node --test test/session.test.mjs
//
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { Bridge } from '../src/bridge.js';
import { Agent } from '../src/agent.js';
import { sessions, history, HOME, loadConfig, SESSION_REGEX, RESUME_ARGS } from '../src/config.js';

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

const ID = 'f6MmbGYWu3JxduAb';

// A fake `aside` CLI. Called as a task (`<prompt>` or `session resume <id>
// <prompt>`) it prints the CLI's announcement line, waits, then answers. Called
// as `session list|steer|stop` it prints what the real CLI prints.
function writeFakeAside() {
  const p = path.join(HOME, 'fake-aside.mjs');
  fs.writeFileSync(p, [
    'const a = process.argv.slice(2);',
    `const ID = ${JSON.stringify(ID)};`,
    "if (a[0] === 'session') {",
    "  const verb = a[1];",
    "  if (verb === 'list') { process.stdout.write(`${ID}  running  ephemeral  PONG response test  2026-09-22T15:40:14.000Z\\nWMm4phZFHoXPu7AN  idle  persistent  Starting Telegram bridge changes  2026-09-22T15:42:16.000Z\\n`); process.exit(0); }",
    "  if (verb === 'steer' || verb === 'stop') {",
    "    if (a[2] !== ID) { process.stdout.write(`\\n\\n \\u2022 Error Session not found: ${a[2]}\\n`); process.exit(0); }",
    "    process.stdout.write('ok  running\\n'); process.exit(0);",
    "  }",
    "  if (verb === 'resume') {",
    "    if (a[2] !== ID) { process.stdout.write(`continuing existing session: ${a[2]}\\n\\n \\u2022 Error Session not found: ${a[2]}\\n`); process.exit(0); }",
    "    process.stdout.write(`continuing existing session: ${a[2]}\\n`);",
    "    setTimeout(() => { process.stdout.write(`RESUMED: ${a.slice(3).join(' ')}\\n`); process.exit(0); }, 150);",
    "  }",
    "} else {",
    "  process.stdout.write(`created new session: ${ID}\\n`);",
    "  setTimeout(() => { process.stdout.write(`NEW: ${a.join(' ')}\\n`); process.exit(0); }, 400);",
    "}",
  ].join('\n'));
  return p;
}

function fakeAgent(extra = {}) {
  const fake = writeFakeAside();
  // The fake is a node script, so the "CLI" is `node fake-aside.mjs ...`. The
  // session subcommands go through cfg.command directly, so point that at a
  // tiny shell shim rather than at node with a baked-in first arg.
  const shim = path.join(HOME, 'fake-aside.sh');
  fs.writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${fake}" "$@"\n`, { mode: 0o755 });
  return new Agent({
    command: shim, newArgs: [], continueArgs: [...RESUME_ARGS], wrapper: [],
    sessionRegex: SESSION_REGEX, timeoutMs: 6000, ...extra,
  });
}

// =====================  parseSession with the shipped regex  ===============
test('parseSession: default regex reads the CLI announcement lines', () => {
  const a = new Agent({ sessionRegex: SESSION_REGEX });
  assert.equal(a.parseSession(`Aside CLI 1.26.916 is available.\n\ncreated new session: ${ID}\n\nPONG`), ID);
  assert.equal(a.parseSession(`continuing existing session: ${ID}\n\nPONG`), ID);
});
test('parseSession: default regex ignores prose about sessions', () => {
  const a = new Agent({ sessionRegex: SESSION_REGEX });
  assert.equal(a.parseSession('Started a fresh session activity log for the session: abcdef'), null);
  assert.equal(a.parseSession('created new session: tooshort'), null);
});

// =====================  Agent.run: id announced while running  =============
test('run: onSession fires with the id before the task finishes', async () => {
  const agent = fakeAgent();
  let announcedId = null;
  let finishedWhenAnnounced = null;
  let finished = false;
  const p = agent.run({ prompt: 'do the thing', onSession: (id) => { announcedId = id; finishedWhenAnnounced = finished; } });
  const res = await p.then((r) => { finished = true; return r; });
  assert.equal(announcedId, ID);
  assert.equal(finishedWhenAnnounced, false, 'the id must be announced while the task is still running');
  assert.equal(res.sessionId, ID);
  assert.match(res.text, /NEW: do the thing/);
});

test('run: a resumed session keeps its id and does not re-announce', async () => {
  const agent = fakeAgent();
  let calls = 0;
  const res = await agent.run({ prompt: 'again', sessionId: ID, onSession: () => { calls++; } });
  assert.equal(calls, 0);
  assert.equal(res.sessionId, ID);
  assert.equal(res.sessionMissing, false);
  assert.match(res.text, /RESUMED: again/);
});

test('run: resume args are `session resume <id> <prompt>`', () => {
  const agent = fakeAgent();
  assert.deepEqual(agent.buildArgs('hi there', ID), ['session', 'resume', ID, 'hi there']);
  assert.deepEqual(agent.buildArgs('hi there', null), ['hi there']);
});

test('run: a rejected id is flagged sessionMissing', async () => {
  const agent = fakeAgent();
  const res = await agent.run({ prompt: 'again', sessionId: 'bogusbogusbogus1' });
  assert.equal(res.sessionMissing, true);
});

// =====================  session subcommands  ===============================
test('steer: ok on a known session, notFound on an unknown one', async () => {
  const agent = fakeAgent();
  const ok = await agent.steer(ID, 'use the csv');
  assert.equal(ok.ok, true);
  assert.equal(ok.notFound, false);
  const bad = await agent.steer('bogusbogusbogus1', 'x');
  assert.equal(bad.ok, false);
  assert.equal(bad.notFound, true);
});

test('listSessions parses the two-space-separated rows', async () => {
  const agent = fakeAgent();
  const rows = await agent.listSessions();
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], { id: ID, status: 'running', tier: 'ephemeral', title: 'PONG response test', updatedAt: '2026-09-22T15:40:14.000Z' });
  const live = await agent.sessionStatus(ID);
  assert.equal(live.status, 'running');
  assert.equal(await agent.sessionStatus('nope'), null);
});

test('sessionCommand: a missing CLI binary is an error, not a throw', async () => {
  const agent = new Agent({ command: 'no-such-aside-binary-zzz', sessionRegex: SESSION_REGEX });
  const r = await agent.steer(ID, 'x');
  assert.equal(r.ok, false);
  assert.ok(r.err);
});

test('abort also asks Aside to stop the session it owns', async () => {
  const agent = fakeAgent();
  const stops = [];
  agent.stopSession = async (id) => { stops.push(id); return { ok: true }; };
  const controller = new AbortController();
  const p = agent.run({ prompt: 'slow', onSession: () => controller.abort(), signal: controller.signal });
  const res = await p;
  assert.equal(res.aborted, true);
  assert.deepEqual(stops, [ID]);
});

// =====================  loadConfig self-heal  ==============================
test('loadConfig: version-2 file with the broken --session args heals to resume + regex', () => {
  const cfgFile = path.join(HOME, 'config.json');
  const saved = fs.existsSync(cfgFile) ? fs.readFileSync(cfgFile) : null;
  try {
    fs.writeFileSync(cfgFile, JSON.stringify({
      version: 2,
      agent: { command: '/x/aside', newArgs: [], continueArgs: ['--session', '{session}'], sessionRegex: null, wrapper: [] },
      channels: [],
    }));
    const cfg = loadConfig();
    assert.equal(cfg.version, 3);
    assert.deepEqual(cfg.agent.continueArgs, RESUME_ARGS);
    assert.equal(cfg.agent.sessionRegex, SESSION_REGEX);
    assert.equal(cfg.agent.command, '/x/aside');
  } finally {
    if (saved) fs.writeFileSync(cfgFile, saved); else fs.rmSync(cfgFile, { force: true });
  }
});

test('loadConfig: custom continueArgs and a custom regex are left alone', () => {
  const cfgFile = path.join(HOME, 'config.json');
  const saved = fs.existsSync(cfgFile) ? fs.readFileSync(cfgFile) : null;
  try {
    fs.writeFileSync(cfgFile, JSON.stringify({
      version: 2,
      agent: { continueArgs: ['--resume', '{session}'], sessionRegex: 'sid=(\\w+)', wrapper: [] },
      channels: [],
    }));
    const cfg = loadConfig();
    assert.deepEqual(cfg.agent.continueArgs, ['--resume', '{session}']);
    assert.equal(cfg.agent.sessionRegex, 'sid=(\\w+)');
  } finally {
    if (saved) fs.writeFileSync(cfgFile, saved); else fs.rmSync(cfgFile, { force: true });
  }
});

// =====================  Bridge  ============================================
function makeChannel(authorized = ['1']) {
  return {
    id: 'test-chan',
    sentText: [],
    isAuthorized(chatId) { return authorized.includes(String(chatId)); },
    async sendText(_chatId, t) { this.sentText.push(t); },
    async sendTyping() {},
    async sendImages() {},
  };
}
function makeBridge(agentStub, agentCfg = {}) {
  const bridge = new Bridge({ agent: { command: 'unused', context: true, ...agentCfg }, channels: [] });
  bridge.agent = agentStub;
  return bridge;
}
const ok = (text, extra = {}) => ({ text, raw: text, sessionId: null, code: 0, error: false, sessionMissing: false, ...extra });

test('bridge: first task starts fresh, announced id is stored and the follow-up resumes it with a bare prompt', async () => {
  resetState();
  const calls = [];
  const stub = {
    async run({ prompt, sessionId, onSession }) {
      calls.push({ prompt, sessionId });
      if (!sessionId) { onSession(ID); return ok('first answer', { sessionId: ID }); }
      return ok('second answer', { sessionId });
    },
  };
  const bridge = makeBridge(stub);
  const ch = makeChannel();
  await bridge.handleMessage(ch, { chatId: '1', text: 'find x' });
  assert.equal(sessions.get('test-chan', '1'), ID);
  await bridge.handleMessage(ch, { chatId: '1', text: 'now the second one' });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].sessionId, null);
  assert.equal(calls[0].prompt, 'find x');
  assert.equal(calls[1].sessionId, ID);
  // Resumed: the prompt is just the message, no replayed transcript.
  assert.equal(calls[1].prompt, 'now the second one');
  // History is still recorded, for the fallback.
  assert.equal(history.get('test-chan', '1').length, 4);
});

test('bridge: a rejected id retries fresh with the replayed history', async () => {
  resetState();
  sessions.set('test-chan', '1', 'stalestalestale1');
  history.append('test-chan', '1', 'user', 'earlier question');
  history.append('test-chan', '1', 'assistant', 'earlier answer');
  const calls = [];
  const stub = {
    async run({ prompt, sessionId, onSession }) {
      calls.push({ prompt, sessionId });
      if (sessionId) return ok('Session not found', { sessionId, sessionMissing: true });
      onSession(ID);
      return ok('fresh answer', { sessionId: ID });
    },
  };
  const bridge = makeBridge(stub);
  const ch = makeChannel();
  await bridge.handleMessage(ch, { chatId: '1', text: 'follow up' });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].sessionId, 'stalestalestale1');
  assert.equal(calls[0].prompt, 'follow up');
  assert.equal(calls[1].sessionId, null);
  assert.match(calls[1].prompt, /User: earlier question/);
  assert.match(calls[1].prompt, /<assistant>earlier answer<\/assistant>/);
  assert.match(calls[1].prompt, /User: follow up$/);
  assert.equal(sessions.get('test-chan', '1'), ID);
});

test('bridge: /steer with nothing running says so', async () => {
  resetState();
  const bridge = makeBridge({ async run() { return ok('x'); }, async steer() { throw new Error('must not be called'); } });
  const ch = makeChannel();
  await bridge.handleMessage(ch, { chatId: '1', text: '/steer use the csv' });
  assert.match(ch.sentText.at(-1), /Nothing is running to steer/);
  await bridge.handleMessage(ch, { chatId: '1', text: '/steer' });
  assert.match(ch.sentText.at(-1), /Add the correction after \/steer/);
});

test('bridge: /steer reaches the running task once its id is known', async () => {
  resetState();
  let release;
  let announce;
  const steers = [];
  const stub = {
    run({ onSession }) {
      announce = () => onSession(ID);
      return new Promise((r) => { release = () => r(ok('done', { sessionId: ID })); });
    },
    async steer(id, text) { steers.push({ id, text }); return { ok: true, out: 'ok  running', err: '', notFound: false }; },
  };
  const bridge = makeBridge(stub);
  const ch = makeChannel();
  const task = bridge.handleMessage(ch, { chatId: '1', text: 'long task' });
  assert.ok(await until(() => bridge.activeTasks('1').length === 1));
  // Before the CLI has printed the id there is nothing to address.
  await bridge.handleMessage(ch, { chatId: '1', text: '/steer not yet' });
  assert.match(ch.sentText.at(-1), /has not reported its session id yet/);
  assert.equal(steers.length, 0);
  announce();
  assert.equal(sessions.get('test-chan', '1'), ID);
  const sentBefore = ch.sentText.length;
  await bridge.handleMessage(ch, { chatId: '1', text: '/steer use the csv, not the web' });
  assert.deepEqual(steers, [{ id: ID, text: 'use the csv, not the web' }]);
  // Silent on success: the running task's reply is the confirmation.
  assert.equal(ch.sentText.length, sentBefore);
  assert.match(history.get('test-chan', '1').map((t) => t.text).join(' | '), /use the csv, not the web/);
  // /steer is a command: it must not have queued a task behind the running one.
  assert.equal(bridge.pendingFor('1').length, 0);
  release();
  await task;
});

test('bridge: /steer relays a session-not-found from the CLI', async () => {
  resetState();
  let release;
  const stub = {
    run({ onSession }) { onSession(ID); return new Promise((r) => { release = () => r(ok('done', { sessionId: ID })); }); },
    async steer() { return { ok: false, out: ' • Error Session not found', err: '', notFound: true }; },
  };
  const bridge = makeBridge(stub);
  const ch = makeChannel();
  const task = bridge.handleMessage(ch, { chatId: '1', text: 'long task' });
  assert.ok(await until(() => bridge.activeTasks('1').length === 1 && bridge.activeTasks('1')[0].sessionId === ID));
  await bridge.handleMessage(ch, { chatId: '1', text: '/steer x' });
  assert.match(ch.sentText.at(-1), /no longer knows that session/);
  release();
  await task;
});

test('bridge: /status shows the session, its live state, and what is running', async () => {
  resetState();
  const bridge = makeBridge({
    async run() { return ok('x'); },
    async sessionStatus(id) { return id === ID ? { id, status: 'idle', tier: 'ephemeral', title: 'PONG response test' } : null; },
  });
  const ch = makeChannel();
  await bridge.handleMessage(ch, { chatId: '1', text: '/status' });
  assert.match(ch.sentText.at(-1), /No session yet/);
  sessions.set('test-chan', '1', ID);
  await bridge.handleMessage(ch, { chatId: '1', text: '/status' });
  assert.match(ch.sentText.at(-1), new RegExp(`Session: ${ID}`));
  assert.match(ch.sentText.at(-1), /Aside reports it idle — "PONG response test"/);
  assert.match(ch.sentText.at(-1), /Nothing is running/);
});

// =====================  bubble rotation on steer  ==========================
// A streaming channel: the reply is edited into one message in place. Steering
// must leave that message as it is and continue in a new one below.
function makeStreamChannel() {
  return {
    id: 'test-chan',
    sentText: [],
    edits: [],
    nextId: 1,
    isAuthorized() { return true; },
    async sendText(_chatId, t) { this.sentText.push(t); return this.nextId++; },
    async editText(_chatId, messageId, t) { this.edits.push({ messageId, text: t }); return true; },
    async sendTyping() {},
    async sendImages() {},
  };
}

test('bridge: a steer rotates the streamed reply into a new message below', async () => {
  resetState();
  let emit;
  let finish;
  const stub = {
    run({ onData, onSession }) {
      onSession(ID);
      emit = onData;
      return new Promise((r) => { finish = (raw) => r(ok('x', { raw, sessionId: ID })); });
    },
    async steer() { return { ok: true, out: 'ok  running', err: '', notFound: false }; },
  };
  const bridge = makeBridge(stub, { streamThrottleMs: 10 });
  const ch = makeStreamChannel();
  const task = bridge.handleMessage(ch, { chatId: '1', text: 'long task' });
  assert.ok(await until(() => bridge.activeTasks('1').length === 1));
  const firstId = ch.sentText.length; // the "Thinking..." placeholder's id
  emit('first part of the answer\n');
  assert.ok(await until(() => ch.edits.some((e) => e.messageId === firstId && /first part/.test(e.text))));

  await bridge.handleMessage(ch, { chatId: '1', text: '/steer change course' });
  // A new placeholder went out below, and nothing else was said.
  assert.equal(ch.sentText.length, firstId + 1);
  assert.match(ch.sentText.at(-1), /Thinking/);
  const secondId = ch.sentText.length;

  emit('second part after steer\n');
  assert.ok(await until(() => ch.edits.some((e) => e.messageId === secondId && /second part/.test(e.text))));
  // The old message never received the post-steer text; it kept what it had
  // with the interruption stamped under it.
  assert.ok(!ch.edits.some((e) => e.messageId === firstId && /second part/.test(e.text)));
  assert.equal(ch.edits.filter((e) => e.messageId === firstId).at(-1).text, 'first part of the answer\n\nInterrupted!');

  finish('first part of the answer\nsecond part after steer\n');
  await task;
  const finalEdit = ch.edits.filter((e) => e.messageId === secondId).at(-1);
  assert.equal(finalEdit.text, 'second part after steer');
  assert.ok(!ch.edits.filter((e) => e.messageId === firstId).some((e) => /second part/.test(e.text)));
});

test('bridge: a dim span open at the cut is not shown as answer text in the new message', async () => {
  resetState();
  let emit;
  let finish;
  const stub = {
    run({ onData, onSession }) {
      onSession(ID);
      emit = onData;
      return new Promise((r) => { finish = (raw) => r(ok('x', { raw, sessionId: ID })); });
    },
    async steer() { return { ok: true, out: 'ok  running', err: '', notFound: false }; },
  };
  const bridge = makeBridge(stub, { streamThrottleMs: 10 });
  const ch = makeStreamChannel();
  const task = bridge.handleMessage(ch, { chatId: '1', text: 'long task' });
  assert.ok(await until(() => bridge.activeTasks('1').length === 1));
  const before = 'answer so far\n\x1b[2mtool output begins ';
  emit(before);
  await bridge.handleMessage(ch, { chatId: '1', text: '/steer go' });
  const secondId = ch.sentText.length;
  const after = 'still tool output\x1b[0m\nreal reply\n';
  emit(after);
  finish(before + after);
  await task;
  const finalEdit = ch.edits.filter((e) => e.messageId === secondId).at(-1);
  assert.equal(finalEdit.text, 'real reply');
});

test('bridge: a steer before any answer text turns the placeholder into "Interrupted!"', async () => {
  resetState();
  let finish;
  const stub = {
    run({ onSession }) { onSession(ID); return new Promise((r) => { finish = () => r(ok('x', { raw: 'reply\n', sessionId: ID })); }); },
    async steer() { return { ok: true, out: 'ok  running', err: '', notFound: false }; },
  };
  const bridge = makeBridge(stub, { streamThrottleMs: 10 });
  const ch = makeStreamChannel();
  ch.deleted = [];
  ch.deleteMessage = async (_c, id) => { ch.deleted.push(id); return true; };
  const task = bridge.handleMessage(ch, { chatId: '1', text: 'long task' });
  assert.ok(await until(() => bridge.activeTasks('1').length === 1));
  const firstId = ch.sentText.length;
  await bridge.handleMessage(ch, { chatId: '1', text: '/steer go' });
  assert.deepEqual(ch.deleted, []);
  assert.equal(ch.edits.filter((e) => e.messageId === firstId).at(-1).text, 'Interrupted!');
  finish();
  await task;
});
