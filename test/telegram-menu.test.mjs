// M1: Telegram setMyCommands menu behaviour.
import test from 'node:test';
import assert from 'node:assert/strict';
import { TelegramChannel } from '../src/channels/telegram.js';
import { listCommands } from '../src/chat-commands.js';

function makeTelegram() {
  const ch = new TelegramChannel({ id: 'tg', type: 'telegram', label: 'T', token: 'x', botUsername: 'MyBot', allowedChatIds: [] });
  ch.calls = [];
  ch.call = async (method, params = {}) => { ch.calls.push({ method, params }); return { ok: true, result: [] }; };
  return ch;
}

test('menu payload: visible, non-hidden commands only', async () => {
  const ch = makeTelegram();
  await ch.registerCommands(listCommands(), { menu: true, hidden: ['status'] });
  const set = ch.calls.find((c) => c.method === 'setMyCommands');
  assert.ok(set, 'setMyCommands must be called');
  const names = set.params.commands.map((c) => c.command);
  for (const want of ['help', 'new', 'whoami']) assert.ok(names.includes(want), `menu missing ${want}`);
  assert.ok(!names.includes('status'), 'hidden command must be excluded');
  for (const c of set.params.commands) {
    assert.match(c.command, /^[a-z0-9_]{1,32}$/);
    assert.ok(c.description.length >= 1 && c.description.length <= 256);
  }
});

test('menu disabled: no setMyCommands call', async () => {
  const ch = makeTelegram();
  await ch.registerCommands(listCommands(), { menu: false });
  assert.ok(!ch.calls.some((c) => c.method === 'setMyCommands'));
});

test('menu failure is tolerated (warn, never throw)', async () => {
  const ch = makeTelegram();
  ch.call = async () => { throw new Error('network down'); };
  await assert.doesNotReject(() => ch.registerCommands(listCommands(), { menu: true }));
});

test('setMyCommands rejection is tolerated', async () => {
  const ch = makeTelegram();
  ch.call = async () => ({ ok: false, description: 'bad request' });
  await assert.doesNotReject(() => ch.registerCommands(listCommands(), { menu: true }));
});
