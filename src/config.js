// Persistent config + per-chat session map, stored under ~/.aside-remote
// (override the directory with ASIDE_REMOTE_HOME).
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export const HOME = process.env.ASIDE_REMOTE_HOME || path.join(os.homedir(), '.aside-remote');
const CONFIG_PATH = path.join(HOME, 'config.json');
const SESSIONS_PATH = path.join(HOME, 'sessions.json');

const DEFAULT_CONFIG = {
  version: 1,
  // How to invoke the Aside browser agent. The bridge shells out to this.
  agent: {
    command: 'aside',        // CLI binary on PATH
    // Optional pseudo-TTY wrapper. The Aside CLI only renders output to a TTY,
    // so when piped it prints nothing. "script" gives it a fake TTY we capture.
    wrapper: process.platform === 'darwin' ? ['script', '-q', '/dev/null'] : [],
    // Args used to *start* a new session. The prompt is appended as the last arg.
    newArgs: [],
    // Args used to *continue* a session. "{session}" is replaced with the id.
    continueArgs: ['--session', '{session}'],
    // Regex (string) used to recover a session id from CLI output for continuity.
    // Disabled by default: the current Aside CLI does not print a session id to
    // stdout, and a prose-matching regex captures ordinary words (e.g. the text
    // after "session ...") as a fake id, which then gets rejected on the next
    // message ("Session not found"). Set this only if your agent CLI prints a
    // session id in a stable, unambiguous form. The bridge self-heals if a
    // stored id is ever rejected, but a bad regex still wastes a retry per turn.
    sessionRegex: null,
    timeoutMs: 1800000,      // 30 min hard cap per task
    // Idle/stall cap: if the agent streams nothing for this many ms, assume it's
    // wedged and kill it early with an explanatory reply, instead of hanging to
    // timeoutMs. This is what catches the common case where the agent blocks on a
    // local approval (writing to memory, editing a file) that Aside gates to its
    // desktop UI — there's no prompt on stdin for the bridge to answer, so the
    // process would otherwise sit silent for the full 30 min. 0 disables.
    idleTimeoutMs: 420000,   // 7 min of total silence -> treat as stalled
                             // (heavy pages behind logins can sit quiet a while
                             // while genuinely working; too low kills live tasks)
    // Live streaming: edit the chat message in place as the agent produces
    // output, instead of waiting for the full result. Throttled to respect
    // platform edit rate limits. Set stream:false for a single final message.
    stream: true,
    streamThrottleMs: 1800,
    // When false (default), the chat shows just the agent's final answer: the
    // "Thinking" notes, repl(...) tool calls, and page snapshots are stripped
    // (like Aside's own chat UI). Set verbose:true to forward the full raw
    // transcript instead.
    verbose: false,
    // Conversation continuity. The Aside CLI can't resume a session id, so we
    // replay context client-side: recent turns are prepended to each prompt so
    // follow-ups ("summarize that", "the second one") work. Bounded by a
    // character budget (not a turn count) so prompts can't grow unbounded.
    // /new clears it. Set context:false to make every message independent.
    context: true,
    contextMaxChars: 2000,
  },
  // Speech-to-text for incoming voice notes. Any OpenAI-compatible
  // /audio/transcriptions endpoint works — override baseUrl to point at Groq or
  // a local whisper server. The key is read from the environment by default, so
  // it never has to be written to disk. Without a key, voice notes get a setup
  // hint instead of a transcript; everything else keeps working.
  voice: {
    enabled: true,
    baseUrl: 'https://api.openai.com/v1',
    model: 'whisper-1',
    apiKey: null,               // takes precedence over apiKeyEnv
    apiKeyEnv: 'OPENAI_API_KEY',
    language: null,             // ISO-639-1 hint, e.g. "en". null = auto-detect.
    timeoutMs: 120000,
    // Echo what was heard back into the chat before running the task, so a
    // mistranscription is obvious rather than silently acted on.
    echoTranscript: true,
  },
  // Incoming files (photos, documents, video). They're downloaded next to the
  // bridge's other state and their paths are handed to the agent, which opens
  // them with its own file tools.
  attachments: {
    enabled: true,
    // Telegram's Bot API refuses to serve downloads above 20 MB, so this is the
    // effective ceiling regardless. Lower it to be stricter.
    maxBytes: 20 * 1024 * 1024,
    // Where downloads land. null = <ASIDE_REMOTE_HOME>/attachments. Aside must
    // have *read* permission here or the agent hangs on a desktop approval when
    // it opens the file; pointing this inside Aside's own agent folder (e.g.
    // "~/.aside/u/0/agents/main/inbox") sidesteps the grant entirely.
    dir: null,
  },
  channels: [],
};

function ensureHome() {
  fs.mkdirSync(HOME, { recursive: true, mode: 0o700 });
}

function readJson(p, fallback) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(p, obj) {
  ensureHome();
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, p);
}

export function loadConfig() {
  const cfg = readJson(CONFIG_PATH, null);
  if (!cfg) return structuredClone(DEFAULT_CONFIG);
  // Merge defaults so older config files keep working.
  return {
    ...structuredClone(DEFAULT_CONFIG),
    ...cfg,
    agent: { ...DEFAULT_CONFIG.agent, ...(cfg.agent || {}) },
    voice: { ...DEFAULT_CONFIG.voice, ...(cfg.voice || {}) },
    attachments: { ...DEFAULT_CONFIG.attachments, ...(cfg.attachments || {}) },
    channels: cfg.channels || [],
  };
}

export function saveConfig(cfg) {
  writeJson(CONFIG_PATH, cfg);
}

export function configPath() {
  return CONFIG_PATH;
}

// Where a chat's incoming files are written: namespaced per chat, so two chats
// can't collide or read each other's uploads. Both segments are
// attacker-influenced, hence the scrub.
//
// baseDir overrides the default (`attachments.dir` in config). It exists because
// the agent must be able to *read* these files, and Aside gates reads outside
// its permitted folders behind a desktop approval the bridge cannot answer —
// pointing this at a folder Aside already trusts avoids that entirely.
const safeSegment = (s) => String(s).replace(/[^\w.\-]+/g, '_');
const expandHome = (p) => p.replace(/^~(?=$|\/)/, os.homedir());
export function attachmentsDir(channelId, chatId, baseDir) {
  const base = baseDir ? expandHome(String(baseDir)) : path.join(HOME, 'attachments');
  return path.join(base, safeSegment(channelId), safeSegment(chatId));
}

// ---- per-chat session map (channelId:chatId -> agent session id) ----
function loadSessions() {
  return readJson(SESSIONS_PATH, {});
}
function saveSessions(map) {
  writeJson(SESSIONS_PATH, map);
}
const key = (channelId, chatId) => `${channelId}:${chatId}`;

export const sessions = {
  get(channelId, chatId) {
    return loadSessions()[key(channelId, chatId)] || null;
  },
  set(channelId, chatId, sessionId) {
    const m = loadSessions();
    m[key(channelId, chatId)] = sessionId;
    saveSessions(m);
  },
  clear(channelId, chatId) {
    const m = loadSessions();
    delete m[key(channelId, chatId)];
    saveSessions(m);
  },
};

// ---- per-chat conversation history (channelId:chatId -> [{role,text}, ...]) ----
// Client-side context replay for follow-ups. Bounded by a character budget:
// each turn is truncated, and oldest turns are dropped once the total exceeds
// the budget. Persists to disk so context survives a bridge restart.
const HISTORY_PATH = path.join(HOME, 'history.json');
const TURN_MAX_CHARS = 800; // truncate any single stored turn
function loadHistory() { return readJson(HISTORY_PATH, {}); }
function saveHistory(map) { writeJson(HISTORY_PATH, map); }

export const history = {
  get(channelId, chatId) {
    return loadHistory()[key(channelId, chatId)] || [];
  },
  // Append a turn, then trim oldest turns to keep total text within maxChars.
  append(channelId, chatId, role, text, maxChars = 2000) {
    const m = loadHistory();
    const k = key(channelId, chatId);
    const arr = m[k] || [];
    arr.push({ role, text: String(text || '').slice(0, TURN_MAX_CHARS) });
    let total = arr.reduce((n, t) => n + t.text.length, 0);
    while (arr.length > 2 && total > maxChars) total -= arr.shift().text.length;
    m[k] = arr;
    saveHistory(m);
  },
  clear(channelId, chatId) {
    const m = loadHistory();
    delete m[key(channelId, chatId)];
    saveHistory(m);
  },
};
