// `aside-remote channels ...` subcommands.
import { loadConfig, saveConfig, configPath } from '../config.js';
import { listChannelTypes, getChannelClass, createChannel } from '../channels/index.js';
import { createIO, log } from '../util.js';

export async function channelsAdd(args) {
  const io = createIO();
  try {
    const types = listChannelTypes();
    let type = args[0];
    if (!type) {
      log.step('Available channel types:');
      types.forEach((t, i) => log.info(`  ${i + 1}) ${t.label} (${t.type})`));
      const pick = await io.askRequired('Choose a type (number or name): ');
      const byIdx = types[Number(pick) - 1];
      type = byIdx ? byIdx.type : pick.trim().toLowerCase();
    }
    const C = getChannelClass(type);
    if (!C) { log.err(`Unknown channel type "${type}". Known: ${types.map((t) => t.type).join(', ')}`); return; }

    const channelCfg = await C.setup(io);
    const config = loadConfig();
    const existingIdx = config.channels.findIndex((c) => c.id === channelCfg.id);
    if (existingIdx >= 0) {
      const ok = await io.confirm(`Channel "${channelCfg.id}" already exists. Overwrite?`, false);
      if (!ok) { log.warn('Cancelled.'); return; }
      config.channels[existingIdx] = channelCfg;
    } else {
      config.channels.push(channelCfg);
    }
    saveConfig(config);
    log.ok(`\nSaved channel "${channelCfg.id}" to ${configPath()}`);
    log.dim('Start it with:  aside-remote start');
  } catch (e) {
    log.err(`\n${e.message}`);
  } finally {
    io.close();
  }
}

export function channelsList() {
  const config = loadConfig();
  if (config.channels.length === 0) {
    log.warn('No channels configured. Add one with: aside-remote channels add');
    return;
  }
  log.step(`Channels (${configPath()}):`);
  for (const c of config.channels) {
    const allow = c.allowedChatIds?.length ? c.allowedChatIds.join(', ') : '(open - anyone!)';
    log.info(`  • ${c.id}  [${c.type}]  ${c.label || ''}`);
    log.dim(`      allowed chats: ${allow}`);
  }
}

export async function channelsRemove(args) {
  const id = args[0];
  if (!id) { log.err('Usage: aside-remote channels remove <id>'); return; }
  const config = loadConfig();
  const before = config.channels.length;
  config.channels = config.channels.filter((c) => c.id !== id);
  if (config.channels.length === before) { log.err(`No channel with id "${id}".`); return; }
  saveConfig(config);
  log.ok(`Removed channel "${id}".`);
}

export async function channelsTest(args) {
  const id = args[0];
  const config = loadConfig();
  const def = config.channels.find((c) => c.id === id) || (config.channels.length === 1 ? config.channels[0] : null);
  if (!def) { log.err('Usage: aside-remote channels test <id>'); return; }
  const channel = createChannel(def);
  const target = def.allowedChatIds?.[0];
  if (!target) { log.err('No allowed chat id to send a test message to.'); return; }
  await channel.sendText(target, 'aside-remote test message - your channel works.');
  log.ok(`Sent a test message via "${def.id}" to chat ${target}.`);
}
