// Persistent config + per-chat session map, stored under ~/.aside-remote
// (override the directory with ASIDE_REMOTE_HOME).
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export const HOME = process.env.ASIDE_REMOTE_HOME || path.join(os.homedir(), '.aside-remote');
const CONFIG_PATH = path.join(HOME, 'config.json');
const SESSIONS_PATH = path.join(HOME, 'sessions.json');

// Pseudo-TTY driver. The Aside CLI only renders output to a TTY, so when its
// stdout is a plain pipe it prints nothing. We used to wrap it in `script -q
// /dev/null`, but macOS `script` calls tcgetattr() on its own stdin at startup
// and aborts ("tcgetattr/ioctl: Operation not supported on socket") for any
// errno other than ENOTTY — and Node's `stdio:'pipe'` is an AF_UNIX socketpair,
// which returns EOPNOTSUPP. The result was that `script` exited without ever
// running `aside`, and its error line leaked into chat as the agent's reply.
//
// Python's pty instead forks the agent onto a real PTY (so it renders), relays
// the master both ways (so we capture output *and* can inject auto-approve
// keystrokes — `script` could never do the latter under a piped stdin), sets a
// sane window size (a bare pty.spawn gives the child a 0x0 terminal), and
// propagates the child's exit code. python3 is a preinstalled system tool, so
// this keeps the package's zero-runtime-dependency promise. (If it's missing or
// is the bare macOS Command Line Tools stub, agent.js probes once and falls back
// to a direct launch — see usableWrapper.)
export const PTY_DRIVER = [
  'import os, pty, sys, select, struct, fcntl, termios',
  'pid, fd = pty.fork()',
  'if pid == 0:',
  // execvp raises (not returns) when the agent CLI is missing/non-executable;
  // let it exit quietly with 127 instead of dumping a Python traceback onto the
  // pty — that traceback would otherwise be relayed to stdout and surface in
  // chat as the "reply", reintroducing the very leak this wrapper fixes.
  '    try: os.execvp(sys.argv[1], sys.argv[1:])',
  '    except Exception: os._exit(127)',
  'fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 50, 120, 0, 0))',
  'fds = [fd, 0]',
  'while fds:',
  '    try: r = select.select(fds, [], [])[0]',
  '    except (InterruptedError, OSError): break',
  '    if fd in r:',
  '        try: data = os.read(fd, 65536)',
  '        except OSError: data = b""',
  '        if not data: break',
  '        os.write(1, data)',
  '    if 0 in r:',
  '        try: data = os.read(0, 65536)',
  '        except OSError: data = b""',
  '        if data:',
  '            try: os.write(fd, data)',
  '            except OSError: pass',
  '        else: fds.remove(0)',  // stdin closed: stop watching it, keep relaying agent output
  '_, st = os.waitpid(pid, 0)',
  'os._exit(os.WEXITSTATUS(st) if os.WIFEXITED(st) else 128 + os.WTERMSIG(st))',
].join('\n');

const DEFAULT_CONFIG = {
  version: 2, // bump whenever a derived default (e.g. PTY_DRIVER) changes; triggers re-heal in loadConfig
  // How to invoke the Aside browser agent. The bridge shells out to this.
  agent: {
    command: 'aside',        // CLI binary on PATH
    // Pseudo-TTY wrapper (see PTY_DRIVER above). macOS only: on Linux the Aside
    // CLI is run directly. Set to [] to disable, or supply your own wrapper.
    wrapper: process.platform === 'darwin' ? ['python3', '-c', PTY_DRIVER] : [],
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
    // Auto-approve interactive prompts. Aside renders approvals as interactive
    // prompts and reads the answer from its TTY; driven from chat there is no one
    // to answer, so the task would otherwise block until `timeoutMs`. When
    // autoApprove is true, the bridge watches the agent's output and, the moment
    // it matches approvePromptRegex, sends approveInput to the agent's stdin to
    // accept and continue. This grants every approval automatically — anyone
    // authorized to message the bot can approve anything the agent asks. Set
    // autoApprove:false to restore the old behaviour (prompt goes unanswered,
    // task hits the timeout). Tune approvePromptRegex/approveInput to match your
    // agent's exact prompt and accept key.
    autoApprove: true,
    approvePromptRegex: 'approve|allow this|proceed\\?|continue\\?|grant|requires? (your )?(approval|permission)|\\[y/n\\]|\\(y/n\\)',
    approveInput: '\r',      // keystrokes to send to accept (default: Enter)
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
    contextMaxChars: 20000,
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
  const merged = {
    ...structuredClone(DEFAULT_CONFIG),
    ...cfg,
    agent: { ...DEFAULT_CONFIG.agent, ...(cfg.agent || {}) },
    voice: { ...DEFAULT_CONFIG.voice, ...(cfg.voice || {}) },
    attachments: { ...DEFAULT_CONFIG.attachments, ...(cfg.attachments || {}) },
    channels: cfg.channels || [],
  };
  // Self-heal the pseudo-TTY wrapper across versions. Early setup persisted the
  // macOS `script -q /dev/null` wrapper, which aborts under Node's socketpair
  // stdin and leaked "tcgetattr/ioctl: Operation not supported on socket" into
  // chat instead of running the agent (see PTY_DRIVER). Later versions embed a
  // python driver that can itself go stale, and a wrapper saved on one OS is
  // wrong on another. On a version bump, refresh a *shipped* (non-custom)
  // wrapper from the current platform default; genuine customizations are kept.
  const w = merged.agent.wrapper;
  const shipped = Array.isArray(w) && (w.length === 0 || w[0] === 'script' || w[0] === 'python3');
  if ((cfg.version || 1) < DEFAULT_CONFIG.version && shipped) {
    merged.agent.wrapper = structuredClone(DEFAULT_CONFIG.agent.wrapper);
  }
  merged.version = DEFAULT_CONFIG.version;
  return merged;
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
// Client-side context replay for follow-ups. Bounded by a total character
// budget: turns are stored in full, and oldest turns are dropped once the
// total exceeds the budget. Persists to disk so context survives a restart.
const HISTORY_PATH = path.join(HOME, 'history.json');
function loadHistory() { return readJson(HISTORY_PATH, {}); }
function saveHistory(map) { writeJson(HISTORY_PATH, map); }

export const history = {
  get(channelId, chatId) {
    return loadHistory()[key(channelId, chatId)] || [];
  },
  // Append a turn, then trim oldest turns to keep total text within maxChars.
  append(channelId, chatId, role, text, maxChars = 20000) {
    const m = loadHistory();
    const k = key(channelId, chatId);
    const arr = m[k] || [];
    arr.push({ role, text: String(text || '') });
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
