// Wraps the Aside browser agent CLI. Each incoming chat message becomes a task.
// Per-chat continuity is achieved by recovering a session id from CLI output
// and passing it back on the next message.
import { spawn } from 'node:child_process';
import { cleanTerminalOutput } from './util.js';

export class Agent {
  constructor(agentCfg) {
    this.cfg = agentCfg;
    this.sessionRe = agentCfg.sessionRegex ? new RegExp(agentCfg.sessionRegex, 'i') : null;
  }

  buildArgs(prompt, sessionId) {
    const sub = (arr) => arr.map((a) => a.replace('{session}', sessionId || ''));
    const base = sessionId
      ? sub(this.cfg.continueArgs || [])
      : sub(this.cfg.newArgs || []);
    return [...base, prompt];
  }

  // Runs one task. Resolves with { text, sessionId, code }.
  // timeoutMs overrides the configured hard cap for this call (e.g. the short
  // reply-formatting pass shouldn't inherit the 30-minute task timeout).
  run({ prompt, sessionId = null, onData, timeoutMs } = {}) {
    const limitMs = timeoutMs ?? this.cfg.timeoutMs ?? 1800000;
    const inner = this.buildArgs(prompt, sessionId);
    // Optional wrapper (e.g. ["script","-q","/dev/null"]) gives the agent a
    // pseudo-TTY so it actually renders output we can capture.
    const wrapper = Array.isArray(this.cfg.wrapper) ? this.cfg.wrapper : [];
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
        // Ignore stdin so a non-TTY agent can never hang waiting for input.
        child = spawn(command, args, { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (e) {
        return resolve({ text: `Failed to launch agent (${command}): ${e.message}`, sessionId, code: -1, error: true });
      }

      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          try { child.kill('SIGKILL'); } catch {}
          const partial = clean(out);
          resolve({ text: `${partial}\n\n[aside-remote] Task timed out after ${Math.round(limitMs / 1000)}s.`.trim(), sessionId, code: -2, error: true });
        }
      }, limitMs);

      child.stdout?.on('data', (d) => { const s = d.toString(); out += s; onData?.(s); });
      child.stderr?.on('data', (d) => { err += d.toString(); });
      child.on('error', (e) => {
        if (settled) return;
        settled = true; clearTimeout(timer);
        resolve({ text: `Agent process error: ${e.message}`, sessionId, code: -1, error: true });
      });
      child.on('close', (code) => {
        if (settled) return;
        settled = true; clearTimeout(timer);
        const cleanOut = clean(out);
        const cleanErr = clean(err);
        const newSession = this.parseSession(cleanOut) || this.parseSession(cleanErr) || sessionId;
        const text = (cleanOut || cleanErr || '(agent produced no output)');
        // The continued session id was rejected by the agent (expired/unknown).
        // Flag it so the bridge can drop it and retry as a fresh session. Note:
        // the agent reports this in its output text, not via a non-zero exit code.
        const sessionMissing = !!sessionId && /\bsession not found\b|\bno such session\b|\bunknown session\b|\binvalid session\b/i.test(`${cleanOut}\n${cleanErr}`);
        // raw keeps the ANSI-coloured stdout so the bridge can colour-filter the
        // transcript down to the final answer (see util.extractAnswer).
        resolve({ text, raw: out, sessionId: newSession, code, error: code !== 0, sessionMissing });
      });
    });
  }

  parseSession(text) {
    if (!this.sessionRe || !text) return null;
    const m = text.match(this.sessionRe);
    return m ? m[1] : null;
  }
}
