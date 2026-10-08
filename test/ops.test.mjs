// M9: ops — /health, redacted timestamped logs, doctor, service units.
import test from 'node:test';
import { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { makeBridge, waitFor } from './helpers.mjs';
import { redact, registerSecrets, log } from '../src/util.js';
import { HOME } from '../src/config.js';

beforeEach(() => {
  writeFileSync(path.join(HOME, 'settings.json'), '{}');
  writeFileSync(path.join(HOME, 'history.json'), '{}');
  writeFileSync(path.join(HOME, 'sessions.json'), '{}');
});

const sentHas = (ch, re) => ch.sent.some((s) => re.test(String(s.text)));
const BIN = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'bin', 'aside-remote.js');

// ---- redact + timestamps ----
test('redact() masks bot tokens and registered keys', () => {
  const token = '123456789:AAHabc-DEF_1234567890abcdefghijklmn';
  assert.equal(redact(`token ${token} end`), 'token <redacted> end');
  registerSecrets(['sk-verysecret']);
  assert.equal(redact('key sk-verysecret here'), 'key <redacted> here');
});

test('log lines carry ISO timestamps when stdout is not a TTY', () => {
  const orig = console.log;
  const lines = [];
  console.log = (s) => lines.push(s);
  try {
    log.info('hello ops');
    log.warn('123456789:AAHabc-DEF_1234567890abcdefghijklmn leaked');
  } finally {
    console.log = orig;
  }
  assert.match(lines[0], /^\[\d{4}-\d{2}-\d{2}T[\d:.]+Z\] hello ops$/);
  assert.ok(lines[1].includes('<redacted>'), 'tokens redacted inside log');
});

// ---- /health ----
test('/health is admin-only and reports the machine without secrets or paths', async () => {
  const { bridge, channel } = makeBridge({ fakeAside: { lines: ['aside 9.9.9'] } });
  bridge.config.roles = { admins: ['42'] };
  await bridge.handleMessage(channel, { chatId: 1, userId: '7', text: '/health', from: 'u' });
  assert.ok(sentHas(channel, /Admins only\./));
  await bridge.handleMessage(channel, { chatId: 1, userId: '42', text: '/health', from: 'u' });
  const t = String(channel.sent.at(-1).text);
  assert.match(t, /Aside Remote Control v0\.1\.0/);
  assert.match(t, /uptime: \d+s/);
  assert.match(t, /node: \d+\.\d+\.\d+/);
  assert.match(t, /aside: 9\.9\.9/);
  assert.match(t, /running: \d+ \/ queued: \d+/);
  assert.match(t, /scheduled jobs: \d+/);
  assert.ok(!t.includes(HOME), 'no paths');
  assert.ok(!t.includes('token'), 'no secrets');
});

test('/health reports the last task error (time + one line)', async () => {
  const { bridge, channel } = makeBridge({ fakeAside: { exit: 1, lines: [] } });
  await bridge.handleMessage(channel, { chatId: 1, text: 'failing task', from: 'u' });
  await bridge.handleMessage(channel, { chatId: 1, text: '/health', from: 'u' });
  const t = String(channel.sent.at(-1).text);
  assert.match(t, /last task error:/);
  assert.ok(!t.includes('last task error: none'));
});

// ---- service print ----
function runCli(args, env = {}) {
  return spawnSync(process.execPath, [BIN, ...args], {
    env: { ...process.env, ASIDE_REMOTE_HOME: HOME, ...env },
    encoding: 'utf8',
  });
}

test('service print --launchd emits an install-ready unit (never installs)', () => {
  const r = runCli(['service', 'print', '--launchd'], { ASIDE_REMOTE_HOME: '/tmp/some-home' });
  assert.equal(r.status, 0);
  const out = r.stdout;
  assert.ok(out.includes('<plist'), 'plist output');
  assert.ok(out.includes('ProgramArguments'));
  assert.ok(out.includes(process.execPath));
  assert.ok(out.includes('aside-remote.js'));
  assert.ok(out.includes('<key>KeepAlive</key>'));
  assert.ok(out.includes('/tmp/some-home'), 'ASIDE_REMOTE_HOME forwarded');
});

test('service print --systemd emits a unit file and omits unset env', () => {
  const r = runCli(['service', 'print', '--systemd'], { ASIDE_REMOTE_HOME: '' });
  assert.equal(r.status, 0);
  assert.ok(r.stdout.includes('[Unit]'));
  assert.ok(r.stdout.includes('Restart=always'));
  assert.ok(r.stdout.includes('ExecStart=' + process.execPath));
  assert.ok(!r.stdout.includes('Environment=ASIDE_REMOTE_HOME='), 'env omitted when unset');
});

test('service print without a kind fails with usage', () => {
  const r = runCli(['service', 'print']);
  assert.equal(r.status, 1);
});

// ---- doctor ----
test('doctor reports ✓/✗ lines and exits 1 on any ✗', () => {
  // Fresh temp home: no config -> channels missing; aside may or may not be on PATH.
  const r = runCli(['doctor']);
  assert.ok(r.stdout.includes('node'), 'node line present');
  assert.ok(/[✓✗]/.test(r.stdout), 'check marks present');
  assert.equal(r.status, 1, 'fresh home must fail at least the channels check');
});

test('doctor sees a valid config with channels as healthy config', () => {
  writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({
    version: 1,
    channels: [{ id: 'tg', type: 'telegram', label: 'T', token: '123456789:AAHabc', allowedChatIds: [] }],
  }), { mode: 0o600 });
  const r = runCli(['doctor']);
  assert.match(r.stdout, /✓ config/);
});
