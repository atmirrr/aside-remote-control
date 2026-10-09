// The bridge wires channels -> agent -> channels.
// Messages from one chat are processed in order (a per-chat queue) so the
// agent session stays consistent and tasks don't overlap.
import fs from 'node:fs';
import path from 'node:path';
import { Agent } from './agent.js';
import { createChannel, loadExternalChannels } from './channels/index.js';
import { Channel } from './channels/base.js';
import { sessions, history, attachmentsDir, saveConfig, HOME } from './config.js';
import { transcribe, isTranscriptionConfigured, VOICE_SETUP_HINT } from './transcribe.js';
import { synthesizeVoice } from './voice.js';
import { log, findImagePaths, cleanTerminalOutput, chunkText, sleep, extractAnswer, splitSummary, formatBytes, readFinalReply } from './util.js';

// Flatten recent turns into the single prompt string the CLI accepts, so a
// message that has to start a *fresh* session still carries recent context
// (a resumed session already has it on the Aside side, so this is not used
// there). The Aside CLI has no structured messages array (the
// industry-standard way), so we use the next-best convention used by real
// flatten-to-CLI bridges + Anthropic guidance: a role-labeled transcript with
// `User:` for user turns and an XML tag around prior assistant answers (XML
// delimits reference content and reduces "User:"-in-content ambiguity). The
// current message is the final `User:` turn — the thing to actually answer.
function buildPrompt(prior, text) {
  if (!prior.length) return text;
  const parts = prior.map((m) =>
    m.role === 'user' ? `User: ${m.text}` : `<assistant>${m.text}</assistant>`,
  );
  parts.push(`User: ${text}`);
  return parts.join('\n\n');
}

// Kinds that are somebody talking. Voice notes and round video notes always are.
// A forwarded audio file is too — and either way the browser agent has no way to
// listen to a file, so transcribing is the only thing that makes it useful.
const SPEECH_KINDS = new Set(['voice', 'audio', 'video_note']);
const isSpeech = (a) => SPEECH_KINDS.has(a.kind);

const NO_MESSAGE = 'The user sent the attached file(s) with no message.';

function describeFiles(files) {
  if (!files.length) return '';
  const lines = files.map((f) => `- ${f.path} (${f.mimeType || 'unknown type'}, ${formatBytes(f.size)})`);
  return `Attached files, saved on this machine — open them with your file tools:\n${lines.join('\n')}`;
}

// A message can carry typed text, speech, files, or any mix of the three. The
// CLI takes one string, so flatten: what was typed, then what was said, then
// where the files landed.
function composeMessage(text, transcript, files) {
  const body = [text?.trim(), transcript?.trim()].filter(Boolean).join('\n\n');
  return [body || NO_MESSAGE, describeFiles(files)].filter(Boolean).join('\n\n');
}

// The queue notice's whole job is to carry the "send now" button; one word
// of text so the bubble is not blank.
const QUEUE_NOTICE = 'Queued';
// Stamped onto the bubble a steer cut short (see entry.rotate).
const INTERRUPTED = 'Interrupted!';
// How long a "send now" tap waits for the running task to have announced its
// session id (it prints it within about a second of starting).
const SEND_NOW_ID_WAIT_MS = 6000;

const HELP = [
  'Aside Remote Control',
  '',
  'Just send a message and I will run it as a task in the Aside browser.',
  'Send a voice note and I will transcribe it first. Attach photos or files and',
  'I will hand them to the agent.',
  '',
  'Each chat is one continuing Aside session: follow-ups ("the second one",',
  '"do that again") pick up where the last task left off. /new starts over.',
  '',
  'Send another message while one is running and it waits its turn, then goes',
  'in on its own when the running task finishes. The queued notice has one',
  'button, "send now": tap it and the message goes straight into the running',
  'task instead, interrupting its current step (it keeps everything done so',
  'far and carries on with your correction). "/steer <text>" does the same',
  'without queueing.',
  '',
  'A long or silent task is never killed automatically. You just get a notice',
  'saying it is taking longer than usual, with a "Stop" button - tap it if you',
  'want out, or ignore it and let the task finish.',
  '',
  'Or prefix it: "/btw <task>" skips the queue and runs straight away, next to',
  'whatever is already going.',
  '',
  'Commands:',
  '  /new      start a fresh agent session (forget context)',
  '  /steer .. send this into the running task right now',
  '  /btw ...  run this task now, alongside the current one, in its own session',
  '  /stop     abort everything running in this chat (and the queue)',
  '  /voice    toggle voice replies (spoken recaps) on/off',
  '  /status   show the session id and what is running or queued',
  '  /whoami   show your chat id',
  '  /help     show this help',
].join('\n');

export class Bridge {
  constructor(config) {
    this.config = config;
    this.agent = new Agent(config.agent);
    this.transcribe = transcribe; // swappable for tests
    this.synthesize = synthesizeVoice; // ElevenLabs TTS; swapped out in tests
    this.queues = new Map(); // chatId -> Promise chain
    // chatId -> Set of { controller, startedAt, isolated }. A chat normally has
    // one in-flight task, but a /btw task runs
    // alongside the current one, so this is a set.
    this.running = new Map();
    // Monotonic task ids. /stop cancels "everything issued up to now", which
    // has to be exact: Date.now() has no resolution to spare when a stop and
    // a queued task land in the same millisecond, and a tie there silently
    // let the queued task through.
    this.taskSeq = 0;
    this.stoppedSeq = new Map(); // chatId -> highest task id cancelled by /stop
    // Tasks that arrived while something was already running and are now sitting
    // in the queue. Each one is announced with a "send now" button, which
    // steers it into the running task instead of waiting. seq -> entry.
    this.pending = new Map();
    this.controller = new AbortController();
  }

  addRunning(chatId, entry) {
    let set = this.running.get(chatId);
    if (!set) { set = new Set(); this.running.set(chatId, set); }
    set.add(entry);
    return entry;
  }

  removeRunning(chatId, entry) {
    const set = this.running.get(chatId);
    if (!set) return;
    set.delete(entry);
    if (!set.size) this.running.delete(chatId);
  }

  activeTasks(chatId) {
    return [...(this.running.get(chatId) || [])];
  }

  enqueue(chatId, task) {
    const prev = this.queues.get(chatId) || Promise.resolve();
    const next = prev.then(task, task);
    this.queues.set(chatId, next.catch(() => {}));
    return next;
  }

  pendingFor(chatId) {
    return [...this.pending.values()].filter((p) => String(p.chatId) === String(chatId));
  }

  // True when a message arriving right now would have to wait: something is
  // already running in this chat, or something is already queued ahead of it.
  wouldQueue(chatId) {
    return this.activeTasks(chatId).length > 0 || this.pendingFor(chatId).length > 0;
  }

  // /voice command: current state plus a one-tap inline toggle. The button's
  // label shows the switch position; tapping it fires the voice:toggle action.
  voiceStatus() {
    const a = this.config.agent || {};
    const on = a.voice === true;
    const hasKey = Boolean(a.voiceApiKey || process.env.ELEVENLABS_API_KEY);
    let text = on
      ? 'Voice replies are ON: task recaps arrive as spoken voice notes.'
      : 'Voice replies are OFF: recaps are sent as text.';
    if (on && !hasKey) {
      text += '\n⚠️ No ElevenLabs key is set (agent.voiceApiKey or the ELEVENLABS_API_KEY env var), so replies fall back to text until one is added.';
    }
    return {
      text,
      buttons: [{ text: on ? '🔊 Voice: ON — tap to turn off' : '🔇 Voice: OFF — tap to turn on', data: 'voice:toggle' }],
    };
  }

  // What is going on in one chat right now, as data: the stored session, how
  // many tasks are running (and for how long, oldest first) and how many wait.
  chatState(channel, chatId) {
    const active = this.activeTasks(chatId);
    return {
      sessionId: sessions.get(channel.id, chatId) || null,
      running: active.length,
      runningMs: active.length ? Date.now() - Math.min(...active.map((t) => t.startedAt)) : 0,
      queued: this.pendingFor(chatId).length,
    };
  }

  // /status as data: chatState plus Aside's own view of the session. `live`
  // is { status, title } when Aside lists the session, null when it does not,
  // and undefined when the chat has no session yet.
  async statusInfo(channel, chatId) {
    const state = this.chatState(channel, chatId);
    if (!state.sessionId) return { ...state, live: undefined };
    const live = typeof this.agent.sessionStatus === 'function'
      ? await this.agent.sessionStatus(state.sessionId).catch(() => null)
      : null;
    return { ...state, live };
  }

  // /status: the chat's session id, its live state as Aside reports it, and
  // what the bridge has running or waiting for this chat.
  async statusText(channel, chatId) {
    const s = await this.statusInfo(channel, chatId);
    const lines = [];
    if (!s.sessionId) {
      lines.push('No session yet. The next task starts one.');
    } else {
      lines.push(`Session: ${s.sessionId}`);
      if (s.live) lines.push(`Aside reports it ${s.live.status}${s.live.title ? ` — "${s.live.title}"` : ''}.`);
      else lines.push('Aside does not list it right now (it may have been cleaned up; the next task will start fresh).');
    }
    const secs = Math.round(s.runningMs / 1000);
    if (s.running === 1) lines.push(`Running: 1 task (${secs}s so far).`);
    else if (s.running > 1) lines.push(`Running: ${s.running} tasks (oldest ${secs}s).`);
    else lines.push('Nothing is running.');
    if (s.queued) lines.push(`Queued: ${s.queued}.`);
    return lines.join('\n');
  }

  // /stop as data: abort everything running in the chat and drop everything
  // queued. Resolves with { stopped, dropped, runningMs } (runningMs is the
  // oldest stopped task's age).
  async stopChat(channel, chatId, from) {
    // Recorded even when nothing is running: anything already queued behind
    // this point is dropped too, so /stop means "stop", not "stop one".
    this.stoppedSeq.set(chatId, this.taskSeq);
    // Queued tasks are already dropped by the seq check when their turn comes,
    // but their "send now" buttons would stay live until then - retire them
    // here so a later tap cannot resurrect work the user just cancelled.
    const dropped = this.pendingFor(chatId);
    for (const p of dropped) await p.cancel('Dropped by /stop.');
    const active = this.activeTasks(chatId);
    if (!active.length) return { stopped: 0, dropped: dropped.length, runningMs: 0 };
    // Concurrency means "the current task" is ambiguous, so /stop stops the
    // lot: the main task, every /btw task, and anything still queued.
    const runningMs = Date.now() - Math.min(...active.map((t) => t.startedAt));
    for (const t of active) t.controller.abort();
    log.info(`[${channel.id}] (${from}) /stop aborted ${active.length} task(s) after ${Math.round(runningMs / 1000)}s`);
    return { stopped: active.length, dropped: dropped.length, runningMs };
  }

  // /new as data: forget the chat's session and its replay history. A task
  // still running belongs to the conversation being forgotten, so it is marked
  // and will not write its session id or its exchange back when it finishes -
  // without that, finishing would quietly undo the reset.
  resetChat(channel, chatId) {
    sessions.clear(channel.id, chatId);
    history.clear(channel.id, chatId);
    const active = this.activeTasks(chatId);
    for (const t of active) t.forgotten = true;
    return { running: active.length };
  }

  // How many tasks are ahead of queued task `seq` in this chat's line: the one
  // running (a /btw beside it never holds the line up) plus earlier queued ones.
  queuedAhead(chatId, seq) {
    const running = this.activeTasks(chatId).some((t) => !t.isolated) ? 1 : 0;
    return running + this.pendingFor(chatId).filter((p) => p.seq < seq).length;
  }

  // Handed to every channel's start(): the slash-command operations, taking
  // data and returning data. For channels that have no "/stop" to type and say
  // things in their own words (a voice channel speaks its answers), so they can
  // offer the same controls without parsing chat text back out.
  // Every call is held to the same allowlist as a message from that chat.
  controlFor(channel) {
    const allowed = (chatId) => {
      if (!channel.isAuthorized(chatId)) throw new Error(`chat ${chatId} is not authorized`);
    };
    return {
      state: (chatId) => { allowed(chatId); return this.chatState(channel, chatId); },
      status: async (chatId) => { allowed(chatId); return this.statusInfo(channel, chatId); },
      stop: async (chatId, from = 'control') => { allowed(chatId); return this.stopChat(channel, chatId, from); },
      reset: (chatId) => { allowed(chatId); return this.resetChat(channel, chatId); },
      steer: async (chatId, text, from = 'control', opts = {}) => {
        allowed(chatId);
        return this.steerChat(channel, chatId, text, from, opts);
      },
    };
  }

  // The running task a steer goes to. With several running (a /btw beside the
  // main one) the chat's own session is the target; a /btw task is only
  // reachable when it is the sole thing running.
  steerTarget(chatId) {
    const active = this.activeTasks(chatId);
    if (!active.length) return null;
    return active.find((t) => !t.isolated) || active[active.length - 1];
  }

  // Steering as data: interrupt the task running in this chat with a new
  // instruction. Resolves { ok: true, target } once it is in, else
  // { ok: false, reason, detail } with reason one of nothing-running,
  // unavailable, no-session, not-found or failed. waitMs lets a caller with
  // nothing on screen to retry from (a voice request) wait for a task that has
  // only just started to announce its session id, as "send now" does.
  async steerChat(channel, chatId, instruction, from, { waitMs = 0 } = {}) {
    if (!this.activeTasks(chatId).length) return { ok: false, reason: 'nothing-running' };
    if (typeof this.agent.steer !== 'function') return { ok: false, reason: 'unavailable' };
    let target = this.steerTarget(chatId);
    const deadline = Date.now() + waitMs;
    while (target && !target.sessionId && Date.now() < deadline) {
      await sleep(100);
      target = this.steerTarget(chatId);
    }
    if (!target) return { ok: false, reason: 'nothing-running' };
    if (!target.sessionId) return { ok: false, reason: 'no-session' };
    const r = await this.agent.steer(target.sessionId, instruction);
    if (r.ok) {
      log.info(`[${channel.id}] (${from}) steered task ${target.seq} [${target.sessionId}]: ${instruction.slice(0, 120)}`);
      if (this.config.agent?.context !== false && !target.forgotten) {
        history.append(channel.id, chatId, 'user', instruction, this.config.agent?.contextMaxChars ?? 2000);
      }
      await target.rotate?.();
      return { ok: true, target };
    }
    log.warn(`[${channel.id}] steer of task ${target.seq} [${target.sessionId}] failed: ${(r.err || r.out || '').slice(0, 300)}`);
    return { ok: false, reason: r.notFound ? 'not-found' : 'failed', detail: String(r.err || r.out || '').trim() };
  }

  // /steer: interrupt the task running in this chat with a new instruction.
  // Returns the text to show, or null when it went in (the running task's
  // reply from here on lands in a fresh bubble below, which is the confirmation).
  async steerRunning(channel, chatId, instruction, from) {
    if (!instruction) return 'Add the correction after /steer, e.g. "/steer use the CSV, not the web".';
    const r = await this.steerChat(channel, chatId, instruction, from);
    if (r.ok) return null;
    switch (r.reason) {
      case 'nothing-running': return 'Nothing is running to steer. Send it as a normal message and it runs next.';
      case 'unavailable': return 'Steering is not available on this bridge.';
      case 'no-session':
        return 'The running task has not reported its session id yet (it does within a few seconds of starting). Try again in a moment.';
      case 'not-found': return 'Aside no longer knows that session, so it cannot be steered. Use /stop, then send the corrected task.';
      default: return `Couldn't steer it: ${(r.detail || 'no reply from the CLI').slice(0, 300)}`;
    }
  }

  // Button taps forwarded by channels that support inline actions. Same
  // authorization gate as messages: buttons only render in chats the bot posted
  // to, but the update's chat id is still checked before acting on it.
  async handleAction(channel, { chatId, messageId, data, from, fromId }) {
    if (!channel.isAuthorized(chatId)) {
      log.warn(`[${channel.id}] blocked action "${data}" from unauthorized chat ${chatId} (${from})`);
      return;
    }
    // In an allowed group, a member who may not drive the agent can still see
    // and tap its buttons (kill, run now). Their taps do nothing.
    if (channel.isAllowedSender && !channel.isAllowedSender(chatId, fromId)) {
      log.warn(`[${channel.id}] ignored action "${data}" from ${from} (${fromId}) in ${chatId}: not an allowed sender`);
      return;
    }
    if (data === 'voice:toggle') {
      this.config.agent.voice = this.config.agent.voice !== true;
      saveConfig(this.config); // survives a bridge restart
      log.info(`[${channel.id}] (${from}) voice replies ${this.config.agent.voice ? 'enabled' : 'disabled'}`);
      const status = this.voiceStatus();
      // Flip the button in place; fall back to a fresh message if the edit fails.
      const edited = messageId != null && await channel.editText(chatId, messageId, status.text, { buttons: status.buttons });
      if (!edited) await channel.sendText(chatId, status.text, { buttons: status.buttons });
      return;
    }

    // "Stop" on a task that outlived a timeout notice. Unlike
    // /stop, which clears the whole chat, this ends exactly the one task the
    // button was raised for - anything else running keeps going.
    const kill = /^kill:(\d+)$/.exec(data || '');
    if (kill) {
      const seq = Number(kill[1]);
      const task = this.activeTasks(chatId).find((t) => t.seq === seq);
      let notice;
      if (!task) {
        // It finished between the notice and the tap. Not an error: the thing
        // the user wanted stopped is already stopped.
        notice = 'That task already finished.';
      } else {
        const secs = Math.round((Date.now() - task.startedAt) / 1000);
        task.controller.abort();
        notice = `🛑 Stopping it (ran ${secs}s)...`;
        log.info(`[${channel.id}] (${from}) stop button aborted task ${seq} after ${secs}s`);
      }
      const edited = messageId != null
        && typeof channel.editText === 'function'
        && await channel.editText(chatId, messageId, notice);
      if (!edited) await channel.sendText(chatId, notice);
      return;
    }

    // "send now" on a queued message: take it out of the queue and steer it
    // into the task that is running. Nothing is said either way - the notice
    // simply goes away. A tap that lost the race (the queue already reached
    // this message, so it went in on its own) just clears the stale notice.
    const sendNow = /^steer:(\d+)$/.exec(data || '');
    if (sendNow) {
      const seq = Number(sendNow[1]);
      const entry = this.pending.get(seq);
      if (!entry || String(entry.chatId) !== String(chatId)) {
        log.info(`[${channel.id}] (${from}) send-now tapped for task ${seq}: already gone`);
        if (messageId != null) await this.dropNotice(channel, chatId, messageId);
        return;
      }
      const outcome = await entry.sendNow();
      log.info(`[${channel.id}] (${from}) send-now tapped for task ${seq}: ${outcome}`);
    }
  }

  // Remove a queue notice. Deleting is the point: the notice exists only to
  // carry its button, so once the button is moot nothing should remain. If the
  // channel cannot delete, strip the button by editing the text back in place.
  async dropNotice(channel, chatId, messageId) {
    if (messageId == null) return;
    let gone = false;
    try { gone = (await channel.deleteMessage?.(chatId, messageId)) === true; } catch {}
    if (!gone && typeof channel.editText === 'function') {
      await channel.editText(chatId, messageId, QUEUE_NOTICE).catch(() => {});
    }
  }

  // Voice mode: synthesize the reply with ElevenLabs and send it as a voice
  // note — the recap when summary mode produced one, else the full answer (a
  // reply without the marker is often short enough to be its own recap; no
  // client-side length cap, the ElevenLabs API limit is the natural bound).
  // voice:true implies summary mode (handleMessage requests the recap
  // whenever either is on). Returns true only once the voice message is
  // actually in the chat; every other path returns false so the caller falls
  // back to the text reply — voice can upgrade a reply, never lose one.
  async speakReply(channel, chatId, text) {
    const a = this.config.agent || {};
    if (a.voice !== true || !text) return false;
    if (typeof channel.sendVoice !== 'function') return false;
    const apiKey = a.voiceApiKey || process.env.ELEVENLABS_API_KEY;
    if (!apiKey) {
      log.warn(`[${channel.id}] voice mode is on but no ElevenLabs key is set (agent.voiceApiKey or ELEVENLABS_API_KEY)`);
      return false;
    }
    try {
      const audio = await this.synthesize({ apiKey, voiceId: a.voiceId, modelId: a.voiceModelId, text });
      return (await channel.sendVoice(chatId, audio)) === true;
    } catch (e) {
      log.warn(`[${channel.id}] voice synthesis/send failed: ${e.message}; sending text instead`);
      return false;
    }
  }

  // Fetch a message's files and turn any speech into text. Called only after the
  // chat has passed authorization, so an unauthorized sender can never make the
  // bridge download or store their files. Resolves to { files, transcript }, or
  // { error } with a message to show the user verbatim.
  async prepareAttachments(channel, chatId, messageId, attachments) {
    const voiceCfg = this.config.voice || {};
    const hasSpeech = attachments.some(isSpeech);
    const hasFiles = attachments.some((a) => !isSpeech(a));

    // Every refusal below happens before the first byte is fetched.
    if (hasFiles && this.config.attachments?.enabled === false) {
      return { error: 'File attachments are disabled on this bridge.' };
    }
    if (hasSpeech && voiceCfg.enabled === false) {
      return { error: 'Voice messages are disabled on this bridge.' };
    }
    // No point pulling audio down when nothing can read it back to us.
    if (hasSpeech && !isTranscriptionConfigured(voiceCfg)) return { error: VOICE_SETUP_HINT };

    const dir = attachmentsDir(channel.id, chatId, this.config.attachments?.dir);
    const files = [];
    const spoken = [];

    for (const [i, a] of attachments.entries()) {
      let filePath;
      try {
        filePath = await a.download(dir, `${messageId}-${i}`);
      } catch (e) {
        return { error: `Couldn't download the ${a.kind} you sent: ${e.message}` };
      }
      if (!isSpeech(a)) {
        files.push({ path: filePath, mimeType: a.mimeType, size: a.size });
        continue;
      }
      try {
        const text = await this.transcribe(filePath, voiceCfg, a.mimeType);
        if (text) spoken.push(text);
      } catch (e) {
        return { error: `Couldn't transcribe the ${a.kind} you sent: ${e.message}` };
      } finally {
        // The audio has done its job. Don't leave recordings of the user lying
        // around; the transcript is what carries forward.
        await fs.promises.rm(filePath, { force: true }).catch(() => {});
      }
    }

    if (hasSpeech && !spoken.length && !files.length) {
      return { error: "I couldn't make out any speech in that — try again?" };
    }
    return { files, transcript: spoken.join('\n\n') };
  }

  async handleMessage(channel, { chatId, text = '', attachments = [], messageId, from, fromId, onRouted }) {
    // A channel that acknowledges each message itself (a voice channel answers
    // the very request that carried it) learns here what became of it, as soon
    // as that is known: { kind } is started, queued (with `ahead`), steered,
    // dropped, command or blocked. Reported once; never allowed to break routing.
    let reported = false;
    const routed = (outcome) => {
      if (reported) return;
      reported = true;
      try { onRouted?.(outcome); } catch {}
    };
    // Replies to a command: tell onRouted first, then say it.
    const reply = (t, o) => { routed({ kind: 'command' }); return channel.sendText(chatId, t, o); };

    if (!channel.isAuthorized(chatId)) {
      routed({ kind: 'blocked' });
      // Report the chat itself, not a forum-topic key: that is what the operator
      // has to put in allowedChatIds.
      const shown = channel.chatOf ? channel.chatOf(chatId) : chatId;
      log.warn(`[${channel.id}] blocked unauthorized chat ${shown} (${from})`);
      await channel.sendText(chatId, `Not authorized. Your chat id is ${shown}. Ask the operator to allow it.`);
      return;
    }
    // An allowed group can hold people who may not drive the agent. Ignore them
    // without replying: answering every message they send would spam the group.
    if (channel.isAllowedSender && !channel.isAllowedSender(chatId, fromId)) {
      routed({ kind: 'blocked' });
      log.warn(`[${channel.id}] ignored ${from} (${fromId}) in ${chatId}: not an allowed sender`);
      return;
    }

    // Commands are typed, never captioned onto a file.
    const cmd = attachments.length ? '' : text.trim().toLowerCase();
    if (cmd === '/help' || cmd === '/start') return reply(HELP);
    if (cmd === '/whoami') return reply(`chat id: ${chatId}\nusername: ${from}`);
    if (cmd === '/status') return reply(await this.statusText(channel, chatId));

    // "/steer <text>": interrupt the task running right now with a correction.
    // The session keeps everything it has done; only the current step is cut
    // short. This is the one path by which a message reaches a task already in
    // flight - an ordinary message would queue behind it.
    if (/^\/steer(?:\s|$)/i.test(text.trim()) && !attachments.length) {
      const instruction = text.trim().replace(/^\/steer\s*/i, '');
      const answer = await this.steerRunning(channel, chatId, instruction, from);
      if (answer) return reply(answer);
      routed({ kind: 'steered' });
      return undefined;
    }
    if (cmd === '/new') {
      this.resetChat(channel, chatId);
      return reply('Started a fresh session. Send your task.');
    }
    if (cmd === '/stop') {
      const r = await this.stopChat(channel, chatId, from);
      if (!r.stopped) {
        return reply(r.dropped
          ? `Nothing was running. Dropped ${r.dropped} queued task${r.dropped === 1 ? '' : 's'}.`
          : 'Nothing is running right now.');
      }
      const secs = Math.round(r.runningMs / 1000);
      return reply(r.stopped === 1
        ? `🛑 Stopping the current task (running ${secs}s)...`
        : `🛑 Stopping ${r.stopped} running tasks (oldest ${secs}s)...`);
    }
    if (cmd === '/voice') {
      const status = this.voiceStatus();
      return reply(status.text, { buttons: status.buttons });
    }

    // "/btw <task>": never queue,
    // start immediately alongside whatever is already going. The prefix is
    // stripped so the agent never sees it. Allowed as a file caption too, since
    // unlike the bare commands above it carries a payload.
    const btw = /^\/btw(?:\s|$)/i.test(text.trim());
    const taskText = btw ? text.trim().replace(/^\/btw\s*/i, '') : text;
    if (btw && !taskText && !attachments.length) {
      return reply('Add the task after /btw, e.g. "/btw check my email".');
    }
    const seq = ++this.taskSeq;
    const controller = new AbortController();
    // Does this message have to wait behind something? If so it gets a queue
    // notice with a "send now" button instead of starting silently. /btw opts
    // out of queueing entirely.
    const willQueue = !btw && this.wouldQueue(chatId);
    // A /btw beside a running task is isolated: its own fresh agent session,
    // and no history append. Two concurrent CLI runs resuming the SAME session
    // id would interleave into one transcript, and history.json is a
    // read-modify-write file that would lose an update if two tasks appended at
    // once. A task that waits its turn has neither problem, so it stays on the
    // normal session and in history. A /btw with nothing else running has no
    // one to collide with, so it keeps the normal session and history too.
    const isolated = btw && this.wouldQueue(chatId);
    // Exactly one of the two paths - its turn in the queue, or the "send now"
    // button steering it into the running task - may consume this message.
    // Whichever gets here first wins and the other becomes a no-op, so a tap
    // landing just as the queue drains cannot send it twice.
    let claimed = false;
    const claim = () => (claimed ? false : (claimed = true));

    const body = async () => {
      // A /stop that landed while this was still waiting its turn cancels it
      // before it ever starts.
      if ((this.stoppedSeq.get(chatId) || 0) >= seq) {
        log.info(`[${channel.id}] (${from}) queued task dropped by /stop`);
        return;
      }
      const started = Date.now();
      const entry = this.addRunning(chatId, { controller, startedAt: started, isolated, seq });
      await channel.sendTyping(chatId);
      // Downloading and transcribing happen before the agent starts, and can take
      // a few seconds, so keep the indicator alive from here rather than later.
      const keepTyping = setInterval(() => channel.sendTyping(chatId).catch(() => {}), 6000);
      // Never let the typing indicator be the only thing holding the process
      // open. If a task's agent never settles, this repeating timer would keep
      // the event loop alive forever - that is exactly what wedged the test
      // suite (and, through it, the bridge) for hours.
      keepTyping.unref?.();

      // Declared up front so the catch/finally below can always reach them,
      // whatever stage the task got to.
      let msgId;
      let streaming = false;
      let flushTimer = null;
      let lastShown = '';
      let editing = false;
      // Message ids of any timeout notices sent for this task, so their kill
      // buttons can be retired once it is over.
      const stallNoticeIds = [];

      try {
        let files = [];
        let transcript = '';
        if (attachments.length) {
          const prepared = await this.prepareAttachments(channel, chatId, messageId, attachments);
          if (prepared.error) {
            await channel.sendText(chatId, prepared.error);
            return;
          }
          ({ files, transcript } = prepared);
          log.info(`[${channel.id}] (${from}) attachments: ${attachments.map((a) => a.kind).join(', ')}`);
          // Show what was heard before acting on it, so a mistranscription is
          // visible rather than silently obeyed.
          if (transcript && this.config.voice?.echoTranscript !== false) {
            await channel.sendText(chatId, `🎙️ ${transcript}`);
          }
        }
        const messageText = composeMessage(taskText, transcript, files);

        const sid = isolated ? null : sessions.get(channel.id, chatId);
        log.info(`[${channel.id}] (${from}) ${isolated ? '/btw task' : 'task'}${sid ? ` [${sid}]` : ' [new]'}: ${messageText.slice(0, 120)}`);
        // The moment a fresh run announces its id, pin it to this task (so
        // /steer and the Stop button can address it) and to the chat (so a
        // follow-up resumes it even if this process dies before the task ends).
        const onSession = (id) => {
          entry.sessionId = id;
          sessions.origin(channel.id, id); // every session this channel starts, kept or not
          if (isolated) {
            log.info(`[${channel.id}] /btw task ${seq} owns its own session ${id}`);
          } else if (entry.forgotten) {
            // /new landed while this was starting: it may finish, but the chat
            // has moved on and must not be pointed back at its session.
            log.info(`[${channel.id}] task ${seq} owns session ${id} (not kept: the chat was reset)`);
          } else {
            sessions.set(channel.id, chatId, id);
            log.info(`[${channel.id}] task ${seq} owns session ${id}`);
          }
        };
        if (sid) entry.sessionId = sid;

        // Stream by editing one message in place, when the channel supports it.
        const wantStream = this.config.agent?.stream !== false
          && typeof channel.editText === 'function'
          && channel.editText !== Channel.prototype.editText;
        const throttle = this.config.agent?.streamThrottleMs ?? 1800;
        const placeholder = '🧠 Thinking...';
        // Voice channels opt out: speaking "Thinking..." aloud is noise, and with
        // no message id there is nothing to stream into, so the final answer
        // arrives as one clean sendText.
        msgId = channel.wantsPlaceholder === false
          ? undefined
          : await channel.sendText(chatId, placeholder).catch(() => undefined);
        streaming = wantStream && msgId != null;
        lastShown = placeholder;

        const verbose = this.config.agent?.verbose === true;
        // Fallback continuity: a resumed session already holds the conversation
        // on the Aside side, so the prompt is just the message. Only a run that
        // has to start fresh (no id, or an id that was just rejected) gets the
        // recent turns replayed client-side, so it does not begin from nothing.
        const useContext = this.config.agent?.context !== false;
        const ctxMax = this.config.agent?.contextMaxChars ?? 2000;
        // Summary mode: ask for a sentinel-delimited final reply at the end.
        // Appended to the prompt only — never stored in history, so it isn't
        // replayed as part of the conversation on the next turn. voice:true
        // implies summary mode: the voice note speaks the recap, so it has to
        // be requested — no need to also set summary:true.
        // Voice channels force this on: without a recap there is nothing
        // short enough to speak, whatever the global toggle says.
        const summaryOn = channel.forcesSummary === true
          || this.config.agent?.summary === true
          || this.config.agent?.voice === true;
        const marker = summaryOn ? (this.config.agent?.summaryMarker || '<<<SUMMARY>>>') : null;
        const makePrompt = (resuming) => {
          let p = (useContext && !resuming)
            ? buildPrompt(history.get(channel.id, chatId), messageText)
            : messageText;
          if (summaryOn) {
            const template = channel.summaryPrompt || this.config.agent?.summaryPrompt || '';
            const instruction = template.replace('{marker}', marker);
            if (instruction) p = `${p}\n\n${instruction}`;
          }
          return p;
        };
        let prompt = makePrompt(Boolean(sid));

        // Live-edit state: accumulate raw output, push the latest tail on a timer.
        let acc = '';
        let editCount = 0;
        // Transcript accounting for bubble rotation (see entry.rotate below).
        // `seen` counts every chunk ever received; `rawCut` is where the
        // transcript shown in the *current* bubble starts, and `rawCarry` is
        // any colour state that was open at the cut and has to be replayed so
        // the answer filter still recognises a dim (tool-output) span that
        // straddles it.
        let seen = 0;
        let rawCut = 0;
        let rawCarry = '';
        // Progress view: the raw transcript tail when verbose, else the cleaned
        // answer-so-far (which stays empty while the agent is doing tool work).
        // Once the summary marker shows up mid-stream, switch the view to the
        // final reply alone — the in-place swap that replaces the transcript.
        const renderPartial = () => {
          const view = verbose ? cleanTerminalOutput(acc) : extractAnswer(acc);
          const { summary } = splitSummary(view, marker);
          return (summary || view).slice(-3500).trim();
        };
        const pushEdit = async (textToShow) => {
          if (editing) return;
          const t = (textToShow ?? renderPartial());
          if (!t || t === lastShown) return;
          editing = true;
          try { await channel.editText(chatId, msgId, t); lastShown = t; editCount++; } catch {} finally { editing = false; }
        };
        const onData = streaming ? (chunk) => {
          acc += chunk;
          seen += chunk.length;
          if (flushTimer) return;
          flushTimer = setTimeout(() => { flushTimer = null; pushEdit(); }, throttle);
        } : undefined;
        // Steering mid-task: the reply so far stays in the bubble it was
        // streaming into (above the user's correction), and everything from
        // here on goes into a new bubble below it, so the steered answer reads
        // in order. Without streaming the reply is sent at the end anyway, so
        // it already lands below and there is nothing to rotate.
        entry.rotate = async () => {
          if (!streaming) return;
          if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
          while (editing) await sleep(20);
          await pushEdit(); // leave the old bubble showing what it had
          // A dim span left open at the cut would leak into the new bubble as
          // answer text; re-open it so the filter keeps treating it as noise.
          const dimOpen = acc.lastIndexOf('\x1b[2m') > acc.lastIndexOf('\x1b[0m');
          const id = await channel.sendText(chatId, placeholder).catch(() => undefined);
          if (id == null) return; // could not open a new bubble: keep the old one
          // Mark the old bubble: a bare placeholder becomes "Interrupted!",
          // text already shown stays as it is with "Interrupted!" on a new line.
          const stamped = lastShown === placeholder ? INTERRUPTED : `${lastShown}\n\n${INTERRUPTED}`;
          try { await channel.editText(chatId, msgId, stamped); } catch {}
          rawCut = seen;
          rawCarry = dimOpen ? '\x1b[2m' : '';
          acc = rawCarry;
          msgId = id;
          lastShown = placeholder;
          log.info(`[${channel.id}] task ${seq} continues in a new message after steer`);
        };

        // A timeout no longer kills the task, it reports (see agent.js). Surface
        // that as its own message carrying a kill button: a task that really is
        // wedged ends with one tap, and a task that is merely slow is left alone.
        // Sent separately rather than edited into the streamed message, which is
        // busy showing progress and would overwrite the notice on the next flush.
        const onStall = async ({ kind, idleMs, limitMs, elapsedMs }) => {
          const mins = (ms) => (ms >= 60000 ? `${Math.round(ms / 60000)}m` : `${Math.round(ms / 1000)}s`);
          // Deliberately plain: from out here a long quiet browser step and a
          // wedged one look identical, so the notice states the one thing that
          // is actually known (it is slow, it is alive) and hands the decision
          // over instead of speculating about why.
          const text = `⏳ This is taking longer than usual (${mins(elapsedMs)} so far). Still running.`;
          log.warn(`[${channel.id}] task ${seq} ${kind === 'idle' ? `silent for ${mins(idleMs)}` : `past its ${mins(limitMs)} cap`}; offering the stop button`);
          const id = await channel.sendText(chatId, text, {
            buttons: [{ text: '🛑 Stop', data: `kill:${seq}` }],
            // What this message is, for channels that render notices their own
            // way: a speaker cannot show a button, and must not treat a notice
            // as the task's final answer.
            notice: 'stall',
            stallKind: kind,
            elapsedMs,
          }).catch(() => undefined);
          if (id != null) stallNoticeIds.push(id);
        };

        // A chat that is being resumed must not stay hidden as archived (Aside's
        // resume leaves archived_at alone). Unarchive when the db says it is
        // archived, or when that can't be read; skip the call when it says no.
        if (sid && typeof this.agent.isArchived === 'function' && typeof this.agent.unarchive === 'function') {
          const was = this.agent.isArchived(sid);
          if (was !== false) {
            const r = await this.agent.unarchive(sid);
            if (was === true) {
              if (this.agent.isArchived(sid) === false) log.info(`[${channel.id}] session ${sid} was archived; unarchived before resuming`);
              else log.warn(`[${channel.id}] could not unarchive session ${sid}: ${(r.err || r.out || '').slice(0, 200)}`);
            }
          }
        }
        let res = await this.agent.run({ prompt, sessionId: sid, onData, onStall, onSession, signal: controller.signal });
        // Self-heal: if the stored session id was rejected (expired/unknown/bad),
        // forget it and retry once as a fresh session instead of failing forever.
        // The retry is a fresh start, so it gets the replayed context.
        if (res.sessionMissing && sid) {
          log.warn(`[${channel.id}] session "${sid}" was rejected; starting a fresh one and retrying`);
          sessions.clear(channel.id, chatId);
          entry.sessionId = null;
          acc = ''; seen = 0; rawCut = 0; rawCarry = '';
          prompt = makePrompt(false);
          res = await this.agent.run({ prompt, sessionId: null, onData, onStall, onSession, signal: controller.signal });
        }
        const secs = ((Date.now() - started) / 1000).toFixed(1);
        log.info(`[${channel.id}] task finished in ${secs}s (exit=${res.code}, ${String(res.text || '').length} chars)`);
        // Surface wrapper/agent stderr in the logs (it's kept out of the chat reply).
        if (res.error && res.errorDetail) log.warn(`[${channel.id}] agent exited ${res.code}; stderr: ${res.errorDetail.slice(0, 500)}`);
        if (!isolated && !entry.forgotten && res.sessionId && !res.sessionMissing
          && res.sessionId !== sessions.get(channel.id, chatId)) {
          sessions.set(channel.id, chatId, res.sessionId);
        }

        if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
        // Default: show just the answer (strip the Thinking/tool transcript) and
        // render its markdown. verbose: forward the raw transcript as plain text.
        let finalText = res.text || '(no output)';
        // The clean answer as delivered, reused for the history entry below.
        let deliveredAnswer = null;
        if (res.aborted) {
          // Deliberate stop: whatever ran already streamed into the message,
          // so the final state just has to say it stopped.
          finalText = '🛑 Stopped.';
        } else if (res.stalled || res.code < 0) {
          // Bridge-synthesized notice (stall / timeout / launch failure): res.text
          // is already the user-facing message, so show it verbatim instead of
          // running it through extractAnswer (which would strip it as transcript).
          finalText = res.text || '(No answer produced.)';
          // A stall on a task with files is almost never the generic memory/edit
          // approval the notice describes — it's the agent blocking on read
          // permission for the attachment. Name the actual directory.
          if (res.stalled && files.length) {
            finalText += `\n\nThis task had attached files. Aside also needs read access to ${path.dirname(files[0].path)} — grant it in Settings → Permissions → Can read, or set "attachments.dir" to a folder Aside already reads.`;
          }
        } else if (!verbose) {
          // After a rotation only the part of the transcript that belongs to
          // the current bubble is shown; the rest is already up in the old one.
          const shownRaw = rawCut ? rawCarry + String(res.raw || '').slice(rawCut) : (res.raw || finalText);
          let answer = extractAnswer(shownRaw);
          // The scrape is a heuristic over terminal colours. When it finds
          // nothing, or misses the summary marker the prompt asked for, read
          // the reply from Aside's own session store, which has it verbatim.
          // Missing that once made a 14-minute voice task end in "No answer
          // produced" on the speaker although the agent had replied.
          if ((!answer || (marker && !answer.includes(marker))) && res.sessionId) {
            let stored = readFinalReply(res.sessionId, started - 2000);
            // The store can trail the CLI's exit by a moment. Worth waiting
            // for only when the scrape found nothing at all: a reply that just
            // lacks the marker is already good enough, and waiting there held
            // every such task open for 1.2s more.
            for (let k = 0; !stored && !answer && k < 3; k++) { await sleep(400); stored = readFinalReply(res.sessionId, started - 2000); }
            if (stored && (!answer || stored.includes(marker))) {
              log.info(`[${channel.id}] reply read from the session store (${stored.length} chars): the terminal scrape ${answer ? 'had no summary marker' : 'came back empty'}`);
              if (!answer) {
                // Keep the transcript the scrape failed on, to find out why.
                try { fs.writeFileSync(path.join(HOME, 'last-empty-scrape.txt'), String(shownRaw).slice(-4 * 1024 * 1024)); } catch {}
              }
              answer = stored;
            }
          }
          // Coverage signal: empty means no user-facing answer was found (or a
          // format slipped past the filter). Log it so odd cases surface.
          if (!answer) log.warn(`[${channel.id}] no answer extracted from ${String(res.text || '').length}-char transcript`);
          deliveredAnswer = answer || null;
          finalText = answer || '(No answer produced — the task may have stopped early or needed an approval.)';
        }
        // Summary mode: show the recap, keep the full answer for history. No
        // marker means the agent ignored the instruction — show the full answer.
        const split = splitSummary(finalText, marker);
        if (summaryOn && !split.summary) log.warn(`[${channel.id}] summary requested but the reply had no "${marker}" marker`);
        finalText = split.summary || split.body;
        const opts = verbose ? {} : { markdown: true };
        // A stop is acknowledged by whoever asked for it; this closing message
        // says so, so a channel that already spoke the acknowledgement can skip it.
        if (res.aborted) opts.notice = 'stopped';
        const parts = chunkText(finalText, 3900);
        // Voice mode: deliver the reply as a spoken voice note — the recap
        // when there is one, else the whole answer. Tried before any text
        // lands, so a failure falls through with nothing lost.
        if (await this.speakReply(channel, chatId, finalText)) {
          if (streaming) {
            while (editing) await sleep(20);
            // Deleting the streamed message is the "replace": the voice note
            // stands alone. If the channel can't delete, land the recap text
            // there instead so it isn't left showing a stale transcript tail.
            let deleted = false;
            try { deleted = (await channel.deleteMessage?.(chatId, msgId)) === true; } catch {}
            if (!deleted && parts[0] !== lastShown) {
              try { await channel.editText(chatId, msgId, parts[0], opts); } catch {}
            }
          }
          log.info(`[${channel.id}] reply delivered as a voice note`);
        } else if (streaming) {
          // Land the final result into the streamed message; overflow as follow-ups.
          while (editing) await sleep(20);
          if (parts[0] !== lastShown) {
            try { await channel.editText(chatId, msgId, parts[0], opts); editCount++; }
            catch { await channel.sendText(chatId, parts[0], opts); }
          }
          for (let i = 1; i < parts.length; i++) await channel.sendText(chatId, parts[i], opts);
          log.info(`[${channel.id}] streamed ${editCount} edit(s)`);
        } else {
          await channel.sendText(chatId, finalText, opts);
        }
        // Remember this exchange (the clean answer, not the raw transcript) so the
        // next message can resolve follow-up references. Store the composed text,
        // not the raw one: for a voice note that's the transcript, and for files
        // it's their paths — so "summarize that pdf again" still resolves.
        // A stopped task has no complete answer; keeping half of one would
        // poison the context of the next turn.
        if (useContext && !res.aborted && !isolated && !entry.forgotten) {
          history.append(channel.id, chatId, 'user', messageText, ctxMax);
          // The full answer, not the recap: follow-ups ("the second one") need
          // the detail that summary mode hides from the chat.
          const cleanAnswer = splitSummary(deliveredAnswer ?? extractAnswer(res.raw || res.text || ''), marker).body;
          if (cleanAnswer) history.append(channel.id, chatId, 'assistant', cleanAnswer, ctxMax);
        }
        // Best-effort: attach any image artifacts the agent referenced. Several
        // shots go out as one grouped album where the channel supports it.
        const imgs = findImagePaths(res.text).map((p) => p.replace(/^~(?=\/)/, process.env.HOME || '~'));
        if (imgs.length) {
          try { await channel.sendImages(chatId, imgs); } catch {}
        }
      } catch (e) {
        const msg = `Error running task: ${e.message}`;
        if (streaming) { try { await channel.editText(chatId, msgId, msg); } catch { await channel.sendText(chatId, msg); } }
        else await channel.sendText(chatId, msg);
      } finally {
        this.removeRunning(chatId, entry);
        // The task is over (finished, stopped, or errored) - retire every kill
        // button it raised, so a later tap can't read as "still killable".
        if (typeof channel.editText === 'function') {
          for (const id of stallNoticeIds) {
            await channel.editText(chatId, id, 'That task is no longer running.').catch(() => {});
          }
        }
        if (flushTimer) clearTimeout(flushTimer);
        clearInterval(keepTyping);
      }
    };
    // The per-chat promise chain is exactly what serialises tasks. The claim
    // guard turns this slot into a no-op if the button already started the task.
    let noticeId;
    // What became of a message that had to wait, for routed(): it stays
    // 'queued' unless its turn comes first ('started'), a steer takes it
    // ('steered') or /stop drops it ('dropped').
    let fate = 'queued';
    const queuedBody = async () => {
      if (!claim()) return;
      fate = 'started';
      this.pending.delete(seq);
      // Its turn came on its own: the message goes in as the next task, and
      // the notice (whose only job was the button) disappears.
      await this.dropNotice(channel, chatId, noticeId);
      return body();
    };

    // A /btw that has something to run beside deliberately skips the per-chat
    // promise chain - joining it would serialise the very thing it is meant to
    // run in parallel. Kept off the chain and not awaited.
    if (btw && isolated) {
      if (!claim()) return;
      routed({ kind: 'started', parallel: true });
      log.info(`[${channel.id}] (${from}) /btw task ${seq} running alongside`);
      body().catch(() => {});
      return;
    }
    if (!willQueue) {
      routed({ kind: 'started' });
      return this.enqueue(chatId, queuedBody);
    }

    this.pending.set(seq, {
      chatId,
      seq,
      // "send now": steer this message into the running task instead of
      // waiting. Resolves with a short outcome for the log; the chat sees
      // nothing but the notice going away.
      sendNow: async () => {
        if ((this.stoppedSeq.get(chatId) || 0) >= seq) {
          this.pending.delete(seq);
          fate = 'dropped';
          await this.dropNotice(channel, chatId, noticeId);
          return 'already dropped by /stop';
        }
        if (typeof this.agent.steer !== 'function') return 'steering unavailable, left queued';
        // The running task announces its id within about a second of starting;
        // a tap that lands before that waits for it rather than giving up.
        const deadline = Date.now() + SEND_NOW_ID_WAIT_MS;
        let target = this.steerTarget(chatId);
        while (target && !target.sessionId && Date.now() < deadline && !claimed) {
          await sleep(100);
          target = this.steerTarget(chatId);
        }
        if (!target) return 'nothing running any more, left queued (it starts next)';
        if (!target.sessionId) return 'running task has no session id yet, left queued';
        if (!claim()) return 'already started on its own';
        fate = 'steered';
        this.pending.delete(seq);
        await this.dropNotice(channel, chatId, noticeId);
        // Files and voice notes are resolved here, the same way a task would.
        let files = [];
        let transcript = '';
        if (attachments.length) {
          const prepared = await this.prepareAttachments(channel, chatId, messageId, attachments);
          if (prepared.error) {
            await channel.sendText(chatId, prepared.error);
            return `attachments failed: ${prepared.error}`;
          }
          ({ files, transcript } = prepared);
        }
        const messageText = composeMessage(taskText, transcript, files);
        const r = await this.agent.steer(target.sessionId, messageText);
        if (!r.ok) {
          // Could not get it in; the running task's own reply will say what
          // happened if it matters. Put the message back in line so it still
          // goes in when the turn ends, exactly as if the button was never tapped.
          claimed = false;
          fate = 'queued';
          this.pending.set(seq, entryRef);
          log.warn(`[${channel.id}] send-now steer of task ${seq} into [${target.sessionId}] failed: ${(r.err || r.out || '').slice(0, 300)}`);
          return 'steer failed, left queued';
        }
        // The steered text becomes part of the running task's conversation, so
        // record it for the fallback context the same way a turn would be.
        if (this.config.agent?.context !== false) {
          history.append(channel.id, chatId, 'user', messageText, this.config.agent?.contextMaxChars ?? 2000);
        }
        // From here on the running task's output streams into a fresh bubble
        // below this message, not the one it started in further up.
        await target.rotate?.();
        return `steered into task ${target.seq} [${target.sessionId}]`;
      },
      cancel: async (why) => {
        if (!claim()) return;
        fate = 'dropped';
        this.pending.delete(seq);
        log.info(`[${channel.id}] queued task ${seq} cancelled: ${why}`);
        await this.dropNotice(channel, chatId, noticeId);
      },
    });
    const entryRef = this.pending.get(seq);
    // Take its place in line before anything is awaited, so messages sent in
    // quick succession keep their order.
    const queued = this.enqueue(chatId, queuedBody);

    // Still waiting its turn: the usual notice with its "send now" button. If
    // the turn came while the notice was going out, it goes again at once.
    if (!claimed && this.pending.has(seq)) {
      routed({ kind: 'queued', ahead: this.queuedAhead(chatId, seq) });
      noticeId = await channel.sendText(chatId, QUEUE_NOTICE, {
        buttons: [{ text: 'send now', data: `steer:${seq}` }],
        // What this message is (see the stall notice): a channel that cannot
        // show the button may say "queued" its own way, or not at all.
        notice: 'queued',
      }).catch(() => undefined);
      if (claimed) await this.dropNotice(channel, chatId, noticeId);
    } else {
      routed({ kind: fate === 'queued' ? 'started' : fate });
    }
    return queued;
  }

  async start(channelFilter) {
    let defs = this.config.channels;
    if (channelFilter) defs = defs.filter((c) => c.id === channelFilter || c.type === channelFilter);
    if (defs.length === 0) {
      log.err(channelFilter ? `No channel matching "${channelFilter}".` : 'No channels configured. Run: aside-remote channels add');
      return false;
    }

    // Channels shipped outside this package name themselves with a `module`
    // field; import them before anything is constructed. Failures in there are
    // logged and skipped, never fatal - that is the point of keeping a channel
    // with its own ports and external dependencies out of this process's
    // startup path.
    await loadExternalChannels(defs);

    log.step(`Starting bridge with ${defs.length} channel(s). Agent command: "${this.config.agent.command}". Ctrl-C to stop.`);
    const signal = this.controller.signal;
    // One unknown or unloadable channel must not stop the others from running.
    const built = [];
    for (const def of defs) {
      try {
        built.push(createChannel(def));
      } catch (e) {
        log.err(`Channel "${def.id || def.type}": ${e.message}. Starting without it.`);
      }
    }
    if (!built.length) {
      log.err('No channels could be started.');
      return false;
    }
    const runners = built.map((channel) => channel.start({
      signal,
      onMessage: (msg) => this.handleMessage(channel, msg),
      onAction: (act) => this.handleAction(channel, act),
      // The slash-command operations as plain calls (see controlFor).
      control: this.controlFor(channel),
    }));

    const stop = () => { log.info('\nStopping...'); this.controller.abort(); };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);

    await Promise.allSettled(runners);
    return true;
  }
}
