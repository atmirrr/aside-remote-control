// Enforces the repo's invariants mechanically. See AGENTS.md for the table.
// I1 zero dependencies · I2 Node >= 18 source floor · I3 outbound-only networking.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
