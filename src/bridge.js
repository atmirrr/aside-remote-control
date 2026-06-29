// The bridge wires channels -> agent -> channels.
// Messages from one chat are processed in order (a per-chat queue) so the
// agent session stays consistent and tasks don't overlap.
import { Agent } from './agent.js';
import { createChannel } from './channels/index.js';
import { Channel } from './channels/base.js';
import { sessions, history } from './config.js';
import { log, findImagePaths, cleanTerminalOutput, chunkText, sleep, extractAnswer } from './util.js';

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

const HELP = [
  'Aside Remote Control',
  '',
  'Just send a message and I will run it as a task in the Aside browser.',
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
    this.queues = new Map(); // chatId -> Promise chain
    this.controller = new AbortController();
  }

  enqueue(chatId, task) {
    const prev = this.queues.get(chatId) || Promise.resolve();
    const next = prev.then(task, task);
    this.queues.set(chatId, next.catch(() => {}));
    return next;
  }

  async handleMessage(channel, { chatId, text, from }) {
    if (!channel.isAuthorized(chatId)) {
      log.warn(`[${channel.id}] blocked unauthorized chat ${chatId} (${from})`);
      await channel.sendText(chatId, `Not authorized. Your chat id is ${chatId}. Ask the operator to allow it.`);
      return;
    }

    const cmd = text.trim().toLowerCase();
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
      const sid = sessions.get(channel.id, chatId);
      const started = Date.now();
      log.info(`[${channel.id}] (${from}) task${sid ? ` [${sid}]` : ' [new]'}: ${text.slice(0, 120)}`);
      await channel.sendTyping(chatId);

      // Stream by editing one message in place, when the channel supports it.
      const wantStream = this.config.agent?.stream !== false
        && typeof channel.editText === 'function'
        && channel.editText !== Channel.prototype.editText;
      const throttle = this.config.agent?.streamThrottleMs ?? 1800;
      const placeholder = '🧠 Thinking...';
      const msgId = await channel.sendText(chatId, placeholder).catch(() => undefined);
      const streaming = wantStream && msgId != null;

      const verbose = this.config.agent?.verbose === true;
      // Conversation continuity: prepend recent turns as context (client-side).
      const useContext = this.config.agent?.context !== false;
      const ctxMax = this.config.agent?.contextMaxChars ?? 2000;
      const prompt = useContext ? buildPrompt(history.get(channel.id, chatId), text) : text;
      const keepTyping = setInterval(() => channel.sendTyping(chatId).catch(() => {}), 6000);

      // Live-edit state: accumulate raw output, push the latest tail on a timer.
      let acc = '';
      let lastShown = placeholder;
      let flushTimer = null;
      let editing = false;
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

      try {
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
        if (!verbose) {
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
        // Remember this exchange (the clean answer, not the raw transcript) so
        // the next message can resolve follow-up references.
        if (useContext) {
          history.append(channel.id, chatId, 'user', text, ctxMax);
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
