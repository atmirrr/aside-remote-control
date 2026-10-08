// When the terminal scrape (extractAnswer) finds no answer, or misses the
// summary marker, the bridge reads the reply from Aside's session store.
// Regression for Oct 1, 2026: a 14-minute voice task ended with the speaker
// saying "No answer produced" although the agent had replied with a summary.
// Run with: ASIDE_REMOTE_HOME=$(mktemp -d) node --test test/
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Bridge } from '../src/bridge.js';
import { HOME } from '../src/config.js';
import { readFinalReply } from '../src/util.js';

if (!process.env.ASIDE_REMOTE_HOME) throw new Error('Set ASIDE_REMOTE_HOME to a temp dir.');
fs.mkdirSync(HOME, { recursive: true });
const resetSessions = () => {
  fs.writeFileSync(path.join(HOME, 'sessions.json'), '{}');
  fs.writeFileSync(path.join(HOME, 'history.json'), '{}');
};

const SID = 'StoreTestSession01';
const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'aside-store-'));
const sessionDir = path.join(fakeHome, '.aside', 'u', '0', 'sessions', `2026-10-01_${SID}`);
fs.mkdirSync(sessionDir, { recursive: true });
const writeStore = (rows) => fs.writeFileSync(path.join(sessionDir, 'messages.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');

const now = Date.now();
const ROWS = [
  { role: 'user', content: [{ type: 'text', text: 'an older question' }], timestamp: now - 600000 },
  { role: 'assistant', content: [{ type: 'text', text: 'an older answer' }], timestamp: now - 590000 },
  { role: 'user', content: [{ type: 'text', text: 'find me a speaker' }], timestamp: now - 1000 },
  { role: 'assistant', content: [{ type: 'thinking', thinking: 'hmm' }, { type: 'toolCall', id: 't1', name: 'bash', arguments: {} }], timestamp: now - 900 },
  { role: 'toolResult', toolCallId: 't1', content: [{ type: 'text', text: 'ok' }], timestamp: now - 800 },
  { role: 'assistant', content: [{ type: 'text', text: 'Full answer.\n<<<SUMMARY>>>\nShort spoken recap.' }], timestamp: now - 500 },
];

test('readFinalReply returns the newest assistant text of this run', () => {
  writeStore(ROWS);
  assert.equal(readFinalReply(SID, now - 2000, fakeHome), 'Full answer.\n<<<SUMMARY>>>\nShort spoken recap.');
});

test('readFinalReply never returns a reply from before the run started', () => {
  writeStore(ROWS.slice(0, 5)); // this run has not replied yet
  assert.equal(readFinalReply(SID, now - 2000, fakeHome), '');
});

test('readFinalReply ignores unknown or unsafe session ids', () => {
  writeStore(ROWS);
  assert.equal(readFinalReply('NoSuchSession99', 0, fakeHome), '');
  assert.equal(readFinalReply('../../etc', 0, fakeHome), '');
});

test('an empty scrape falls back to the stored reply, and the summary is what gets sent', async () => {
  resetSessions();
  writeStore(ROWS);
  const prevHome = process.env.HOME;
  process.env.HOME = fakeHome; // os.homedir() reads $HOME
  try {
    const sent = [];
    const ch = { id: 'voice-test', sent, isAuthorized: () => true, forcesSummary: true, wantsPlaceholder: false,
      async sendText(_c, t) { sent.push(t); }, async sendTyping() {}, async sendImage() {} };
    const b = new Bridge({ agent: { command: 'x', summaryPrompt: 'Finish with {marker}.' }, channels: [] });
    // Only tool noise reaches the terminal: the scrape finds nothing.
    b.agent = { run: async () => ({ text: "bash(command: 'ls')", raw: "bash(command: 'ls')", sessionId: SID, code: 0, error: false, sessionMissing: false }) };
    await b.handleMessage(ch, { chatId: '1', text: 'find me a speaker', from: 'u' });
    assert.equal(sent.at(-1), 'Short spoken recap.');
    assert.ok(!sent.some((t) => /no answer produced/i.test(t)));
  } finally {
    process.env.HOME = prevHome;
  }
});

test('a scrape that has the answer is left alone', async () => {
  resetSessions();
  writeStore(ROWS);
  const prevHome = process.env.HOME;
  process.env.HOME = fakeHome;
  try {
    const sent = [];
    const ch = { id: 'voice-test', sent, isAuthorized: () => true, forcesSummary: true, wantsPlaceholder: false,
      async sendText(_c, t) { sent.push(t); }, async sendTyping() {}, async sendImage() {} };
    const b = new Bridge({ agent: { command: 'x', summaryPrompt: 'Finish with {marker}.' }, channels: [] });
    const raw = 'Scraped answer.\n<<<SUMMARY>>>\nScraped recap.';
    b.agent = { run: async () => ({ text: raw, raw, sessionId: SID, code: 0, error: false, sessionMissing: false }) };
    await b.handleMessage(ch, { chatId: '1', text: 'find me a speaker', from: 'u' });
    assert.equal(sent.at(-1), 'Scraped recap.');
  } finally {
    process.env.HOME = prevHome;
  }
});
