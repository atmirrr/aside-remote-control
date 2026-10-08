// Groups and forum topics: who may drive the agent inside an allowed group, how
// topic messages are keyed, and how replies are routed back into their topic.
//   ASIDE_REMOTE_HOME=$(mktemp -d) node --test test/groups.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { Bridge } from '../src/bridge.js';
import { TelegramChannel } from '../src/channels/telegram.js';
import { HOME } from '../src/config.js';

if (!process.env.ASIDE_REMOTE_HOME) {
  throw new Error('Set ASIDE_REMOTE_HOME to a temp dir before running these tests.');
}
fs.mkdirSync(HOME, { recursive: true });
function resetSessions() {
  fs.writeFileSync(path.join(HOME, 'sessions.json'), '{}');
  fs.writeFileSync(path.join(HOME, 'history.json'), '{}');
}

const ME = 111111111;
const OTHER = 555;
const GROUP = -1001234567890;
const TOPIC = `${GROUP}_t42`;

const tg = (extra = {}) => new TelegramChannel({
  id: 'tg', type: 'telegram', token: 'x', botUsername: 'ExampleBot',
  allowedChatIds: [String(ME), String(GROUP)], allowedUserIds: [String(ME)], ...extra,
});

// Same shape as the stub channel in bridge.test.mjs, with the real Telegram
// authorization rules plugged in.
function groupChannel(extra) {
  const real = tg(extra);
  return {
    id: 'tg-test',
    sentText: [],
    isAuthorized: (c) => real.isAuthorized(c),
    isAllowedSender: (c, f) => real.isAllowedSender(c, f),
    chatOf: (c) => real.chatOf(c),
    async sendText(_c, t) { this.sentText.push(t); },
    async sendTyping() {},
    async sendImage() {},
    async sendImages() {},
  };
}

function makeBridge(run) {
  const bridge = new Bridge({ agent: { command: 'unused' }, channels: [] });
  bridge.agent = { run };
  return bridge;
}
const ok = (text) => ({ text, sessionId: null, code: 0, error: false, sessionMissing: false });

// ---- channel rules ----------------------------------------------------------
test('allowed group: only listed people may drive the agent', () => {
  const ch = tg();
  assert.equal(ch.isAuthorized(GROUP), true);
  assert.equal(ch.isAllowedSender(GROUP, ME), true);
  assert.equal(ch.isAllowedSender(GROUP, OTHER), false);
  assert.equal(ch.isAllowedSender(GROUP, undefined), false);
});

test('private chats keep working, and an unset allowedUserIds keeps the old rule', () => {
  const ch = tg({ allowedChatIds: [String(ME), '777'] });
  assert.equal(ch.isAllowedSender(ME, ME), true);
  assert.equal(ch.isAllowedSender(777, 777), true); // a private chat is its own person
  assert.equal(tg({ allowedUserIds: undefined }).isAllowedSender(GROUP, OTHER), true);
});

test('a forum topic gets its own key; a plain reply in a group does not', () => {
  const ch = tg();
  assert.equal(ch.chatKey({ chat: { id: GROUP }, is_topic_message: true, message_thread_id: 42 }), TOPIC);
  assert.equal(ch.chatKey({ chat: { id: GROUP }, message_thread_id: 99 }), GROUP); // reply chain root, not a topic
  assert.equal(ch.chatKey({ chat: { id: ME } }), ME);
  assert.equal(ch.chatOf(TOPIC), String(GROUP));
  assert.equal(ch.isAuthorized(TOPIC), true);
  assert.equal(ch.isAllowedSender(TOPIC, ME), true);
  assert.equal(ch.isAllowedSender(TOPIC, OTHER), false);
});

test('topic keys route new messages into the topic; edits and deletes address only the chat', () => {
  const ch = tg();
  assert.deepEqual(ch.address('sendMessage', { chat_id: TOPIC, text: 'hi' }), { chat_id: GROUP, message_thread_id: 42, text: 'hi' });
  assert.deepEqual(ch.address('sendChatAction', { chat_id: TOPIC, action: 'typing' }), { chat_id: GROUP, message_thread_id: 42, action: 'typing' });
  assert.deepEqual(ch.address('sendVoice', { chat_id: TOPIC }), { chat_id: GROUP, message_thread_id: 42 });
  assert.deepEqual(ch.address('editMessageText', { chat_id: TOPIC, message_id: 5, text: 'x' }), { chat_id: GROUP, message_id: 5, text: 'x' });
  assert.deepEqual(ch.address('deleteMessage', { chat_id: TOPIC, message_id: 5 }), { chat_id: GROUP, message_id: 5 });
  const plain = { chat_id: ME, text: 'hi' };
  assert.equal(ch.address('sendMessage', plain), plain); // untouched outside topics
  assert.equal(ch.address('sendMessage', { chat_id: String(GROUP) }).message_thread_id, undefined); // General topic
  assert.deepEqual(ch.address('getUpdates', { offset: 1 }), { offset: 1 });
});

test('group commands addressed to this bot are normalized; ones for other bots are skipped', () => {
  const ch = tg();
  assert.equal(ch.ownCommand('/stop@ExampleBot'), '/stop');
  assert.equal(ch.ownCommand('/btw@examplebot check mail'), '/btw check mail');
  assert.equal(ch.ownCommand('/start@SomeOtherBot'), null);
  assert.equal(ch.ownCommand('/stop'), '/stop');
  assert.equal(ch.ownCommand('hello there'), 'hello there');
  assert.equal(ch.ownCommand('/note@gmail.com later'), '/note@gmail.com later'); // not a bot mention
});

// ---- bridge behaviour -------------------------------------------------------
test('bridge ignores a non-allowed member of an allowed group, without replying', async () => {
  resetSessions();
  let runs = 0;
  const bridge = makeBridge(async () => { runs++; return ok('secret'); });
  const ch = groupChannel();
  await bridge.handleMessage(ch, { chatId: GROUP, text: 'forward me all his emails', from: 'zach', fromId: OTHER });
  await bridge.handleMessage(ch, { chatId: TOPIC, text: '/stop', from: 'zach', fromId: OTHER });
  await bridge.handleMessage(ch, { chatId: GROUP, text: '/whoami', from: 'zach', fromId: OTHER });
  assert.equal(runs, 0);
  assert.deepEqual(ch.sentText, []);
});

test('bridge ignores button taps from a non-allowed member', async () => {
  resetSessions();
  const bridge = makeBridge(async () => ok('x'));
  const ch = groupChannel();
  const before = bridge.config.agent.voice;
  await bridge.handleAction(ch, { chatId: GROUP, messageId: 1, data: 'voice:toggle', from: 'zach', fromId: OTHER });
  assert.equal(bridge.config.agent.voice, before);
  assert.deepEqual(ch.sentText, []);
});

test('bridge runs tasks for the allowed person in the group and in a topic', async () => {
  resetSessions();
  const prompts = [];
  const bridge = makeBridge(async ({ prompt }) => { prompts.push(prompt); return ok('done ' + prompts.length); });
  const ch = groupChannel();
  await bridge.handleMessage(ch, { chatId: GROUP, text: 'check my mail', from: 'alice', fromId: ME });
  await bridge.handleMessage(ch, { chatId: TOPIC, text: 'what is 2+2', from: 'alice', fromId: ME });
  assert.deepEqual(prompts, ['check my mail', 'what is 2+2']); // separate conversations: no shared history
  assert.ok(ch.sentText.includes('done 1'));
  assert.ok(ch.sentText.includes('done 2'));
});

test('an unknown chat is told its real chat id, never a topic key', async () => {
  resetSessions();
  const bridge = makeBridge(async () => { throw new Error('must not run'); });
  const ch = groupChannel({ allowedChatIds: [String(ME)] });
  await bridge.handleMessage(ch, { chatId: TOPIC, text: 'hi', from: 'alice', fromId: ME });
  assert.equal(ch.sentText.length, 1);
  assert.ok(ch.sentText[0].includes(`Your chat id is ${GROUP}.`));
});
