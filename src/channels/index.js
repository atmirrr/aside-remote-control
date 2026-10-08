// Channel registry. Register every platform implementation here.
import { TelegramChannel } from './telegram.js';

const REGISTRY = new Map([
  [TelegramChannel.type, TelegramChannel],
]);

export function listChannelTypes() {
  return [...REGISTRY.values()].map((C) => ({ type: C.type, label: C.label }));
}

export function getChannelClass(type) {
  return REGISTRY.get(type) || null;
}

// Register an additional channel implementation (used by new channel modules
// and by tests that need to inject a fake channel).
export function registerChannel(C) {
  REGISTRY.set(C.type, C);
}

export function createChannel(cfg) {
  const C = getChannelClass(cfg.type);
  if (!C) throw new Error(`Unknown channel type: ${cfg.type}`);
  return new C(cfg);
}
