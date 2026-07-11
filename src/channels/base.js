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

  // True if a given chat is allowed to drive the agent.
  isAuthorized(chatId) {
    const allow = this.cfg.allowedChatIds;
    if (!allow || allow.length === 0) return true; // open mode (not recommended)
    return allow.map(String).includes(String(chatId));
  }

  // Begin receiving. Call onMessage({ chatId, text, messageId, from, attachments })
  // per message. Must stop cleanly when signal.aborted becomes true.
  //
  // `attachments` (optional, default []) describes any files the message carried:
  //   { kind, name, mimeType, size, durationSec, download(destDir, prefix) }
  // where kind is one of voice | audio | video_note | photo | document | video.
  // download() must fetch the bytes and resolve with a local path. Keep it lazy:
  // the bridge only calls it once the chat has passed isAuthorized(), so an
  // unauthorized sender can never make the bridge fetch or store their files.
  async start(/* { onMessage, signal } */) {
    throw new Error('start() not implemented');
  }

  // Send a message. Should return the platform message id of the sent message
  // (used by streaming to edit it in place); may return undefined otherwise.
  async sendText(/* chatId, text */) { throw new Error('sendText() not implemented'); }
  async sendTyping(/* chatId */) {} // optional
  async sendImage(/* chatId, filePath, caption */) {} // optional

  // Edit a previously sent message in place. Channels that support live
  // streaming override this and return true on success; the no-op default
  // (returns false) makes the bridge fall back to a single final message.
  async editText(/* chatId, messageId, text */) { return false; }
}
