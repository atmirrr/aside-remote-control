// M6: scheduler — spec parsing, next-run computation, fire lifecycle.
import test from 'node:test';
import { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { makeBridge, makeChannel, waitFor } from './helpers.mjs';
import { parseSpec, nextRun, Scheduler } from '../src/scheduler.js';
import { schedules, HOME } from '../src/config.js';

beforeEach(() => {
  writeFileSync(path.join(HOME, 'schedules.json'), '{}');
  writeFileSync(path.join(HOME, 'history.json'), '{}');
  writeFileSync(path.join(HOME, 'sessions.json'), '{}');
});

const logHas = (argvLog, needle) => () => {
  try { return readFileSync(argvLog, 'utf8').includes(needle); } catch { return false; }
};
const sentHas = (ch, re) => ch.sent.some((s) => re.test(String(s.text)));
const lastSent = (ch) => String(ch.sent.at(-1)?.text ?? '');

// ---- parseSpec ----
test('parseSpec: deterministic grammar', () => {
  assert.equal(parseSpec('every 10m').kind, 'every');
  assert.equal(parseSpec('every 2h').everyMs, 2 * 3600 * 1000);
  assert.equal(parseSpec('every 1d').everyMs, 86400 * 1000);
  assert.deepEqual({ ...parseSpec('daily 09:30'), kind: null }, { hour: 9, minute: 30, kind: null });
  assert.equal(parseSpec('weekdays 07:00').kind, 'weekdays');
  assert.deepEqual({ ...parseSpec('weekly mon 08:00'), kind: null }, { dow: 1, hour: 8, minute: 0, kind: null });
  assert.equal(parseSpec('weekly sun 08:00').dow, 0);
  assert.equal(parseSpec('at 2026-10-20 09:00').kind, 'at');
  assert.equal(parseSpec('in 30m').kind, 'in');
  assert.equal(parseSpec('cron 0 9 * * 1-5').kind, 'cron');
  assert.equal(parseSpec('cron */15 9-17 * * 1-5').kind, 'cron');
  for (const bad of ['', 'every', 'every 5x', 'daily 25:00', 'daily 9:99', 'weekly funday 08:00', 'cron 60 * * * *', 'cron * * * *', 'at 2026-13-01 09:00', 'in x', 'banana 09:00', 'daily']) {
    assert.equal(parseSpec(bad), null, `"${bad}" must not parse`);
  }
});

// ---- nextRun with DST (Europe/London; 2026-03-29 spring forward, 2026-10-25 fall back) ----
const LDN = 'Europe/London';
test('nextRun: daily table across DST', () => {
  // 2026-03-29T01:30 does not exist in London: the next valid fire is 03-30.
  assert.equal(
    nextRun(parseSpec('daily 01:30'), Date.parse('2026-03-28T01:30:00Z'), LDN),
    Date.parse('2026-03-30T00:30:00Z'), // 01:30 BST = 00:30 UTC
  );
  // Ambiguous 2026-10-25T01:30 (occurs twice): fires once — the first pass (BST).
  assert.equal(
    nextRun(parseSpec('daily 01:30'), Date.parse('2026-10-25T00:00:00Z'), LDN),
    Date.parse('2026-10-25T00:30:00Z'), // first 01:30 (BST, UTC+1)
  );
  // Plain daily after a normal morning.
  assert.equal(
    nextRun(parseSpec('daily 09:00'), Date.parse('2026-10-08T09:00:00Z'), LDN),
    Date.parse('2026-10-09T08:00:00Z'),
  );
});

test('nextRun: weekly and weekdays', () => {
  // 2026-10-08 is a Thursday.
  assert.equal(nextRun(parseSpec('weekly mon 08:00'), Date.parse('2026-10-08T00:00:00Z'), LDN), Date.parse('2026-10-12T07:00:00Z'));
  // 06:00Z is 07:00 BST on the 9th: equal to afterMs, so the next strict fire is Monday.
  assert.equal(nextRun(parseSpec('weekdays 07:00'), Date.parse('2026-10-09T06:00:00Z'), LDN), Date.parse('2026-10-12T06:00:00Z'));
  assert.equal(nextRun(parseSpec('weekdays 07:00'), Date.parse('2026-10-09T06:30:00Z'), LDN), Date.parse('2026-10-12T06:00:00Z'));
});

test('nextRun: cron with dom/dow OR semantics and month reach', () => {
  // 2026-10-09 is a Friday. cron 0 12 13 * 5 => 13th OR Friday: Friday hits first.
  const friday = nextRun(parseSpec('cron 0 12 13 * 5'), Date.parse('2026-10-08T00:00:00Z'), LDN);
  assert.equal(friday, Date.parse('2026-10-09T11:00:00Z'), 'Friday before the 13th');
  // dom 13 in a month where the 13th is not Friday still fires (OR).
  const dom13 = nextRun(parseSpec('cron 0 12 13 * 5'), Date.parse('2026-10-13T12:00:00Z'), LDN);
  assert.equal(dom13, Date.parse('2026-10-16T11:00:00Z'), 'next Friday after the 13th');
  // Far month reach: December 1st searched from October.
  assert.equal(
    nextRun(parseSpec('cron 0 9 1 12 *'), Date.parse('2026-10-08T00:00:00Z'), LDN),
    Date.parse('2026-12-01T09:00:00Z'),
  );
});

test('nextRun: one-shots and every', () => {
  assert.equal(nextRun(parseSpec('at 2026-10-20 09:00'), 0, LDN), Date.parse('2026-10-20T09:00:00Z'));
  assert.equal(nextRun(parseSpec('at 2026-10-20 09:00'), Date.parse('2026-10-20T09:00:00Z'), LDN), null, 'past one-shot has no next run');
  const every = parseSpec('every 10m');
  assert.equal(nextRun(every, 1000, LDN), 1000 + 600000);
  assert.equal(parseSpec('in 30m').kind, 'in');
});

// ---- scheduler lifecycle ----
function makeSchedulerBridge(extra = {}) {
  const made = makeBridge(extra);
  made.bridge.channelInstances.set('test', made.channel);
  made.bridge.config.schedule = { timezone: 'UTC', minIntervalSec: 0, maxJobsPerChat: 20 };
  made.bridge.scheduler = new Scheduler({
    store: schedules,
    bridge: made.bridge,
    timezone: 'UTC',
    minIntervalSec: 0,
    maxJobsPerChat: 20,
    now: () => Date.now(),
  });
  return made;
}

test('/schedule adds a job, /jobs lists it, /unschedule removes it (admin-gated)', async () => {
  const { bridge, channel } = makeSchedulerBridge();
  await bridge.handleMessage(channel, { chatId: 1, userId: '42', text: '/schedule daily 09:00 check inbox', from: 'u' });
  assert.match(lastSent(channel), /Scheduled \w+ \(daily 09:00\)/);
  await bridge.handleMessage(channel, { chatId: 1, text: '/jobs', from: 'u' });
  assert.match(lastSent(channel), /daily 09:00/);
  assert.match(lastSent(channel), /check inbox/);
  const id = Object.keys(schedules.get())[0];
  await bridge.handleMessage(channel, { chatId: 1, userId: '42', text: `/unschedule ${id}`, from: 'u' });
  assert.match(lastSent(channel), /Unscheduled/);
  assert.deepEqual(Object.keys(schedules.get()), []);
});

test('/schedule enforces the grammar and limits', async () => {
  const { bridge, channel } = makeSchedulerBridge();
  bridge.scheduler.minIntervalSec = 300;
  await bridge.handleMessage(channel, { chatId: 1, userId: '42', text: '/schedule every 1m hi', from: 'u' });
  assert.match(lastSent(channel), /at least 5m/, 'minIntervalSec enforced');
  await bridge.handleMessage(channel, { chatId: 1, userId: '42', text: '/schedule banana 09:00 hi', from: 'u' });
  assert.match(lastSent(channel), /Usage: \/schedule/);
  await bridge.handleMessage(channel, { chatId: 1, userId: '42', text: `/schedule daily 09:00 ${'x'.repeat(2001)}`, from: 'u' });
  assert.match(lastSent(channel), /2000 characters/);
  assert.deepEqual(Object.keys(schedules.get()), []);
});

test('a fired job enqueues the task with the ⏰ prefix and no history', async () => {
  const { bridge, channel, argvLog, home } = makeSchedulerBridge({ fakeAside: { lines: ['Answer: ok'] }, agent: { context: false } });
  await bridge.handleMessage(channel, { chatId: 1, userId: '42', text: '/schedule every 10m check inbox', from: 'u' });
  const job = Object.values(schedules.get())[0];
  bridge.scheduler.tick(job.nextRunMs);
  assert.ok(await waitFor(() => logHas(argvLog, 'check inbox'), { timeoutMs: 5000 }));
  await waitFor(() => channel.sent.some((s) => String(s.text).startsWith(`⏰ ${job.id}: `)), { timeoutMs: 5000 });
  assert.ok(channel.sent.some((s) => String(s.text).startsWith(`⏰ ${job.id}: `)), 'reply carries the schedule prefix');
  const hist = JSON.parse(readFileSync(path.join(home, 'history.json'), 'utf8'));
  assert.deepEqual(hist['test:1'] || [], [], 'scheduled turns leave no history');
  // repeating job survives and reschedules
  assert.ok(Object.keys(schedules.get()).includes(job.id), 'repeating job persists after firing');
  await bridge.handleMessage(channel, { chatId: 1, text: '/retry', from: 'u' });
  assert.ok(sentHas(channel, /Nothing to retry yet/), 'scheduled task must not become the retry target');
});

test('one-shot jobs are removed after firing', async () => {
  const { bridge, channel, argvLog } = makeSchedulerBridge({ fakeAside: { lines: ['Answer: ok'] }, agent: { context: false } });
  await bridge.handleMessage(channel, { chatId: 1, userId: '42', text: '/schedule at 2026-10-20 09:00 ping me', from: 'u' });
  const job = Object.values(schedules.get())[0];
  bridge.scheduler.tick(Date.parse('2026-10-20T09:00:00Z'));
  assert.ok(await waitFor(() => logHas(argvLog, 'ping me'), { timeoutMs: 5000 }));
  await waitFor(() => Object.keys(schedules.get()).length === 0, { timeoutMs: 5000 });
});

test('auth re-check: creator no longer admin or chat no longer allowed removes the job', async () => {
  const { bridge, channel, argvLog } = makeSchedulerBridge({ fakeAside: { lines: ['Answer: ok'] }, agent: { context: false } });
  bridge.config.roles = { admins: ['42'] };
  await bridge.handleMessage(channel, { chatId: 1, userId: '42', text: '/schedule every 10m task one', from: 'u' });
  const job = Object.values(schedules.get())[0];
  bridge.config.roles = { admins: ['99'] }; // creator demoted
  bridge.scheduler.tick(job.nextRunMs);
  await waitFor(() => Object.keys(schedules.get()).length === 0, { timeoutMs: 5000 });
  assert.ok(sentHas(channel, /authorization/), 'auth change is reported');
  const log = (() => { try { return readFileSync(argvLog, 'utf8'); } catch { return ''; } })();
  assert.ok(!log.includes('task one'), 'task never ran');
});

test('three consecutive failures auto-disable the job with a notice', async () => {
  const { bridge, channel, argvLog } = makeSchedulerBridge({ fakeAside: { exit: 1, lines: [] }, agent: { context: false } });
  await bridge.handleMessage(channel, { chatId: 1, userId: '42', text: '/schedule every 10m failing task', from: 'u' });
  let job = Object.values(schedules.get())[0];
  for (let i = 1; i <= 3; i++) {
    bridge.scheduler.tick(job.nextRunMs);
    assert.ok(await waitFor(() => Object.keys(schedules.get()).length === 0 || Object.values(schedules.get())[0]?.consecutiveFails >= i, { timeoutMs: 5000 }), `failure ${i} not recorded`);
    job = Object.values(schedules.get())[0];
    if (!job) break;
  }
  assert.equal(Object.keys(schedules.get()).length, 0, 'job disabled after 3 failures');
  assert.ok(sentHas(channel, /disabled after 3 consecutive failures/));
});

test('jobs persist across scheduler instances and missed fires are skipped', async () => {
  const { bridge, channel } = makeSchedulerBridge();
  await bridge.handleMessage(channel, { chatId: 1, userId: '42', text: '/schedule daily 09:00 persistent task', from: 'u' });
  const job = Object.values(schedules.get())[0];
  const later = Date.parse('2026-11-01T00:00:00Z');
  const s2 = new Scheduler({ store: schedules, bridge, timezone: 'UTC', minIntervalSec: 0, maxJobsPerChat: 20, now: () => later });
  s2.start(); // boot recomputes next runs and drops missed one-shots
  const fresh = schedules.get()[job.id];
  s2.stop();
  assert.ok(fresh, 'job survived a new scheduler instance');
  assert.ok(fresh.nextRunMs > later, 'next run recomputed after the missed window');
});
