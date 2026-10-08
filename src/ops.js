// Ops helpers: `aside-remote doctor` checks and `service print` unit files.
import fs from 'node:fs';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { loadConfig, configPath } from './config.js';
import { httpsJson, transcriptionKey, isLocalEndpoint, log } from './util.js';
import { isTranscriptionConfigured } from './transcribe.js';

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'aside-remote.js');

// ---- doctor ----
async function asideVersionSafe() {
  return new Promise((resolve) => {
    execFile('aside', ['--version'], { timeout: 10000 }, (err, stdout) => {
      if (err) return resolve(null);
      resolve(String(stdout).trim().split(/\s+/).pop() || 'unknown');
    });
  });
}

export async function doctor(args = []) {
  const online = args.includes('--online');
  const rows = [];
  let failed = false;
  const check = (ok, label, detail = '') => {
    if (!ok) failed = true;
    rows.push(`${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`);
  };

  check(/^(\d+)\./.test(process.versions.node) && Number(process.versions.node.split('.')[0]) >= 18, 'node', `v${process.versions.node} (need >= 18)`);

  const asideV = await asideVersionSafe();
  check(asideV !== null, 'aside on PATH', asideV ? `v${asideV}` : 'not found (the bridge shells out to it)');

  let config = null;
  let modeOk = true;
  try {
    const p = configPath();
    if (fs.existsSync(p)) {
      modeOk = (fs.statSync(p).mode & 0o777) === 0o600;
    }
    config = loadConfig();
  } catch { config = null; }
  check(config !== null, 'config readable', modeOk ? '' : 'mode should be 0600');

  if (config) {
    check(config.channels.length > 0, 'channels', config.channels.length ? `${config.channels.length} configured` : 'none — run: aside-remote channels add');

    const voice = config.voice || {};
    const voiceOk = voice.enabled === false || isTranscriptionConfigured(voice);
    check(voiceOk, 'voice (STT)', voice.engine === 'whisper-cpp' ? 'whisper-cpp' : (isLocalEndpoint(voice) ? 'local endpoint' : (transcriptionKey(voice) ? 'key configured' : 'not configured')));

    const tts = config.tts || {};
    const ttsOk = tts.enabled !== true || isLocalEndpoint(tts) || !!transcriptionKey(tts);
    check(ttsOk, 'tts', tts.enabled === true ? (ttsOk ? 'ready' : 'enabled but no key/endpoint') : 'off');

    const outbound = config.outbound || {};
    if (Array.isArray(outbound.dirs) && outbound.dirs.length) {
      const expand = (d) => String(d).replace(/^~(?=$|\/)/, os.homedir());
      const missing = outbound.dirs.filter((d) => !fs.existsSync(expand(d)));
      check(missing.length === 0, 'outbound dirs', missing.length ? `missing: ${missing.join(', ')}` : 'all exist');
    } else {
      check(true, 'outbound', 'off (dirs empty)');
    }

    if (online) {
      for (const c of config.channels) {
        if (c.type !== 'telegram' || !c.token) { check(false, `channel ${c.id} getMe`, 'not telegram or no token'); continue; }
        try {
          const res = await httpsJson(`https://api.telegram.org/bot${c.token}/getMe`, { method: 'POST', body: {}, timeoutMs: 15000 });
          check(res.ok, `channel ${c.id} getMe`, res.data?.result?.username ? `@${res.data.result.username}` : `HTTP ${res.status}`);
        } catch (e) {
          check(false, `channel ${c.id} getMe`, e.message);
        }
      }
    }
  }

  for (const row of rows) console.log(row);
  return failed ? 1 : 0;
}

// ---- service units (print only; never installs) ----
export function serviceUnit(kind) {
  const node = process.execPath;
  const home = process.env.ASIDE_REMOTE_HOME;
  if (kind === 'launchd') {
    const env = home ? `    <key>EnvironmentVariables</key>
    <dict>
      <key>ASIDE_REMOTE_HOME</key>
      <string>${home}</string>
    </dict>
` : '';
    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.aside-remote.bridge</string>
  <key>ProgramArguments</key>
  <array>
    <string>${node}</string>
    <string>${BIN}</string>
    <string>start</string>
  </array>
${env}  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/tmp/aside-remote.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/aside-remote.err.log</string>
</dict>
</plist>`;
  }
  if (kind === 'systemd') {
    const env = home ? `Environment=ASIDE_REMOTE_HOME=${home}\n` : '';
    return `[Unit]
Description=aside-remote bridge (chat -> Aside browser agent)
After=network-online.target

[Service]
ExecStart=${node} ${BIN} start
Restart=always
${env}
[Install]
WantedBy=multi-user.target
`;
  }
  return null;
}
