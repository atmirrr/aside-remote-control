// Command dispatcher for the `aside-remote` CLI.
import { channelsAdd, channelsList, channelsRemove, channelsTest } from './commands/channels.js';
import { startCmd } from './commands/start.js';
import { loadConfig } from './config.js';
import { listChannelTypes, createChannel } from './channels/index.js';
import { log } from './util.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

function version() {
  try {
    const pkgPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
    return JSON.parse(readFileSync(pkgPath, 'utf8')).version;
  } catch { return '0.0.0'; }
}

const USAGE = `aside-remote v${version()} - remote-control your Aside browser agent from chat apps

Usage:
  aside-remote channels add [type]      Add a channel (interactive). type: ${listChannelTypes().map((t) => t.type).join(', ')}
  aside-remote channels list            List configured channels
  aside-remote channels remove <id>     Remove a channel
  aside-remote channels test [id]       Send a test message through a channel
  aside-remote start [--channel <id>]   Start the bridge (long-runs; Ctrl-C to stop)
  aside-remote help                     Show this help
  aside-remote version                  Print version

Config lives in ~/.aside-remote (override with ASIDE_REMOTE_HOME).
The bridge shells out to the "aside" CLI - make sure it's installed and signed in.`;

export async function main(argv = process.argv.slice(2)) {
  const [cmd, sub, ...rest] = argv;

  switch (cmd) {
    case undefined:
    case 'help':
    case '-h':
    case '--help':
      console.log(USAGE);
      return;

    case 'version':
    case '-v':
    case '--version':
      console.log(version());
      return;

    case 'channels':
      switch (sub) {
        case 'add': return channelsAdd(rest);
        case 'list': case 'ls': return channelsList();
        case 'remove': case 'rm': return channelsRemove(rest);
        case 'test': return channelsTest(rest);
        default:
          log.err(`Unknown channels subcommand "${sub || ''}".`);
          console.log('  try: aside-remote channels add | list | remove <id> | test [id]');
          process.exitCode = 1;
          return;
      }

    case 'start':
      return startCmd([sub, ...rest].filter((x) => x !== undefined));

    default:
      log.err(`Unknown command "${cmd}".`);
      console.log(USAGE);
      process.exitCode = 1;
  }
}
