// Deterministic scheduler: /schedule specs -> next-run computation -> task
// enqueue through the normal bridge queue. No NLP — the grammar is exact and
// documented (docs/scheduler.md). Time: process TZ unless schedule.timezone
// sets an IANA zone; DST is handled by iterating absolute time and matching
// wall-clock minutes (nonexistent minutes never match; ambiguous minutes fire
// once because we return on first match).

// ---- spec grammar ----
const DOW = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

// cron field: * | n | a-b | a,b | */n | a-b/n. Returns a Set, or null for '*'.
function parseCronField(field, min, max) {
  const s = String(field).trim();
  if (s === '*') return null;
  const values = new Set();
  for (const part of s.split(',')) {
    let step = 1;
    let body = part;
    const stepMatch = /\/(\d+)$/.exec(part);
    if (stepMatch) {
      step = Number(stepMatch[1]);
      body = part.slice(0, stepMatch.index);
    }
    if (step <= 0) return undefined;
    let lo;
    let hi;
    if (body === '*') {
      lo = min;
      hi = max;
    } else if (/^\d+$/.test(body)) {
      lo = Number(body);
      hi = lo;
    } else {
      const r = /^(\d+)-(\d+)$/.exec(body);
      if (!r) return undefined;
      lo = Number(r[1]);
      hi = Number(r[2]);
    }
    if (lo < min || hi > max || lo > hi) return undefined;
    for (let v = lo; v <= hi; v += step) values.add(v);
  }
  return values;
}

function parseTime(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return { hour: h, minute: min };
}

function parseInterval(token) {
  const m = /^(\d+)([mhd])$/.exec(String(token));
  if (!m) return null;
  const n = Number(m[1]);
  if (n <= 0) return null;
  const unit = { m: 60000, h: 3600000, d: 86400000 }[m[2]];
  return n * unit;
}

// Returns a normalized spec object or null.
export function parseSpec(text) {
  const a = String(text ?? '').trim().split(/\s+/).filter(Boolean);
  if (!a.length) return null;
  const [kw, ...rest] = a;
  if (kw === 'every' && rest.length === 1) {
    const ms = parseInterval(rest[0]);
    return ms ? { kind: 'every', everyMs: ms } : null;
  }
  if (kw === 'daily' && rest.length === 1) {
    const t = parseTime(rest[0]);
    return t ? { kind: 'daily', hour: t.hour, minute: t.minute } : null;
  }
  if (kw === 'weekdays' && rest.length === 1) {
    const t = parseTime(rest[0]);
    return t ? { kind: 'weekdays', hour: t.hour, minute: t.minute } : null;
  }
  if (kw === 'weekly' && rest.length === 2) {
    const dow = DOW[rest[0].toLowerCase()];
    const t = parseTime(rest[1]);
    return dow !== undefined && t ? { kind: 'weekly', dow, hour: t.hour, minute: t.minute } : null;
  }
  if (kw === 'at' && rest.length === 2) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(rest[0]);
    const t = parseTime(rest[1]);
    if (!m || !t) return null;
    const ms = Date.parse(`${m[1]}-${m[2]}-${m[3]}T${String(t.hour).padStart(2, '0')}:${String(t.minute).padStart(2, '0')}:00Z`);
    return Number.isNaN(ms) ? null : { kind: 'at', whenMs: ms, oneShot: true };
  }
  if (kw === 'in' && rest.length === 1) {
    const ms = parseInterval(rest[0]);
    return ms ? { kind: 'in', everyMs: ms, oneShot: true, relative: true } : null;
  }
  if (kw === 'cron' && rest.length === 5) {
    const minute = parseCronField(rest[0], 0, 59);
    const hour = parseCronField(rest[1], 0, 23);
    const dom = parseCronField(rest[2], 1, 31);
    const mon = parseCronField(rest[3], 1, 12);
    const dowField = String(rest[4]).toLowerCase();
    // Accept mon-fri style names too; 7 normalizes to 0 (both mean Sunday).
    const dowNames = dowField.split(',').map((x) => (DOW[x] !== undefined ? String(DOW[x]) : x)).join(',');
    const dow = parseCronField(dowNames, 0, 7);
    if (dow) {
      if (dow.has(7)) { dow.delete(7); dow.add(0); }
    }
    if (minute === undefined || hour === undefined || dom === undefined || mon === undefined || dow === undefined) return null;
    if (dow && dow.has(7)) { dow.delete(7); dow.add(0); }
    return {
      kind: 'cron',
      minute, hour, dom, mon, dow,
      domRestricted: dom !== null,
      dowRestricted: dow !== null,
    };
  }
  return null;
}

// Split "/schedule <spec...> <task...>" by trying the longest known form.
export function splitScheduleArgs(args) {
  const a = String(args ?? '').trim().split(/\s+/).filter(Boolean);
  if (!a.length) return null;
  const forms = [['cron', 6], ['at', 3], ['weekly', 3], ['every', 2], ['daily', 2], ['weekdays', 2], ['in', 2]];
  for (const [kw, n] of forms) {
    if (a[0] === kw && a.length >= n) {
      const specText = a.slice(0, n).join(' ');
      if (parseSpec(specText)) {
        const task = a.slice(n).join(' ');
        return task ? { specText, task } : null;
      }
    }
  }
  return null;
}

// ---- wall-clock parts in an IANA zone ----
function wallParts(ms, timezone) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone || undefined,
    hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', weekday: 'short',
  });
  const out = {};
  for (const p of fmt.formatToParts(new Date(ms))) {
    if (p.type !== 'literal') out[p.type] = p.value;
  }
  out.dow = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[out.weekday];
  return out;
}

function matchesMinute(spec, p) {
  if (spec.kind === 'daily') return Number(p.hour) === spec.hour && Number(p.minute) === spec.minute;
  if (spec.kind === 'weekdays') return p.dow >= 1 && p.dow <= 5 && Number(p.hour) === spec.hour && Number(p.minute) === spec.minute;
  if (spec.kind === 'weekly') return p.dow === spec.dow && Number(p.hour) === spec.hour && Number(p.minute) === spec.minute;
  return false;
}

function cronDayMatches(spec, p) {
  const month = Number(p.month);
  if (spec.mon && !spec.mon.has(month)) return false;
  const dom = Number(p.day);
  const domOk = spec.dom === null || spec.dom.has(dom);
  const dowOk = spec.dow === null || spec.dow.has(p.dow === 7 ? 0 : p.dow);
  // Standard cron OR semantics: when both are restricted, either matches.
  if (spec.domRestricted && spec.dowRestricted) return domOk || dowOk;
  return domOk && dowOk;
}

// Next fire strictly after afterMs, or null. Iterates absolute time and
// matches wall-clock minutes, so DST gaps/overlaps behave per spec.
export function nextRun(spec, afterMs, timezone) {
  if (spec.kind === 'at') return spec.whenMs > afterMs ? spec.whenMs : null;
  if (spec.kind === 'in') return afterMs + spec.everyMs;
  if (spec.kind === 'every') return afterMs + spec.everyMs;
  if (spec.kind === 'cron') {
    // Day-wise search (up to 366 days), then minute-wise within a matching
    // wall-clock day. Anchoring at each day's 00:00Z keeps the scan inside
    // that day (DST days are 23/25h; scanDay stops at the date change).
    const dayStart = (ms) => {
      const p = wallParts(ms, timezone);
      return Date.parse(`${p.year}-${p.month}-${p.day}T00:00:00Z`);
    };
    let day = dayStart(afterMs + 60000);
    const end = dayStart(afterMs + 60000 + 367 * 86400000);
    while (day < end) {
      if (cronDayMatches(spec, wallParts(day, timezone))) {
        const found = scanDay(spec, day, timezone, (sp, pp) => sp.minute.has(Number(pp.minute)) && sp.hour.has(Number(pp.hour)));
        if (found && found > afterMs) return found;
      }
      day += 86400000;
    }
    return null;
  }
  // daily/weekdays/weekly: minute-wise over 8 days.
  const end = afterMs + 8 * 86400000;
  for (let t = afterMs + 60000; t < end; t += 60000) {
    if (matchesMinute(spec, wallParts(t, timezone))) return t;
  }
  return null;
}

function scanDay(spec, dayStartMs, timezone, minuteOk) {
  const anchor = wallParts(dayStartMs, timezone);
  const end = dayStartMs + 26 * 3600000; // covers a 25-hour DST day
  for (let t = dayStartMs; t < end; t += 60000) {
    const p = wallParts(t, timezone);
    if (p.day !== anchor.day || p.month !== anchor.month) break; // left the day
    if (minuteOk(spec, p)) return t;
  }
  return null;
}

// ---- scheduler ----
export class Scheduler {
  constructor({ store, bridge, timezone = null, minIntervalSec = 300, maxJobsPerChat = 20, now = () => Date.now() }) {
    this.store = store;
    this.bridge = bridge;
    this.timezone = timezone;
    this.minIntervalSec = minIntervalSec;
    this.maxJobsPerChat = maxJobsPerChat;
    this.now = now;
    this.timer = null;
  }

  start() {
    this.recomputeAll();
    if (!this.timer) {
      this.timer = setInterval(() => this.tick(), 15000);
      this.timer.unref?.();
    }
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  // Recompute next runs at boot; fires missed while down are skipped. One-shot
  // jobs whose moment has passed are removed.
  recomputeAll() {
    const nowMs = this.now();
    for (const job of Object.values(this.store.get())) {
      const next = nextRun(job.spec, nowMs, this.timezone);
      if (next === null && job.spec.oneShot) {
        this.store.clear(job.id);
        continue;
      }
      if (next !== null && next !== job.nextRunMs) {
        this.store.set(job.id, { ...job, nextRunMs: next });
      }
    }
  }

  add({ channelId, chatId, creatorUserId, specText, task }) {
    const spec = parseSpec(specText);
    if (!spec) return { error: 'Usage: /schedule every <n>m|h|d | daily HH:MM | weekdays HH:MM | weekly <day> HH:MM | cron <m> <h> <dom> <mon> <dow> | at YYYY-MM-DD HH:MM | in <n>m|h|d' };
    if ((spec.kind === 'every' || spec.kind === 'in') && spec.everyMs < this.minIntervalSec * 1000) {
      return { error: `Intervals must be at least ${Math.ceil(this.minIntervalSec / 60)}m (schedule.minIntervalSec).` };
    }
    if (String(task).length > 2000) return { error: 'Scheduled tasks are limited to 2000 characters.' };
    const chatKey = `${channelId}:${chatId}`;
    const mine = Object.values(this.store.get()).filter((j) => j.chatKey === chatKey).length;
    if (mine >= this.maxJobsPerChat) return { error: `At most ${this.maxJobsPerChat} scheduled jobs per chat (schedule.maxJobsPerChat).` };
    const id = Math.random().toString(36).slice(2, 8);
    const job = {
      id,
      chatKey,
      channelId,
      chatId,
      creatorUserId,
      specText,
      task,
      spec,
      createdAt: this.now(),
      nextRunMs: nextRun(spec, this.now(), this.timezone),
      lastStatus: 'pending',
      consecutiveFails: 0,
    };
    this.store.set(id, job);
    return { ok: true, job };
  }

  remove(id, chatKey) {
    const job = this.store.get(id);
    if (!job) return false;
    if (chatKey && job.chatKey !== chatKey) return false;
    this.store.clear(id);
    return true;
  }

  list(chatKey) {
    return Object.values(this.store.get())
      .filter((j) => !chatKey || j.chatKey === chatKey)
      .sort((a, b) => a.nextRunMs - b.nextRunMs);
  }

  // Fire every due job. nowMs injectable for tests.
  async tick(nowMs = this.now()) {
    const due = Object.values(this.store.get()).filter((j) => j.nextRunMs !== null && j.nextRunMs <= nowMs);
    for (const job of due) {
      const outcome = await this.fire(job);
      if (outcome === 'fired') {
        // Re-read: fire() may have updated the stored job (failure counters).
        const current = this.store.get(job.id);
        if (!current) continue;
        if (current.spec.oneShot) this.store.clear(job.id);
        else this.store.set(job.id, { ...current, nextRunMs: nextRun(current.spec, nowMs, this.timezone) });
      }
    }
  }

  // Re-check authorization, then enqueue through the normal queue.
  async fire(job) {
    const channel = this.bridge.channelInstances?.get(job.channelId);
    const creatorStillAdmin = this.bridge.isAdmin(job.creatorUserId);
    const chatAllowed = channel ? channel.isAuthorized(job.chatId, job.creatorUserId) : false;
    if (!channel || !creatorStillAdmin || !chatAllowed) {
      this.store.clear(job.id);
      if (channel) {
        channel.sendText(job.chatId, `⏰ ${job.id}: skipped and removed — authorization changed.`).catch(() => {});
      }
      return 'auth-failed';
    }
    let item;
    try {
      item = await this.bridge.submitTask(channel, {
        chatId: job.chatId,
        text: job.task,
        attachments: [],
        from: `schedule:${job.id}`,
        scheduleId: job.id,
        ephemeral: true,
      });
    } catch {
      item = { result: { error: true } };
    }
    const res = item?.result || { error: true };
    const failed = !res || res.cancelled === true || res.error === true || res.stalled === true;
    if (failed) {
      const fails = (job.consecutiveFails || 0) + 1;
      if (fails >= 3) {
        this.store.clear(job.id);
        channel.sendText(job.chatId, `⏰ ${job.id}: disabled after 3 consecutive failures.`).catch(() => {});
        return 'disabled';
      }
      this.store.set(job.id, { ...job, consecutiveFails: fails, lastStatus: 'failed' });
    } else {
      this.store.set(job.id, { ...job, consecutiveFails: 0, lastStatus: 'ok' });
    }
    return 'fired';
  }
}
