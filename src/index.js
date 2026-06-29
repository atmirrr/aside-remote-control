// Library entry point for programmatic use.
export { Bridge } from './bridge.js';
export { Agent } from './agent.js';
export { Channel } from './channels/base.js';
export { TelegramChannel } from './channels/telegram.js';
export { createChannel, getChannelClass, listChannelTypes } from './channels/index.js';
export { loadConfig, saveConfig, sessions } from './config.js';
export { main } from './cli.js';
