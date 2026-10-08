// M5: outbound files, completion ping, inline buttons, approve-by-rerun.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, symlinkSync, existsSync, realpathSync, rmSync } from 'node:fs';
import path from 'node:path';
import { makeBridge, makeChannel, waitFor, FAKE_ASIDE } from './helpers.mjs';
import { checkOutboundPath, findFilePaths } from '../src/util.js';
import { TelegramChannel } from '../src/channels/telegram.js';
import { HOME } from '../src/config.js';

const sentHas = (ch, re) => ch.sent.some((s) => re.test(String(s.text)));
const argvOf = (argvLog) => {
  try { return readFileSync(argvLog, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); }
  catch { return []; }
};
const logLines = (argvLog) => () => {
  try { return readFileSync(argvLog, 'utf8').trim().split('\n').filter(Boolean).length; } catch { return 0; }
};

import os from 'node:os';
// Fixture dirs live OUTSIDE the bridge home so the config.json-inside-home
// rule and the allowed-dirs rule can be tested independently.
const work = path.join(os.tmpdir(), 'm5-outbound-test');
rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });

// ---- 5a outbound file policy (pure matrix) ----
test('outbound path policy matrix', () => {
  const allowed = path.join(work, 'allowed');
  const outside = path.join(work, 'outside');
  mkdirSync(allowed, { recursive: true });
  mkdirSync(outside, { recursive: true });
  const good = path.join(allowed, 'report.txt');
  writeFileSync(good, 'hello');
  const outsideFile = path.join(outside, 'x.txt');
  writeFileSync(outsideFile, 'x');
  const big = path.join(allowed, 'big.txt');
  writeFileSync(big, 'x'.repeat(100));
  const escape = path.join(allowed, 'escape.txt');
  symlinkSync(path.join(outside, 'secret.txt'), escape);
  writeFileSync(path.join(outside, 'secret.txt'), 's');
  const env = path.join(allowed, '.env');
  writeFileSync(env, 'KEY=1');
  const pem = path.join(allowed, 'cert.pem');
  writeFileSync(pem, 'pem');
  const homeCfg = path.join(HOME, 'config.json');
  writeFileSync(homeCfg, '{}');
  const okCfg = path.join(allowed, 'config.json');
  writeFileSync(okCfg, '{}');

  const cfg = { dirs: [allowed, HOME], maxBytes: 50, denylist: ['.env*', 'id_rsa*', '*.pem', '*.key'], home: HOME };
  assert.equal(checkOutboundPath(good, cfg).ok, true);
  assert.match(checkOutboundPath(outsideFile, cfg).reason, /outside allowed dirs/);
  assert.match(checkOutboundPath(escape, cfg).reason, /outside allowed dirs/, 'symlink must not escape');
  assert.match(checkOutboundPath(path.join(allowed, 'missing.txt'), cfg).reason, /not a readable file/);
  assert.match(checkOutboundPath(allowed, cfg).reason, /not a regular file/);
  assert.match(checkOutboundPath(big, cfg).reason, /over maxBytes/);
  assert.match(checkOutboundPath(env, cfg).reason, /denylisted name/);
  assert.match(checkOutboundPath(pem, cfg).reason, /denylisted name/);
  assert.match(checkOutboundPath(homeCfg, cfg).reason, /config\.json/, 'config.json inside the bridge home is denied');
  assert.equal(checkOutboundPath(okCfg, { ...cfg, dirs: [allowed] }).ok, true, 'config.json in an allowed dir outside home is fine');
  assert.match(checkOutboundPath(good, { ...cfg, dirs: [] }).reason, /dirs is empty/, 'disabled by default');
});

test('findFilePaths picks document paths out of text', () => {
  const paths = findFilePaths('done — see /tmp/out/report.pdf and ~/docs/notes.md (also /x/y.csv)');
  assert.deepEqual(paths, ['/tmp/out/report.pdf', '~/docs/notes.md', '/x/y.csv']);
});

test('bridge sends referenced files only when outbound.dirs is configured, capped', async () => {
  const allowed = path.join(work, 'bridge-out');
  mkdirSync(allowed, { recursive: true });
  const refs = [];
  for (let i = 1; i <= 6; i++) {
    const p = path.join(allowed, `doc${i}.txt`);
    writeFileSync(p, `content ${i}`);
    refs.push(p);
  }
  const { bridge, channel } = makeBridge({ fakeAside: { lines: ['Answer: done', ...refs] } });
  bridge.config.outbound = { dirs: [allowed], maxBytes: 1000, maxFiles: 5, denylist: [] };
  await bridge.handleMessage(channel, { chatId: 1, text: 'make docs', from: 'u' });
  assert.equal(channel.files.length, 5, 'maxFiles cap applies');
  const realRefs = refs.map((r) => realpathSync(r));
  assert.ok(channel.files.every((f) => realRefs.includes(f.filePath)), 'sent paths are the realpaths of the refs');

  const { bridge: b2, channel: c2 } = makeBridge({ fakeAside: { lines: ['Answer: done', refs[0]] } });
  await b2.handleMessage(c2, { chatId: 1, text: 'make docs', from: 'u' });
  assert.equal(c2.files.length, 0, 'no outbound.dirs -> nothing sent');
});

// ---- 5b completion ping ----
test('completion ping fires only when enabled and the task ran long enough', async () => {
  const a = makeBridge({ fakeAside: { lines: ['Answer: ok'] }, agent: { context: false } });
  a.bridge.config.notify = { doneAfterSec: 0.0001 };
  await a.bridge.handleMessage(a.channel, { chatId: 1, text: 'go', from: 'u' });
  assert.ok(sentHas(a.channel, /✅ Done in \d/), 'ping after a long-enough task');
  const b = makeBridge({ fakeAside: { lines: ['Answer: ok'] }, agent: { context: false } });
  await b.bridge.handleMessage(b.channel, { chatId: 1, text: 'go', from: 'u' });
  assert.ok(!sentHas(b.channel, /✅ Done in/), 'default (0) means no ping');
});

// ---- 5c inline buttons + callback queries ----
function makeTelegram() {
  const ch = new TelegramChannel({ id: 'tg', type: 'telegram', label: 'T', token: 'x', botUsername: 'MyBot', allowedChatIds: [] });
  ch.calls = [];
  // Tiny sleep paces the poll loop (a stub that answers instantly makes the
  // loop busy-spin and exhaust the heap).
  ch.call = async (method, params = {}) => {
    ch.calls.push({ method, params });
    await new Promise((r) => setTimeout(r, 2));
    return { ok: true, result: [] };
  };
  return ch;
}

test('telegram sendText renders inline keyboards and enforces the 64-byte cap', async () => {
  const ch = makeTelegram();
  await ch.sendText(7, 'pick', { buttons: [[{ text: 'Go', data: '/rerun abc123' }]] });
  const send = ch.calls.find((c) => c.method === 'sendMessage');
  assert.deepEqual(send.params.reply_markup, { inline_keyboard: [[{ text: 'Go', data: '/rerun abc123' }]] });
  await assert.rejects(
    () => ch.sendText(7, 'x', { buttons: [[{ text: 'Go', data: 'x'.repeat(65) }]] }),
    /64 bytes/,
  );
});

test('telegram polling requests callback_query updates', async () => {
  const ch = makeTelegram();
  const ac = new AbortController();
  const started = ch.start({ signal: ac.signal, onMessage: () => {} });
  await waitFor(() => ch.calls.some((c) => c.method === 'getUpdates' && c.params.timeout === 30), { timeoutMs: 5000 });
  ac.abort();
  await started;
  const poll = ch.calls.find((c) => c.method === 'getUpdates' && c.params.timeout === 30);
  assert.deepEqual(poll.params.allowed_updates, ['message', 'edited_message', 'callback_query']);
});

test('a callback tap is answered and flows through the registry with authorization', async () => {
  const { bridge } = makeBridge();
  const ch = makeTelegram();
  const ac = new AbortController();
  let updates = [
    { update_id: 1, callback_query: { id: 'cq-1', from: { id: 42, username: 'alice' }, message: { chat: { id: 7, type: 'private' }, message_id: 5 }, data: '/rerun deadbeef' } },
  ];
  let getCalls = 0;
  ch.call = async (method, params = {}) => {
    if (method === 'getUpdates') {
      getCalls += 1;
      // First call is the start-up drain; it must not consume the fixture.
      const next = getCalls === 1 ? null : updates.shift();
      await new Promise((r) => setTimeout(r, 2));
      return { ok: true, result: next ? [next] : [] };
    }
    ch.calls.push({ method, params });
    return { ok: true, result: [] };
  };
  const started = ch.start({ signal: ac.signal, onMessage: (m) => bridge.handleMessage(ch, m) });
  await waitFor(() => ch.calls.some((c) => c.method === 'answerCallbackQuery'), { timeoutMs: 5000 });
  await waitFor(() => ch.calls.some((c) => c.method === 'sendMessage' && /invalid or expired/.test(String(c.params.text))), { timeoutMs: 5000 });
  ac.abort();
  await started;
  assert.equal(ch.calls.find((c) => c.method === 'answerCallbackQuery').params.callback_query_id, 'cq-1');
});

test('an unauthorized callback tap is answered but refused', async () => {
  const { bridge } = makeBridge();
  const ch = makeTelegram();
  ch.cfg.allowedChatIds = ['99'];
  const ac = new AbortController();
  let updates = [
    { update_id: 1, callback_query: { id: 'cq-2', from: { id: 1, username: 'mallory' }, message: { chat: { id: 7, type: 'private' }, message_id: 5 }, data: '/rerun x' } },
  ];
  let getCalls = 0;
  ch.call = async (method, params = {}) => {
    if (method === 'getUpdates') {
      getCalls += 1;
      // First call is the start-up drain; it must not consume the fixture.
      const next = getCalls === 1 ? null : updates.shift();
      await new Promise((r) => setTimeout(r, 2));
      return { ok: true, result: next ? [next] : [] };
    }
    ch.calls.push({ method, params });
    return { ok: true, result: [] };
  };
  const started = ch.start({ signal: ac.signal, onMessage: (m) => bridge.handleMessage(ch, m) });
  await waitFor(() => ch.calls.some((c) => c.method === 'answerCallbackQuery'), { timeoutMs: 5000 });
  await waitFor(() => ch.calls.some((c) => c.method === 'sendMessage' && /Not authorized/.test(String(c.params.text))), { timeoutMs: 5000 });
  ac.abort();
  await started;
});

// ---- 5d approve-by-rerun ----
test('a stall offers re-run with full access; the token is admin, chat-bound, single-use', async () => {
  const { bridge, channel, argvLog } = makeBridge({
    fakeAside: { hang: true },
    agent: { idleTimeoutMs: 60 },
  });
  bridge.config.permissions = { allowChatOverride: true, escalation: true };
  const p = bridge.handleMessage(channel, { chatId: 1, text: 'stall me', from: 'u' });
  assert.ok(await waitFor(() => channel.sent.some((s) => /re-runs the same task with full access/.test(String(s.text))), { timeoutMs: 5000 }));
  const stallMsg = channel.sent.find((s) => /re-runs the same task with full access/.test(String(s.text)));
  const button = stallMsg.opts?.buttons?.[0]?.[0];
  assert.ok(button, 'stall message must carry the button');
  const token = button.data.split(' ')[1];
  await p;

  // re-arm the fake aside for the re-run
  process.env.FAKE_ASIDE = JSON.stringify({ argvLog, lines: ['Answer: ok'] });
  await bridge.handleMessage(channel, { chatId: 1, text: `/rerun ${token}`, from: 'u' });
  assert.ok(await waitFor(() => argvOf(argvLog).some((a) => a[0] === 'exec' && a[1] === '--permission' && a[2] === 'full-access'), { timeoutMs: 5000 }), 're-run must force full-access argv');
  assert.ok(sentHas(channel, /Re-running with full access/));
  assert.ok(channel.keyboardRemovals.length > 0, 'keyboard removed after the tap');
  // single use
  await bridge.handleMessage(channel, { chatId: 1, text: `/rerun ${token}`, from: 'u' });
  assert.ok(sentHas(channel, /invalid or expired/));
});

test('escalation stays off by default and tokens expire', async () => {
  const a = makeBridge({ fakeAside: { hang: true }, agent: { idleTimeoutMs: 60 } });
  const p1 = a.bridge.handleMessage(a.channel, { chatId: 1, text: 'stall me', from: 'u' });
  assert.ok(await waitFor(() => a.channel.sent.some((s) => /went silent/.test(String(s.text))), { timeoutMs: 5000 }));
  await p1;
  assert.ok(!a.channel.sent.some((s) => /re-runs the same task with full access/.test(String(s.text))), 'no button unless escalation is enabled');

  const b = makeBridge({ fakeAside: { hang: true }, agent: { idleTimeoutMs: 60 } });
  b.bridge.config.permissions = { escalation: true };
  const p2 = b.bridge.handleMessage(b.channel, { chatId: 1, text: 'stall me', from: 'u' });
  assert.ok(await waitFor(() => b.channel.sent.some((s) => /re-runs the same task with full access/.test(String(s.text))), { timeoutMs: 5000 }));
  await p2;
  const rec = [...b.bridge.rerunTokens.values()][0];
  rec.expiresAt = Date.now() - 1;
  await b.bridge.handleMessage(b.channel, { chatId: 1, text: `/rerun ${[...b.bridge.rerunTokens.keys()][0]}`, from: 'u' });
  assert.ok(sentHas(b.channel, /invalid or expired/));
});
