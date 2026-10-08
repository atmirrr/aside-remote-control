// Channel registry. Built-in platform implementations are registered here;
// anything else is loaded at startup from a `module` field on the channel
// config (see loadExternalChannels).
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { TelegramChannel } from './telegram.js';
import { HOME } from '../config.js';
import { log } from '../util.js';

const REGISTRY = new Map([
  [TelegramChannel.type, TelegramChannel],
]);

// Register a Channel subclass under its static `type`. Exported so a channel
// shipped as its own package can register itself, and so tests can install a
// fake without reaching into the map.
export function registerChannel(C) {
  if (typeof C !== 'function' || typeof C.type !== 'string' || !C.type) {
    throw new Error('A channel must be a class with a non-empty static `type`.');
  }
  REGISTRY.set(C.type, C);
  return C;
}

export function listChannelTypes() {
  return [...REGISTRY.values()].map((C) => ({ type: C.type, label: C.label }));
}

export function getChannelClass(type) {
  return REGISTRY.get(type) || null;
}

export function createChannel(cfg) {
  const C = getChannelClass(cfg.type);
  if (!C) throw new Error(`Unknown channel type: ${cfg.type}`);
  return new C(cfg);
}

// A `module` may be an absolute path, a "~/" path, a path relative to
// ASIDE_REMOTE_HOME, or a bare package specifier ("aside-remote-homeassistant").
// Paths become file: URLs because a bare relative string would otherwise be
// resolved against this file rather than the user's config.
function resolveSpecifier(spec, baseDir) {
  const s = String(spec).replace(/^~(?=$|\/)/, os.homedir());
  if (s.startsWith('/') || s.startsWith('./') || s.startsWith('../')) {
    return pathToFileURL(path.resolve(baseDir, s)).href;
  }
  return s;
}

// Pick the Channel subclass out of a loaded module: prefer an export whose
// static `type` matches what the config asked for, then fall back to any
// exported class that declares a type at all (a module with one channel in it).
function pickChannelClass(mod, type) {
  const exported = [mod?.default, ...Object.values(mod || {})].filter((v) => typeof v === 'function');
  return exported.find((C) => C.type === type)
    || exported.find((C) => typeof C.type === 'string' && C.type)
    || null;
}

// Import and register every channel implementation that lives outside this
// package, named by a `module` field on its config entry. Call once before
// createChannel.
//
// A broken or missing external channel must never take the bridge down with
// it - that is the whole point of keeping it outside. Failures are logged and
// the channel is skipped, so the built-in ones still start.
export async function loadExternalChannels(defs = [], baseDir = HOME) {
  const loaded = [];
  for (const def of defs) {
    if (!def?.module || REGISTRY.has(def.type)) continue;
    const label = def.id || def.type || def.module;
    try {
      const mod = await import(resolveSpecifier(def.module, baseDir));
      const C = pickChannelClass(mod, def.type);
      if (!C) throw new Error(`no channel class exported (expected a class with a static type of "${def.type}")`);
      registerChannel(C);
      loaded.push(C.type);
    } catch (e) {
      log.warn(`Channel "${label}": couldn't load "${def.module}" - ${e.message}. Starting without it.`);
    }
  }
  return loaded;
}
