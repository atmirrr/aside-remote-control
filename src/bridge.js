// The bridge wires channels -> agent -> channels.
// Messages from one chat are processed in order (a per-chat queue) so the
// agent session stays consistent and tasks don't overlap.
import fs from 'node:fs';
import path from 'node:path';
import { Agent } from './agent.js';
import { createChannel } from './channels/index.js';
import { Channel } from './channels/base.js';
import { sessions, history, attachmentsDir, saveConfig } from './config.js';
import { transcribe, isTranscriptionConfigured, VOICE_SETUP_HINT } from './transcribe.js';
import { synthesizeVoice } from './voice.js';
import { log, findImagePaths, cleanTerminalOutput, chunkText, sleep, extractAnswer, splitSummary, formatBytes } from './util.js';

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
  '  /voice    toggle voice replies (spoken recaps) on/off',
  '  /status   show the current session id',
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
    this.controller = new AbortController();
  }

  enqueue(chatId, task) {
    const prev = this.queues.get(chatId) || Promise.resolve();
    const next = prev.then(task, task);
    this.queues.set(chatId, next.catch(() => {}));
    return next;
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

  // Button taps forwarded by channels that support inline actions. Same
  // authorization gate as messages: buttons only render in chats the bot posted
  // to, but the update's chat id is still checked before acting on it.
  async handleAction(channel, { chatId, messageId, data, from }) {
    if (!channel.isAuthorized(chatId)) {
      log.warn(`[${channel.id}] blocked action "${data}" from unauthorized chat ${chatId} (${from})`);
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
    }
  }

  // Voice mode: synthesize the recap with ElevenLabs and send it as a voice
  // note. voice:true implies summary mode (handleMessage requests the recap
  // whenever either is on). Returns true only once the voice message is
  // actually in the chat; every other path returns false so the caller falls
  // back to the text reply — voice can upgrade a reply, never lose one.
  async speakSummary(channel, chatId, summary) {
    const a = this.config.agent || {};
    if (a.voice !== true || !summary) return false;
    if (typeof channel.sendVoice !== 'function') return false;
    const apiKey = a.voiceApiKey || process.env.ELEVENLABS_API_KEY;
    if (!apiKey) {
      log.warn(`[${channel.id}] voice mode is on but no ElevenLabs key is set (agent.voiceApiKey or ELEVENLABS_API_KEY)`);
      return false;
    }
    // A recap this long isn't a voice note (and would burn TTS credits).
    if (summary.length > 4000) {
      log.warn(`[${channel.id}] recap too long to speak (${summary.length} chars); sending text instead`);
      return false;
    }
    try {
      const audio = await this.synthesize({ apiKey, voiceId: a.voiceId, modelId: a.voiceModelId, text: summary });
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
    if (cmd === '/voice') {
      const status = this.voiceStatus();
      return channel.sendText(chatId, status.text, { buttons: status.buttons });
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
        let prompt = useContext ? buildPrompt(history.get(channel.id, chatId), messageText) : messageText;
        // Summary mode: ask for a sentinel-delimited final reply at the end.
        // Appended to the prompt only — never stored in history, so it isn't
        // replayed as part of the conversation on the next turn. voice:true
        // implies summary mode: the voice note speaks the recap, so it has to
        // be requested — no need to also set summary:true.
        const summaryOn = this.config.agent?.summary === true || this.config.agent?.voice === true;
        const marker = summaryOn ? (this.config.agent?.summaryMarker || '<<<SUMMARY>>>') : null;
        if (summaryOn) {
          const instruction = (this.config.agent?.summaryPrompt || '').replace('{marker}', marker);
          if (instruction) prompt = `${prompt}\n\n${instruction}`;
        }

        // Live-edit state: accumulate raw output, push the latest tail on a timer.
        let acc = '';
        let editCount = 0;
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
        // Surface wrapper/agent stderr in the logs (it's kept out of the chat reply).
        if (res.error && res.errorDetail) log.warn(`[${channel.id}] agent exited ${res.code}; stderr: ${res.errorDetail.slice(0, 500)}`);
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
        // Summary mode: show the recap, keep the full answer for history. No
        // marker means the agent ignored the instruction — show the full answer.
        const split = splitSummary(finalText, marker);
        if (summaryOn && !split.summary) log.warn(`[${channel.id}] summary requested but the reply had no "${marker}" marker`);
        finalText = split.summary || split.body;
        const opts = verbose ? {} : { markdown: true };
        const parts = chunkText(finalText, 3900);
        // Voice mode: where summary mode would swap the transcript for the
        // recap text, deliver the recap as a spoken voice note instead. Tried
        // before any text lands, so a failure falls through with nothing lost.
        if (await this.speakSummary(channel, chatId, split.summary)) {
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
          log.info(`[${channel.id}] recap delivered as a voice note`);
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
        if (useContext) {
          history.append(channel.id, chatId, 'user', messageText, ctxMax);
          // The full answer, not the recap: follow-ups ("the second one") need
          // the detail that summary mode hides from the chat.
          const cleanAnswer = splitSummary(extractAnswer(res.raw || res.text || ''), marker).body;
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
        onAction: (act) => this.handleAction(channel, act),
      });
    });

    const stop = () => { log.info('\nStopping...'); this.controller.abort(); };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);

    await Promise.allSettled(runners);
    return true;
  }
}
