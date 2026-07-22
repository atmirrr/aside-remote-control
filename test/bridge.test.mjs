// In-process tests for the bridge/agent/util logic.
//
// These use a STUB agent (no real `aside` CLI, no browser) so they are fast,
// deterministic, and safe to run anywhere. They cover the paths that are
// impractical to exercise through a live Telegram round-trip: authorization,
// per-chat queue ordering, session self-heal, empty/!image output, and the
// terminal-output cleaning that the pseudo-TTY wrapper depends on.
//
// Run with an isolated state dir so the real ~/.aside-remote is never touched:
//   ASIDE_REMOTE_HOME=$(mktemp -d) node --test test/
//
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { Bridge } from '../src/bridge.js';
import { Channel } from '../src/channels/base.js';
import { TelegramChannel } from '../src/channels/telegram.js';
import { Agent } from '../src/agent.js';
import { sessions, history, HOME, loadConfig, PTY_DRIVER } from '../src/config.js';
import { cleanTerminalOutput, chunkText, findImagePaths } from '../src/util.js';

// Guard: refuse to run against a real home dir so we never clobber live state.
if (!process.env.ASIDE_REMOTE_HOME) {
  throw new Error('Set ASIDE_REMOTE_HOME to a temp dir before running these tests.');
}
fs.mkdirSync(HOME, { recursive: true });
const SESSIONS_FILE = path.join(HOME, 'sessions.json');
function resetSessions() {
  fs.writeFileSync(SESSIONS_FILE, '{}');
  fs.writeFileSync(path.join(HOME, 'history.json'), '{}');
}

// ---- stubs -----------------------------------------------------------------
function makeChannel(authorized = ['1']) {
  return {
    id: 'test-chan',
    sentText: [],
    typings: 0,
    images: [],
    albums: [],
    isAuthorized(chatId) { return authorized.includes(String(chatId)); },
    async sendText(_chatId, t) { this.sentText.push(t); },
    async sendTyping() { this.typings++; },
    async sendImage(_chatId, p) { this.images.push(p); },
    async sendImages(chatId, ps, caption) { this.albums.push(ps); return Channel.prototype.sendImages.call(this, chatId, ps, caption); },
  };
}

function makeBridge(runHandler, agentCfg = {}) {
  const bridge = new Bridge({ agent: { command: 'unused', ...agentCfg }, channels: [] });
  bridge.agent = { run: runHandler }; // swap in the stub
  return bridge;
}

const ok = (text, extra = {}) => ({ text, sessionId: null, code: 0, error: false, sessionMissing: false, ...extra });

// =====================  cleanTerminalOutput  =================================
test('cleanTerminalOutput: pty echo collapses to the answer', () => {
  assert.equal(cleanTerminalOutput('\x04\b\b4\x1b[0m\r\n'), '4');
});
test('cleanTerminalOutput: literal ^D echo is erased by backspaces', () => {
  assert.equal(cleanTerminalOutput('^D\b\b42\x1b[0m\r\n'), '42');
});
test('cleanTerminalOutput: CRLF multi-line is preserved', () => {
  assert.equal(cleanTerminalOutput('line one\r\nline two\r\n'), 'line one\nline two');
});
test('cleanTerminalOutput: spinner overwrite keeps final frame', () => {
  assert.equal(cleanTerminalOutput('loading...\rdone\r\n'), 'done');
});
test('cleanTerminalOutput: ANSI-only input becomes empty', () => {
  assert.equal(cleanTerminalOutput('\x1b[0m\r\n'), '');
});

// =====================  chunkText  ==========================================
test('chunkText: short text is a single chunk', () => {
  assert.deepEqual(chunkText('hello', 100), ['hello']);
});
test('chunkText: long text splits into pieces within the size limit', () => {
  const text = Array.from({ length: 200 }, (_, i) => `line ${i}`).join('\n');
  const chunks = chunkText(text, 200);
  assert.ok(chunks.length > 1);
  for (const c of chunks) assert.ok(c.length <= 200, `chunk too long: ${c.length}`);
  assert.equal(chunks.join('\n'), text); // lossless
});
test('chunkText: a single over-long line is hard-split', () => {
  const chunks = chunkText('x'.repeat(50), 10);
  assert.equal(chunks.length, 5);
  assert.ok(chunks.every((c) => c.length <= 10));
});

// =====================  findImagePaths  =====================================
test('findImagePaths: finds absolute/relative/home image paths', () => {
  const found = findImagePaths('see /a/b.png and ./c.jpg and ~/d.webp');
  assert.deepEqual(found.sort(), ['./c.jpg', '/a/b.png', '~/d.webp'].sort());
});
test('findImagePaths: ignores non-image paths', () => {
  assert.deepEqual(findImagePaths('/a/b.txt /c/d.md'), []);
});

// =====================  Agent.parseSession  =================================
test('parseSession: null regex never extracts a session id (no poisoning)', () => {
  const a = new Agent({ sessionRegex: null });
  assert.equal(a.parseSession('Started a fresh session activity log'), null);
});
test('parseSession: missing regex is treated as disabled', () => {
  const a = new Agent({});
  assert.equal(a.parseSession('session: abcdef'), null);
});

// =====================  Agent idle/stall timeout  ==========================
// A live `aside` agent that blocks on a local approval (writing to memory,
// editing a file) goes silent with no prompt on stdin, so the bridge would
// otherwise hang to the 30-min hard cap. The idle timer kills it early.
test('Agent.run: idle timeout kills a silent-but-alive process and flags it stalled', async () => {
  const a = new Agent({
    command: process.execPath, // node
    wrapper: [],               // spawn directly, no pty wrapper needed for the test
    // print once, then stay alive forever producing nothing (mimics the wedge)
    newArgs: ['-e', 'process.stdout.write("working\\n"); setInterval(() => {}, 1000);'],
    idleTimeoutMs: 1000,
    timeoutMs: 20000,
  });
  const t0 = Date.now();
  const res = await a.run({ prompt: 'x' });
  const ms = Date.now() - t0;
  assert.equal(res.stalled, true);
  assert.equal(res.code, -3);
  assert.equal(res.error, true);
  assert.match(res.text, /went silent/i);
  assert.ok(ms < 8000, `should stall fast, took ${ms}ms`);
});

test('Agent.run: idle timeout does not trip a process that finishes promptly', async () => {
  const a = new Agent({
    command: process.execPath,
    wrapper: [],
    newArgs: ['-e', 'process.stdout.write("hi\\n");'],
    idleTimeoutMs: 2000,
    timeoutMs: 20000,
  });
  const res = await a.run({ prompt: 'x' });
  assert.ok(!res.stalled);
  assert.equal(res.error, false);
  assert.match(res.text, /hi/);
});

// =====================  Agent auto-approve  ================================
// A fake "agent" CLI that prints an approval prompt and only finishes once it
// receives something on stdin — exactly the shape that would otherwise hang.
function writeFakeApprover() {
  const p = path.join(HOME, 'fake-approver.mjs');
  fs.writeFileSync(p, [
    "process.stdout.write('working on it...\\n');",
    "process.stdout.write('Approve this action? [y/N]\\n');",
    "let got = '';",
    "process.stdin.on('data', (d) => { got += d.toString();",
    "  if (got.length) { process.stdout.write('APPROVED, finished\\n'); process.exit(0); } });",
    "process.stdin.on('end', () => {});",
    // Self-timeout so a genuinely unanswered prompt fails fast instead of hanging.
    "setTimeout(() => { process.stdout.write('NO INPUT, gave up\\n'); process.exit(1); }, 2500);",
  ].join('\n'));
  return p;
}

test('autoApprove answers an interactive prompt instead of hanging to timeout', async () => {
  const fake = writeFakeApprover();
  const agent = new Agent({
    command: process.execPath, newArgs: [fake], continueArgs: [fake], wrapper: [],
    autoApprove: true, approvePromptRegex: '\\[y/n\\]|approve', approveInput: 'y\n',
    timeoutMs: 6000,
  });
  const res = await agent.run({ prompt: 'do the thing' });
  assert.ok(res.text.includes('APPROVED'), `expected approval, got: ${res.text}`);
  assert.equal(res.code, 0);
});

test('without autoApprove the same prompt goes unanswered (stdin is closed)', async () => {
  const fake = writeFakeApprover();
  const agent = new Agent({
    command: process.execPath, newArgs: [fake], continueArgs: [fake], wrapper: [],
    autoApprove: false, timeoutMs: 6000,
  });
  const res = await agent.run({ prompt: 'do the thing' });
  assert.ok(res.text.includes('NO INPUT'), `expected no-input path, got: ${res.text}`);
});

// =====================  Wrapper / error surfacing  =========================
// A wrapper or agent that fails must never leak its stderr (or a Python
// traceback from the pty driver) into chat — that leak was the original bug
// ("script: tcgetattr/ioctl: Operation not supported on socket"). stderr is
// kept on errorDetail for logging; the reply falls back to the placeholder.
test('stderr is never surfaced as the reply (kept on errorDetail)', async () => {
  const agent = new Agent({
    command: process.execPath,
    newArgs: ['-e', 'process.stderr.write("BOOM internal wrapper error"); process.exit(1)'],
    continueArgs: [], wrapper: [], timeoutMs: 6000,
  });
  const res = await agent.run({ prompt: 'x' });
  assert.equal(res.text, '(agent produced no output)');
  assert.equal(res.error, true);
  assert.match(res.errorDetail, /BOOM internal wrapper error/);
});

// The macOS python pty driver must exit quietly when the agent CLI can't be
// exec'd (missing/non-executable) instead of dumping a traceback onto the pty,
// which would be relayed to stdout and surface in chat as the "reply".
test('python pty driver does not leak a traceback when the agent CLI is missing',
  { skip: process.platform !== 'darwin' && 'darwin-only (needs python3 + pty)' }, async () => {
  const agent = new Agent({
    command: 'no-such-aside-binary-zzz', newArgs: [], continueArgs: [],
    wrapper: ['python3', '-c', PTY_DRIVER], timeoutMs: 6000,
  });
  const res = await agent.run({ prompt: 'x' });
  assert.doesNotMatch(res.raw || '', /Traceback/);
  assert.equal(res.text, '(agent produced no output)');
  assert.equal(res.code, 127);
});

// Existing installs persisted the broken `script -q /dev/null` wrapper; loading
// must self-heal it (and bump the stored version) without re-running setup.
test('loadConfig migrates a stale `script` wrapper off the broken default', () => {
  const cfgFile = path.join(HOME, 'config.json');
  const saved = fs.existsSync(cfgFile) ? fs.readFileSync(cfgFile) : null;
  try {
    fs.writeFileSync(cfgFile, JSON.stringify({
      version: 1,
      agent: { command: 'aside', wrapper: ['script', '-q', '/dev/null'] },
      channels: [],
    }));
    const cfg = loadConfig();
    assert.notEqual(cfg.agent.wrapper[0], 'script'); // healed to the platform default
    assert.equal(cfg.version, 2);
  } finally {
    if (saved) fs.writeFileSync(cfgFile, saved); else fs.rmSync(cfgFile, { force: true });
  }
});

// A genuinely custom wrapper must be preserved across the migration.
test('loadConfig preserves a custom (non-shipped) wrapper', () => {
  const cfgFile = path.join(HOME, 'config.json');
  const saved = fs.existsSync(cfgFile) ? fs.readFileSync(cfgFile) : null;
  try {
    fs.writeFileSync(cfgFile, JSON.stringify({
      version: 1,
      agent: { command: 'aside', wrapper: ['unbuffer', '-p'] },
      channels: [],
    }));
    const cfg = loadConfig();
    assert.deepEqual(cfg.agent.wrapper, ['unbuffer', '-p']);
  } finally {
    if (saved) fs.writeFileSync(cfgFile, saved); else fs.rmSync(cfgFile, { force: true });
  }
});

// =====================  Bridge in-chat commands  ============================
test('/help returns help text without invoking the agent', async () => {
  resetSessions();
  let called = 0;
  const bridge = makeBridge(async () => { called++; return ok('nope'); });
  const ch = makeChannel();
  await bridge.handleMessage(ch, { chatId: '1', text: '/help', from: 'u' });
  assert.equal(called, 0);
  assert.ok(ch.sentText.join('\n').includes('Aside Remote Control'));
});

test('/start is an alias for /help', async () => {
  resetSessions();
  const bridge = makeBridge(async () => ok('x'));
  const ch = makeChannel();
  await bridge.handleMessage(ch, { chatId: '1', text: '/start', from: 'u' });
  assert.ok(ch.sentText.join('\n').includes('Aside Remote Control'));
});

test('/whoami reports the chat id and username', async () => {
  resetSessions();
  const bridge = makeBridge(async () => ok('x'));
  const ch = makeChannel(['42']); // authorize this chat so /whoami runs
  await bridge.handleMessage(ch, { chatId: '42', text: '/whoami', from: 'alice' });
  const msg = ch.sentText.join('\n');
  assert.ok(msg.includes('42'));
  assert.ok(msg.includes('alice'));
});

test('/status with no session tells the user to start one', async () => {
  resetSessions();
  const bridge = makeBridge(async () => ok('x'));
  const ch = makeChannel();
  await bridge.handleMessage(ch, { chatId: '1', text: '/status', from: 'u' });
  assert.ok(ch.sentText.join('\n').toLowerCase().includes('no active session'));
});

test('/status with an active session shows the id', async () => {
  resetSessions();
  sessions.set('test-chan', '1', 'sess-123');
  const bridge = makeBridge(async () => ok('x'));
  const ch = makeChannel();
  await bridge.handleMessage(ch, { chatId: '1', text: '/status', from: 'u' });
  assert.ok(ch.sentText.join('\n').includes('sess-123'));
});

test('/new clears the stored session', async () => {
  resetSessions();
  sessions.set('test-chan', '1', 'sess-xyz');
  const bridge = makeBridge(async () => ok('x'));
  const ch = makeChannel();
  await bridge.handleMessage(ch, { chatId: '1', text: '/new', from: 'u' });
  assert.equal(sessions.get('test-chan', '1'), null);
  assert.ok(ch.sentText.join('\n').toLowerCase().includes('fresh session'));
});

test('commands are case-insensitive', async () => {
  resetSessions();
  const bridge = makeBridge(async () => ok('x'));
  const ch = makeChannel();
  await bridge.handleMessage(ch, { chatId: '1', text: '/HELP', from: 'u' });
  assert.ok(ch.sentText.join('\n').includes('Aside Remote Control'));
});

// =====================  Bridge authorization  ==============================
test('unauthorized chat is rejected and the agent is never called', async () => {
  resetSessions();
  let called = 0;
  const bridge = makeBridge(async () => { called++; return ok('secret'); });
  const ch = makeChannel(['1']); // only chat 1 is allowed
  await bridge.handleMessage(ch, { chatId: '999', text: 'do something', from: 'mallory' });
  assert.equal(called, 0);
  assert.ok(ch.sentText.join('\n').toLowerCase().includes('not authorized'));
  assert.ok(ch.sentText.join('\n').includes('999')); // echoes their chat id
});

// =====================  Bridge task flow  ==================================
test('a normal task runs the agent and replies with its output', async () => {
  resetSessions();
  let seenPrompt = null;
  const bridge = makeBridge(async ({ prompt }) => { seenPrompt = prompt; return ok('the answer is 4'); });
  const ch = makeChannel();
  await bridge.handleMessage(ch, { chatId: '1', text: 'what is 2+2', from: 'u' });
  assert.equal(seenPrompt, 'what is 2+2'); // first turn: empty history -> no context wrapper
  assert.ok(ch.sentText.includes('the answer is 4'));
  assert.ok(ch.sentText.includes('🧠 Thinking...'));
  assert.ok(ch.typings >= 1);
});

test('empty agent output falls back to a placeholder reply', async () => {
  resetSessions();
  const bridge = makeBridge(async () => ok(''));
  const ch = makeChannel();
  await bridge.handleMessage(ch, { chatId: '1', text: 'hi', from: 'u' });
  assert.ok(ch.sentText.includes('(no output)'));
});

test('image paths in agent output are sent as images', async () => {
  resetSessions();
  const bridge = makeBridge(async () => ok('here is your screenshot: /tmp/shot.png'));
  const ch = makeChannel();
  await bridge.handleMessage(ch, { chatId: '1', text: 'screenshot', from: 'u' });
  assert.deepEqual(ch.images, ['/tmp/shot.png']);
});

test('several image paths are handed to the channel as one group', async () => {
  resetSessions();
  const bridge = makeBridge(async () => ok('shots: /tmp/a.png and /tmp/b.png and /tmp/c.png'));
  const ch = makeChannel();
  await bridge.handleMessage(ch, { chatId: '1', text: 'screenshot', from: 'u' });
  assert.deepEqual(ch.albums, [['/tmp/a.png', '/tmp/b.png', '/tmp/c.png']]);
});

// =====================  Telegram albums  =====================================
// Exercise the sendMediaGroup payload without touching the network: the HTTP
// layer is stubbed and we assert on what would have been posted.
function fakeTelegram(files) {
  const dir = fs.mkdtempSync(path.join(HOME, 'imgs-'));
  const paths = files.map((n) => {
    const p = path.join(dir, n);
    fs.writeFileSync(p, 'png-bytes');
    return p;
  });
  const ch = new TelegramChannel({ id: 'tg', type: 'telegram', token: 'x' });
  ch.calls = [];
  ch.postMultipart = async (method, fields, parts) => { ch.calls.push({ method, fields, parts }); return { ok: true }; };
  return { ch, paths };
}

test('telegram: multiple images go out as one sendMediaGroup', async () => {
  const { ch, paths } = fakeTelegram(['a.png', 'b.png', 'c.png']);
  await ch.sendImages('42', paths, 'three shots');
  assert.equal(ch.calls.length, 1);
  const [call] = ch.calls;
  assert.equal(call.method, 'sendMediaGroup');
  assert.equal(call.fields.chat_id, '42');
  assert.equal(call.parts.length, 3);
  const media = JSON.parse(call.fields.media);
  assert.deepEqual(media.map((m) => m.media), ['attach://f0', 'attach://f1', 'attach://f2']);
  assert.ok(media.every((m) => m.type === 'photo'));
  // Caption rides on the first item only — that is what renders as the album caption.
  assert.equal(media[0].caption, 'three shots');
  assert.ok(media.slice(1).every((m) => m.caption === undefined));
});

test('telegram: a single image still uses sendPhoto (a 1-item group is invalid)', async () => {
  const { ch, paths } = fakeTelegram(['solo.png']);
  await ch.sendImages('42', paths, 'cap');
  assert.deepEqual(ch.calls.map((c) => c.method), ['sendPhoto']);
  assert.equal(ch.calls[0].fields.caption, 'cap');
});

test('telegram: more than 10 images are batched into groups of 10', async () => {
  const { ch, paths } = fakeTelegram(Array.from({ length: 12 }, (_, i) => `s${i}.png`));
  await ch.sendImages('42', paths);
  assert.deepEqual(ch.calls.map((c) => c.method), ['sendMediaGroup', 'sendMediaGroup']);
  assert.deepEqual(ch.calls.map((c) => c.parts.length), [10, 2]);
});

test('telegram: an 11th trailing image falls back to sendPhoto, not a 1-item group', async () => {
  const { ch, paths } = fakeTelegram(Array.from({ length: 11 }, (_, i) => `s${i}.png`));
  await ch.sendImages('42', paths);
  assert.deepEqual(ch.calls.map((c) => c.method), ['sendMediaGroup', 'sendPhoto']);
});

test('telegram: missing files are skipped', async () => {
  const { ch, paths } = fakeTelegram(['a.png', 'b.png']);
  await ch.sendImages('42', [...paths, path.join(HOME, 'nope.png')]);
  assert.equal(ch.calls[0].parts.length, 2);
});

test('a stalled task surfaces the explanatory note verbatim, not the generic fallback', async () => {
  resetSessions();
  const note = "[aside-remote] The agent went silent for 120s and looks stuck — most likely it hit a local approval Aside can't grant in remote mode (e.g. writing to memory or editing a file). Run this one in the Aside desktop app, or keep remote tasks read-only.";
  // raw is a transcript with NO final answer — extractAnswer would yield '' and
  // the bridge must NOT let that swallow the note.
  const bridge = makeBridge(async () => ({
    text: note,
    raw: "\x1b[2mThinking: update USER.md\x1b[0m\r\nedit_file(path: '/x/USER.md')\r\n",
    sessionId: null, code: -3, error: true, stalled: true, sessionMissing: false,
  }));
  const ch = makeChannel();
  await bridge.handleMessage(ch, { chatId: '1', text: 'remember my favorite color is blue', from: 'u' });
  const joined = ch.sentText.join('\n');
  assert.ok(joined.includes('went silent'), `expected the stall note, got: ${joined}`);
  assert.ok(joined.includes('Aside desktop app'), 'note should tell the user where to run it');
  assert.ok(!/No answer produced/.test(joined), 'must not fall back to the generic message');
});

// =====================  Session self-heal  =================================
test('a rejected session id is dropped and the task retried fresh', async () => {
  resetSessions();
  sessions.set('test-chan', '1', 'activity'); // poisoned id
  const calls = [];
  const bridge = makeBridge(async ({ sessionId }) => {
    calls.push(sessionId);
    if (sessionId === 'activity') return ok('• Error Session not found: activity', { sessionMissing: true });
    return ok('7'); // fresh retry succeeds
  });
  const ch = makeChannel();
  await bridge.handleMessage(ch, { chatId: '1', text: 'what is 3+4', from: 'u' });
  assert.deepEqual(calls, ['activity', null]);          // tried bad id, then fresh
  assert.equal(sessions.get('test-chan', '1'), null);   // poisoned id cleared
  assert.ok(ch.sentText.includes('7'));                 // user sees the real answer
  assert.ok(!ch.sentText.some((t) => /not found/i.test(t))); // never the error
});

test('a successful session id is persisted for continuity', async () => {
  resetSessions();
  const bridge = makeBridge(async () => ok('done', { sessionId: 'fresh-sess-1' }));
  const ch = makeChannel();
  await bridge.handleMessage(ch, { chatId: '1', text: 'task', from: 'u' });
  assert.equal(sessions.get('test-chan', '1'), 'fresh-sess-1');
});

// =====================  Per-chat queue ordering  ===========================
test('messages from one chat are processed strictly in order', async () => {
  resetSessions();
  const order = [];
  // context:false so the 2nd prompt isn't wrapped with the 1st turn's history.
  const bridge = makeBridge(async ({ prompt }) => {
    // First task is slow; a broken queue would let the 2nd finish first.
    const delay = prompt === 'first' ? 40 : 0;
    await new Promise((r) => setTimeout(r, delay));
    order.push(prompt);
    return ok(prompt);
  }, { context: false });
  const ch = makeChannel();
  const p1 = bridge.handleMessage(ch, { chatId: '1', text: 'first', from: 'u' });
  const p2 = bridge.handleMessage(ch, { chatId: '1', text: 'second', from: 'u' });
  await Promise.all([p1, p2]);
  assert.deepEqual(order, ['first', 'second']);
});

test('different chats are processed independently', async () => {
  resetSessions();
  const done = [];
  const bridge = makeBridge(async ({ prompt }) => { done.push(prompt); return ok(prompt); });
  const ch = makeChannel(['1', '2']);
  await Promise.all([
    bridge.handleMessage(ch, { chatId: '1', text: 'A', from: 'u1' }),
    bridge.handleMessage(ch, { chatId: '2', text: 'B', from: 'u2' }),
  ]);
  assert.deepEqual(done.sort(), ['A', 'B']);
});

// =====================  Error handling  ====================================
test('an agent that throws does not crash the bridge', async () => {
  resetSessions();
  const bridge = makeBridge(async () => { throw new Error('boom'); });
  const ch = makeChannel();
  await bridge.handleMessage(ch, { chatId: '1', text: 'go', from: 'u' });
  assert.ok(ch.sentText.join('\n').toLowerCase().includes('error'));
});

// =====================  Conversation continuity  ==========================
test('a follow-up gets the prior turn prepended as context', async () => {
  resetSessions();
  const prompts = [];
  const bridge = makeBridge(async ({ prompt }) => { prompts.push(prompt); return ok('Paris'); });
  const ch = makeChannel();
  await bridge.handleMessage(ch, { chatId: '1', text: 'capital of France?', from: 'u' });
  await bridge.handleMessage(ch, { chatId: '1', text: 'and Germany?', from: 'u' });
  assert.equal(prompts[0], 'capital of France?');      // first turn: no context yet
  assert.ok(prompts[1].includes('capital of France?')); // prior user turn replayed
  assert.ok(prompts[1].includes('Paris'));              // prior clean answer replayed
  assert.ok(prompts[1].includes('and Germany?'));       // the current message
});

test('history stores the clean answer, not the raw transcript', async () => {
  resetSessions();
  const raw = "Thinking: looking\nrepl(title:'x', code:'y')\n > out\nThe answer is 42.";
  const bridge = makeBridge(async () => ({ text: raw, raw, sessionId: null, code: 0, error: false, sessionMissing: false }));
  await bridge.handleMessage(makeChannel(), { chatId: '1', text: 'q', from: 'u' });
  const assistant = history.get('test-chan', '1').find((t) => t.role === 'assistant');
  assert.equal(assistant.text, 'The answer is 42.');
});

test('/new clears conversation history', async () => {
  resetSessions();
  const bridge = makeBridge(async () => ok('hi'));
  const ch = makeChannel();
  await bridge.handleMessage(ch, { chatId: '1', text: 'hello', from: 'u' });
  assert.ok(history.get('test-chan', '1').length > 0);
  await bridge.handleMessage(ch, { chatId: '1', text: '/new', from: 'u' });
  assert.equal(history.get('test-chan', '1').length, 0);
});

test('context:false keeps each message independent', async () => {
  resetSessions();
  const prompts = [];
  const bridge = makeBridge(async ({ prompt }) => { prompts.push(prompt); return ok('ok'); }, { context: false });
  const ch = makeChannel();
  await bridge.handleMessage(ch, { chatId: '1', text: 'one', from: 'u' });
  await bridge.handleMessage(ch, { chatId: '1', text: 'two', from: 'u' });
  assert.deepEqual(prompts, ['one', 'two']);
});

test('history is bounded by a character budget (oldest turns drop)', () => {
  resetSessions();
  for (let i = 0; i < 10; i++) history.append('test-chan', '9', 'user', 'x'.repeat(300), 800);
  const turns = history.get('test-chan', '9');
  const total = turns.reduce((n, t) => n + t.text.length, 0);
  assert.ok(turns.length < 10, 'oldest turns should be dropped');
  assert.ok(total <= 800, `over budget: ${total}`);
});
