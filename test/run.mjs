#!/usr/bin/env node
// Test runner that works on Node 18–24+: runs each test/*.test.mjs file
// sequentially in its own `node --test` child with a fresh temp
// ASIDE_REMOTE_HOME, aggregates exit codes, and cleans temp dirs.
//
// Why not just `node --test test/`: Node >= 21 no longer accepts a directory
// positional, and --test-concurrency only exists on Node >= 20.10. Per-file
// children sidestep both and keep Node 18 compatibility.
import { readdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const files = readdirSync(path.join(root, 'test'))
  .filter((f) => f.endsWith('.test.mjs'))
  .sort();

let failed = 0;
for (const f of files) {
  const home = mkdtempSync(path.join(tmpdir(), 'aside-remote-test-'));
  const r = spawnSync(process.execPath, ['--test', path.join(root, 'test', f)], {
    cwd: root,
    env: { ...process.env, ASIDE_REMOTE_HOME: home },
    stdio: 'inherit',
  });
  rmSync(home, { recursive: true, force: true });
  if (r.status !== 0) failed += 1;
}

if (failed > 0) {
  console.error(`\n${failed} of ${files.length} test file(s) failed`);
  process.exit(1);
}
console.log(`\nAll ${files.length} test files passed (node ${process.versions.node}).`);
