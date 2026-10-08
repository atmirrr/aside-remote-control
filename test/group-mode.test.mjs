// M7: group mode — mention-gated acting, user allowlists, mention stripping.
import test from 'node:test';
import assert from 'node:assert/strict';
import { TelegramChannel } from '../src/channels/telegram.js';
import { makeBridge, waitFor } from './helpers.mjs';

const BOT = 'MyBot';
function makeTg(cfgGroups) {
  const ch = new TelegramChannel({
    id: 'tg', type: 'telegram', label: 'T', token: 'x',
    botUsername: BOT, allowedChatIds: ['-1001', '7'],
    groups: cfgGroups,
  });
  return ch;
}

const GROUP = { chat: { id: '-1001', type: 'supergroup' }, from: { id: 42, username: 'alice' } };
const PRIVATE = { chat: { id: '7', type: 'private' }, from: { id: 42, username: 'alice' } };
const replyToBot = { ...GROUP, reply_to_message: { from: { id: 99, username: BOT } } };

function classify(ch, msg, text) {
  const r = ch.classifyMessage(msg, text);
  return { act: r !== null, text: r ? r.text : null };
}

test('classifyMessage: private chats always act, any mode', () => {
  const ch = makeTg({ mode: 'mention' });
  assert.deepEqual(classify(ch, PRIVATE, 'plain task'), { act: true, text: 'plain task' });
  assert.deepEqual(classify(ch, PRIVATE, '/help'), { act: true, text: '/help' });
});

test('classifyMessage: no groups config keeps today\'s behaviour (everything acts)', () => {
  const ch = makeTg(undefined);
  assert.deepEqual(classify(ch, GROUP, 'plain task'), { act: true, text: 'plain task' });
  assert.deepEqual(classify(ch, GROUP, '/help'), { act: true, text: '/help' });
});

test('classifyMessage: mention-mode group matrix', () => {
  const ch = makeTg({ mode: 'mention' });
  // plain: ignored
  assert.deepEqual(classify(ch, GROUP, 'plain task'), { act: false, text: null });
  // bare command: not addressed -> ignored
  assert.deepEqual(classify(ch, GROUP, '/help'), { act: false, text: null });
  // addressed command: acts, mention stripped
  assert.deepEqual(classify(ch, GROUP, '/help@MyBot'), { act: true, text: '/help' });
  assert.deepEqual(classify(ch, GROUP, '/help@mybot'), { act: true, text: '/help' });
  // addressed to another bot: ignored
  assert.deepEqual(classify(ch, GROUP, '/help@OtherBot'), { act: false, text: null });
  // plain-text mention: acts, stripped
  assert.deepEqual(classify(ch, GROUP, '@MyBot do the thing'), { act: true, text: 'do the thing' });
  assert.deepEqual(classify(ch, GROUP, 'mid @MyBot mention'), { act: true, text: 'mid  mention' });
  assert.deepEqual(classify(ch, GROUP, '@MyBot @MyBot twice'), { act: true, text: 'twice' });
  // entity-based mention (no literal text match needed beyond the entity)
  const withEntity = { ...GROUP, entities: [{ type: 'mention', offset: 0, length: BOT.length + 1 }] };
  assert.deepEqual(classify(ch, withEntity, `@${BOT} hi`), { act: true, text: 'hi' });
  // reply to the bot: acts
  assert.deepEqual(classify(ch, replyToBot, 'the second one'), { act: true, text: 'the second one' });
  // reply to someone else: ignored
  const replyOther = { ...GROUP, reply_to_message: { from: { id: 5, username: 'bob' } } };
  assert.deepEqual(classify(ch, replyOther, 'nope'), { act: false, text: null });
});

test('classifyMessage: captions flow through the same gate', () => {
  const ch = makeTg({ mode: 'mention' });
  assert.deepEqual(classify(ch, GROUP, '@MyBot look at this'), { act: true, text: 'look at this' });
});

test('isAuthorized: group allowlist gates the sender even when the chat is allowed', () => {
  const open = makeTg(undefined);
  assert.equal(open.isAuthorized('-1001', '42'), true);
  assert.equal(open.isAuthorized('-1001', '999'), true, 'chat allowlist only, any member');

  const strict = makeTg({ mode: 'mention', requireUserAllowlist: true, allowedUserIds: ['42'] });
  assert.equal(strict.isAuthorized('-1001', '42'), true);
  assert.equal(strict.isAuthorized('-1001', '999'), false, 'user must be allowlisted');
  assert.equal(strict.isAuthorized('7', '999'), false, 'private chat sender also checked');
  assert.equal(strict.isAuthorized('-9999', '42'), false, 'chat itself must be allowed too');

  const empty = makeTg({ requireUserAllowlist: true, allowedUserIds: [] });
  assert.equal(empty.isAuthorized('-1001', '999'), true, 'empty user allowlist is open (same rule as chats)');
});

test('poll loop: mention-mode group only delivers acting messages', async () => {
  const { bridge } = makeBridge();
  const ch = makeTg({ mode: 'mention' });
  const got = [];
  const ac = new AbortController();
  let feed = [
    { update_id: 1, message: { ...GROUP, message_id: 1, text: 'ignored plain' } },
    { update_id: 2, message: { ...GROUP, message_id: 2, text: '@MyBot run this', from: { id: 42, username: 'alice' } } },
    { update_id: 3, message: { ...GROUP, message_id: 3, text: 'again', reply_to_message: { from: { id: 99, username: BOT } } } },
    { update_id: 4, message: { ...GROUP, message_id: 4, text: '/help@MyBot' } },
  ];
  let getCalls = 0;
  ch.call = async (method, params = {}) => {
    if (method === 'getUpdates') {
      getCalls += 1;
      const next = getCalls === 1 ? null : feed.shift();
      await new Promise((r) => setTimeout(r, 2));
      return { ok: true, result: next ? [next] : [] };
    }
    return { ok: true, result: [] };
  };
  const started = ch.start({ signal: ac.signal, onMessage: (m) => { got.push(m); return bridge.handleMessage(ch, m); } });
  await waitFor(() => got.length === 3, { timeoutMs: 5000 });
  ac.abort();
  await started;
  assert.deepEqual(got.map((m) => m.text), ['run this', 'again', '/help']);
});
