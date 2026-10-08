// Channel interface. Implement one subclass per chat platform.
// Adding a new platform later = drop a file in this folder and register it
// in ./index.js. Nothing else in the codebase needs to change.
export class Channel {
  static type = 'base';
  static label = 'Base';

  // Interactive setup wizard. Receives the shared IO helper and must return a
  // plain serializable config object: { id, type, label, ...platformFields }.
  static async setup(/* io */) {
    throw new Error('setup() not implemented');
  }

  constructor(cfg) {
    this.cfg = cfg;
    this.id = cfg.id;
    this.label = cfg.label || cfg.id;
  }

  // Chat channels get a "Thinking..." placeholder that is later edited into
  // the final reply. Voice channels speak every message aloud, so a spoken
  // placeholder is pure noise — they return false and receive only the final
  // reply as a single sendText.
  get wantsPlaceholder() { return true; }

  // Chat channels can show a full answer and let the reader skim it, so the
  // recap is optional there. A voice channel has no scrollback - whatever is
  // not spoken is lost - so it always needs one, regardless of agent.summary.
  get forcesSummary() { return false; }

  // Optional per-channel replacement for agent.summaryPrompt, for when the
  // house style genuinely differs (a speaker wants three spoken sentences,
  // not a chat post). Use {marker} for the sentinel line.
  get summaryPrompt() { return null; }

  // The chat an allowlist entry names. A channel that addresses conversations
  // inside one chat (Telegram forum topics) overrides this to drop the suffix.
  chatOf(chatId) { return String(chatId); }

  // True if a given chat is allowed to drive the agent.
  isAuthorized(chatId) {
    const allow = this.cfg.allowedChatIds;
    if (!allow || allow.length === 0) return true; // open mode (not recommended)
    return allow.map(String).includes(this.chatOf(chatId));
  }

  // Within an allowed chat, may this person drive the agent? Only matters for a
  // shared chat (a group): with allowedUserIds set, everyone not listed is
  // ignored. Unset keeps the old rule (anyone in an allowed chat). A private
  // chat is its own single person, so it always passes.
  isAllowedSender(chatId, fromId) {
    const users = this.cfg.allowedUserIds;
    if (!Array.isArray(users) || users.length === 0) return true;
    if (fromId == null || fromId === '') return false;
    if (String(fromId) === this.chatOf(chatId)) return true;
    return users.map(String).includes(String(fromId));
  }

  // Begin receiving. Call onMessage({ chatId, text, messageId, from, attachments })
  // per message. Channels that support tappable inline buttons also call
  // onAction({ chatId, messageId, data, from }) when one is tapped (onAction
  // may be absent — guard before calling). Must stop cleanly when
  // signal.aborted becomes true.
  //
  // `attachments` (optional, default []) describes any files the message carried:
  //   { kind, name, mimeType, size, durationSec, download(destDir, prefix) }
  // where kind is one of voice | audio | video_note | photo | document | video.
  // download() must fetch the bytes and resolve with a local path. Keep it lazy:
  // the bridge only calls it once the chat has passed isAuthorized(), so an
  // unauthorized sender can never make the bridge fetch or store their files.
  async start(/* { onMessage, onAction, signal } */) {
    throw new Error('start() not implemented');
  }

  // Send a message. Should return the platform message id of the sent message
  // (used by streaming to edit it in place); may return undefined otherwise.
  // opts.buttons: [{ text, data }] — rendered as tappable inline buttons by
  // channels that support them (taps come back via onAction); ignored otherwise.
  async sendText(/* chatId, text, opts */) { throw new Error('sendText() not implemented'); }
  async sendTyping(/* chatId */) {} // optional
  async sendImage(/* chatId, filePath, caption */) {} // optional

  // Send several images as one grouped attachment when the platform supports
  // it. The default fans out to sendImage so channels only override this if
  // they have a real album/gallery primitive.
  async sendImages(chatId, filePaths, caption = '') {
    for (const [i, p] of filePaths.entries()) await this.sendImage(chatId, p, i === 0 ? caption : '');
  }

  // Edit a previously sent message in place. Channels that support live
  // streaming override this and return true on success; the no-op default
  // (returns false) makes the bridge fall back to a single final message.
  async editText(/* chatId, messageId, text */) { return false; }

  // Send a short audio clip as a playable voice message. Channels that support
  // it override this and return true on success; the default (false) makes the
  // bridge fall back to sending the text instead.
  async sendVoice(/* chatId, buffer, caption */) { return false; }

  // Remove a previously sent message. Voice mode uses this to replace the
  // streamed transcript with the voice note; the default (false) makes the
  // bridge edit the message instead of deleting it.
  async deleteMessage(/* chatId, messageId */) { return false; }
}
