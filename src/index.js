// Library entry point for programmatic use.
export { Bridge } from './bridge.js';
export { Agent } from './agent.js';
export { Channel } from './channels/base.js';
export { TelegramChannel } from './channels/telegram.js';
export { createChannel, getChannelClass, listChannelTypes, registerChannel, loadExternalChannels } from './channels/index.js';
// Exported for channel authors: a channel implementation shipped as its own
// package needs the base class and the bridge's logger.
export { log } from './util.js';
export { loadConfig, saveConfig, sessions, attachmentsDir } from './config.js';
export { transcribe, isTranscriptionConfigured } from './transcribe.js';
export { main } from './cli.js';
