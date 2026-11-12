// Live task cards (Telegram widgets): step parsing, the state's size cap, and the
// bridge driving a card through a task. Synthetic data only.
// Run with: ASIDE_REMOTE_HOME=$(mktemp -d) node --test --test-concurrency=1 test/cards.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { Bridge } from '../src/bridge.js';
import { HOME } from '../src/config.js';
import { sleep } from '../src/util.js';
import { cardJson, stepTitle, stepReader, CardStore, cardCaption } from '../src/cards.js';

if (!process.env.ASIDE_REMOTE_HOME) throw new Error('Set ASIDE_REMOTE_HOME to a temp dir.');
fs.mkdirSync(HOME, { recursive: true });
const reset = () => {
  fs.writeFileSync(path.join(HOME, 'sessions.json'), '{}');
  fs.writeFileSync(path.join(HOME, 'history.json'), '{}');
  fs.rmSync(path.join(HOME, 'cards.json'), { force: true });
};
const ok = (text) => ({ text, sessionId: null, code: 0, error: false, sessionMissing: false });
const DM = 111;

function cardChannel({ refuse = false } = {}) {
  return {
    id: 'tg-test', cfg: {},
    sentText: [], edits: [], cards: [], updates: [], captions: [], _mid: 500,
    isAuthorized: () => true,
    cardsFor: (c) => /^\d+$/.test(String(c)),
    async sendCard(_c, state, caption) {
      if (refuse) return undefined;
      const id = ++this._mid;
      this.cards.push({ id, state: JSON.parse(state), caption });
      return id;
    },
    async updateCard(_c, id, state) { this.updates.push({ id, state: JSON.parse(state) }); return true; },
    async setCardCaption(_c, id, caption) { this.captions.push({ id, caption }); return true; },
    async sendText(_c, t) { this.sentText.push(t); return ++this._mid; },
    async editText(_c, _m, t) { this.edits.push(t); return true; },
    async sendTyping() {},
    async sendImage() {},
    async sendImages() {},
  };
}

function makeBridge(run, extra = {}) {
  const bridge = new Bridge({ agent: { command: 'unused', stream: true, streamThrottleMs: 5, cardMinGapMs: 10, cardStopGraceMs: 60 }, channels: [] });
  bridge.agent = { run, ...extra };
  return bridge;
}

const lastState = (ch) => ch.updates.at(-1)?.state;

test('stepTitle reads the title of a tool call and nothing else', () => {
  assert.equal(stepTitle("bash(title: 'Reading the notes', command: 'ls')"), 'Reading the notes');
  assert.equal(stepTitle('\x1b[32mrepl\x1b[0m(title: "Opening the page",'), 'Opening the page');
  assert.equal(stepTitle("bash(title: 'The user\\'s list', command: 'x')"), "The user's list");
  assert.equal(stepTitle('Thinking: about it'), null);
  assert.equal(stepTitle("read_file(path: '/tmp/x')"), null);
  assert.equal(stepTitle("bash(title: '', command: 'x')"), null);
  assert.ok(stepTitle(`bash(title: '${'x'.repeat(200)}',`).length <= 60);
});

test('stepReader joins lines split across chunks', () => {
  const got = [];
  const feed = stepReader((t) => got.push(t));
  feed("bash(title: 'First st");
  feed("ep', command: 'a')\nsome output\nrepl(title: 'Sec");
  assert.deepEqual(got, ['First step']);
  feed("ond step', code: 'b')\n");
  assert.deepEqual(got, ['First step', 'Second step']);
});

test('cardJson stays under the 1024-byte state limit and keeps the newest steps', () => {
  const s = Array.from({ length: 40 }, (_, i) => [`Step number ${i} ${'y'.repeat(50)}`, 1700000000000 + i]);
  const out = cardJson({ st: 'w', t0: 1, n: 40, q: 0, s });
  assert.ok(Buffer.byteLength(out) <= 1000, `got ${Buffer.byteLength(out)} bytes`);
  const back = JSON.parse(out);
  assert.equal(back.n, 40);
  assert.match(back.s.at(-1)[0], /^Step number 39/);
});

test('a DM task gets a card, steps update it, and the answer arrives as its own message', async () => {
  reset();
  const ch = cardChannel();
  const bridge = makeBridge(async ({ onData }) => {
    onData?.("bash(title: 'Reading the notes', command: 'ls')\n");
    await sleep(30);
    onData?.("plain output line\nrepl(title: 'Opening the page', code: 'x')\n");
    await sleep(30);
    return ok('The answer is 42');
  });
  await bridge.handleMessage(ch, { chatId: DM, text: 'do it', from: 'u', fromId: DM });

  assert.equal(ch.cards.length, 1, 'one card sent');
  assert.equal(ch.cards[0].state.st, 'w');
  assert.equal(ch.cards[0].caption, 'Working');
  assert.ok(!ch.sentText.includes('🧠 Thinking...'), 'no text placeholder when the card went out');
  const titles = ch.updates.flatMap((u) => u.state.s.map((x) => x[0]));
  assert.ok(titles.includes('Reading the notes') && titles.includes('Opening the page'), `steps: ${titles}`);
  assert.equal(lastState(ch).st, 'd');
  assert.equal(lastState(ch).n, 2);
  assert.match(ch.captions.at(-1).caption, /^Done \d+:\d\d$/);
  assert.deepEqual(ch.sentText, ['The answer is 42'], 'the answer is a new message, not an edit');
  assert.deepEqual(ch.edits, []);
});

test('a refused card falls back to the text bubble', async () => {
  reset();
  const ch = cardChannel({ refuse: true });
  const bridge = makeBridge(async () => ok('fallback answer'));
  await bridge.handleMessage(ch, { chatId: DM, text: 'do it', from: 'u', fromId: DM });
  assert.equal(ch.sentText[0], '🧠 Thinking...');
  assert.equal(ch.edits.at(-1), 'fallback answer');
});

test('a group chat keeps the text bubble', async () => {
  reset();
  const ch = cardChannel();
  const bridge = makeBridge(async () => ok('group answer'));
  await bridge.handleMessage(ch, { chatId: '-100123', text: 'do it', from: 'u', fromId: DM });
  assert.equal(ch.cards.length, 0);
  assert.equal(ch.sentText[0], '🧠 Thinking...');
});

// A run that waits until it is aborted or released.
function heldRun(sessionId = 'ABCDEFGHIJKLMNOP') {
  let release;
  const done = new Promise((r) => { release = r; });
  const run = async ({ onSession, signal, onData }) => {
    onSession?.(sessionId);
    onData?.("bash(title: 'Waiting on the page', command: 'sleep')\n");
    return new Promise((resolve) => {
      signal?.addEventListener('abort', () => resolve({ ...ok(''), aborted: true }), { once: true });
      done.then((text) => resolve(ok(text)));
    });
  };
  return { run, release };
}

test('card stop ends the task after the undo window; the card says stopped and no answer is sent', async () => {
  reset();
  const ch = cardChannel();
  const held = heldRun();
  const bridge = makeBridge(held.run);
  const task = bridge.handleMessage(ch, { chatId: DM, text: 'long one', from: 'u', fromId: DM });
  await sleep(40);
  const id = ch.cards[0].id;
  const s = JSON.parse(await bridge.handleCardQuery(ch, { chatId: DM, messageId: id, data: 's', fromId: DM, from: 'u' }));
  assert.equal(s.st, 'w');
  await bridge.handleCardQuery(ch, { chatId: DM, messageId: id, data: 'stop', fromId: DM, from: 'u' });
  await task;
  assert.equal(lastState(ch).st, 'x');
  assert.match(ch.captions.at(-1).caption, /^Stopped /);
  assert.deepEqual(ch.sentText, [], 'a stop sends no answer');
});

test('undo inside the window keeps the task running', async () => {
  reset();
  const ch = cardChannel();
  const held = heldRun();
  const bridge = makeBridge(held.run);
  const task = bridge.handleMessage(ch, { chatId: DM, text: 'long one', from: 'u', fromId: DM });
  await sleep(40);
  const id = ch.cards[0].id;
  await bridge.handleCardQuery(ch, { chatId: DM, messageId: id, data: 'stop', fromId: DM, from: 'u' });
  await bridge.handleCardQuery(ch, { chatId: DM, messageId: id, data: 'undo', fromId: DM, from: 'u' });
  await sleep(150); // past the 60 ms window
  assert.equal(bridge.activeTasks(DM).length, 1, 'still running');
  held.release('finished after all');
  await task;
  assert.equal(lastState(ch).st, 'd');
  assert.deepEqual(ch.sentText, ['finished after all']);
});

test('a message sent while a card task runs shows on the card, and "now" steers it in', async () => {
  reset();
  const ch = cardChannel();
  const held = heldRun();
  const steered = [];
  const bridge = makeBridge(held.run, { steer: async (sid, text) => { steered.push([sid, text]); return { ok: true }; } });
  const first = bridge.handleMessage(ch, { chatId: DM, text: 'first', from: 'u', fromId: DM });
  await sleep(40);
  const second = bridge.handleMessage(ch, { chatId: DM, text: 'second thought', from: 'u', fromId: DM });
  await sleep(40);
  assert.ok(!ch.sentText.includes('Queued'), 'no separate queue notice beside a card');
  assert.equal(lastState(ch).q, 1);
  await bridge.handleCardQuery(ch, { chatId: DM, messageId: ch.cards[0].id, data: 'now', fromId: DM, from: 'u' });
  await sleep(60);
  assert.deepEqual(steered, [['ABCDEFGHIJKLMNOP', 'second thought']]);
  assert.equal(lastState(ch).q, 0);
  assert.ok(lastState(ch).s.some((x) => x[0] === 'Your follow-up'));
  held.release('both done');
  await Promise.all([first, second]);
  assert.equal(ch.cards.length, 1, 'the steered message did not start a second task');
});

test('an unauthorized sender gets nothing back', async () => {
  reset();
  const ch = cardChannel();
  ch.isAllowedSender = () => false;
  const bridge = makeBridge(async () => ok('x'));
  assert.equal(await bridge.handleCardQuery(ch, { chatId: DM, messageId: 1, data: 's', fromId: 999, from: 'x' }), null);
});

test('cards a previous run left working are corrected on start and answered as stopped', async () => {
  reset();
  const store = new CardStore(path.join(HOME, 'cards.json'));
  store.set('tg-test', DM, 77, { st: 'w', t0: Date.now() - 5000, n: 2, q: 0, s: [['Old step', Date.now() - 4000]] });
  const ch = cardChannel();
  const bridge = makeBridge(async () => ok('x'));
  const answer = JSON.parse(await bridge.handleCardQuery(ch, { chatId: DM, messageId: 77, data: 's', fromId: DM, from: 'u' }));
  assert.equal(answer.st, 'x');
  store.set('tg-test', DM, 78, { st: 'w', t0: Date.now() - 5000, n: 1, q: 0, s: [] });
  const fresh = makeBridge(async () => ok('x'));
  await fresh.retireCards(ch);
  const fixed = ch.updates.find((u) => u.id === 78);
  assert.equal(fixed?.state.st, 'x');
  assert.match(ch.captions.find((c) => c.id === 78)?.caption || '', /^Stopped /);
});

test('captions name the end state', () => {
  const t0 = Date.now() - 125000;
  assert.equal(cardCaption({ st: 'w', t0 }), 'Working');
  assert.equal(cardCaption({ st: 'd', t0, te: t0 + 125000 }), 'Done 2:05');
  assert.equal(cardCaption({ st: 'x', t0, te: t0 + 61000 }), 'Stopped 1:01');
  assert.equal(cardCaption({ st: 'f', t0, te: t0 + 1000 }), 'Failed 0:01');
});

test('the Telegram channel answers every card query, with state when the bridge has it', async () => {
  const { TelegramChannel } = await import('../src/channels/telegram.js');
  const ch = new TelegramChannel({ id: 'tg', token: 'x', cards: true });
  const calls = [];
  ch.call = async (method, params) => { calls.push([method, params]); return { ok: true }; };
  const q = { id: 'q1', chat: { id: 111, type: 'private' }, message_id: 5, data: 's', from: { id: 111, first_name: 'T' } };
  let seen;
  await ch.answerCardQuery(q, async (x) => { seen = x; return '{"st":"w"}'; });
  assert.deepEqual(seen, { chatId: 111, messageId: 5, data: 's', from: 'T', fromId: 111 });
  assert.deepEqual(calls.at(-1), ['answerWidgetQuery', { widget_query_id: 'q1', data: '{"st":"w"}' }]);
  await ch.answerCardQuery(q, async () => { throw new Error('boom'); });
  assert.deepEqual(calls.at(-1), ['answerWidgetQuery', { widget_query_id: 'q1' }], 'a failing bridge still answers');
  await ch.answerCardQuery(q, async () => 'x'.repeat(2000));
  assert.deepEqual(calls.at(-1), ['answerWidgetQuery', { widget_query_id: 'q1' }], 'oversized state is not sent');
});

test('cardJson keeps the newest 4 helper agents and shortens their names', async () => {
  const { cardJson } = await import('../src/cards.js');
  const a = Array.from({ length: 6 }, (_, i) => [`agent ${i} `.padEnd(80, 'x'), i % 2 ? 'w' : 'd']);
  const out = JSON.parse(cardJson({ st: 'w', t0: 1, n: 0, q: 0, s: [], a }));
  assert.equal(out.a.length, 4);
  assert.equal(out.a[0][0].startsWith('agent 2'), true);
  assert.ok(out.a.every(([t]) => t.length <= 40));
});

test('readAgents lists a session\'s subagents active since the task began', async () => {
  const { readAgents } = await import('../src/cards.js');
  const { execFileSync } = await import('node:child_process');
  const os = await import('node:os'); const path = await import('node:path'); const fs = await import('node:fs');
  const db = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ar-db-')), 'state.db');
  execFileSync('sqlite3', [db, `create table sessions (id text, parent_id text, title text, status text, created_at int, updated_at int);
    insert into sessions values ('kid1kid1kid1kid1','PARENTPARENT0001','Old helper','idle',100,100),
    ('kid2kid2kid2kid2','PARENTPARENT0001','Compare prices','running',2000,2001),
    ('kid3kid3kid3kid3','PARENTPARENT0001','New Session','errored',2002,2003),
    ('kid4kid4kid4kid4','OTHEROTHEROTHER1','Not ours','running',2000,2001);`]);
  assert.deepEqual(await readAgents('PARENTPARENT0001', 2000 * 1000, db), [['Compare prices', 'w'], ['Agent', 'f']]);
  assert.equal(await readAgents("x' or 1=1 --", 0, db), null);
});

test('a card shows helper agents and writes only when they change', async () => {
  const { TaskCard } = await import('../src/cards.js');
  const writes = [];
  const card = new TaskCard({ channel: { id: 'c', updateCard: async (_c, _m, j) => writes.push(JSON.parse(j)) }, chatId: 1, messageId: 2,
    state: { st: 'w', t0: 0, n: 0, q: 0, s: [] }, store: { set() {} }, minGapMs: 0 });
  card.agents([['Helper', 'w']]);
  card.agents([['Helper', 'w']]);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0].a, [['Helper', 'w']]);
});
