// M3: identity, roles, per-chat settings, argv hardening, conversation commands.
import test from 'node:test';
import { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { makeBridge, makeChannel, waitFor } from './helpers.mjs';
import { sessions, settings, history, HOME } from '../src/config.js';

// Tests share one HOME; reset the stores so state never leaks across tests.
beforeEach(() => {
  writeFileSync(path.join(HOME, 'settings.json'), '{}');
  writeFileSync(path.join(HOME, 'history.json'), '{}');
  writeFileSync(path.join(HOME, 'sessions.json'), '{}');
});

const logLines = (argvLog) => () => {
  try { return readFileSync(argvLog, 'utf8').trim().split('\n').filter(Boolean).length; } catch { return 0; }
};
const argvOf = (argvLog) => {
  const lines = readFileSync(argvLog, 'utf8').trim().split('\n').filter(Boolean);
  return lines.map((l) => JSON.parse(l));
};
const sentHas = (ch, re) => ch.sent.some((s) => re.test(String(s.text)));

const KEY = 'test:1';

// ---- roles ----
test('role matrix: admins list gates admin commands', async () => {
  const { bridge, channel } = makeBridge({ agent: { defaults: {} } });
  bridge.config.roles = { admins: ['42'] };
  bridge.config.permissions = { allowChatOverride: true };
  await bridge.handleMessage(channel, { chatId: 1, userId: '7', text: '/permission ask', from: 'u' });
  assert.ok(sentHas(channel, /Admins only\./), 'non-admin must be refused');
  await bridge.handleMessage(channel, { chatId: 1, userId: '42', text: '/permission ask', from: 'u' });
  assert.ok(sentHas(channel, /Permission set to ask/), 'admin must be allowed');
});

test('role matrix: empty admins list means every authorized sender is admin (I8)', async () => {
  const { bridge, channel } = makeBridge({ agent: { defaults: {} } });
  bridge.config.roles = {};
  bridge.config.permissions = { allowChatOverride: true };
  await bridge.handleMessage(channel, { chatId: 1, userId: '7', text: '/permission ask', from: 'u' });
  assert.ok(sentHas(channel, /Permission set to ask/), 'no admins configured -> everyone is admin');
});

// ---- settings persistence and precedence ----
test('settings persist to settings.json and reach argv; defaults fill in', async () => {
  const { bridge, channel, argvLog, home } = makeBridge({
    fakeAside: { lines: ['Answer: ok'] },
    agent: { newArgs: ['exec'], defaults: { model: 'dflt/model' } },
  });
  await bridge.handleMessage(channel, { chatId: 1, text: '/model gpt-x', from: 'u' });
  assert.ok(sentHas(channel, /Model set to gpt-x/));
  const store = JSON.parse(readFileSync(path.join(home, 'settings.json'), 'utf8'));
  assert.equal(store[KEY].model, 'gpt-x');
  // chat setting wins over the default
  await bridge.handleMessage(channel, { chatId: 1, text: 'task one', from: 'u' });
  const argv1 = argvOf(argvLog).at(-1);
  assert.deepEqual(argv1, ['exec', '--model', 'gpt-x', 'task one']);
  // without a chat setting, the default fills in
  await bridge.handleMessage(channel, { chatId: 2, text: 'task two', from: 'u' });
  const argv2 = argvOf(argvLog).at(-1);
  assert.deepEqual(argv2, ['exec', '--model', 'dflt/model', 'task two']);
});

test('reset clears a setting and flags disappear', async () => {
  const { bridge, channel, argvLog } = makeBridge({
    fakeAside: { lines: ['Answer: ok'] },
    agent: { newArgs: ['exec'] },
  });
  await bridge.handleMessage(channel, { chatId: 1, text: '/model gpt-x', from: 'u' });
  await bridge.handleMessage(channel, { chatId: 1, text: '/model reset', from: 'u' });
  await bridge.handleMessage(channel, { chatId: 1, text: 'plain task', from: 'u' });
  assert.deepEqual(argvOf(argvLog).at(-1), ['exec', 'plain task']);
});

test('continued sessions get no flags (and the reply says so)', async () => {
  const { bridge, channel, argvLog } = makeBridge({
    fakeAside: { lines: ['Answer: ok'] },
    agent: { newArgs: ['exec'], continueArgs: ['session', 'resume', '{session}'] },
  });
  sessions.set(channel.id, 1, 'S-abc');
  await bridge.handleMessage(channel, { chatId: 1, text: '/model gpt-x', from: 'u' });
  assert.ok(sentHas(channel, /applies to the next new session/));
  await bridge.handleMessage(channel, { chatId: 1, text: 'continue me', from: 'u' });
  // The first spawn is the continued session; a later record is the
  // self-heal retry after the fake CLI rejects the unknown id.
  assert.deepEqual(argvOf(argvLog)[0], ['session', 'resume', 'S-abc', 'continue me']);
});

// ---- argv hardening (I7, I8-sanctioned default change) ----
test('a leading-dash prompt can never be parsed as a CLI flag', async () => {
  const { bridge, channel, argvLog } = makeBridge({ fakeAside: { lines: ['Answer: ok'] }, agent: { newArgs: [], context: false } });
  await bridge.handleMessage(channel, { chatId: 1, text: '--permission full-access hi', from: 'u' });
  assert.deepEqual(argvOf(argvLog).at(-1), ['Do this task: --permission full-access hi']);
});

test('a one-word prompt equal to a root subcommand runs as a task', async () => {
  const { bridge, channel, argvLog } = makeBridge({ fakeAside: { lines: ['Answer: ok'] }, agent: { newArgs: [], context: false } });
  for (const word of ['logout', 'update', 'host']) {
    await bridge.handleMessage(channel, { chatId: 1, text: word, from: 'u' });
    assert.deepEqual(argvOf(argvLog).at(-1), [`Do this task: ${word}`], word);
  }
});

test('setting commands validate input (usage text, no effect)', async () => {
  const { bridge, channel } = makeBridge();
  await bridge.handleMessage(channel, { chatId: 1, text: '/model --x', from: 'u' });
  assert.ok(sentHas(channel, /Usage: \/model/));
  await bridge.handleMessage(channel, { chatId: 1, text: '/model a b', from: 'u' });
  assert.ok(sentHas(channel, /Usage: \/model/));
  await bridge.handleMessage(channel, { chatId: 1, text: '/effort banana', from: 'u' });
  assert.ok(sentHas(channel, /Usage: \/effort/));
  await bridge.handleMessage(channel, { chatId: 1, text: '/fast maybe', from: 'u' });
  assert.ok(sentHas(channel, /Usage: \/fast/));
  assert.equal(settings.get(KEY), null, 'invalid input must not write settings');
});

// ---- /permission gating ----
test('/permission is refused until the operator opts in', async () => {
  const { bridge, channel } = makeBridge();
  await bridge.handleMessage(channel, { chatId: 1, userId: '42', text: '/permission ask', from: 'u' });
  assert.ok(sentHas(channel, /allowChatOverride/), 'refusal must explain the opt-in');
});

test('/permission full-access needs a confirm word', async () => {
  const { bridge, channel } = makeBridge();
  bridge.config.permissions = { allowChatOverride: true };
  await bridge.handleMessage(channel, { chatId: 1, userId: '42', text: '/permission full-access', from: 'u' });
  assert.ok(sentHas(channel, /confirm/));
  await bridge.handleMessage(channel, { chatId: 1, userId: '42', text: '/permission full-access confirm', from: 'u' });
  assert.ok(sentHas(channel, /Permission set to full-access/));
});

// ---- conversation commands ----
test('/retry re-runs the last composed task, refuses when running or none', async () => {
  const { bridge, channel, argvLog } = makeBridge({ fakeAside: { lines: ['Answer: ok'] }, agent: { newArgs: ['exec'], context: false } });
  await bridge.handleMessage(channel, { chatId: 1, text: '/retry', from: 'u' });
  assert.ok(sentHas(channel, /Nothing to retry yet/));
  await bridge.handleMessage(channel, { chatId: 1, text: 'original task', from: 'u' });
  await bridge.handleMessage(channel, { chatId: 1, text: '/retry', from: 'u' });
  assert.ok(sentHas(channel, /Re-running/));
  assert.ok(await waitFor(() => logLines(argvLog)() === 2, { timeoutMs: 5000 }));
  assert.equal(argvOf(argvLog).at(-1).at(-1), 'original task');
});

test('/retry refuses while a task is running', async () => {
  const { bridge, channel, argvLog } = makeBridge({ fakeAside: { hang: true } });
  const p = bridge.handleMessage(channel, { chatId: 1, text: 'task', from: 'u' });
  assert.ok(await waitFor(() => logLines(argvLog)() === 1));
  await bridge.handleMessage(channel, { chatId: 1, text: '/retry', from: 'u' });
  assert.ok(sentHas(channel, /already running/));
  await bridge.handleMessage(channel, { chatId: 1, text: '/cancel', from: 'u' });
  await p;
});

test('/undo pops the last user+assistant pair', async () => {
  const { bridge, channel, home } = makeBridge({ fakeAside: { lines: ['Answer: final'] } });
  await bridge.handleMessage(channel, { chatId: 1, text: 'question', from: 'u' });
  await bridge.handleMessage(channel, { chatId: 1, text: '/undo', from: 'u' });
  assert.ok(sentHas(channel, /Removed the last turn/));
  const hist = JSON.parse(readFileSync(path.join(home, 'history.json'), 'utf8'));
  assert.deepEqual(hist[KEY] || [], []);
  await bridge.handleMessage(channel, { chatId: 1, text: '/undo', from: 'u' });
  assert.ok(sentHas(channel, /Nothing to undo/));
});

test('/history lists recent turns, capped and truncated', async () => {
  // context stays on (default) so history is actually stored.
  const { bridge, channel } = makeBridge({ fakeAside: { lines: ['Answer: ok'] } });
  for (let i = 1; i <= 3; i++) await bridge.handleMessage(channel, { chatId: 1, text: `task ${i}`, from: 'u' });
  await bridge.handleMessage(channel, { chatId: 1, text: '/history 2', from: 'u' });
  const last = String(channel.sent.at(-1).text);
  assert.ok(last.includes('task 3'), `expected task 3 in: ${last}`);
  assert.ok(!last.includes('task 1'));
  await bridge.handleMessage(channel, { chatId: 1, text: '/history 99', from: 'u' });
  const rows = String(channel.sent.at(-1).text).split('\n').length;
  assert.ok(rows <= 20 + 1, 'n must be capped at 20');
});

test('/whoami keeps the first lines and appends id, role, chat type', async () => {
  const { bridge, channel } = makeBridge();
  bridge.config.roles = { admins: ['42'] };
  await bridge.handleMessage(channel, { chatId: 7, userId: '42', chatType: 'group', text: '/whoami', from: 'alice' });
  const t = String(channel.sent.at(-1).text);
  assert.match(t, /chat id: 7\nusername: alice/, 'first two lines unchanged');
  assert.match(t, /user id: 42/);
  assert.match(t, /role: admin/);
  assert.match(t, /chat type: group/);
});

test('channel.isAuthorized receives the optional userId', async () => {
  const seen = [];
  const ch = makeChannel({ isAuthorized: (chatId, userId) => { seen.push([chatId, userId]); return true; } });
  const { bridge } = makeBridge({ channel: ch });
  await bridge.handleMessage(ch, { chatId: 9, userId: 'u9', text: '/status', from: 'u' });
  assert.deepEqual(seen, [[9, 'u9']]);
});

// ---- effective verbose (bridge-side setting) ----
test('verbose chat setting routes the raw transcript (not just the answer)', async () => {
  const { bridge, channel } = makeBridge({
    fakeAside: { lines: ['Thinking: plan', 'Answer: ok'] },
    agent: { context: false },
  });
  await bridge.handleMessage(channel, { chatId: 1, text: 'plain', from: 'u' });
  assert.ok(!sentHas(channel, /Thinking: plan/), 'default: only the answer');
  await bridge.handleMessage(channel, { chatId: 1, text: '/verbose on', from: 'u' });
  await bridge.handleMessage(channel, { chatId: 1, text: 'verbose run', from: 'u' });
  assert.ok(sentHas(channel, /Thinking: plan/), 'verbose: raw transcript shown');
});
