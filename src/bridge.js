// The bridge wires channels -> agent -> channels.
// Messages from one chat are processed in order (a per-chat queue) so the
// agent session stays consistent and tasks don't overlap.
import fs from 'node:fs';
import path from 'node:path';
import { Agent } from './agent.js';
import { createChannel } from './channels/index.js';
import { Channel } from './channels/base.js';
import { sessions, history, attachmentsDir, settings } from './config.js';
import { parseCommand, listCommands } from './chat-commands.js';
import { transcribe, isTranscriptionConfigured, VOICE_SETUP_HINT } from './transcribe.js';
import { log, findImagePaths, cleanTerminalOutput, chunkText, sleep, extractAnswer, formatBytes } from './util.js';

// Flatten recent turns into the single prompt string the CLI accepts, so
// follow-ups keep context. The Aside CLI has no structured messages array (the
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

export class Bridge {
  constructor(config) {
    this.config = config;
    this.agent = new Agent(config.agent);
    this.transcribe = transcribe; // swappable for tests
    // Control plane: a global FIFO of submitted tasks plus the running set,
    // keyed channelId:chatId. maxConcurrent caps parallel agent processes;
    // maxQueuePerChat caps one chat's backlog.
    this.queue = [];
    this.running = new Map();
    this.active = 0;
    this.lastTasks = new Map(); // chatKey -> last composed task (for /retry)
    this.controller = new AbortController();
  }

  // Roles: an empty/absent admins list means every authorized sender is admin
  // (I8, preserves v0.1.0 behaviour).
  isAdmin(userId) {
    const admins = this.config.roles?.admins || [];
    return admins.length === 0 || admins.map(String).includes(String(userId));
  }

  // Effective per-chat option: chat setting -> agent.defaults -> unset.
  effectiveSetting(channel, chatId, field) {
    const chat = settings.get(this.chatKey(channel, chatId)) || {};
    const defs = this.config.agent?.defaults || {};
    if (chat[field] !== undefined) return chat[field];
    if (defs[field] !== undefined && defs[field] !== null) return defs[field];
    return null;
  }

  chatKey(channel, chatId) {
    return `${channel.id}:${chatId}`;
  }

  // Submit a task. Runs immediately when the chat is idle and capacity allows,
  // otherwise queues it (replying ⏳ Queued (#n)) or refuses when the per-chat
  // backlog is full. The returned promise resolves when the task has finished
  // (or was dropped).
  submitTask(channel, msg) {
    const key = this.chatKey(channel, msg.chatId);
    const cap = this.config.agent?.maxQueuePerChat ?? 5;
    const pending = this.queue.filter((i) => i.key === key).length;
    if (pending >= cap) {
      return channel.sendText(msg.chatId, `Queue is full (${cap}). /cancel to clear.`);
    }
    return new Promise((resolve) => {
      const item = {
        key, channel, msg, resolve, queuedAt: Date.now(),
        abortController: new AbortController(), startedAt: null, promise: null,
      };
      this.queue.push(item);
      if (this.running.has(key) || this.active >= (this.config.agent?.maxConcurrent ?? 1)) {
        channel.sendText(msg.chatId, `⏳ Queued (#${this.queue.length})`).catch(() => {});
      }
      this.pump();
    });
  }

  // Start as many queued tasks as the global cap allows, FIFO across chats
  // (skipping tasks whose chat already has one running, so per-chat order is
  // preserved).
  pump() {
    const cap = this.config.agent?.maxConcurrent ?? 1;
    while (this.active < cap && this.queue.length) {
      const idx = this.queue.findIndex((i) => !this.running.has(i.key));
      if (idx === -1) break;
      const item = this.queue.splice(idx, 1)[0];
      this.active += 1;
      this.running.set(item.key, item);
      item.startedAt = Date.now();
      item.promise = this.runTaskBody(item).finally(() => {
        this.active -= 1;
        this.running.delete(item.key);
        item.resolve();
        this.pump();
      });
    }
  }

  dropQueued(key) {
    const dropped = this.queue.filter((i) => i.key === key);
    for (const it of dropped) it.resolve();
    this.queue = this.queue.filter((i) => i.key !== key);
    return dropped.length;
  }

  queuedFor(key) {
    return this.queue.filter((i) => i.key === key);
  }

  // Abort this chat's running task and drop its pending queue.
  cancelChat(key) {
    const r = this.running.get(key);
    const dropped = this.dropQueued(key);
    if (r) r.abortController.abort();
    return { hadRunning: !!r, dropped, startedAt: r?.startedAt ?? null };
  }

  // Shutdown: stop channels and abort every running task (group kill).
  abortAll() {
    this.controller.abort();
    for (const item of this.running.values()) item.abortController.abort();
  }

  // Build the command context and run a registry command. Command failures
  // become a chat reply, never a bridge crash. admin-flagged commands are
  // gated on the sender's role (empty admins list -> everyone is admin, I8).
  async runCommand(channel, { chatId, userId, from, messageId, chatType }, cmd, args) {
    const role = this.isAdmin(userId) ? 'admin' : 'user';
    if (cmd.admin && role !== 'admin') {
      return channel.sendText(chatId, 'Admins only.');
    }
    const ctx = {
      bridge: this,
      channel,
      chatId,
      userId: userId ?? null,
      from,
      role,
      chatType: chatType ?? 'private',
      reply: (text, opts) => channel.sendText(chatId, text, opts),
    };
    try {
      return await cmd.run(ctx, args);
    } catch (e) {
      log.warn(`[${channel.id}] command /${cmd.name} failed: ${e.message}`);
      return channel.sendText(chatId, `Command /${cmd.name} failed: ${e.message}`);
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

  async handleMessage(channel, { chatId, text = '', attachments = [], messageId, from, userId, chatType }) {
    if (!channel.isAuthorized(chatId, userId)) {
      log.warn(`[${channel.id}] blocked unauthorized chat ${chatId} (${from})`);
      await channel.sendText(chatId, `Not authorized. Your chat id is ${chatId}. Ask the operator to allow it.`);
      return;
    }

    // Commands are typed, never captioned onto a file. Unknown /word keeps
    // running as an agent task (I8).
    const parsed = attachments.length ? null : parseCommand(text, { botUsername: channel.botUsername });
    if (parsed?.ignore) return; // aimed at a different bot in a group
    if (parsed) return this.runCommand(channel, { chatId, userId, from, messageId, chatType }, parsed.cmd, parsed.args);

    // Real task -> run in order for this chat.
    return this.submitTask(channel, { chatId, text, attachments, messageId, from });
  }

  // Run one queued task end-to-end: attachments, agent, streaming, history.
  // The item's abortController.signal cancels the agent (group kill).
  async runTaskBody(item) {
    const { channel, msg, abortController } = item;
    const { chatId, text = '', attachments = [], messageId, from } = msg;
    const started = item.startedAt;
      await channel.sendTyping(chatId);
      // Downloading and transcribing happen before the agent starts, and can take
      // a few seconds, so keep the indicator alive from here rather than later.
      const keepTyping = setInterval(() => channel.sendTyping(chatId).catch(() => {}), 6000);

      // Declared up front so the catch/finally below can always reach them,
      // whatever stage the task got to.
      let msgId;
      let streaming = false;
      let flushTimer = null;
      let lastShown = '';
      let editing = false;

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
        const messageText = composeMessage(text, transcript, files);

        const sid = sessions.get(channel.id, chatId);
        log.info(`[${channel.id}] (${from}) task${sid ? ` [${sid}]` : ' [new]'}: ${messageText.slice(0, 120)}`);

        // Stream by editing one message in place, when the channel supports it.
        const wantStream = this.config.agent?.stream !== false
          && typeof channel.editText === 'function'
          && channel.editText !== Channel.prototype.editText;
        const throttle = this.config.agent?.streamThrottleMs ?? 1800;
        const placeholder = '🧠 Thinking...';
        msgId = await channel.sendText(chatId, placeholder).catch(() => undefined);
        streaming = wantStream && msgId != null;
        lastShown = placeholder;

        // Effective per-chat options: chat setting -> agent.defaults -> unset.
        const verbose = this.effectiveSetting(channel, chatId, 'verbose') ?? this.config.agent?.verbose === true;
        const agentOpts = {
          model: this.effectiveSetting(channel, chatId, 'model'),
          speed: this.effectiveSetting(channel, chatId, 'speed'),
          effort: this.effectiveSetting(channel, chatId, 'effort'),
          permission: this.effectiveSetting(channel, chatId, 'permission'),
        };
        // Conversation continuity: prepend recent turns as context (client-side).
        const useContext = this.config.agent?.context !== false;
        const ctxMax = this.config.agent?.contextMaxChars ?? 2000;
        const prompt = useContext ? buildPrompt(history.get(channel.id, chatId), messageText) : messageText;
        // Remember the composed task so /retry can re-run it.
        this.lastTasks.set(item.key, { text: messageText, attachments });

        // Live-edit state: accumulate raw output, push the latest tail on a timer.
        let acc = '';
        let editCount = 0;
        // Progress view: the raw transcript tail when verbose, else the cleaned
        // answer-so-far (which stays empty while the agent is doing tool work).
        const renderPartial = () => {
          const view = verbose ? cleanTerminalOutput(acc) : extractAnswer(acc);
          return view.slice(-3500).trim();
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
          if (flushTimer) return;
          flushTimer = setTimeout(() => { flushTimer = null; pushEdit(); }, throttle);
        } : undefined;

        let res = await this.agent.run({ prompt, sessionId: sid, onData, signal: abortController.signal, opts: agentOpts });
        // Self-heal: if the stored session id was rejected (expired/unknown/bad),
        // forget it and retry once as a fresh session instead of failing forever.
        if (!res.cancelled && res.sessionMissing && sid) {
          log.warn(`[${channel.id}] session "${sid}" was rejected; starting a fresh one and retrying`);
          sessions.clear(channel.id, chatId);
          acc = '';
          res = await this.agent.run({ prompt, sessionId: null, onData, signal: abortController.signal, opts: agentOpts });
        }
        const secs = ((Date.now() - started) / 1000).toFixed(1);
        log.info(`[${channel.id}] task finished in ${secs}s (exit=${res.code}, ${String(res.text || '').length} chars)`);
        if (!res.cancelled && res.sessionId && res.sessionId !== sid) sessions.set(channel.id, chatId, res.sessionId);

        if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
        // Default: show just the answer (strip the Thinking/tool transcript) and
        // render its markdown. verbose: forward the raw transcript as plain text.
        let finalText = res.text || '(no output)';
        if (res.cancelled) {
          // Cancelled: replace the placeholder with the marker (streaming) or
          // send it as the final message. No history, no session, no images.
          const marker = '🛑 Cancelled.';
          if (streaming) {
            while (editing) await sleep(20);
            try { await channel.editText(chatId, msgId, marker); editCount++; }
            catch { await channel.sendText(chatId, marker); }
          } else {
            await channel.sendText(chatId, marker);
          }
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
          const answer = extractAnswer(res.raw || finalText);
          // Coverage signal: empty means no user-facing answer was found (or a
          // format slipped past the filter). Log it so odd cases surface.
          if (!answer) log.warn(`[${channel.id}] no answer extracted from ${String(res.text || '').length}-char transcript`);
          finalText = answer || '(No answer produced — the task may have stopped early or needed an approval.)';
        }
        if (!res.cancelled) {
          const opts = verbose ? {} : { markdown: true };
          const parts = chunkText(finalText, 3900);
          if (streaming) {
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
          if (useContext) {
            history.append(channel.id, chatId, 'user', messageText, ctxMax);
            const cleanAnswer = extractAnswer(res.raw || res.text || '');
            if (cleanAnswer) history.append(channel.id, chatId, 'assistant', cleanAnswer, ctxMax);
          }
          // Best-effort: attach any image artifacts the agent referenced.
          for (const img of findImagePaths(res.text)) {
            try { await channel.sendImage(chatId, img.replace(/^~(?=\/)/, process.env.HOME || '~')); } catch {}
          }
        }
      } catch (e) {
        const msg = `Error running task: ${e.message}`;
        if (streaming) { try { await channel.editText(chatId, msgId, msg); } catch { await channel.sendText(chatId, msg); } }
        else await channel.sendText(chatId, msg);
      } finally {
        if (flushTimer) clearTimeout(flushTimer);
        clearInterval(keepTyping);
      }
  }

  async start(channelFilter) {
    let defs = this.config.channels;
    if (channelFilter) defs = defs.filter((c) => c.id === channelFilter || c.type === channelFilter);
    if (defs.length === 0) {
      log.err(channelFilter ? `No channel matching "${channelFilter}".` : 'No channels configured. Run: aside-remote channels add');
      return false;
    }

    log.step(`Starting bridge with ${defs.length} channel(s). Agent command: "${this.config.agent.command}". Ctrl-C to stop.`);
    const signal = this.controller.signal;
    const runners = defs.map((def) => {
      const channel = createChannel(def);
      const commandsCfg = this.config.commands || {};
      // Fire-and-forget: registerCommands logs its own failures and must never
      // prevent the poll loop from starting.
      channel.registerCommands(listCommands(), {
        menu: commandsCfg.menu !== false,
        hidden: commandsCfg.hidden || [],
      });
      return channel.start({
        signal,
        // Never return the task promise here: the poll loop must keep reading
        // updates while a task runs, or /cancel and friends would starve.
        onMessage: (msg) => {
          this.handleMessage(channel, msg).catch((e) => log.warn(`[${channel.id}] message failed: ${e.message}`));
        },
      });
    });

    let stopping = false;
    const stop = () => {
      if (stopping) process.exit(0); // second signal: exit immediately
      stopping = true;
      log.info('\nStopping...');
      this.abortAll();
      const taskSettled = [...this.running.values()].map((i) => i.promise).filter(Boolean);
      // Give channel loops and in-flight tasks up to 5 s to settle, then exit 0.
      Promise.race([
        Promise.allSettled([...runners, ...taskSettled]),
        sleep(5000),
      ]).then(() => process.exit(0));
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);

    await Promise.allSettled(runners);
    return true;
  }
}
