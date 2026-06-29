// `aside-remote start [--channel <id|type>]`
import { loadConfig } from '../config.js';
import { Bridge } from '../bridge.js';

export async function startCmd(args) {
  let channelFilter = null;
  for (let i = 0; i < args.length; i++) {
    if ((args[i] === '--channel' || args[i] === '-c') && args[i + 1]) channelFilter = args[++i];
  }
  const config = loadConfig();
  const bridge = new Bridge(config);
  await bridge.start(channelFilter);
}
