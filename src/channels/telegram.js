// Telegram channel: long-polling getUpdates, no webhook / public URL needed.
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { Channel } from './base.js';
import { httpsJson, log, sleep, mdToTelegramHtml } from '../util.js';

const API = (token, method) => `https://api.telegram.org/bot${token}/${method}`;

export class TelegramChannel extends Channel {
  static type = 'telegram';
  static label = 'Telegram';

  constructor(cfg) {
    super(cfg);
    this.token = cfg.token;
    this.offset = 0;
  }

  async call(method, params = {}) {
    const res = await httpsJson(API(this.token, method), { method: 'POST', body: params, timeoutMs: 65000 });
    return res.data;
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
  async start({ onMessage, signal }) {
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
        if (!r?.ok) { await sleep(2000); continue; }
        for (const u of r.result) {
          this.offset = u.update_id + 1;
          const msg = u.message || u.edited_message;
          const text = msg?.text;
          if (!msg || !text) continue;
          await onMessage({
            chatId: msg.chat.id,
            text,
            messageId: msg.message_id,
            from: msg.from?.username || msg.from?.first_name || String(msg.from?.id || ''),
          });
        }
      } catch (e) {
        if (signal.aborted) break;
        log.warn(`[${this.id}] poll error: ${e.message} (retry in ${backoff}ms)`);
        await sleep(backoff);
        backoff = Math.min(backoff * 2, 30000);
      }
    }
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
  async sendOne(chatId, text, { markdown } = {}) {
    const base = { chat_id: chatId, text, disable_web_page_preview: true };
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
  async editText(chatId, messageId, text, { markdown } = {}) {
    const plain = { chat_id: chatId, message_id: messageId, text: text.slice(0, 4096), disable_web_page_preview: true };
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

  async sendImage(chatId, filePath, caption = '') {
    if (!fs.existsSync(filePath)) return false;
    const buf = fs.readFileSync(filePath);
    const filename = path.basename(filePath);
    await this.multipartPhoto(chatId, buf, filename, caption);
    return true;
  }

  // Minimal multipart/form-data POST for sendPhoto (no deps).
  multipartPhoto(chatId, buffer, filename, caption) {
    return new Promise((resolve, reject) => {
      const boundary = `----asideremote${Date.now().toString(16)}`;
      const pre = [];
      const field = (name, value) =>
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`;
      pre.push(field('chat_id', String(chatId)));
      if (caption) pre.push(field('caption', caption.slice(0, 1000)));
      pre.push(
        `--${boundary}\r\nContent-Disposition: form-data; name="photo"; filename="${filename}"\r\n` +
        `Content-Type: application/octet-stream\r\n\r\n`
      );
      const head = Buffer.from(pre.join(''), 'utf8');
      const tail = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
      const body = Buffer.concat([head, buffer, tail]);

      const req = https.request(API(this.token, 'sendPhoto'), {
        method: 'POST',
        headers: {
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': body.length,
        },
      }, (res) => {
        const chunks = [];
        res.on('data', (d) => chunks.push(d));
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      });
      req.on('error', reject);
      req.write(body);
      req.end();
    });
  }
}
