// Chat command registry + parser.
//
// Every visible command must appear in the README In-chat commands table and
// in the generated /help text — enforced by test/invariants.test.mjs (I10).
// Entry shape: { name, description, usage?, admin?, hidden?, aliases?, run(ctx, args) }
// where ctx = { bridge, channel, chatId, userId, from, role, reply(text, opts) }.
import { sessions, history } from './config.js';

const registry = [];

export function defineCommand(cmd) {
  registry.push(cmd);
  return cmd;
}

export function listCommands() {
  return [...registry];
}

export function findCommand(name) {
  const n = String(name).toLowerCase();
  return registry.find((c) => c.name === n || (c.aliases || []).includes(n)) || null;
}

// Parses a chat message as a command. Only messages without attachments are
// considered (a file caption is never a command).
//
// Returns:
//   { cmd, args }        — known command; args keep their case, trimmed
//   { ignore: true }     — addressed to a different bot via @username
//   null                 — not a command (unknown /word or plain text), runs
//                          as an agent task instead (I8)
export function parseCommand(text, { botUsername } = {}) {
  const m = /^\/([A-Za-z0-9_]+)(?:@([A-Za-z0-9_]+))?(?:\s+([\s\S]*))?$/.exec(String(text ?? '').trim());
  if (!m) return null;
  const atBot = m[2] || null;
  const args = (m[3] || '').trim();
  if (atBot && botUsername && atBot.toLowerCase() !== String(botUsername).toLowerCase()) {
    return { ignore: true };
  }
  const cmd = findCommand(m[1]);
  if (!cmd) return null;
  return { cmd, args };
}

export function helpText() {
  const rows = listCommands()
    .filter((c) => !c.hidden)
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((c) => `  /${c.name.padEnd(10)} ${c.description}`)
    .join('\n');
  return [
    'Aside Remote Control',
    '',
    'Just send a message and I will run it as a task in the Aside browser.',
    'Send a voice note and I will transcribe it first. Attach photos or files and',
    'I will hand them to the agent.',
    '',
    'Commands:',
    rows,
  ].join('\n');
}

// ---- built-ins (migrated from bridge.js; replies stay byte-identical) ----
const preview = (t) => {
  const s = String(t ?? '').replace(/\s+/g, ' ').trim();
  return s.length > 60 ? `${s.slice(0, 60)}…` : s;
};

defineCommand({
  name: 'help',
  aliases: ['start'],
  description: 'show this help',
  run: (ctx) => ctx.reply(helpText()),
});

defineCommand({
  name: 'new',
  description: 'start a fresh agent session (forget context)',
  run: (ctx) => {
    // Cancel first: a finishing task would otherwise re-populate history.
    ctx.bridge.cancelChat(`${ctx.channel.id}:${ctx.chatId}`);
    sessions.clear(ctx.channel.id, ctx.chatId);
    history.clear(ctx.channel.id, ctx.chatId);
    return ctx.reply('Started a fresh session. Send your task.');
  },
});

defineCommand({
  name: 'cancel',
  description: 'stop the running task and drop queued ones',
  run: (ctx) => {
    const { hadRunning, dropped, startedAt } = ctx.bridge.cancelChat(`${ctx.channel.id}:${ctx.chatId}`);
    if (hadRunning) {
      const ran = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
      return ctx.reply(`🛑 Cancelled (ran ${ran}s).${dropped ? ` Dropped ${dropped} queued.` : ''}`);
    }
    if (dropped) return ctx.reply(`Dropped ${dropped} queued.`);
    return ctx.reply('Nothing is running.');
  },
});

defineCommand({
  name: 'queue',
  description: 'show pending tasks (/queue clear drops them)',
  run: (ctx, args) => {
    const key = `${ctx.channel.id}:${ctx.chatId}`;
    if (String(args).trim().toLowerCase() === 'clear') {
      const dropped = ctx.bridge.dropQueued(key);
      return ctx.reply(dropped ? `Dropped ${dropped} queued.` : 'Queue is empty.');
    }
    const items = ctx.bridge.queuedFor(key);
    if (!items.length) return ctx.reply('Queue is empty.');
    const now = Date.now();
    const rows = items.map((it, i) => `#${i + 1} ${Math.max(1, Math.round((now - it.queuedAt) / 1000))}s: ${preview(it.msg.text)}`);
    return ctx.reply(rows.join('\n'));
  },
});

defineCommand({
  name: 'status',
  description: 'show session id, running task, and queue',
  run: (ctx) => {
    const sid = sessions.get(ctx.channel.id, ctx.chatId);
    const lines = [sid ? `Active session: ${sid}` : 'No active session yet. Send a task to start one.'];
    const key = `${ctx.channel.id}:${ctx.chatId}`;
    const running = ctx.bridge.running.get(key);
    if (running) {
      lines.push(`Running: ${Math.max(1, Math.round((Date.now() - running.startedAt) / 1000))}s — ${preview(running.msg.text)}`);
    }
    const queued = ctx.bridge.queuedFor(key).length;
    if (queued) lines.push(`Queued: ${queued}`);
    return ctx.reply(lines.join('\n'));
  },
});

defineCommand({
  name: 'whoami',
  description: 'show your chat id',
  run: (ctx) => ctx.reply(`chat id: ${ctx.chatId}\nusername: ${ctx.from}`),
});
