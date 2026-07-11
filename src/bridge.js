// The bridge wires channels -> agent -> channels.
// Messages from one chat are processed in order (a per-chat queue) so the
// agent session stays consistent and tasks don't overlap.
import fs from 'node:fs';
import path from 'node:path';
import { Agent } from './agent.js';
import { createChannel } from './channels/index.js';
import { Channel } from './channels/base.js';
import { sessions, history, attachmentsDir } from './config.js';
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

const HELP = [
  'Aside Remote Control',
  '',
  'Just send a message and I will run it as a task in the Aside browser.',
  'Send a voice note and I will transcribe it first. Attach photos or files and',
  'I will hand them to the agent.',
  '',
  'Commands:',
  '  /new      start a fresh agent session (forget context)',
  '  /status   show the current session id',
  '  /whoami   show your chat id',
  '  /help     show this help',
].join('\n');

export class Bridge {
  constructor(config) {
    this.config = config;
    this.agent = new Agent(config.agent);
    this.transcribe = transcribe; // swappable for tests
    this.queues = new Map(); // chatId -> Promise chain
    this.controller = new AbortController();
  }

  enqueue(chatId, task) {
    const prev = this.queues.get(chatId) || Promise.resolve();
    const next = prev.then(task, task);
    this.queues.set(chatId, next.catch(() => {}));
    return next;
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

  async handleMessage(channel, { chatId, text = '', attachments = [], messageId, from }) {
    if (!channel.isAuthorized(chatId)) {
      log.warn(`[${channel.id}] blocked unauthorized chat ${chatId} (${from})`);
      await channel.sendText(chatId, `Not authorized. Your chat id is ${chatId}. Ask the operator to allow it.`);
      return;
    }

    // Commands are typed, never captioned onto a file.
    const cmd = attachments.length ? '' : text.trim().toLowerCase();
    if (cmd === '/help' || cmd === '/start') return channel.sendText(chatId, HELP);
    if (cmd === '/whoami') return channel.sendText(chatId, `chat id: ${chatId}\nusername: ${from}`);
    if (cmd === '/status') {
      const sid = sessions.get(channel.id, chatId);
      return channel.sendText(chatId, sid ? `Active session: ${sid}` : 'No active session yet. Send a task to start one.');
    }
    if (cmd === '/new') {
      sessions.clear(channel.id, chatId);
      history.clear(channel.id, chatId);
      return channel.sendText(chatId, 'Started a fresh session. Send your task.');
    }

    // Real task -> run in order for this chat.
    return this.enqueue(chatId, async () => {
      const started = Date.now();
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

        const verbose = this.config.agent?.verbose === true;
        // Conversation continuity: prepend recent turns as context (client-side).
        const useContext = this.config.agent?.context !== false;
        const ctxMax = this.config.agent?.contextMaxChars ?? 2000;
        const prompt = useContext ? buildPrompt(history.get(channel.id, chatId), messageText) : messageText;

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

        let res = await this.agent.run({ prompt, sessionId: sid, onData });
        // Self-heal: if the stored session id was rejected (expired/unknown/bad),
        // forget it and retry once as a fresh session instead of failing forever.
        if (res.sessionMissing && sid) {
          log.warn(`[${channel.id}] session "${sid}" was rejected; starting a fresh one and retrying`);
          sessions.clear(channel.id, chatId);
          acc = '';
          res = await this.agent.run({ prompt, sessionId: null, onData });
        }
        const secs = ((Date.now() - started) / 1000).toFixed(1);
        log.info(`[${channel.id}] task finished in ${secs}s (exit=${res.code}, ${String(res.text || '').length} chars)`);
        if (res.sessionId && res.sessionId !== sid) sessions.set(channel.id, chatId, res.sessionId);

        if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
        // Default: show just the answer (strip the Thinking/tool transcript) and
        // render its markdown. verbose: forward the raw transcript as plain text.
        let finalText = res.text || '(no output)';
        if (res.stalled || res.code < 0) {
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
      } catch (e) {
        const msg = `Error running task: ${e.message}`;
        if (streaming) { try { await channel.editText(chatId, msgId, msg); } catch { await channel.sendText(chatId, msg); } }
        else await channel.sendText(chatId, msg);
      } finally {
        if (flushTimer) clearTimeout(flushTimer);
        clearInterval(keepTyping);
      }
    });
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
      return channel.start({
        signal,
        onMessage: (msg) => this.handleMessage(channel, msg),
      });
    });

    const stop = () => { log.info('\nStopping...'); this.controller.abort(); };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);

    await Promise.allSettled(runners);
    return true;
  }
}
