// Enforces the repo's invariants mechanically. See AGENTS.md for the table.
// I1 zero dependencies · I2 Node >= 18 source floor · I3 outbound-only networking.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listCommands, helpText } from '../src/chat-commands.js';
import { DEFAULT_CONFIG } from '../src/config.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const AREAS = ['src', 'bin', 'test'];

// Manual recursive walk: readdirSync({recursive}) and fs.glob are Node 20+
// and therefore banned here too (I2).
function walk(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (/\.(c|m)?js$/.test(e.name)) out.push(p);
  }
  return out;
}

function codeFiles(areas = AREAS) {
  return areas.flatMap((a) => walk(path.join(root, a)));
}

// A line carrying this comment is exempt from the banned-API scan (I2 escape
// hatch); the reason must be stated after the colon.
const IGNORE = 'invariants-ignore';

function eachLine(content, fn) {
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes(IGNORE)) continue;
    fn(lines[i], i + 1);
  }
}

test('I1: package.json has zero dependency entries', () => {
  const keys = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];
  for (const key of keys) {
    const v = pkg[key];
    const empty = v === undefined || (typeof v === 'object' && Object.keys(v).length === 0);
    assert.ok(empty, `I1: package.json must not declare "${key}" (found ${JSON.stringify(v)})`);
  }
});

test('I2: no API newer than the Node 18 source floor', () => {
  const banned = [
    { re: /\btoSorted\s*\(/, name: 'Array#toSorted' },
    { re: /\btoReversed\s*\(/, name: 'Array#toReversed' },
    { re: /\bObject\.groupBy\s*\(/, name: 'Object.groupBy' },
    { re: /\bArray\.fromAsync\s*\(/, name: 'Array.fromAsync' },
    { re: /\bPromise\.withResolvers\s*\(/, name: 'Promise.withResolvers' },
    { re: /import\.meta\.dirname/, name: 'import.meta.dirname' },
    { re: /import\.meta\.filename/, name: 'import.meta.filename' },
    { re: /\bfs\.glob/, name: 'fs.glob*' },
    { re: /readdirSync\s*\([^)]*\{\s*recursive\s*:/, name: 'readdirSync({recursive})' },
    { re: /\bAbortSignal\.any\s*\(/, name: 'AbortSignal.any' },
    { re: /\bmock\.timers\b/, name: 'mock.timers' },
    { re: /\bWebSocket\b/, name: 'global WebSocket' },
    { re: /(^|[^.a-zA-Z])fetch\s*\(/, name: 'global fetch (use util httpsJson)' },
    { re: /\bgetBuiltinModule\s*\(/, name: 'process.getBuiltinModule' },
    { re: /\.union\s*\(/, name: 'Set#union' },
    { re: /\.intersection\s*\(/, name: 'Set#intersection' },
    { re: /\.difference\s*\(/, name: 'Set#difference' },
  ];
  const hits = [];
  for (const f of codeFiles()) {
    const rel = path.relative(root, f);
    // This file's own banned-list literals would otherwise self-match.
    if (rel === 'test/invariants.test.mjs') continue;
    eachLine(readFileSync(f, 'utf8'), (line, n) => {
      for (const { re, name } of banned) {
        if (re.test(line)) hits.push(`${rel}:${n} uses ${name} (Node > 18)`);
      }
    });
  }
  assert.deepEqual(hits, []);
});

test('I2: every import specifier is relative or node: prefixed', () => {
  const re = /(?:import|export)[^'"]*?from\s*['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]|^import\s+['"]([^'"]+)['"]/gm;
  const bad = [];
  for (const f of codeFiles()) {
    const content = readFileSync(f, 'utf8');
    for (const m of content.matchAll(re)) {
      const spec = m[1] || m[2] || m[3];
      if (spec && !spec.startsWith('./') && !spec.startsWith('../') && !spec.startsWith('node:')) {
        bad.push(`${path.relative(root, f)} imports "${spec}"`);
      }
    }
  }
  assert.deepEqual(bad, []);
});

test('I3: no listening servers in production code', () => {
  // Production code only: hermetic tests legitimately spin a loopback HTTP
  // server as a download fixture (test/attachments.test.mjs), which is not
  // the bridge exposing a listener.
  const re = /createServer\s*\(|\.listen\s*\(/;
  const hits = [];
  for (const f of codeFiles(['src', 'bin'])) {
    const rel = path.relative(root, f);
    eachLine(readFileSync(f, 'utf8'), (line, n) => {
      if (re.test(line)) hits.push(`${rel}:${n}`);
    });
  }
  assert.deepEqual(hits, []);
});

test('I10: command registry is valid and documented', () => {
  const cmds = listCommands();
  assert.ok(cmds.length <= 100, `I10: at most 100 commands (found ${cmds.length})`);
  const names = new Set();
  const aliases = new Set();
  for (const c of cmds) {
    assert.match(c.name, /^[a-z0-9_]{1,32}$/, `I10: bad command name "${c.name}"`);
    assert.ok(
      typeof c.description === 'string' && c.description.length >= 3 && c.description.length <= 256,
      `I10: bad description for "/${c.name}"`,
    );
    assert.ok(!names.has(c.name), `I10: duplicate command name "${c.name}"`);
    names.add(c.name);
    for (const a of c.aliases || []) {
      assert.ok(!names.has(a) && !aliases.has(a), `I10: duplicate alias "${a}"`);
      aliases.add(a);
    }
  }
  const readme = readFileSync(path.join(root, 'README.md'), 'utf8');
  const commandsSection = readme.split('## In-chat commands')[1]?.split('\n## ')[0] ?? '';
  const help = helpText();
  for (const c of cmds) {
    if (c.hidden) continue;
    assert.ok(
      new RegExp('\\|\\s*`?/' + c.name + '\\b').test(commandsSection),
      `I10: README In-chat commands table missing /${c.name}`,
    );
    assert.ok(help.includes(`/${c.name}`), `I10: generated /help missing /${c.name}`);
  }
});

test('I10: every top-level config key appears in the README config block', () => {
  const readme = readFileSync(path.join(root, 'README.md'), 'utf8');
  const section = readme.split('## Configuration')[1]?.split('\n## ')[0] ?? '';
  for (const key of Object.keys(DEFAULT_CONFIG)) {
    if (key === 'version') continue;
    assert.ok(new RegExp(`\\b${key}\\b`).test(section), `I10: README config block missing key "${key}"`);
  }
});
