// M4: Aside session integration — list/resume/steer, discovery, stop-on-cancel.
import test from 'node:test';
import { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { makeBridge, makeChannel, waitFor } from './helpers.mjs';
import { parseSessionLine } from '../src/aside-cli.js';
import { sessions, history, HOME } from '../src/config.js';

beforeEach(() => {
  writeFileSync(path.join(HOME, 'history.json'), '{}');
  writeFileSync(path.join(HOME, 'sessions.json'), '{}');
});

const logLines = (argvLog) => () => {
  try { return readFileSync(argvLog, 'utf8').trim().split('\n').filter(Boolean).length; } catch { return 0; }
};
const argvOf = (argvLog) => readFileSync(argvLog, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
const sentHas = (ch, re) => ch.sent.some((s) => re.test(String(s.text)));
const seed = (stateFile, arr) => writeFileSync(stateFile, JSON.stringify({ sessions: arr }));
const S = (id, state = 'idle', title = 'A title', createdAt = '2026-10-08T10:00:00.000Z') => ({ id, state, title, createdAt });

// ---- parser tolerance ----
test('parseSessionLine: tolerant of shapes', () => {
  assert.deepEqual(parseSessionLine('AbCdEfGh12345678 idle persistent My task title 2026-10-08T10:00:00.000Z'),
    { id: 'AbCdEfGh12345678', state: 'idle', title: 'My task title', createdAt: '2026-10-08T10:00:00.000Z' });
  assert.deepEqual(parseSessionLine('AbCdEfGh12345678 interrupted ephemeral ok 2026-10-08T15:47:09.000Z'),
    { id: 'AbCdEfGh12345678', state: 'interrupted', title: 'ok', createdAt: '2026-10-08T15:47:09.000Z' });
  // no timestamp
  assert.deepEqual(parseSessionLine('AbCdEfGh12345678 idle persistent just a title'),
    { id: 'AbCdEfGh12345678', state: 'idle', title: 'just a title', createdAt: null });
  // garbage falls back to the raw line
  assert.deepEqual(parseSessionLine('not a session line at all'), { raw: 'not a session line at all' });
  assert.deepEqual(parseSessionLine(''), { raw: '' });
});

// ---- command behaviours ----
test('/sessions lists sessions and marks the bound one', async () => {
  const { bridge, channel, stateFile } = makeBridge();
  seed(stateFile, [S('Sess-aaaa'), S('Sess-bbbb', 'interrupted', 'x'.repeat(60))]);
  sessions.set(channel.id, 1, 'Sess-aaaa');
  await bridge.handleMessage(channel, { chatId: 1, text: '/sessions', from: 'u' });
  const t = String(channel.sent.at(-1).text);
  assert.match(t, /Sess-aaaa idle A title.*← bound/);
  assert.match(t, /Sess-bbbb interrupted/);
  assert.ok(t.includes('x'.repeat(40)), 'title truncated to 40 chars');
  assert.ok(!t.includes('x'.repeat(41)), 'title must not exceed 40 chars');
});

test('/sessions falls back to raw lines for unparseable output', async () => {
  const { bridge, channel, stateFile } = makeBridge();
  // fake-aside prints list rows; craft one via a raw-shaped session title is
  // not needed — instead check raw fallback by giving a session with weird id.
  seed(stateFile, [{ id: 'not-a-session-line-at-all', state: 'idle', title: 'T', createdAt: '2026-10-08T10:00:00.000Z' }]);
  await bridge.handleMessage(channel, { chatId: 1, text: '/sessions', from: 'u' });
  const t = String(channel.sent.at(-1).text);
  assert.ok(t.includes('not-a-session-line-at-all'));
});

test('commands reply with the no-support text when the CLI has no sessions', async () => {
  const { bridge, channel } = makeBridge({ fakeAside: { noSessions: true } });
  await bridge.handleMessage(channel, { chatId: 1, text: '/sessions', from: 'u' });
  assert.ok(sentHas(channel, /no session support/));
  await bridge.handleMessage(channel, { chatId: 1, text: '/resume Sess-aaaa', from: 'u' });
  assert.ok(sentHas(channel, /no session support/));
  await bridge.handleMessage(channel, { chatId: 1, text: '/steer go', from: 'u' });
  assert.ok(sentHas(channel, /no session support/));
});

test('/resume validates the id and binds it, clearing client-side history', async () => {
  const { bridge, channel, stateFile, home } = makeBridge();
  seed(stateFile, [S('Sess-aaaa')]);
  history.append(channel.id, 1, 'user', 'old context');
  await bridge.handleMessage(channel, { chatId: 1, text: '/resume bad!id', from: 'u' });
  assert.ok(sentHas(channel, /Usage: \/resume/));
  await bridge.handleMessage(channel, { chatId: 1, text: '/resume Missing123', from: 'u' });
  assert.ok(sentHas(channel, /No such session: Missing123/));
  await bridge.handleMessage(channel, { chatId: 1, text: '/resume Sess-aaaa', from: 'u' });
  assert.ok(sentHas(channel, /Resumed session Sess-aaaa/));
  assert.equal(sessions.get(channel.id, 1), 'Sess-aaaa');
  const hist = JSON.parse(readFileSync(path.join(home, 'history.json'), 'utf8'));
  assert.deepEqual(hist['test:1'] || [], [], 'client-side history cleared on resume');
});

test('a bound session is continued server-side, without history replay', async () => {
  const { bridge, channel, stateFile, argvLog } = makeBridge({ fakeAside: { lines: ['Answer: ok'] } });
  seed(stateFile, [S('Sess-aaaa')]);
  sessions.set(channel.id, 1, 'Sess-aaaa');
  history.append(channel.id, 1, 'user', 'prior turn');
  await bridge.handleMessage(channel, { chatId: 1, text: 'new msg', from: 'u' });
  const argv = argvOf(argvLog).at(-1);
  assert.deepEqual(argv, ['session', 'resume', 'Sess-aaaa', 'new msg'], 'server-side resume, no history wrapper');
});

test('a fresh task captures the printed session id (U1 discovery)', async () => {
  const { bridge, channel, argvLog } = makeBridge({ fakeAside: { lines: ['Answer: ok'], sessionId: 'Fresh-1234' } });
  await bridge.handleMessage(channel, { chatId: 1, text: 'hello', from: 'u' });
  assert.equal(sessions.get(channel.id, 1), 'Fresh-1234', 'session id bound from stdout');
  assert.deepEqual(argvOf(argvLog).at(-1), ['exec', 'hello']);
});

test('/steer routes to a bound session only while a task runs', async () => {
  const { bridge, channel, stateFile, argvLog } = makeBridge({ fakeAside: { hang: true } });
  seed(stateFile, [S('Sess-aaaa')]);
  sessions.set(channel.id, 1, 'Sess-aaaa');
  await bridge.handleMessage(channel, { chatId: 1, text: '/steer do X', from: 'u' });
  assert.ok(sentHas(channel, /Nothing is running/));
  const p = bridge.handleMessage(channel, { chatId: 1, text: 'task', from: 'u' });
  assert.ok(await waitFor(() => logLines(argvLog)() >= 1));
  await bridge.handleMessage(channel, { chatId: 1, text: '/steer do X', from: 'u' });
  assert.ok(argvOf(argvLog).some((a) => a[0] === 'session' && a[1] === 'steer' && a[2] === 'Sess-aaaa' && a[3] === 'do X'));
  await bridge.handleMessage(channel, { chatId: 1, text: '/cancel', from: 'u' });
  await p;
});

test('/cancel also stops the bound session server-side (best effort)', async () => {
  const { bridge, channel, stateFile, argvLog } = makeBridge({ fakeAside: { hang: true } });
  seed(stateFile, [S('Sess-aaaa')]);
  sessions.set(channel.id, 1, 'Sess-aaaa');
  const p = bridge.handleMessage(channel, { chatId: 1, text: 'task', from: 'u' });
  assert.ok(await waitFor(() => logLines(argvLog)() >= 1));
  await bridge.handleMessage(channel, { chatId: 1, text: '/cancel', from: 'u' });
  assert.ok(sentHas(channel, /🛑 Cancelled \(ran \d+s\)\./));
  await p;
  assert.ok(await waitFor(() => argvOf(argvLog).some((a) => a[0] === 'session' && a[1] === 'stop' && a[2] === 'Sess-aaaa'), { timeoutMs: 5000 }), 'stop must be attempted');
});

test('/cancel without a bound session still cancels (no stop call)', async () => {
  const { bridge, channel, argvLog } = makeBridge({ fakeAside: { hang: true } });
  const p = bridge.handleMessage(channel, { chatId: 1, text: 'task', from: 'u' });
  assert.ok(await waitFor(() => logLines(argvLog)() >= 1));
  await bridge.handleMessage(channel, { chatId: 1, text: '/cancel', from: 'u' });
  await p;
  assert.ok(!argvOf(argvLog).some((a) => a[0] === 'session' && a[1] === 'stop'), 'no stop without a bound session');
});
