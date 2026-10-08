// M1: command parser, registry dispatch, generated help.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parseCommand, listCommands, helpText } from '../src/chat-commands.js';
import { makeBridge, waitFor } from './helpers.mjs';
import { sessions } from '../src/config.js';

test('parseCommand table: case, args, @bot, unknown word', () => {
  const cases = [
    ['/help', { botUsername: 'MyBot' }, { name: 'help', args: '' }],
    ['/HELP', {}, { name: 'help', args: '' }],
    ['/status  some Args', {}, { name: 'status', args: 'some Args' }],
    ['/help@MyBot', { botUsername: 'MyBot' }, { name: 'help', args: '' }],
    ['/help@mybot', { botUsername: 'MyBot' }, { name: 'help', args: '' }],
    ['/help@OtherBot', { botUsername: 'MyBot' }, { ignore: true }],
    ['/new@MyBot task text', { botUsername: 'MyBot' }, { name: 'new', args: 'task text' }],
    ['/start', {}, { name: 'help', args: '' }],
    ['/frobnicate', {}, null],
    ['hello', {}, null],
    ['', {}, null],
    ['/help   ', {}, { name: 'help', args: '' }],
  ];
  for (const [text, opts, expected] of cases) {
    const got = parseCommand(text, opts);
    if (expected === null) assert.equal(got, null, `"${text}" must not parse as a command`);
    else if (expected.ignore) assert.deepEqual(got, { ignore: true }, `"${text}" must be ignored`);
    else {
      assert.ok(got, `"${text}" must parse as a command`);
      assert.equal(got.cmd.name, expected.name, `"${text}" name`);
      assert.equal(got.args, expected.args, `"${text}" args`);
    }
  }
});

test('parseCommand: @bot with no known botUsername is accepted', () => {
  const got = parseCommand('/help@Whatever', {});
  assert.ok(got && got.cmd.name === 'help');
});

test('help text is generated from the registry', () => {
  const help = helpText();
  assert.ok(help.includes('Aside Remote Control'));
  for (const c of listCommands().filter((x) => !x.hidden)) {
    assert.ok(help.includes(`/${c.name}`), `generated help missing /${c.name}`);
  }
});

test('dispatch: migrated commands keep their first lines (M3 extends /whoami)', async () => {
  const { bridge, channel } = makeBridge();
  await bridge.handleMessage(channel, { chatId: 7, text: '/whoami', from: 'u' });
  assert.ok(channel.sent.at(-1).text.startsWith('chat id: 7\nusername: u\n'), 'first two lines unchanged');
  assert.ok(channel.sent.at(-1).text.includes('user id:'));
  assert.ok(/role: (admin|user)/.test(channel.sent.at(-1).text));
  assert.ok(channel.sent.at(-1).text.includes('chat type: private'));
  await bridge.handleMessage(channel, { chatId: 7, text: '/status' });
  assert.equal(channel.sent.at(-1).text, 'No active session yet. Send a task to start one.');
  await bridge.handleMessage(channel, { chatId: 7, text: '/new' });
  assert.equal(channel.sent.at(-1).text, 'Started a fresh session. Send your task.');
  sessions.set(channel.id, 7, 'S-1');
  await bridge.handleMessage(channel, { chatId: 7, text: '/status' });
  assert.equal(channel.sent.at(-1).text, 'Active session: S-1');
  await bridge.handleMessage(channel, { chatId: 7, text: '/help' });
  assert.ok(channel.sent.at(-1).text.includes('Aside Remote Control'));
  await bridge.handleMessage(channel, { chatId: 7, text: '/start' });
  assert.ok(channel.sent.at(-1).text.includes('Aside Remote Control'));
});

test('dispatch: unknown /word is a task for the agent', async () => {
  const { bridge, channel, argvLog } = makeBridge({ fakeAside: { lines: ['Answer: ok'] } });
  const p = bridge.handleMessage(channel, { chatId: 3, text: '/frobnicate' });
  const logHas = () => { try { return readFileSync(argvLog, 'utf8').length > 0; } catch { return false; } };
  assert.ok(await waitFor(logHas, { timeoutMs: 5000 }));
  await p;
  assert.ok(readFileSync(argvLog, 'utf8').includes('/frobnicate'));
});

test('dispatch: /cmd@OtherBot is silently ignored', async () => {
  const { bridge, channel } = makeBridge();
  channel.botUsername = 'MyBot';
  await bridge.handleMessage(channel, { chatId: 3, text: '/help@OtherBot' });
  assert.equal(channel.sent.length, 0);
});

test('attachments disable command parsing (a caption is never a command)', async () => {
  const { bridge, channel, argvLog } = makeBridge({ fakeAside: { lines: ['Answer: ok'] } });
  bridge.config.attachments.enabled = true;
  const download = async (dir) => {
    mkdirSync(dir, { recursive: true });
    const p = path.join(dir, 'm1.jpg');
    writeFileSync(p, 'x');
    return p;
  };
  await bridge.handleMessage(channel, {
    chatId: 9, text: '/help', messageId: 1,
    attachments: [{ kind: 'photo', name: 'm1.jpg', mimeType: 'image/jpeg', size: 1, download }],
  });
  assert.ok(!channel.sent.some((s) => String(s.text).includes('Aside Remote Control')), 'help must not fire for captions');
  assert.ok(readFileSync(argvLog, 'utf8').includes('/help'), 'caption must run as a task');
});
