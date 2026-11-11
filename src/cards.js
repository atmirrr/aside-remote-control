// Live task cards: a Telegram widget that stands in for the "Thinking..." bubble
// while a task runs (Bot API 10.4, private chats only for now).
//
// The card's HTML never changes after it is sent; the bridge writes its state, a
// JSON text of at most 1024 bytes, with editMessageWidgetData (silent: no
// "edited" mark, no notification). The card ticks its own clocks on the phone,
// so the bridge only writes when something real changes: a new step, the queue,
// the end. It also asks the bridge for fresh state while it is on screen, and
// those asks are answered from here.
//
// State, as the card reads it:
//   st  'w' working · 'd' done · 'x' stopped · 'f' failed
//   t0  start, ms since epoch       te  end, ms (finished cards only)
//   n   steps so far                q   messages waiting behind this task
//   s   the newest steps, oldest first: [[title, startedAtMs], ...]
import fs from 'node:fs';
import { cleanTerminalOutput, log } from './util.js';

// Telegram refuses state over 1024 bytes; stay clear of it.
const MAX_STATE_BYTES = 1000;
const KEEP_STEPS = 6;
const MAX_TITLE = 60;
// How long a finished or abandoned card is remembered, by count.
const KEEP_CARDS = 30;

// The state as the text the card receives. Drops the oldest steps, then shortens
// titles, until it fits; the card shows "+N" for steps it no longer has.
export function cardJson(state) {
  const s = { ...state, s: (state.s || []).slice(-KEEP_STEPS) };
  let out = JSON.stringify(s);
  while (Buffer.byteLength(out) > MAX_STATE_BYTES && s.s.length > 1) {
    s.s = s.s.slice(1);
    out = JSON.stringify(s);
  }
  if (Buffer.byteLength(out) > MAX_STATE_BYTES) {
    s.s = s.s.map(([t, at]) => [String(t).slice(0, 24), at]);
    out = JSON.stringify(s);
  }
  return out;
}

// The agent's own name for a step, from one line of its terminal output.
// Tool calls print as `bash(title: 'Reading the bridge code', command: ...`
// (the tool name in colour); lines without a title are not steps.
const TITLE = /^\s*[\w.]+\s*\(\s*title:\s*(['"])((?:\\.|(?!\1).)*)\1/;
export function stepTitle(line) {
  const m = TITLE.exec(cleanTerminalOutput(String(line || '')));
  if (!m) return null;
  const t = m[2].replace(/\\(['"\\])/g, '$1').replace(/\s+/g, ' ').trim();
  if (!t) return null;
  return t.length > MAX_TITLE ? `${t.slice(0, MAX_TITLE - 1)}…` : t;
}

// Feeds raw output chunks in, calls onStep(title) once per complete step line.
export function stepReader(onStep) {
  let buf = '';
  return (chunk) => {
    buf += String(chunk || '');
    const lines = buf.split('\n');
    buf = lines.pop() || '';
    if (buf.length > 64 * 1024) buf = buf.slice(-4096); // a line with no end in sight
    for (const line of lines) {
      const t = stepTitle(line);
      if (t) onStep(t);
    }
  };
}

const elapsed = (ms) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return s < 3600
    ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
    : `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}`;
};

// What the caption under the card says, for apps that cannot draw widgets and
// for the chat list. The card itself says the same, so this stays short.
export function cardCaption(state) {
  if (state.st === 'w') return 'Working';
  const took = elapsed((state.te || Date.now()) - state.t0);
  if (state.st === 'd') return `Done ${took}`;
  if (state.st === 'x') return `Stopped ${took}`;
  return `Failed ${took}`;
}

// Every card this bridge has open or recently finished, keyed by channel, chat
// and message, saved to disk so a card can still be answered (and corrected,
// if its task died with the process) after a restart.
export class CardStore {
  constructor(file) {
    this.file = file;
    this.map = new Map();
    try {
      for (const [k, v] of Object.entries(JSON.parse(fs.readFileSync(file, 'utf8')))) this.map.set(k, v);
    } catch { /* first run, or an unreadable file: start empty */ }
  }

  key(channelId, chatId, messageId) { return `${channelId}|${chatId}|${messageId}`; }

  get(channelId, chatId, messageId) { return this.map.get(this.key(channelId, chatId, messageId)) || null; }

  set(channelId, chatId, messageId, state) {
    const k = this.key(channelId, chatId, messageId);
    this.map.delete(k); // re-insert so the newest stays last
    this.map.set(k, JSON.parse(cardJson(state)));
    while (this.map.size > KEEP_CARDS) this.map.delete(this.map.keys().next().value);
    try {
      fs.writeFileSync(this.file, JSON.stringify(Object.fromEntries(this.map)), { mode: 0o600 });
    } catch (e) {
      log.warn(`cards: couldn't save ${this.file}: ${e.message}`);
    }
  }

  // Cards a previous run left showing "working": their task is gone with it.
  unfinished(channelId) {
    const out = [];
    for (const [k, v] of this.map) {
      const [ch, chatId, messageId] = k.split('|');
      if (ch === channelId && v.st === 'w') out.push({ chatId, messageId: Number(messageId), state: v });
    }
    return out;
  }
}

// One task's card. Writes are coalesced: a burst of steps becomes one edit, at
// most one every minGapMs, because every edit counts against the bot's send
// limits.
export class TaskCard {
  constructor({ channel, chatId, messageId, state, store, minGapMs = 1500 }) {
    Object.assign(this, { channel, chatId, messageId, state, store, minGapMs });
    this.timer = null;
    this.last = 0;
    this.done = false;
    this.stopTimer = null;
  }

  json() { return cardJson(this.state); }

  step(title) {
    if (this.done || !title) return;
    this.state.s = [...this.state.s, [title, Date.now()]].slice(-KEEP_STEPS);
    this.state.n += 1;
    this.schedule();
  }

  queued(n) {
    if (this.done || this.state.q === n) return;
    this.state.q = n;
    this.schedule();
  }

  schedule() {
    if (this.timer) return;
    const wait = Math.max(0, this.last + this.minGapMs - Date.now());
    this.timer = setTimeout(() => { this.timer = null; this.push().catch(() => {}); }, wait);
    this.timer.unref?.();
  }

  async push() {
    this.last = Date.now();
    this.store.set(this.channel.id, this.chatId, this.messageId, this.state);
    return this.channel.updateCard(this.chatId, this.messageId, this.json());
  }

  // st: 'd' done, 'x' stopped, 'f' failed. The last write, plus the caption.
  async finish(st) {
    if (this.done) return;
    this.done = true;
    clearTimeout(this.timer);
    clearTimeout(this.stopTimer);
    this.timer = null;
    this.state.st = st;
    this.state.te = Date.now();
    this.state.q = 0;
    await this.push().catch(() => {});
    await this.channel.setCardCaption?.(this.chatId, this.messageId, cardCaption(this.state)).catch(() => {});
  }
}
