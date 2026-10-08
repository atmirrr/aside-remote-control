// Shared helpers for NEW tests. Existing tests keep their own stubs — do not
// refactor them onto these. Tests run via `npm test` (test/run.mjs), which
// gives every test file its own temp ASIDE_REMOTE_HOME.
import path from 'node:path';
import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Bridge } from '../src/bridge.js';
import { Channel } from '../src/channels/base.js';
import { HOME } from '../src/config.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const FAKE_ASIDE = path.join(root, 'test', 'fixtures', 'fake-aside.mjs');

let seq = 0;

// Stub channel that records everything it was asked to send.
export function makeChannel(overrides = {}) {
  const ch = new Channel({ id: 'test', type: 'test', label: 'Test' });
  ch.sent = [];
  ch.typing = [];
  ch.images = [];
  ch.edits = [];
  ch.sendText = async (chatId, text, opts) => { ch.sent.push({ chatId, text, opts }); };
  ch.sendTyping = async (chatId) => { ch.typing.push(chatId); };
  ch.sendImage = async (chatId, file, caption) => { ch.images.push({ chatId, file, caption }); };
  ch.editText = async (chatId, messageId, text) => { ch.edits.push({ chatId, messageId, text }); return true; };
  Object.assign(ch, overrides);
  return ch;
}

// Bridge wired to the fake aside CLI, no pty wrapper, no network.
// fakeAside/agent entries are merged into the fake-CLI config.
export function makeBridge({ fakeAside = {}, channel, agent = {} } = {}) {
  const n = ++seq;
  const stateFile = path.join(HOME, `fake-aside-state-${n}.json`);
  const argvLog = path.join(HOME, `fake-aside-argv-${n}.log`);
  process.env.FAKE_ASIDE = JSON.stringify({ argvLog, ...fakeAside });
  process.env.FAKE_ASIDE_STATE = stateFile;
  const config = {
    version: 1,
    agent: {
      command: FAKE_ASIDE,
      wrapper: [],
      newArgs: ['exec'],
      continueArgs: ['session', 'resume', '{session}'],
      sessionRegex: 'created new session: ([A-Za-z0-9_-]+)',
      timeoutMs: 10000,
      idleTimeoutMs: 0,
      stream: false,
      context: true,
      contextMaxChars: 2000,
      maxConcurrent: 1,
      maxQueuePerChat: 5,
      ...agent,
    },
    voice: { enabled: false },
    attachments: { enabled: false },
    channels: [],
  };
  const bridge = new Bridge(config);
  const chan = channel || makeChannel();
  return { bridge, config, channel: chan, home: HOME, stateFile, argvLog };
}

// Poll until cond() is truthy or the timeout elapses. Keeps every sleep
// under the 200 ms I9 cap.
export async function waitFor(cond, { timeoutMs = 3000, intervalMs = 20 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}
