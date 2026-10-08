// Persistent config + per-chat session map, stored under ~/.aside-remote
// (override the directory with ASIDE_REMOTE_HOME).
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export const HOME = process.env.ASIDE_REMOTE_HOME || path.join(os.homedir(), '.aside-remote');
const CONFIG_PATH = path.join(HOME, 'config.json');
const SESSIONS_PATH = path.join(HOME, 'sessions.json');
// Which channel started each agent session (session id -> channel id). Append-only: the
// sessions map above only keeps the current session per chat, this keeps every one, so a
// chat list elsewhere (aside-phone) can say "telegram" or "voice" instead of Aside's "cli".
const ORIGINS_PATH = path.join(HOME, 'origins.json');

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

// The Aside CLI announces a fresh session on its first output line
// ("created new session: <16-char id>") and a resumed one as "continuing
// existing session: <id>". Ids are bare 16-character alphanumerics.
export const SESSION_REGEX = '(?:created new|continuing existing) session: ([A-Za-z0-9]{16})';
export const RESUME_ARGS = ['session', 'resume', '{session}'];
// The pre-0.2 default. It never worked: `--session` is not a flag on the CLI
// (resume is a subcommand), and it could only ever fire once sessionRegex was
// set, which shipped as null. Recognised in loadConfig so old files self-heal.
const LEGACY_CONTINUE_ARGS = ['--session', '{session}'];

const DEFAULT_CONFIG = {
  version: 3, // bump whenever a derived default (e.g. PTY_DRIVER) changes; triggers re-heal in loadConfig
  // How to invoke the Aside browser agent. The bridge shells out to this.
  agent: {
    command: 'aside',        // CLI binary on PATH
    // Pseudo-TTY wrapper (see PTY_DRIVER above). macOS only: on Linux the Aside
    // CLI is run directly. Set to [] to disable, or supply your own wrapper.
    wrapper: process.platform === 'darwin' ? ['python3', '-c', PTY_DRIVER] : [],
    // Args used to *start* a new session. The prompt is appended as the last arg.
    newArgs: [],
    // Args used to *continue* a session. "{session}" is replaced with the id.
    // `aside session resume <id> <prompt>` carries the full conversation on
    // the Aside side, so follow-ups ("the second one") resolve without the
    // bridge replaying anything.
    continueArgs: [...RESUME_ARGS],
    // Regex (string) used to recover a session id from CLI output for continuity.
    // Group 1 must be the id. The default matches the CLI's own announcement
    // line, which is stable and unambiguous. Set to null to disable continuity
    // (every message then starts a fresh session, with client-side context
    // replay as the only memory, see `context`). The bridge self-heals if a
    // stored id is ever rejected ("Session not found"): it forgets the id and
    // retries the message as a fresh session.
    sessionRegex: SESSION_REGEX,
    // On /stop (or the Stop button) the bridge interrupts the CLI process and
    // also runs `aside session stop <id>` so the browser-side task is dropped
    // rather than left running headless. false = keystroke/signal only.
    stopSessionOnAbort: true,
    // Both caps below are *report* thresholds, not kill switches. Crossing one
    // posts a "taking longer than usual" notice carrying a Stop button, and the
    // task keeps running; ending it is the reader's call. See killOnTimeout.
    timeoutMs: 1800000,      // 30 min: how long before "this is taking a while"
    // Idle/stall cap: the agent streaming nothing for this long usually means it
    // blocked on a local approval (writing to memory, editing a file) that Aside
    // gates to its desktop UI — there's no prompt on stdin for the bridge to
    // answer. But a long quiet browser step looks exactly the same from out here,
    // which is why this reports instead of killing. 0 disables the check.
    idleTimeoutMs: 420000,   // 7 min of total silence -> raise the kill button
                             // (heavy pages behind logins can sit quiet a while
                             // while genuinely working)
    // Restores the old behaviour: cross either cap and the agent process is
    // SIGKILLed on the spot, with the reply explaining why. Worth turning on for
    // an unattended bridge, where nobody is watching chat to tap the button and a
    // wedged task would otherwise hold its chat's queue indefinitely.
    killOnTimeout: false,
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
    // Fallback continuity. Real continuity is the resumed Aside session (see
    // continueArgs); this client-side replay only kicks in when a message has
    // to start a *fresh* session — the first one, after /new, or after a
    // stored id was rejected — so a lost session still carries its recent
    // turns. Recent turns are recorded per chat and prepended to that first
    // prompt, bounded by a character budget (not a turn count). /new clears
    // it. Set context:false to never replay anything.
    context: true,
    contextMaxChars: 20000,
    // Summary mode. A long task streams a lot of intermediate text into the one
    // chat message; with summary:true the prompt asks the agent to end its reply
    // with `summaryMarker` on its own line followed by a short recap, and the
    // bridge shows *that* in chat — replacing everything streamed so far — the
    // moment the marker appears. The full answer is still what gets remembered
    // for follow-ups. If the agent ignores the instruction (no marker in the
    // reply), the full answer is shown as usual, so this can only ever add a
    // step, never lose the result. Off by default: it costs an extra
    // instruction on every prompt.
    summary: false,
    summaryMarker: '<<<SUMMARY>>>',
    // Phrased as "the reply the user sees", not "summarize what you did":
    // summarize-style prompts produce narration ("The user asked for...") and
    // drop the actual deliverable. Telling the agent the transcript above the
    // marker is hidden makes it carry answers/paths/links across on its own.
    summaryPrompt: 'When the task is complete, output a line containing exactly {marker} and then the reply the user will actually see in chat — everything before the marker is hidden from them. Lead with the outcome itself: the answer, data, links, or file paths the user asked for. Add brief context about how you got there only when it helps. Match the length to the task — a short answer deserves a short reply.',
    // Voice mode. Implies summary mode — the voice note speaks the summary
    // recap, so voice:true activates the recap machinery on its own; no need
    // to also set summary:true. With an ElevenLabs API key available
    // (voiceApiKey here, or the ELEVENLABS_API_KEY env var), the recap that
    // summary mode would show as text is synthesized and delivered as a voice
    // note instead — the streamed transcript message is deleted once the voice
    // is sent, so the spoken recap IS the reply. A reply without the marker is
    // spoken in full instead. If the key is missing, synthesis fails, or the
    // channel can't send/delete, the text reply is shown as usual: voice can
    // only upgrade the reply, never lose it. Follow-up context is unaffected.
    voice: false,
    voiceApiKey: null,                       // prefer the env var; this file is plaintext
    // Any voice id from your ElevenLabs account (My Voices / Voice Library).
    voiceId: '1t1EeRixsJrKbiF1zwM6',
    voiceModelId: 'eleven_multilingual_v2',
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
  const stale = (cfg.version || 1) < DEFAULT_CONFIG.version;
  if (stale && shipped) {
    merged.agent.wrapper = structuredClone(DEFAULT_CONFIG.agent.wrapper);
  }
  // Session continuity (version 3). Files written before it carry the broken
  // `--session` args and a null regex, i.e. continuity switched off. Move a
  // shipped (non-custom) pair onto the working defaults; a user who set their
  // own continueArgs or regex keeps them.
  const a = merged.agent;
  const legacyArgs = Array.isArray(a.continueArgs)
    && a.continueArgs.length === LEGACY_CONTINUE_ARGS.length
    && a.continueArgs.every((x, i) => x === LEGACY_CONTINUE_ARGS[i]);
  if (legacyArgs) a.continueArgs = [...RESUME_ARGS];
  if (stale && (a.sessionRegex == null || a.sessionRegex === '') && (legacyArgs || !cfg.agent || !('continueArgs' in cfg.agent))) {
    a.sessionRegex = SESSION_REGEX;
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
function recordOrigin(channelId, sessionId) {
  if (!sessionId) return;
  const m = readJson(ORIGINS_PATH, {});
  if (m[sessionId] === channelId) return;
  m[sessionId] = channelId;
  saveOrigins(m);
}
function saveOrigins(map) {
  try { writeJson(ORIGINS_PATH, map); } catch {}
}

export const sessions = {
  origin: recordOrigin,
  get(channelId, chatId) {
    return loadSessions()[key(channelId, chatId)] || null;
  },
  set(channelId, chatId, sessionId) {
    recordOrigin(channelId, sessionId);
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
