// Wraps the Aside browser agent CLI. Each incoming chat message becomes a task.
// Per-chat continuity is achieved by recovering a session id from CLI output
// (the CLI prints "created new session: <id>" as its first line) and passing it
// back on the next message via `aside session resume <id> <prompt>`.
import { spawn, spawnSync, execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cleanTerminalOutput, log } from './util.js';

// `aside session <verb>` calls are short and print plain text even without a
// TTY, so they need none of the pty machinery the main task run does.
const SESSION_CMD_TIMEOUT_MS = 15000;

// After a remote /stop we interrupt the agent and give it this long to unwind
// and exit on its own before killing it outright.
const STOP_GRACE_MS = 5000;

// macOS ships `python3` as a Command Line Tools stub that, until the tools are
// installed, exits without ever starting an interpreter. Probe the configured
// python wrapper once: if it can't import the modules the pty driver needs, drop
// it and launch the agent directly (with a one-time warning) instead of silently
// never running it. Non-python or empty wrappers are returned unchanged.
let pyWrapperUsable = null;
let warnedNoPy = false;
function usableWrapper(wrapper) {
  if (!wrapper.length || wrapper[0] !== 'python3') return wrapper;
  if (pyWrapperUsable === null) {
    try {
      const r = spawnSync(wrapper[0], ['-c', 'import pty, select, fcntl, termios, struct'], { stdio: 'ignore' });
      pyWrapperUsable = !r.error && r.status === 0;
    } catch { pyWrapperUsable = false; }
  }
  if (pyWrapperUsable) return wrapper;
  if (!warnedNoPy) {
    warnedNoPy = true;
    log.warn(`python3 pseudo-TTY wrapper unavailable (on macOS run 'xcode-select --install'); launching the agent directly — output may be limited.`);
  }
  return [];
}

export class Agent {
  constructor(agentCfg) {
    this.cfg = agentCfg;
    this.sessionRe = agentCfg.sessionRegex ? new RegExp(agentCfg.sessionRegex, 'i') : null;
    // Auto-approve: when the agent suspends a task on an interactive approval
    // prompt, the bridge writes `approveInput` to its stdin to accept and keep
    // going — otherwise the process just blocks until the hard timeout (stdin is
    // unattended on the chat side). Only armed when autoApprove is on *and* a
    // prompt pattern is configured; otherwise this stays null and stdin is closed
    // immediately, preserving the old "never hang on generic input" behaviour.
    this.approveRe = agentCfg.autoApprove && agentCfg.approvePromptRegex
      ? new RegExp(agentCfg.approvePromptRegex, 'i')
      : null;
    this.approveInput = agentCfg.approveInput ?? '\r';
  }

  buildArgs(prompt, sessionId) {
    const sub = (arr) => arr.map((a) => a.replace('{session}', sessionId || ''));
    const base = sessionId
      ? sub(this.cfg.continueArgs || [])
      : sub(this.cfg.newArgs || []);
    return [...base, prompt];
  }

  // Run `aside session <verb> [args]` and resolve with { ok, out, err }. Never
  // rejects: a missing binary or a non-zero exit comes back as ok:false with
  // the text, so callers can relay it. The CLI reports a bad id as a normal
  // exit with "Session not found" in stdout, hence the text check.
  sessionCommand(verb, ...args) {
    const cmd = this.cfg.command || 'aside';
    return new Promise((resolve) => {
      let child;
      try {
        child = execFile(cmd, ['session', verb, ...args], { env: process.env, timeout: SESSION_CMD_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 }, (e, stdout, stderr) => {
          const out = cleanTerminalOutput(String(stdout || ''));
          const err = cleanTerminalOutput(String(stderr || ''));
          const notFound = /\bsession not found\b|\bno such session\b|\bunknown session\b/i.test(`${out}\n${err}`);
          const ok = !e && !notFound && !/^\s*(•\s*)?error\b/im.test(out);
          resolve({ ok, out, err: e && !err ? e.message : err, notFound });
        });
      } catch (e) {
        return resolve({ ok: false, out: '', err: e.message, notFound: false });
      }
      child?.on?.('error', () => {}); // surfaced through the callback's `e`
    });
  }

  // Whether Aside has the session archived, read from its account db(s) with the
  // system sqlite3: true / false, or null when that can't be told (no sqlite3,
  // no db, id not found). Read-only, a few ms.
  isArchived(sessionId) {
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(sessionId || '')) return null;
    const root = path.join(os.homedir(), '.aside', 'u');
    let dirs = [];
    try { dirs = fs.readdirSync(root); } catch { return null; }
    for (const d of dirs) {
      const db = path.join(root, d, 'state.db');
      if (!fs.existsSync(db)) continue;
      const r = spawnSync('/usr/bin/sqlite3', ['-readonly', db, `select coalesce(archived_at, 0) from sessions where id = '${sessionId}'`], { encoding: 'utf8', timeout: 5000 });
      if (r.status !== 0) continue;
      const v = String(r.stdout || '').trim();
      if (v !== '') return v !== '0';
    }
    return null;
  }

  // Resuming an archived session keeps it archived, which hides a chat that is
  // still in use from every chat list. The CLI has no unarchive verb, so this
  // goes through `aside repl`. Idempotent on a session that isn't archived.
  unarchive(sessionId) {
    const cmd = this.cfg.command || 'aside';
    return new Promise((resolve) => {
      let child;
      try {
        child = execFile(cmd, ['repl', `aside.sessions.unarchive(${JSON.stringify(sessionId)})`], { env: process.env, timeout: SESSION_CMD_TIMEOUT_MS, maxBuffer: 1024 * 1024 }, (e, stdout, stderr) => {
          const out = cleanTerminalOutput(String(stdout || ''));
          const err = cleanTerminalOutput(String(stderr || ''));
          resolve({ ok: !e, out, err: e && !err ? e.message : err });
        });
      } catch (e) {
        return resolve({ ok: false, out: '', err: e.message });
      }
      child?.on?.('error', () => {});
    });
  }

  // Interrupt a running session with a new instruction. The CLI answers
  // "ok  running" immediately; the steered reply then shows up in the output
  // of the task process that owns the session, so nothing else to collect here.
  steer(sessionId, prompt) { return this.sessionCommand('steer', sessionId, prompt); }

  // Ask Aside itself to stop a session. Used alongside the Ctrl-C/SIGINT sent
  // to the child process on /stop: the keystroke ends the CLI, this makes sure
  // the browser-side task is dropped too.
  stopSession(sessionId) { return this.sessionCommand('stop', sessionId); }

  // Parsed `aside session list`: [{ id, status, tier, title, updatedAt }].
  // Columns are separated by two or more spaces; the title may itself contain
  // single spaces, never runs of them.
  async listSessions() {
    const r = await this.sessionCommand('list');
    if (!r.ok) return [];
    return r.out.split('\n').map((l) => l.trim()).filter(Boolean).map((line) => {
      const cols = line.split(/\s{2,}/);
      if (cols.length < 2 || !/^[A-Za-z0-9_-]{8,}$/.test(cols[0])) return null;
      return { id: cols[0], status: cols[1], tier: cols[2] || '', title: cols[3] || '', updatedAt: cols[4] || '' };
    }).filter(Boolean);
  }

  async sessionStatus(sessionId) {
    if (!sessionId) return null;
    return (await this.listSessions()).find((s) => s.id === sessionId) || null;
  }

  // Runs one task. Resolves with { text, sessionId, code }.
  // timeoutMs overrides the configured hard cap for this call (e.g. the short
  // reply-formatting pass shouldn't inherit the 30-minute task timeout).
  // onSession(id) fires once, as soon as a *new* session's id appears in the
  // output (the CLI prints it within about a second of starting), so the
  // caller can steer or stop the session while the task is still running.
  run({ prompt, sessionId = null, onData, onStall, onSession, timeoutMs, idleTimeoutMs, signal } = {}) {
    const limitMs = timeoutMs ?? this.cfg.timeoutMs ?? 1800000;
    // Idle/stall cap: kill early if the agent emits no output for this long (0
    // disables). The agent normally streams "Thinking"/tool-call lines steadily,
    // so a long dead silence means it's blocked on something we can't answer
    // remotely — most often a local approval (writing to memory, editing a file)
    // that Aside gates to its desktop UI with no prompt on stdin. Failing fast
    // beats hanging to limitMs (the 30-min hard cap).
    const idleMs = idleTimeoutMs ?? this.cfg.idleTimeoutMs ?? 0;
    // Both caps used to kill outright. They no longer do. From out here a long
    // quiet browser step and a genuinely wedged process look identical, so the
    // automatic kill threw away real work on every false positive. Now a cap
    // firing only *reports* (via onStall); the task keeps running and the chat
    // side offers a button to end it by hand. killOnTimeout:true restores the
    // old behaviour for unattended deployments where nobody is there to tap it.
    const killOnTimeout = this.cfg.killOnTimeout === true;
    const inner = this.buildArgs(prompt, sessionId);
    // Optional wrapper (e.g. ["python3","-c",PTY_DRIVER]) gives the agent a
    // pseudo-TTY so it actually renders output we can capture. See config.js.
    const wrapper = usableWrapper(Array.isArray(this.cfg.wrapper) ? this.cfg.wrapper : []);
    const usePty = wrapper.length > 0;
    const command = usePty ? wrapper[0] : this.cfg.command;
    const args = usePty ? [...wrapper.slice(1), this.cfg.command, ...inner] : inner;
    const clean = (s) => (usePty ? cleanTerminalOutput(s) : (s || '').trim());
    return new Promise((resolve) => {
      let out = '';
      let err = '';
      let settled = false;
      let child;
      try {
        // Pipe stdin so we can answer interactive approval prompts (see below).
        // When auto-approve is off we close it right away, so a non-TTY agent
        // still gets EOF and can never hang waiting for generic input.
        child = spawn(command, args, { env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });
      } catch (e) {
        return resolve({ text: `Failed to launch agent (${command}): ${e.message}`, sessionId, code: -1, error: true });
      }
      if (!this.approveRe) { try { child.stdin?.end(); } catch {} }

      // Remote abort (/stop). With the pty wrapper the agent owns a real
      // terminal, so writing 0x03 to its stdin delivers a genuine SIGINT - the
      // same Ctrl-C a local user would press - letting it unwind and tell Aside
      // to drop the task. Without a terminal (or with stdin already closed
      // because auto-approve is off) there is nothing to interrupt, so signal
      // the process instead. Either way SIGKILL after the grace window, so a
      // wedged agent can't ignore the stop.
      let aborted = false;
      let stopTimer = null;
      // The session this run owns: the one passed in, or the one announced in
      // the output once a fresh run starts. Known to the caller via onSession.
      let liveSession = sessionId;
      const onAbort = () => {
        if (settled || aborted) return;
        aborted = true;
        if (usePty && child.stdin && child.stdin.writable) {
          try { child.stdin.write('\x03'); } catch {}
        } else {
          try { child.kill('SIGINT'); } catch {}
        }
        // Also tell Aside to drop the session's task, so a browser step that
        // is mid-flight does not carry on after the CLI is gone.
        if (liveSession && this.cfg.stopSessionOnAbort !== false) {
          this.stopSession(liveSession).catch(() => {});
        }
        stopTimer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, STOP_GRACE_MS);
      };
      if (signal) {
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
      }
      // Every settle path runs this: timers off, abort listener detached.
      const cleanup = () => {
        clearTimeout(timer);
        clearTimeout(idleTimer);
        clearTimeout(stopTimer);
        signal?.removeEventListener('abort', onAbort);
      };

      // Auto-approve state. `armed` flips off after we answer a prompt and back
      // on once the prompt clears from the output, so a TUI that repaints the
      // same prompt many times still gets exactly one answer, and a second,
      // later approval is still handled.
      let armed = true;
      const maybeApprove = () => {
        if (!this.approveRe || settled || !child.stdin || child.stdin.destroyed) return;
        const tail = clean(out.length > 8000 ? out.slice(-8000) : out).slice(-600);
        const visible = this.approveRe.test(tail);
        if (armed && visible) {
          armed = false;
          try { child.stdin.write(this.approveInput); } catch {}
        } else if (!armed && !visible) {
          armed = true; // prompt cleared — ready for the next one
        }
      };

      const startedAt = Date.now();
      // Fire-and-forget: a reporting hook must never be able to break the run,
      // whether it throws synchronously or rejects later.
      const report = (kind, extra) => {
        try {
          const r = onStall?.({ kind, elapsedMs: Date.now() - startedAt, ...extra });
          if (r && typeof r.catch === 'function') r.catch(() => {});
        } catch {}
      };

      let idleTimer = null;
      const timer = setTimeout(() => {
        if (settled) return;
        // Past the hard cap. Report once and leave it running (see killOnTimeout).
        if (!killOnTimeout) return report('timeout', { limitMs });
        settled = true;
        cleanup();
        try { child.kill('SIGKILL'); } catch {}
        const partial = clean(out);
        resolve({ text: `${partial}\n\n[aside-remote] Task timed out after ${Math.round(limitMs / 1000)}s.`.trim(), sessionId, code: -2, error: true });
      }, limitMs);

      // Re-armed on every chunk of output; fires only after idleMs of pure silence.
      // One notice per silent stretch: without this a stall that never ends would
      // repeat the same message every idleMs for the rest of the task.
      let stallReported = false;
      const armIdle = () => {
        if (!idleMs || settled) return;
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
          if (settled) return;
          if (!killOnTimeout) {
            if (stallReported) return;
            stallReported = true;
            return report('idle', { idleMs });
          }
          settled = true;
          cleanup();
          try { child.kill('SIGKILL'); } catch {}
          const note = `[aside-remote] The agent went silent for ${Math.round(idleMs / 1000)}s and looks stuck — most likely it hit a local approval Aside can't grant in remote mode (e.g. writing to memory or editing a file). Run this one in the Aside desktop app, or keep remote tasks read-only.`;
          // text is the user-facing notice; raw keeps the partial transcript for
          // verbose/debug and history. The bridge shows this verbatim (see below).
          resolve({ text: note, raw: out, sessionId, code: -3, error: true, stalled: true });
        }, idleMs);
      };
      // Output means it is alive again: re-arm the silence guard, and let a later
      // stall raise a fresh notice rather than staying quiet because of an old one.
      const noteOutput = () => { stallReported = false; armIdle(); };
      armIdle();

      // Session id announcement. Checked on every chunk until found; the CLI
      // prints it on its first line, so this costs one regex on early output.
      let announced = false;
      const maybeAnnounce = () => {
        if (announced || sessionId || !this.sessionRe) return;
        const id = this.parseSession(clean(out.length > 4000 ? out.slice(0, 4000) : out));
        if (!id) return;
        announced = true;
        liveSession = id;
        try {
          const r = onSession?.(id);
          if (r && typeof r.catch === 'function') r.catch(() => {});
        } catch {}
      };

      // Auto-approve runs on the same chunks that re-arm the idle timer: an
      // answered prompt produces fresh output, so the stall guard stays honest.
      child.stdout?.on('data', (d) => { const s = d.toString(); out += s; noteOutput(); onData?.(s); maybeAnnounce(); maybeApprove(); });
      child.stderr?.on('data', (d) => { err += d.toString(); noteOutput(); });
      child.on('error', (e) => {
        if (settled) return;
        settled = true; cleanup();
        resolve({ text: `Agent process error: ${e.message}`, sessionId, code: -1, error: true });
      });
      child.on('close', (code) => {
        if (settled) return;
        settled = true; cleanup();
        // Stopped on request: report that as the outcome rather than letting a
        // half-finished transcript surface as if it were the answer.
        if (aborted) {
          const partial = clean(out);
          return resolve({
            text: '[aside-remote] Task stopped on request.',
            raw: out,
            sessionId: this.parseSession(partial) || liveSession || sessionId,
            code: -4,
            error: true,
            aborted: true,
          });
        }
        const cleanOut = clean(out);
        const cleanErr = clean(err);
        const newSession = this.parseSession(cleanOut) || this.parseSession(cleanErr) || liveSession || sessionId;
        // Never surface stderr as the user-facing reply. With the pty wrapper the
        // agent's own output is merged into stdout, so `err` only carries wrapper
        // diagnostics (a failed launch, a stub interpreter, the old "script:
        // tcgetattr..." abort). Leaking that into chat was the original bug; keep
        // it on `errorDetail` for logging instead.
        const text = (cleanOut || '(agent produced no output)');
        // The continued session id was rejected by the agent (expired/unknown).
        // Flag it so the bridge can drop it and retry as a fresh session. Note:
        // the agent reports this in its output text, not via a non-zero exit code.
        const sessionMissing = !!sessionId && /\bsession not found\b|\bno such session\b|\bunknown session\b|\binvalid session\b/i.test(`${cleanOut}\n${cleanErr}`);
        // raw keeps the ANSI-coloured stdout so the bridge can colour-filter the
        // transcript down to the final answer (see util.extractAnswer).
        resolve({ text, raw: out, errorDetail: cleanErr, sessionId: newSession, code, error: code !== 0, sessionMissing });
      });
    });
  }

  parseSession(text) {
    if (!this.sessionRe || !text) return null;
    const m = text.match(this.sessionRe);
    return m ? m[1] : null;
  }
}
