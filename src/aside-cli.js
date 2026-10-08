// Thin execFile wrappers around the configured aside CLI for session queries.
// No shell, 15 s timeout, output capped. Used for /sessions, /resume, /steer,
// and the best-effort session stop behind /cancel.
import { execFile } from 'node:child_process';

const TIMEOUT_MS = 15000;
const MAX_OUTPUT = 64 * 1024;

function runCli(command, args, { timeoutMs = TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: timeoutMs, maxBuffer: MAX_OUTPUT, env: process.env }, (err, stdout, stderr) => {
      if (err) return resolve({ ok: false, error: `${err.message}`, stdout: String(stdout), stderr: String(stderr) });
      resolve({ ok: true, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

// Parse one `aside session list` line. Tolerant of the shapes seen so far
// (docs/aside-cli-notes.md): <id> <state> [persistent|ephemeral] <title...>
// [ISO-8601]. Unparseable lines fall back to { raw: line }.
export function parseSessionLine(line) {
  const m = /^([A-Za-z0-9_-]{8,64})\s+(\S+)\s+(.*)$/.exec(String(line).trim());
  if (!m) return { raw: String(line).trim() };
  let rest = m[3];
  let createdAt = null;
  const iso = /(\d{4}-\d{2}-\d{2}T[\d:.]+Z?)\s*$/;
  const t = iso.exec(rest);
  if (t) {
    createdAt = t[1];
    rest = rest.slice(0, t.index).trim();
  }
  rest = rest.replace(/^(persistent|ephemeral|session)\s+/, '');
  return { id: m[1], state: m[2], title: rest, createdAt };
}

export function makeAsideCli(command) {
  let sessionSupport; // undefined = unknown, then cached
  return {
    async supportsSessions() {
      if (sessionSupport !== undefined) return sessionSupport;
      const r = await runCli(command, ['session', '--help']);
      sessionSupport = r.ok;
      return sessionSupport;
    },
    async listSessions() {
      const r = await runCli(command, ['session', 'list']);
      if (!r.ok) return { ok: false, error: r.error };
      const rows = r.stdout.split('\n').map((l) => l.trim()).filter(Boolean).map(parseSessionLine);
      return { ok: true, rows };
    },
    async version() {
      const r = await runCli(command, ['--version']);
      return r.ok ? r.stdout.trim().split(/\s+/).pop() : null;
    },
    async stopSession(id) {
      const r = await runCli(command, ['session', 'stop', id]);
      return r.ok;
    },
    async steerSession(id, text) {
      const r = await runCli(command, ['session', 'steer', id, text]);
      return r.ok;
    },
  };
}
