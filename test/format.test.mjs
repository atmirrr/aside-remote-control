// Tests for verbose filtering (extractAnswer) and Telegram markdown rendering.
// Run with: ASIDE_REMOTE_HOME=$(mktemp -d) node --test test/
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { Bridge } from '../src/bridge.js';
import { HOME } from '../src/config.js';
import { extractAnswer, mdToTelegramHtml, stripCitations } from '../src/util.js';
import { TelegramChannel } from '../src/channels/telegram.js';

if (!process.env.ASIDE_REMOTE_HOME) throw new Error('Set ASIDE_REMOTE_HOME to a temp dir.');
fs.mkdirSync(HOME, { recursive: true });
const resetSessions = () => {
  fs.writeFileSync(path.join(HOME, 'sessions.json'), '{}');
  fs.writeFileSync(path.join(HOME, 'history.json'), '{}');
};
const ok = (text) => ({ text, sessionId: null, code: 0, error: false, sessionMissing: false });

const TRANSCRIPT = [
  'Thinking: I need to open the page and read its heading.',
  "repl(title: 'Open the page',",
  "     code: 'const p = await openTab(\"https://example.com\"); console.log((await snapshot(p)).tree)')",
  ' > Opened a new tab and set it active: tabs[0]',
  '- heading "Example Domain" [level=1]',
  '- text: "This domain is for use in examples."',
  'The page heading is **Example Domain**.',
].join('\n');

// ---------------- extractAnswer ----------------
test('extractAnswer strips Thinking/repl/tool-output/snapshot, keeps the answer', () => {
  assert.equal(extractAnswer(TRANSCRIPT), 'The page heading is **Example Domain**.');
});
test('extractAnswer keeps real markdown list items', () => {
  assert.equal(extractAnswer('Steps:\n- First\n- Second'), 'Steps:\n- First\n- Second');
});
test('extractAnswer leaves an already-clean answer unchanged', () => {
  assert.equal(extractAnswer('42'), '42');
});
test('extractAnswer returns empty for an answerless transcript (only Thinking + tool calls)', () => {
  // pure Thinking + tool call (the real read_file-suspended shape)
  assert.equal(extractAnswer("Thinking: trying read_file\nread_file(path: '/x')"), '');
  // dim-wrapped tool output is colour-stripped too, leaving nothing
  const E = '\x1b';
  assert.equal(extractAnswer(`${E}[2mThinking: x${E}[0m\nread_file(path: '/x')\n${E}[2m > [stderr]\nnot permitted${E}[0m`), '');
});
test('extractAnswer uses ANSI dim spans to strip Thinking + arbitrary tool output dumps', () => {
  const E = '\x1b';
  const raw = `${E}[2mThinking: checking${E}[0m\n` +
    `${E}[32mread_file${E}[0m(path: ${E}[32m'/x'${E}[39m)\n` +
    `${E}[2m > dump line 1\nsecret dump line 2${E}[0m\n` +
    'The version is 1.2.3.\n';
  assert.equal(extractAnswer(raw), 'The version is 1.2.3.');
});
test('extractAnswer strips non-repl tool calls (bash, read_file)', () => {
  const t = "bash(command: 'ls', title: 'List')\nread_file(path: '/x')\nDone: 5 files.";
  assert.equal(extractAnswer(t), 'Done: 5 files.');
});

// ---------------- mdToTelegramHtml ----------------
test('mdToTelegramHtml renders bold/italic/code/link', () => {
  assert.equal(
    mdToTelegramHtml('**b** and *i* and `c` and [l](https://x.com)'),
    '<b>b</b> and <i>i</i> and <code>c</code> and <a href="https://x.com">l</a>',
  );
});
test('mdToTelegramHtml escapes html and never eats plain numbers', () => {
  assert.equal(mdToTelegramHtml('1 < 2 & 3 has 4 apples'), '1 &lt; 2 &amp; 3 has 4 apples');
});
test('mdToTelegramHtml renders fenced code blocks', () => {
  assert.equal(mdToTelegramHtml('```\nnpm test\n```'), '<pre>npm test</pre>');
});
test('mdToTelegramHtml does not format inside code spans', () => {
  assert.equal(mdToTelegramHtml('`a**b**c`'), '<code>a**b**c</code>');
});

// ---------------- bridge verbose behavior ----------------
function makeChannel() {
  return { id: 'test-chan', sent: [], isAuthorized: () => true,
    async sendText(_c, t) { this.sent.push(t); }, async sendTyping() {}, async sendImage() {} };
}
function makeBridge(out, agent = {}) {
  const b = new Bridge({ agent: { command: 'x', ...agent }, channels: [] });
  b.agent = { run: async () => ok(out) };
  return b;
}

test('default (verbose off): only the clean answer is sent', async () => {
  resetSessions();
  const ch = makeChannel();
  await makeBridge(TRANSCRIPT).handleMessage(ch, { chatId: '1', text: 'go', from: 'u' });
  assert.equal(ch.sent.at(-1), 'The page heading is **Example Domain**.');
  assert.ok(!ch.sent.some((t) => /Thinking:|repl\(/.test(t)));
});

test('verbose:true forwards the full raw transcript', async () => {
  resetSessions();
  const ch = makeChannel();
  await makeBridge(TRANSCRIPT, { verbose: true }).handleMessage(ch, { chatId: '1', text: 'go', from: 'u' });
  assert.ok(ch.sent.at(-1).includes('Thinking:'));
  assert.ok(ch.sent.at(-1).includes('The page heading'));
});

test('an answerless transcript shows a clean note, never the raw transcript', async () => {
  resetSessions();
  const ch = makeChannel();
  const noiseOnly = "Thinking: I'll try read_file\nread_file(path: '/etc/x')";
  await makeBridge(noiseOnly).handleMessage(ch, { chatId: '1', text: 'go', from: 'u' });
  assert.ok(/no answer produced/i.test(ch.sent.at(-1)));
  assert.ok(!ch.sent.some((t) => /Thinking:|read_file\(/.test(t))); // no leak
});

// ---------------- Telegram markdown rendering + fallback ----------------
test('sendOne renders HTML for markdown and falls back to plain on rejection', async () => {
  const ch = new TelegramChannel({ id: 't', token: 'x', botUsername: 'b' });
  const calls = [];
  ch.call = async (_m, params) => { calls.push(params); return params.parse_mode ? { ok: false } : { ok: true, result: { message_id: 5 } }; };
  const id = await ch.sendOne('1', 'hello **world**', { markdown: true });
  assert.equal(calls.length, 2);                  // HTML attempt, then plain fallback
  assert.equal(calls[0].parse_mode, 'HTML');
  assert.equal(calls[0].text, 'hello <b>world</b>');
  assert.equal(calls[1].parse_mode, undefined);
  assert.equal(calls[1].text, 'hello **world**');  // original markdown, unrendered
  assert.equal(id, 5);
});

test('sendOne sends plain (one call) when markdown is off', async () => {
  const ch = new TelegramChannel({ id: 't', token: 'x' });
  const calls = [];
  ch.call = async (_m, p) => { calls.push(p); return { ok: true, result: { message_id: 9 } }; };
  await ch.sendOne('1', 'just plain', {});
  assert.equal(calls.length, 1);
  assert.equal(calls[0].parse_mode, undefined);
});

// The CLI prints an update banner on stdout, un-dimmed, so it survived the
// colour filter and appeared above every answer in the chat. Seen live.
test('extractAnswer strips the CLI update banner', () => {
  const raw = 'Aside CLI 1.26.709.1533 is available \x1b[2m(current 1.26.706.1553). Run: aside --update\x1b[0m\r\n4\r\n';
  assert.equal(extractAnswer(raw), '4');
});
test('extractAnswer keeps an answer that merely mentions availability', () => {
  assert.equal(extractAnswer('The room is available tomorrow.'), 'The room is available tomorrow.');
});

// Citation markup: the agent cites sources with <citation refs="…">claim</citation>
// (plus one nested <quote> per source). Telegram has no footnote affordance, so
// before this the tags were HTML-escaped and shown to the user as literal text.
test('stripCitations unwraps a citation, keeping the claim', () => {
  assert.equal(stripCitations('It is <citation refs="s1#1">sunny</citation> today.'), 'It is sunny today.');
});

test('stripCitations drops nested quote excerpts but keeps the claim', () => {
  const s = 'It is <citation refs="a#1,b#2">free<quote refs="a#1">entrada gratuita</quote><quote refs="b#2">no charge</quote></citation>.';
  assert.equal(stripCitations(s), 'It is free.');
});

test('stripCitations removes orphaned/unclosed tags', () => {
  assert.equal(stripCitations('Broken <citation refs="z#9">tail'), 'Broken tail');
  assert.equal(stripCitations('Stray </quote> here'), 'Stray here');
});

test('stripCitations leaves citation-free text byte-identical', () => {
  const s = 'Plain  text   spacing.\n\n\n\nAnd gaps.';
  assert.equal(stripCitations(s), s);
});

test('stripCitations does not touch fenced code about citation syntax', () => {
  const s = 'Docs:\n```\n<citation refs="s#1">x</citation>\n```\nSee <citation refs="s#1">above</citation>.';
  assert.equal(stripCitations(s), 'Docs:\n```\n<citation refs="s#1">x</citation>\n```\nSee above.');
});

test('extractAnswer strips citation markup from the final answer', () => {
  assert.equal(extractAnswer('Thinking: hmm\nThe gym is <citation refs="v#1">EUR 9/month</citation>.'), 'The gym is EUR 9/month.');
});

test('mdToTelegramHtml renders inside a citation instead of escaping the tag', () => {
  assert.equal(mdToTelegramHtml('It is <citation refs="s#1">**sunny**</citation> today.'), 'It is <b>sunny</b> today.');
  assert.equal(mdToTelegramHtml('Use <div> tags'), 'Use &lt;div&gt; tags');
});
