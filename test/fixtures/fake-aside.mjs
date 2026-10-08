#!/usr/bin/env node
// Fake aside CLI for tests. No network, no browser. Configured via env:
//   FAKE_ASIDE        JSON: { lines, delayMs, exit, hang, spawnChild, sessionId, argvLog }
//   FAKE_ASIDE_STATE  path to a JSON session-state file ({ sessions: [...] })
//
// Behaviour:
//   * appends its argv as a JSON line to argvLog (when set)
//   * `session list` prints "<id> <state> persistent <title> <ISO-8601>" rows
//   * `session stop|resume|steer|queue` use/mutate the state file, canned output
//   * a task run prints `created new session: <sessionId>` (when set), then the
//     lines with delayMs between them, optionally spawns a detached grandchild
//     (pid written to spawnChild), optionally hangs forever, then exits.
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';

const cfg = JSON.parse(process.env.FAKE_ASIDE || '{}');
const statePath = process.env.FAKE_ASIDE_STATE || '';
const argv = process.argv.slice(2);

if (cfg.argvLog) appendFileSync(cfg.argvLog, JSON.stringify(argv) + '\n');

const loadState = () => {
  try { return JSON.parse(readFileSync(statePath, 'utf8')); } catch { return { sessions: [] }; }
};
const saveState = (s) => {
  if (statePath) writeFileSync(statePath, JSON.stringify(s));
};

async function handleSession() {
  const sub = argv[1];
  if (sub === '--help') {
    console.log('Usage: aside session <list|resume|stop|steer|queue|archive|delete>');
    return;
  }
  if (sub === 'list') {
    for (const s of loadState().sessions) console.log(`${s.id} ${s.state} persistent ${s.title} ${s.createdAt}`);
    return;
  }
  const id = argv[2];
  if (sub === 'stop') {
    const st = loadState();
    const s = st.sessions.find((x) => x.id === id);
    if (s) { s.state = 'stopped'; saveState(st); console.log(`stopped session ${id}`); }
    else console.log(`no such session: ${id}`);
    return;
  }
  if (sub === 'resume') {
    const st = loadState();
    const s = st.sessions.find((x) => x.id === id);
    if (!s) { console.log(`no such session: ${id}`); return; }
    console.log(`resuming session ${id}`);
    for (const line of cfg.lines || []) console.log(line);
    // A resumed session honours hang too, like a fresh task run.
    if (cfg.hang) await new Promise(() => setInterval(() => {}, 1000));
    return;
  }
  if (sub === 'steer' || sub === 'queue') {
    console.log(`ok: ${sub} ${argv.slice(2).join(' ')}`);
    return;
  }
  console.log(`aside session: unknown subcommand ${sub}`);
}

if (argv[0] === 'session') {
  // Emulate a CLI without session support when the test asks for it.
  if (cfg.noSessions) {
    console.log('unknown command: session');
    process.exit(1);
  }
  await handleSession();
  process.exit(0);
}

if (cfg.sessionId) console.log(`created new session: ${cfg.sessionId}`);
for (const line of cfg.lines || []) {
  console.log(line);
  if (cfg.delayMs) await new Promise((r) => setTimeout(r, cfg.delayMs));
}
if (cfg.spawnChild) {
  // Not detached: like a real agent's child, it stays in the fake-aside
  // process group so the bridge's group kill reaches it. unref() only means
  // "don't keep this process alive", not "new process group".
  const c = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  c.unref();
  writeFileSync(cfg.spawnChild, String(c.pid));
}
// Hang forever. The interval keeps a handle alive so Node never trips its
// "unsettled top-level await" exit on a plain never-resolving promise.
if (cfg.hang) await new Promise(() => setInterval(() => {}, 1000));
process.exit(cfg.exit ?? 0);
