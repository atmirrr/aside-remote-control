// Chat command registry + parser.
//
// Every visible command must appear in the README In-chat commands table and
// in the generated /help text — enforced by test/invariants.test.mjs (I10).
// Entry shape: { name, description, usage?, admin?, hidden?, aliases?, run(ctx, args) }
// where ctx = { bridge, channel, chatId, userId, from, role, reply(text, opts) }.
import { sessions, history, settings } from './config.js';

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
  description: 'show your chat id, user id, role, and chat type',
  run: (ctx) => ctx.reply(
    `chat id: ${ctx.chatId}\nusername: ${ctx.from}\nuser id: ${ctx.userId ?? 'unknown'}\nrole: ${ctx.role}\nchat type: ${ctx.chatType ?? 'private'}`,
  ),
});

// ---- per-chat options (M3). Effective value = chat setting -> agent.defaults
// -> unset. All input is validated and rejects with usage text (I7). ----
const KEY = (ctx) => `${ctx.channel.id}:${ctx.chatId}`;
const sessionNote = (ctx) => (sessions.get(ctx.channel.id, ctx.chatId) ? ' (applies to the next new session)' : '');

const currentValue = (ctx, field) => {
  const chat = settings.get(KEY(ctx)) || {};
  const defs = ctx.bridge.config.agent?.defaults || {};
  if (chat[field] !== undefined) return { value: chat[field], source: 'chat setting' };
  if (defs[field] !== undefined && defs[field] !== null) return { value: defs[field], source: 'agent.defaults' };
  return { value: null, source: null };
};

const setSetting = (ctx, field, value) => {
  const k = KEY(ctx);
  const cur = settings.get(k) || {};
  if (value === null) delete cur[field];
  else cur[field] = value;
  settings.set(k, cur);
};

const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}(\/[A-Za-z0-9][A-Za-z0-9._:-]{0,63})?$/;
const EFFORTS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultrabrowse'];
const PERMISSIONS = ['ask', 'guard', 'full-access'];

defineCommand({
  name: 'model',
  description: 'set the agent model for this chat (/model reset clears)',
  run: (ctx, args) => {
    const a = String(args).trim();
    if (!a) {
      const cur = currentValue(ctx, 'model');
      return ctx.reply(`Current model: ${cur.value ?? 'default (Aside setting)'}${cur.source ? ` (${cur.source})` : ''}. Allowed: id or provider/id. /model reset clears.`);
    }
    if (a === 'reset') { setSetting(ctx, 'model', null); return ctx.reply('Model reset.'); }
    if (a.split(/\s+/).length > 1 || !MODEL_RE.test(a)) return ctx.reply('Usage: /model <id|provider/id|reset> — id like gpt-5.6-sol or openai/gpt-5.6-sol');
    setSetting(ctx, 'model', a);
    return ctx.reply(`Model set to ${a}.${sessionNote(ctx)}`);
  },
});

defineCommand({
  name: 'fast',
  description: 'toggle fast model speed (/fast on|off|reset)',
  run: (ctx, args) => {
    const a = String(args).trim().toLowerCase();
    if (!a) {
      const cur = currentValue(ctx, 'speed');
      return ctx.reply(`Current speed: ${cur.value ?? 'default (Aside setting)'}${cur.source ? ` (${cur.source})` : ''}. Allowed: on, off, reset.`);
    }
    if (a === 'reset') { setSetting(ctx, 'speed', null); return ctx.reply('Speed reset.'); }
    if (a === 'on') { setSetting(ctx, 'speed', 'fast'); return ctx.reply(`Speed set to fast.${sessionNote(ctx)}`); }
    if (a === 'off') { setSetting(ctx, 'speed', 'default'); return ctx.reply(`Speed set to default.${sessionNote(ctx)}`); }
    return ctx.reply('Usage: /fast on|off|reset');
  },
});

defineCommand({
  name: 'effort',
  description: 'set thinking effort (/effort <level>|reset)',
  run: (ctx, args) => {
    const a = String(args).trim().toLowerCase();
    if (!a) {
      const cur = currentValue(ctx, 'effort');
      return ctx.reply(`Current effort: ${cur.value ?? 'default (Aside setting)'}${cur.source ? ` (${cur.source})` : ''}. Allowed: ${EFFORTS.join(', ')}. /effort reset clears.`);
    }
    if (a === 'reset') { setSetting(ctx, 'effort', null); return ctx.reply('Effort reset.'); }
    if (!EFFORTS.includes(a)) return ctx.reply(`Usage: /effort ${EFFORTS.join('|')}|reset`);
    setSetting(ctx, 'effort', a);
    return ctx.reply(`Effort set to ${a}.${sessionNote(ctx)}`);
  },
});

defineCommand({
  name: 'verbose',
  description: 'show the raw agent transcript (/verbose on|off|reset)',
  run: (ctx, args) => {
    const a = String(args).trim().toLowerCase();
    if (!a) {
      const cur = currentValue(ctx, 'verbose');
      return ctx.reply(`Verbose: ${cur.value === true ? 'on' : 'off'}${cur.source ? ` (${cur.source})` : ''}. Allowed: on, off, reset.`);
    }
    if (a === 'reset') { setSetting(ctx, 'verbose', null); return ctx.reply('Verbose reset.'); }
    if (a === 'on') { setSetting(ctx, 'verbose', true); return ctx.reply('Verbose on: you will see the raw transcript.'); }
    if (a === 'off') { setSetting(ctx, 'verbose', false); return ctx.reply('Verbose off: you will see only the final answer.'); }
    return ctx.reply('Usage: /verbose on|off|reset');
  },
});

defineCommand({
  name: 'permission',
  admin: true,
  description: 'override the agent permission for this chat (admin)',
  run: (ctx, args) => {
    if (ctx.bridge.config.permissions?.allowChatOverride !== true) {
      return ctx.reply('Permission overrides are disabled. The operator can enable them by setting "permissions.allowChatOverride": true in config.json.');
    }
    const raw = String(args).trim();
    const words = raw.split(/\s+/);
    const a = words[0].toLowerCase();
    if (!a) {
      const cur = currentValue(ctx, 'permission');
      return ctx.reply(`Current permission: ${cur.value ?? 'default (Aside setting)'}${cur.source ? ` (${cur.source})` : ''}. Allowed: ask, guard, full-access. /permission reset clears.`);
    }
    if (a === 'reset') { setSetting(ctx, 'permission', null); return ctx.reply('Permission reset.'); }
    if (!PERMISSIONS.includes(a)) return ctx.reply('Usage: /permission ask|guard|full-access|reset');
    if (a === 'full-access' && words[1] !== 'confirm') {
      return ctx.reply('full-access runs the agent with no permission gates — it can read and change anything. Confirm with: /permission full-access confirm');
    }
    setSetting(ctx, 'permission', a);
    return ctx.reply(`Permission set to ${a}.${sessionNote(ctx)}`);
  },
});

// ---- conversation commands ----
defineCommand({
  name: 'retry',
  description: 're-run this chat\'s last task',
  run: (ctx) => {
    const key = KEY(ctx);
    if (ctx.bridge.running.has(key)) return ctx.reply('A task is already running. /cancel first.');
    const last = ctx.bridge.lastTasks.get(key);
    if (!last) return ctx.reply('Nothing to retry yet.');
    ctx.bridge.submitTask(ctx.channel, { chatId: ctx.chatId, text: last.text, attachments: last.attachments, from: ctx.from });
    return ctx.reply(`↻ Re-running: ${preview(last.text)}`);
  },
});

defineCommand({
  name: 'undo',
  description: 'remove the last exchange from this chat\'s history',
  run: (ctx) => {
    const removed = history.pop(ctx.channel.id, ctx.chatId);
    if (!removed) return ctx.reply('Nothing to undo.');
    const lines = removed.map((t) => `${t.role === 'user' ? 'User' : 'Assistant'}: ${preview(t.text)}`);
    return ctx.reply(`Removed the last turn:\n${lines.join('\n')}`);
  },
});

defineCommand({
  name: 'history',
  description: 'show recent turns (/history [n], max 20)',
  run: (ctx, args) => {
    const n = Math.min(Math.max(parseInt(String(args).trim(), 10) || 5, 1), 20);
    const turns = history.get(ctx.channel.id, ctx.chatId).slice(-n);
    if (!turns.length) return ctx.reply('No history yet.');
    const rows = turns.map((t, i) => `${i + 1}. ${t.role === 'user' ? 'User' : 'Assistant'}: ${String(t.text).slice(0, 200)}`);
    return ctx.reply(rows.join('\n'));
  },
});
