# Aside Remote Control

Remote-control your [Aside](https://aside.com) browser agent from chat apps. Send a message, the agent runs it as a full task in your local browser, and replies back in the chat. **Telegram** is supported today; the channel layer is pluggable so Slack/Discord/etc. can be added without touching the core.

- Zero runtime dependencies (Node 18+ standard library only).
- No webhook, no public URL, no hosted backend. Pure long-polling.
- Live streaming: the reply updates in place as the agent works.
- Clean replies: just the answer (tool-call transcript stripped), with Markdown rendered. `verbose` shows the full transcript.
- **Voice notes**: speak the task. It's transcribed, echoed back so you can catch a mishearing, then run.
- **Attachments**: send photos, PDFs, anything. They're saved locally and their paths handed to the agent.
- Follow-up context: recent turns are replayed so "summarize that" works (client-side, budget-bounded). `/new` resets.
- Access control by chat id so only you can drive your browser.

> The bridge runs on your machine and drives **your** local Aside agent. Anyone you authorize can make that agent do anything you can. Treat the bot token and your config like credentials.

## How it works

```
Telegram  ──getUpdates──▶  aside-remote bridge  ──spawn──▶  aside CLI  ──▶  your browser
   ▲                              │
   └────────── sendMessage ◀──────┘  (agent output, screenshots)
```

Each chat maps to one Aside session. The bridge recovers the session id from the
CLI output and passes it back on the next message, so context carries over.
`/new` starts fresh.

## Prerequisites

1. **Node 18+**
2. **The Aside CLI**, installed and signed in (the bridge shells out to it):
   ```bash
   curl -fsSL https://releases.aside.com/install.sh | bash
   aside "hello"   # confirm it runs a session
   ```
3. A **Telegram bot token** — create one in ~1 minute:
   - Open [@BotFather](https://t.me/BotFather) in Telegram
   - Send `/newbot`, pick a name and username
   - Copy the token it gives you (looks like `123456789:AAH...`)

## Enabling remote writes

> [!IMPORTANT]
> ⚠️ Write tasks (updating memory, editing a file) hang over the bridge by default.
>
> **Fix:** in Aside → **Settings → Permissions → Can edit**, the agent's folder (`~/.aside/u/0/agents/main`) shows as **Default** but doesn't actually apply — click **Add** and select it again to make it stick.

## Install

```bash
git clone https://github.com/atmirrr/aside-remote-control.git
cd aside-remote-control
npm link        # or: npm install -g .
```

Or run directly without installing: `node bin/aside-remote.js <command>`.

## Quickstart

```bash
# 1. Add a Telegram channel (interactive: paste token, auto-detect your chat id)
aside-remote channels add telegram

# 2. Start the bridge (long-running; Ctrl-C to stop)
aside-remote start
```

Then message your bot in Telegram:

```
open my Gmail and tell me the latest unread subject
```

The agent does it and replies. Send `/help` in the chat for in-band commands.

## Voice notes and attachments

Hold the mic button and talk, or attach a file. Both work anywhere a typed
message does — including as a follow-up ("what's on line 12 of that?").

**Voice** is transcribed before the task runs, so it needs a speech-to-text
endpoint. Any OpenAI-compatible `/audio/transcriptions` API works. The simplest
setup is an env var:

```bash
export OPENAI_API_KEY=sk-...
aside-remote start
```

The bot echoes what it heard (`🎙️ open my email`) before acting, so a
mistranscription is visible rather than silently obeyed. Either way the recording
is **deleted from disk as soon as it's transcribed**. Without an endpoint, voice
notes reply with a setup hint and everything else keeps working.

### Fully local voice (no API key, no audio leaves the machine)

Run any OpenAI-compatible whisper server on loopback and point `baseUrl` at it:

```json
{ "voice": { "baseUrl": "http://127.0.0.1:8000/v1", "model": "small.en" } }
```

**A loopback `baseUrl` needs no API key** — `apiKey` may stay `null`. Plain
`http://` is accepted for loopback only; the bridge refuses to POST an
`Authorization` header over cleartext to any other host.

Servers that speak this API today: [`speaches`](https://github.com/speaches-ai/speaches)
(formerly `faster-whisper-server`), or `whisper-server` from
[whisper.cpp](https://github.com/ggerganov/whisper.cpp). Both expose
`POST /v1/audio/transcriptions`.

Speed, measured on an M-series Mac with `faster-whisper` `tiny.en` on CPU: a
3-second voice note transcribed in **~2 s**. `tiny.en` is the least accurate
model — step up to `small.en` or `medium.en` if it fumbles accents or noise.

> [!IMPORTANT]
> ⚠️ **The agent must be allowed to read wherever attachments land**, or every
> file task hangs.
>
> Aside gates reads outside its permitted folders behind a desktop approval that
> the bridge can't answer, so the agent goes silent and the task dies on the
> stall timeout. Either grant read access to `~/.aside-remote/attachments` in
> Aside → **Settings → Permissions → Can read**, or point downloads somewhere
> Aside already trusts:
>
> ```json
> { "attachments": { "dir": "~/.aside/u/0/agents/main/inbox" } }
> ```
>
> Voice notes are unaffected — the bridge reads the audio itself.

**Attachments** (photos, documents, video) are downloaded to
`~/.aside-remote/attachments/<channel>/<chat>/` and their paths are appended to
the prompt, so the agent opens them with its own file tools:

```
what's the total on this?          ← your caption
[receipt.pdf]                      ← your file
```

becomes

```
what's the total on this?

Attached files, saved on this machine — open them with your file tools:
- /Users/you/.aside-remote/attachments/telegram-mybot/12345/98-0-receipt.pdf (application/pdf, 84 KB)
```

Notes:

- Sending several photos at once (an album) is **one** task, not one per photo.
- Telegram's Bot API refuses to serve downloads over 20 MB — that's the ceiling
  regardless of `attachments.maxBytes`.
- Voice notes, round video notes, and audio files are transcribed. Photos,
  documents, and video are passed through as files.
- A caption on a file is never read as a command: a photo captioned `/new` is a
  task about the photo.

## CLI commands

| Command | What it does |
| --- | --- |
| `aside-remote channels add [type]` | Add a channel (interactive wizard) |
| `aside-remote channels list` | List configured channels |
| `aside-remote channels remove <id>` | Remove a channel |
| `aside-remote channels test [id]` | Send a test message through a channel |
| `aside-remote start [--channel <id>]` | Start the bridge |
| `aside-remote help` / `version` | Help / version |

## In-chat commands

| Message | Effect |
| --- | --- |
| `/help` | Show help |
| `/new` | Start a fresh agent session (drop context) |
| `/status` | Show the current session id |
| `/whoami` | Show your chat id (handy when authorizing) |
| a voice note | Transcribed, then run as a task |
| a file or photo | Downloaded, then handed to the agent as a task |
| anything else | Run as a task in the browser |

## Configuration

State lives in `~/.aside-remote/` (override with `ASIDE_REMOTE_HOME`):

- `config.json` — channels (incl. bot tokens), agent, voice, and attachment settings
- `sessions.json` — per-chat → Aside session id map
- `history.json` — per-chat recent turns, for follow-up context
- `attachments/` — files received from chats (audio is deleted after transcription)

`config.json` agent block (defaults shown):

```json
{
  "agent": {
    "command": "aside",
    "newArgs": [],
    "continueArgs": ["--session", "{session}"],
    "sessionRegex": null,
    "timeoutMs": 1800000,
    "idleTimeoutMs": 420000,
    "stream": true,
    "streamThrottleMs": 1800,
    "verbose": false,
    "context": true,
    "contextMaxChars": 2000
  }
}
```

- `command` / `newArgs` / `continueArgs`: how the agent is invoked. The user's
  message is appended as the final argument. `{session}` is substituted with the
  recovered session id when continuing.
- `sessionRegex`: how a session id is recovered from CLI output for continuity.
  **Disabled (`null`) by default** because the current Aside CLI doesn't print a
  session id to stdout — and a loose regex matches ordinary words in the agent's
  prose, storing a bogus id that gets rejected on the next message. Set it only
  if your agent CLI emits a session id in a stable, unambiguous form. If a stored
  id is ever rejected, the bridge drops it and retries as a fresh session.
- `timeoutMs` / `idleTimeoutMs`: two independent kill switches. `timeoutMs` is
  the hard cap on total task time (30 min). `idleTimeoutMs` is a stall detector:
  if the agent streams **nothing** for this long (7 min default; `0` disables),
  the bridge assumes it's wedged, kills it, and replies with an explanation
  instead of hanging out the full `timeoutMs`. This is what catches the common
  case where the agent blocks on a **local approval** — see
  [Enabling remote writes](#enabling-remote-writes) above.
- `stream` / `streamThrottleMs`: when `true` (default), the bot sends a
  placeholder and edits it in place as the agent streams output, at most once
  per `streamThrottleMs` (to respect platform edit rate limits). Set
  `stream: false` for a single final message instead.
- `verbose`: when `false` (default), the chat shows only the agent's final
  answer — the "Thinking" notes, `repl(...)` tool calls, and page snapshots are
  stripped (like Aside's own chat UI), and the answer's Markdown (`**bold**`,
  `` `code` ``, links) is rendered via Telegram formatting. Set `verbose: true`
  to forward the full raw transcript as plain text (handy for debugging).
- `context` / `contextMaxChars`: when `true` (default), recent turns (the user
  message + the clean answer) are prepended to each prompt so **follow-ups keep
  context** ("summarize that", "the second one"). The Aside CLI can't resume a
  session id, so this continuity is reconstructed client-side and bounded by a
  **character budget** (`contextMaxChars`, oldest turns dropped first) rather
  than a turn count. `/new` clears it; `context: false` makes each message
  independent.

`config.json` voice + attachments blocks (defaults shown):

```json
{
  "voice": {
    "enabled": true,
    "baseUrl": "https://api.openai.com/v1",
    "model": "whisper-1",
    "apiKey": null,
    "apiKeyEnv": "OPENAI_API_KEY",
    "language": null,
    "timeoutMs": 120000,
    "echoTranscript": true
  },
  "attachments": {
    "enabled": true,
    "maxBytes": 20971520,
    "dir": null
  }
}
```

- `baseUrl`: any OpenAI-compatible `/audio/transcriptions` endpoint. Use
  `https://api.groq.com/openai/v1` for Groq, or `http://localhost:8000/v1` for a
  self-hosted whisper server if you'd rather no audio left the machine.
- `apiKey` / `apiKeyEnv`: `apiKey` wins if set; otherwise the named environment
  variable is read. Prefer the env var — it never touches disk.
- `language`: an ISO-639-1 hint like `"en"`. `null` auto-detects.
- `echoTranscript`: post `🎙️ <what I heard>` before running the task. Leave this
  on: it's the only way to notice a mistranscription before the agent acts on it.
- `enabled`: two independent killswitches. `attachments.enabled: false` refuses
  files; `voice.enabled: false` refuses voice notes. Either refusal happens
  **before the first byte is downloaded**.
- `attachments.dir`: where downloads land. `null` means
  `<ASIDE_REMOTE_HOME>/attachments`. A leading `~` is expanded. Set this to a
  folder Aside can already read (see the callout above) to avoid the permission
  grant — the agent has to open these files, and a read it isn't allowed to make
  hangs the task until the stall timeout fires.

> Tip: tokens live in `config.json`. Keep `~/.aside-remote/` private (the CLI
> creates it `0700`/`0600`). The repo `.gitignore` already excludes config.
> Prefer `OPENAI_API_KEY` in the environment over `voice.apiKey` on disk.

## Troubleshooting

**The bot ignores everything I send.** Telegram hands each update to exactly one
`getUpdates` caller, so a second bridge on the same token silently steals your
messages. Only run one. The bridge now logs this:

```
[telegram-mybot] getUpdates rejected: Conflict: terminated by other getUpdates request
[telegram-mybot] another process is polling this bot token. Stop it, or updates
                 will go to whichever instance wins the race.
```

Restarting the bridge can briefly show that same warning — Telegram holds the
old long-poll open for up to 30s. It clears on its own.

**File tasks hang, then report a stall.** The agent can't read the attachments
directory. See the callout in
[Voice notes and attachments](#voice-notes-and-attachments).

## Security

- Always set `allowedChatIds` (the wizard does this for you). With it empty, the
  bot is **open** and anyone who finds it can control your browser.
- The bridge only acts on messages from authorized chats; others get a polite
  "not authorized" with their chat id so you can choose to allow them.
- Attachments are **never downloaded until the sender is authorized**, so a
  stranger can't make the bridge pull bytes onto your disk. Files land in
  `~/.aside-remote/attachments/` (`0700`/`0600`), namespaced per chat. They are
  kept for the agent to re-read; delete the directory whenever you like.
- Voice recordings are deleted immediately after transcription — only the text
  survives, in `history.json`.
- Sending a voice note ships that audio to whatever `voice.baseUrl` points at
  (OpenAI by default). Point it at a local whisper server to avoid that.

## Adding a new channel (for contributors)

1. Create `src/channels/<platform>.js` extending `Channel` (`src/channels/base.js`).
   Implement `static type`, `static async setup(io)`, `start({ onMessage, signal })`,
   `sendText`, and optionally `sendTyping` / `sendImage`.
2. Register it in `src/channels/index.js`.

To support voice/files, have `start()` include an `attachments` array on each
message (see `base.js` for the shape). Keep `download()` **lazy** — the bridge
calls it only after authorization, which is what keeps unauthorized senders from
writing to your disk.

That's it — the CLI, config, bridge, sessions, and access control all work
against the `Channel` interface, so no other file needs changes.

## Roadmap

**Reliability & control**

- Approval handling — the bridge now **detects the stall** (`idleTimeoutMs`) and
  replies with an explanation instead of hanging (see
  [Enabling remote writes](#enabling-remote-writes)). A true in-chat
  approve/deny isn't possible until Aside exposes a headless permission mode on
  `aside exec` — the request currently surfaces nowhere the bridge can see it.
- `/cancel` — stop a running task without waiting for the timeout.
- Concurrency caps (per-chat and global) on spawned agent processes.

**More channels** (each is just a new `Channel` subclass — see below)

- Slack, Discord, iMessage, WhatsApp.

**Richer input & output**

- Image display — return screenshots and generated/referenced images inline in chat.
- Outbound files — send the agent's generated documents back as attachments
  (only `sendPhoto` is wired up today).
- Local speech-to-text — spawn a `whisper.cpp` binary instead of calling an HTTP
  endpoint, for a fully offline voice path.
- Per-message model / speed / effort controls (`/model`, `/fast`, `/effort`) —
  Aside already exposes `--model` / `--speed` / `--effort` / `--account`.

## License

MIT — see [LICENSE](./LICENSE).
