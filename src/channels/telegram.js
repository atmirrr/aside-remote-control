// Telegram channel: long-polling getUpdates, no webhook / public URL needed.
import fs from 'node:fs';
import path from 'node:path';
import { Channel } from './base.js';
import { httpsJson, httpsGetBuffer, multipartPost, sanitizeFilename, log, sleep, mdToTelegramHtml } from '../util.js';

const API = (token, method) => `https://api.telegram.org/bot${token}/${method}`;
const FILE_URL = (token, remotePath) => `https://api.telegram.org/file/bot${token}/${remotePath}`;

// Telegram's Bot API will not serve a download above 20 MB, whatever we ask for.
const MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024;
// An album (several photos sent at once) arrives as one update per file, tied
// together by media_group_id. Wait this long for the rest of the group before
// handing it over, so an album becomes one agent task instead of N.
const MEDIA_GROUP_WINDOW_MS = 1500;
// A forum topic is its own conversation inside one supergroup. The bridge keys
// session, queue, history and /stop by a single opaque chat id, so a topic is
// addressed as "<chat id>_t<topic id>": it gets its own session, and replies go
// back into that topic instead of landing in the group's General.
const TOPIC_SEP = '_t';

// Render the channel-agnostic [{ text, data }] button list as one row of
// Telegram inline keyboard buttons; taps arrive as callback_query updates.
const inlineKeyboard = (buttons) => ({
  inline_keyboard: [buttons.map((b) => ({ text: b.text, callback_data: b.data }))],
});

export class TelegramChannel extends Channel {
  static type = 'telegram';
  static label = 'Telegram';

  constructor(cfg) {
    super(cfg);
    this.token = cfg.token;
    this.offset = 0;
    this.mediaGroups = new Map(); // media_group_id -> { attachments, timer, ... }
    this.lastPollError = null;    // dedupes the poll-failure warning
  }

  async call(method, params = {}) {
    const res = await httpsJson(API(this.token, method), { method: 'POST', body: this.address(method, params), timeoutMs: 65000 });
    return res.data;
  }

  // ---------- chat addressing (groups, forum topics) ----------

  // The bridge's key for the conversation a message belongs to. Only genuine
  // topic messages get a topic suffix: a plain reply in a group also carries a
  // message_thread_id (its reply chain's root), which must not split the chat.
  chatKey(msg) {
    return msg.is_topic_message && msg.message_thread_id
      ? `${msg.chat.id}${TOPIC_SEP}${msg.message_thread_id}`
      : msg.chat.id;
  }

  chatOf(chatId) { return String(chatId).split(TOPIC_SEP)[0]; }

  // Turn a bridge chat key back into Telegram's addressing. Methods that post a
  // new message (send*) need the topic; edits and deletes name a message id
  // that is already unique within the chat, so they only need the chat.
  address(method, params) {
    const key = params?.chat_id;
    if (key == null || !String(key).includes(TOPIC_SEP)) return params;
    const [chat, thread] = String(key).split(TOPIC_SEP);
    const out = { ...params, chat_id: /^-?\d+$/.test(chat) ? Number(chat) : chat };
    if (method.startsWith('send') && thread) out.message_thread_id = Number(thread);
    return out;
  }

  // In a group, clients address commands as "/stop@ThisBot". Strip our own name
  // so the bridge's command matching sees "/stop". A command aimed at another
  // bot in the same group is not ours: null means skip the message.
  ownCommand(text) {
    const m = /^(\/\w+)@(\w+)(?=\s|$)/.exec(text);
    if (!m) return text;
    const me = String(this.cfg.botUsername || '').toLowerCase();
    if (me && m[2].toLowerCase() !== me) return null;
    return m[1] + text.slice(m[0].length);
  }

  // ---------- setup wizard ----------
  static async setup(io) {
    log.step('\nAdd a Telegram channel');
    log.dim('  Create a bot first: open @BotFather in Telegram, send /newbot, follow prompts.');
    const token = await io.askRequired('  Bot token (from @BotFather): ');

    // Verify the token.
    const me = await httpsJson(API(token, 'getMe'), { method: 'POST', body: {} });
    if (!me.data?.ok) {
      throw new Error(`Telegram rejected that token: ${me.data?.description || 'unknown error'}`);
    }
    const botName = me.data.result.username;
    log.ok(`  Verified bot @${botName}.`);

    const label = (await io.ask(`  Label for this channel [${botName}]: `)) || botName;

    // Authorize chats. Strongly recommended.
    let allowedChatIds = [];
    log.dim('\n  Restrict who can control your agent (recommended).');
    const auto = await io.confirm('  Auto-detect your chat id now (you send a message to the bot)?', true);
    if (auto) {
      log.info(`  Open Telegram, message @${botName} anything (e.g. "hi"). Waiting...`);
      const chatId = await TelegramChannel.waitForChatId(token, 90000, io);
      if (chatId) {
        allowedChatIds.push(String(chatId));
        log.ok(`  Captured chat id: ${chatId}`);
      } else {
        log.warn('  Timed out. You can add ids manually below.');
      }
    }
    const more = await io.ask('  Additional allowed chat ids (comma-separated, blank to skip): ');
    if (more) allowedChatIds.push(...more.split(',').map((s) => s.trim()).filter(Boolean));
    allowedChatIds = [...new Set(allowedChatIds)];

    if (allowedChatIds.length === 0) {
      const open = await io.confirm('  No chat ids set: ANYONE who finds the bot can control your browser. Continue open?', false);
      if (!open) throw new Error('Setup cancelled: no authorized chats.');
    }

    return {
      id: `telegram-${botName}`.toLowerCase(),
      type: 'telegram',
      label,
      token,
      botUsername: botName,
      allowedChatIds,
    };
  }

  // Poll once-ish until a human sends a message; return their chat id.
  static async waitForChatId(token, timeoutMs, io) {
    const deadline = Date.now() + timeoutMs;
    let offset = 0;
    // drain old updates first
    const first = await httpsJson(API(token, 'getUpdates'), { method: 'POST', body: { timeout: 0 } });
    if (first.data?.ok && first.data.result.length) {
      offset = first.data.result[first.data.result.length - 1].update_id + 1;
    }
    while (Date.now() < deadline) {
      const r = await httpsJson(API(token, 'getUpdates'), { method: 'POST', body: { offset, timeout: 20 } });
      if (r.data?.ok) {
        for (const u of r.data.result) {
          offset = u.update_id + 1;
          const chatId = u.message?.chat?.id ?? u.edited_message?.chat?.id;
          if (chatId) return chatId;
        }
      }
    }
    return null;
  }

  // ---------- runtime ----------
  async start({ onMessage, onAction, signal }) {
    // Skip backlog: only handle messages that arrive after start.
    try {
      const drain = await this.call('getUpdates', { timeout: 0 });
      if (drain?.ok && drain.result.length) {
        this.offset = drain.result[drain.result.length - 1].update_id + 1;
      }
    } catch { /* ignore */ }

    log.ok(`[${this.id}] listening as @${this.cfg.botUsername || '?'}`);
    let backoff = 1000;
    while (!signal.aborted) {
      try {
        const r = await this.call('getUpdates', { offset: this.offset, timeout: 30 });
        backoff = 1000;
        if (!r?.ok) {
          // Telegram hands each update to exactly one getUpdates caller, so a
          // second bridge on the same token starves this one. Retrying in
          // silence makes that look like "the bot just ignores me" — say it out
          // loud, but only when the reason changes, or it repeats every 2s.
          const why = r?.description || 'unknown error';
          if (why !== this.lastPollError) {
            log.warn(`[${this.id}] getUpdates rejected: ${why}`);
            if (/conflict/i.test(why)) {
              log.warn(`[${this.id}] another process is polling this bot token. Stop it, or updates will go to whichever instance wins the race.`);
            }
            this.lastPollError = why;
          }
          await sleep(2000);
          continue;
        }
        this.lastPollError = null;
        for (const u of r.result) {
          this.offset = u.update_id + 1;
          // Inline button tap. Ack right away so the client stops the button's
          // loading spinner, then forward to the bridge.
          if (u.callback_query) {
            const cb = u.callback_query;
            this.call('answerCallbackQuery', { callback_query_id: cb.id }).catch(() => {});
            if (onAction && cb.message) {
              await onAction({
                chatId: this.chatKey(cb.message),
                messageId: cb.message.message_id,
                data: cb.data || '',
                from: cb.from?.username || cb.from?.first_name || String(cb.from?.id || ''),
                fromId: cb.from?.id,
              });
            }
            continue;
          }
          const msg = u.message || u.edited_message;
          if (!msg) continue;
          // A file-bearing message carries its text in `caption`, not `text`.
          const text = this.ownCommand(msg.text || msg.caption || '');
          if (text === null) continue; // a command for some other bot in the group
          const attachments = this.attachmentsOf(msg);
          if (!text && !attachments.length) continue; // stickers, joins, pins, ...

          if (msg.media_group_id && attachments.length) {
            this.bufferAlbum(msg, text, attachments, onMessage);
            continue;
          }
          // Deliberately not awaited. The bridge already serializes tasks per
          // chat, and a task can run for half an hour - blocking here would stop
          // us reading further updates, so /stop could never be seen *while* the
          // task it is meant to abort is still running. Same fire-and-forget
          // shape bufferAlbum already uses.
          Promise.resolve(onMessage({
            chatId: this.chatKey(msg),
            text,
            attachments,
            messageId: msg.message_id,
            from: msg.from?.username || msg.from?.first_name || String(msg.from?.id || ''),
            fromId: msg.from?.id,
          })).catch((e) => log.warn(`[${this.id}] message failed: ${e.message}`));
        }
      } catch (e) {
        if (signal.aborted) break;
        log.warn(`[${this.id}] poll error: ${e.message} (retry in ${backoff}ms)`);
        await sleep(backoff);
        backoff = Math.min(backoff * 2, 30000);
      }
    }
    // Drop any album still waiting for its remaining parts.
    for (const g of this.mediaGroups.values()) clearTimeout(g.timer);
    this.mediaGroups.clear();
  }

  // Collect the parts of one album, then emit them as a single message. Only one
  // part of an album carries the caption, so keep the first one we see.
  bufferAlbum(msg, text, attachments, onMessage) {
    const id = msg.media_group_id;
    const group = this.mediaGroups.get(id) || {
      chatId: this.chatKey(msg),
      messageId: msg.message_id,
      from: msg.from?.username || msg.from?.first_name || String(msg.from?.id || ''),
      fromId: msg.from?.id,
      text: '',
      attachments: [],
      timer: null,
    };
    group.attachments.push(...attachments);
    if (!group.text && text) group.text = text;
    clearTimeout(group.timer);
    group.timer = setTimeout(() => {
      this.mediaGroups.delete(id);
      const { timer, ...message } = group;
      // Fired from a timer, outside the poll loop's try/catch: swallow failures
      // here or an album error would become an unhandled rejection.
      Promise.resolve(onMessage(message)).catch((e) => log.warn(`[${this.id}] album failed: ${e.message}`));
    }, MEDIA_GROUP_WINDOW_MS);
    this.mediaGroups.set(id, group);
  }

  // Describe a message's files as channel-neutral attachment specs. Nothing is
  // fetched here: download() is called by the bridge only after the chat clears
  // authorization, so an unauthorized sender can never make us pull bytes.
  attachmentsOf(msg) {
    const specs = [];
    const push = (kind, file, extra = {}) => {
      if (file) specs.push({ kind, fileId: file.file_id, size: file.file_size, mimeType: file.mime_type, ...extra });
    };
    push('voice', msg.voice, { name: 'voice', mimeType: msg.voice?.mime_type || 'audio/ogg', durationSec: msg.voice?.duration });
    push('video_note', msg.video_note, { name: 'video-note', mimeType: 'video/mp4', durationSec: msg.video_note?.duration });
    push('audio', msg.audio, { name: msg.audio?.file_name || msg.audio?.title || 'audio', durationSec: msg.audio?.duration });
    if (msg.photo?.length) {
      // `photo` is the same image at several resolutions, ascending. Take the best.
      const largest = msg.photo[msg.photo.length - 1];
      specs.push({ kind: 'photo', fileId: largest.file_id, size: largest.file_size, mimeType: 'image/jpeg', name: 'photo.jpg' });
    }
    push('document', msg.document, { name: msg.document?.file_name || 'document' });
    push('video', msg.video, { name: msg.video?.file_name || 'video.mp4', durationSec: msg.video?.duration });
    return specs.map((spec) => ({ ...spec, download: (dir, prefix) => this.downloadFile(spec, dir, prefix) }));
  }

  // Resolve a file_id to bytes and write them under destDir. Returns the path.
  async downloadFile(spec, destDir, prefix = '') {
    const r = await this.call('getFile', { file_id: spec.fileId });
    if (!r?.ok) throw new Error(r?.description || 'Telegram would not hand over that file');
    const remote = r.result.file_path; // e.g. "voice/file_12.oga"
    const buf = await httpsGetBuffer(FILE_URL(this.token, remote), { maxBytes: MAX_DOWNLOAD_BYTES });

    // Telegram resolves an extension even when the client sent no usable name,
    // and both the agent's file tools and the transcriber key off it.
    let name = sanitizeFilename(spec.name || spec.kind, spec.kind);
    const ext = path.extname(remote);
    if (ext && !path.extname(name)) name += ext;

    fs.mkdirSync(destDir, { recursive: true, mode: 0o700 });
    const dest = path.join(destDir, prefix ? `${sanitizeFilename(prefix, 'msg')}-${name}` : name);
    fs.writeFileSync(dest, buf, { mode: 0o600 });
    return dest;
  }

  async sendTyping(chatId) {
    try { await this.call('sendChatAction', { chat_id: chatId, action: 'typing' }); } catch {}
  }

  async sendText(chatId, text, opts = {}) {
    // Telegram hard limit is 4096 chars; chunk conservatively.
    const parts = [];
    const size = 3900;
    if (text.length <= size) parts.push(text);
    else for (let i = 0; i < text.length; i += size) parts.push(text.slice(i, i + size));
    let lastId;
    for (const part of parts) lastId = (await this.sendOne(chatId, part, opts)) ?? lastId;
    return lastId; // id of the last message sent, so callers can edit it
  }

  // One sendMessage. With { markdown: true } the text is rendered to Telegram
  // HTML; if Telegram rejects the markup it is retried as plain text.
  async sendOne(chatId, text, { markdown, buttons } = {}) {
    const base = { chat_id: chatId, text, disable_web_page_preview: true };
    if (buttons?.length) base.reply_markup = inlineKeyboard(buttons);
    if (markdown) {
      const r = await this.call('sendMessage', { ...base, text: mdToTelegramHtml(text), parse_mode: 'HTML' });
      if (r?.ok) return r.result?.message_id;
    }
    const r = await this.call('sendMessage', base);
    return r?.result?.message_id;
  }

  // Edit a message in place (used for streaming). Telegram rejects empty and
  // unchanged text, so the bridge only calls this with new, non-empty text.
  // { markdown: true } renders HTML with a plain-text fallback.
  async editText(chatId, messageId, text, { markdown, buttons } = {}) {
    const plain = { chat_id: chatId, message_id: messageId, text: text.slice(0, 4096), disable_web_page_preview: true };
    if (buttons?.length) plain.reply_markup = inlineKeyboard(buttons);
    try {
      if (markdown) {
        const r = await this.call('editMessageText', { ...plain, text: mdToTelegramHtml(plain.text), parse_mode: 'HTML' });
        if (r?.ok) return true;
      }
      const r = await this.call('editMessageText', plain);
      return r?.ok === true;
    } catch {
      return false;
    }
  }

  // Single seam for multipart uploads, so tests can capture what would be
  // posted without touching the network.
  postMultipart(method, fields, files) {
    return multipartPost(API(this.token, method), { fields: this.address(method, fields), files });
  }

  // Voice note: a playable voice bubble. Telegram's sendVoice accepts OGG/Opus,
  // MP3, or M4A; ElevenLabs returns MP3, so the buffer is sent as-is.
  async sendVoice(chatId, buffer, caption = '') {
    if (!buffer || buffer.length === 0) return false;
    const res = await this.postMultipart('sendVoice', {
      chat_id: String(chatId),
      ...(caption ? { caption: caption.slice(0, 1000) } : {}),
    }, [{ field: 'voice', filename: 'summary.mp3', buffer, contentType: 'audio/mpeg' }]);
    return res?.data?.ok === true;
  }

  // Remove a sent message (voice mode deletes the streamed transcript once the
  // voice note is out). Returns false when Telegram refuses so callers can
  // fall back to editing the text in place.
  async deleteMessage(chatId, messageId) {
    try {
      const r = await this.call('deleteMessage', { chat_id: chatId, message_id: messageId });
      return r?.ok === true;
    } catch { return false; }
  }

  async sendImage(chatId, filePath, caption = '') {
    if (!fs.existsSync(filePath)) return false;
    await this.postMultipart('sendPhoto',
      { chat_id: String(chatId), ...(caption ? { caption: caption.slice(0, 1000) } : {}) },
      [{ field: 'photo', filename: path.basename(filePath), buffer: fs.readFileSync(filePath) }]);
    return true;
  }

  // Album: one sendMediaGroup instead of N separate photos, so the client shows
  // a single grouped attachment. Telegram allows 2-10 items per group, so we
  // batch in tens; a lone image falls back to sendPhoto (a 1-item group errors).
  // The caption belongs to the first item — that renders as the album caption.
  async sendImages(chatId, filePaths, caption = '') {
    const files = filePaths.filter((p) => fs.existsSync(p));
    if (files.length === 0) return false;
    if (files.length === 1) return this.sendImage(chatId, files[0], caption);

    for (let i = 0; i < files.length; i += 10) {
      const batch = files.slice(i, i + 10);
      // A trailing batch of exactly one can't be a group; send it on its own.
      if (batch.length === 1) { await this.sendImage(chatId, batch[0]); continue; }
      const parts = batch.map((p, n) => ({ field: `f${n}`, filename: path.basename(p), buffer: fs.readFileSync(p) }));
      const media = parts.map((part, n) => ({
        type: 'photo',
        media: `attach://${part.field}`,
        ...(i === 0 && n === 0 && caption ? { caption: caption.slice(0, 1000) } : {}),
      }));
      await this.postMultipart('sendMediaGroup', { chat_id: String(chatId), media: JSON.stringify(media) }, parts);
    }
    return true;
  }
}
