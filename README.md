# Aside Remote Control

Remote-control your [Aside](https://aside.com) browser agent from chat apps. Send a message, the agent runs it as a full task in your local browser, and replies back in the chat. **Telegram** is built in; other platforms plug in as channel modules without touching the core.

- Zero runtime dependencies (Node 18+ standard library only).
- No webhook, no public URL, no hosted backend. Pure long-polling.
- Real sessions: each chat is one Aside session, resumed on every message, so follow-ups ("the second one") just work. `/new` starts over.
- Live streaming: the reply updates in place as the agent works.
- Clean replies: just the answer (tool-call transcript and citation tags stripped), with Markdown rendered. `verbose` shows the full transcript.
- Control from chat: `/stop`, steer a running task with a correction, queue more work or run it alongside with `/btw`. A long task gets a Stop button instead of being killed.
- **Voice notes**: speak the task. It's transcribed, echoed back so you can catch a mishearing, then run.
- **Attachments**: send photos, PDFs, anything. They're saved locally and their paths handed to the agent. Image files the agent mentions come back as photos.
- Voice replies (optional): with an ElevenLabs key, replies arrive as spoken voice notes. `/voice` toggles it.
- Groups and forum topics, with per-user access control on top of the chat allowlist, so only you can drive your browser.

> The bridge runs on your machine and drives **your** local Aside agent. Anyone you authorize can make that agent do anything you can. Treat the bot token and your config like credentials.

## How it works

```
Telegram  ──getUpdates──▶  aside-remote bridge  ──spawn──▶  aside CLI  ──▶  your browser
   ▲                              │
   └────────── sendMessage ◀──────┘  (agent output, screenshots)
```

The first message in a chat starts a new Aside session. The CLI announces the
session id, the bridge stores it, and every later message runs
`aside session resume <id> <message>`, so Aside itself carries the conversation.
`/new` starts fresh.

Each chat runs one task at a time, in order. Different chats, and different
forum topics, run independently.

## Prerequisites

1. **Node 18+**
2. **The Aside CLI**, installed and signed in (the bridge shells out to it):
   ```bash
   curl -fsSL https://releases.aside.com/install.sh | bash
   aside "hello"   # confirm it runs a session
   ```
3. **macOS: python3** from the Xcode Command Line Tools (`xcode-select --install`).
   The Aside CLI only prints to a terminal, so the bridge runs it inside a small
   built-in python3 pseudo-terminal. Without a working python3 it warns and runs
   the CLI directly, and output may be limited. On Linux the CLI runs directly.
4. A **Telegram bot token**, made in about a minute:
   - Open [@BotFather](https://t.me/BotFather) in Telegram
   - Send `/newbot`, pick a name and username
   - Copy the token it gives you (looks like `123456789:AAH...`)

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

## Permissions

Bridge tasks run with your Aside default permission, set in Aside's settings.
With **full access** the agent can read and write files anywhere, which is what
remote use usually needs. With **Guard**, Aside asks before the agent touches a
folder outside its allowed list, and a task driven from chat can sit on that
question until you tap Stop. Either:

- run bridge tasks with full access, whatever your default is:
  ```json
  { "agent": { "newArgs": ["--permission", "full-access"] } }
  ```
- or stay on Guard and set `attachments.dir` to a folder Aside already allows,
  so the agent can open the files you send.

## Using it from chat

| Message | Effect |
| --- | --- |
| `/help` | Show help (`/start` does the same) |
| `/new` | Start a fresh agent session (drop context) |
| `/stop` | Stop everything running in this chat and drop anything queued |
| `/steer <text>` | Send a correction into the running task right now |
| `/btw <task>` | Run a task now instead of queueing (in its own session if something is already running) |
| `/voice` | Toggle voice replies on/off (replies with an inline toggle button) |
| `/status` | Show the session id, what Aside reports for it, and what is running or queued |
| `/whoami` | Show your chat id (handy when authorizing) |
| a voice note | Transcribed, then run as a task |
| a file or photo | Downloaded, then handed to the agent as a task |
| anything else | Run as a task in the browser |

While a task is running:

- A new message waits its turn under a **Queued** notice with a **send now**
  button. Tap it to push the message into the running task instead; `/steer`
  does the same without queueing. The task keeps what it has done, the reply so
  far is marked "Interrupted!", and the answer continues in a new message below
  your correction.
- Nothing is killed automatically. If a task runs past 30 minutes, or prints
  nothing for 7, the chat gets "This is taking longer than usual" with a
  **Stop** button. Stop ends that one task; `/stop` ends everything in the chat.
  Both also tell Aside to stop the session, so the browser doesn't carry on.

## Groups and forum topics

- **Allow the group:** add the bot, then send `/whoami@YourBot` there. It
  answers "Not authorized" with the group's chat id. Add that id to the
  channel's `allowedChatIds` in `config.json` and restart the bridge.
- **Choose who can drive it:** set `allowedUserIds` on the channel. In groups,
  everyone else's messages and button taps are then ignored, without a reply.
  Your user id is the chat id `/whoami` shows in a private chat with the bot.
- **Forum topics** each get their own session, queue and `/stop`, and replies go
  back into the same topic.
- **Commands:** `/stop@YourBot` works; commands addressed to another bot are
  ignored.
- **Privacy mode:** by default Telegram only lets a bot in a group see commands
  and replies to its own messages. For plain messages to reach it, turn privacy
  mode off in @BotFather (`/setprivacy`, then Disable) or make the bot a group
  admin.

## Voice notes and attachments

Hold the mic button and talk, or attach a file. Both work anywhere a typed
message does, including as a follow-up ("what's on line 12 of that?").

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

**A loopback `baseUrl` needs no API key**, so `apiKey` may stay `null`. Plain
`http://` is accepted for loopback only; the bridge refuses to POST an
`Authorization` header over cleartext to any other host.

Servers that speak this API today: [`speaches`](https://github.com/speaches-ai/speaches)
(formerly `faster-whisper-server`), or `whisper-server` from
[whisper.cpp](https://github.com/ggerganov/whisper.cpp). Both expose
`POST /v1/audio/transcriptions`.

Speed, measured on an M-series Mac with `faster-whisper` `tiny.en` on CPU: a
3-second voice note transcribed in **~2 s**. `tiny.en` is the least accurate
model; step up to `small.en` or `medium.en` if it fumbles accents or noise.

**Attachments** (photos, documents, video) are downloaded to
`~/.aside-remote/attachments/<channel>/<chat>/` and their paths are appended to
the prompt, so the agent opens them with its own file tools. The agent needs
permission to read there; see [Permissions](#permissions).

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
- Telegram's Bot API refuses to serve downloads over 20 MB, so that's the
  ceiling regardless of `attachments.maxBytes`.
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

## Configuration

State lives in `~/.aside-remote/` (override with `ASIDE_REMOTE_HOME`):

- `config.json`: channels (incl. bot tokens), agent, voice, and attachment settings
- `sessions.json`: chat (or forum topic) → Aside session id. Before resuming one,
  the bridge checks Aside's db (`sqlite3 -readonly ~/.aside/u/*/state.db`) and
  unarchives the session if needed, since Aside's own resume leaves an archived
  session hidden from its chat list.
- `origins.json`: every session a channel ever started → that channel's id
  (append-only). Aside labels them all `cli`; this lets other tools show where
  each one came from.
- `history.json`: per-chat recent turns, for fallback context (see `context` below)
- `attachments/`: files received from chats (audio is deleted after transcription)

`config.json` agent block (defaults shown):

```json
{
  "agent": {
    "command": "aside",
    "newArgs": [],
    "continueArgs": ["session", "resume", "{session}"],
    "sessionRegex": "(?:created new|continuing existing) session: ([A-Za-z0-9]{16})",
    "stopSessionOnAbort": true,
    "timeoutMs": 1800000,
    "idleTimeoutMs": 420000,
    "killOnTimeout": false,
    "autoApprove": true,
    "approvePromptRegex": "approve|allow this|proceed\\?|continue\\?|grant|requires? (your )?(approval|permission)|\\[y/n\\]|\\(y/n\\)",
    "approveInput": "\r",
    "stream": true,
    "streamThrottleMs": 1800,
    "verbose": false,
    "context": true,
    "contextMaxChars": 20000,
    "summary": false,
    "summaryMarker": "<<<SUMMARY>>>",
    "summaryPrompt": "When the task is complete, output a line containing exactly {marker} and then the reply the user will actually see in chat — everything before the marker is hidden from them. Lead with the outcome itself: the answer, data, links, or file paths the user asked for. Add brief context about how you got there only when it helps. Match the length to the task — a short answer deserves a short reply.",
    "voice": false,
    "voiceApiKey": null,
    "voiceId": "1t1EeRixsJrKbiF1zwM6",
    "voiceModelId": "eleven_multilingual_v2"
  }
}
```

- `command` / `newArgs` / `continueArgs` / `sessionRegex`: how the agent is
  invoked. The message is appended as the last argument. A new chat runs
  `aside <newArgs> <message>`; the CLI's first line, `created new session: <id>`,
  is matched by `sessionRegex` and stored, and later messages run
  `aside session resume <id> <message>`. If Aside rejects a stored id, the bridge
  forgets it and retries as a new session. `sessionRegex: null` makes every
  message a new session. Configs saved with the old defaults (`--session` and a
  `null` regex) are upgraded when loaded.
- `wrapper` (not shown): the pseudo-terminal the CLI runs inside on macOS (see
  [Prerequisites](#prerequisites)). `[]` runs the CLI directly, which is the
  Linux default.
- `stopSessionOnAbort`: on `/stop` or the Stop button, the bridge sends the CLI a
  Ctrl-C and also runs `aside session stop <id>`, so a browser step in flight
  doesn't carry on. If the CLI hasn't exited 5 s later, it's killed. `false`
  skips the `session stop` call.
- `timeoutMs` / `idleTimeoutMs` / `killOnTimeout`: report thresholds, not kill
  switches. Past `timeoutMs` (30 min), or after `idleTimeoutMs` (7 min) with no
  output at all (`0` turns that check off), the chat gets "This is taking longer
  than usual" with a Stop button, and the task keeps running. A slow page and a
  stuck task look the same from outside, so ending it is your call.
  `killOnTimeout: true` kills the task at that point instead, which suits an
  unattended bridge where nobody will tap Stop.
- `autoApprove` / `approvePromptRegex` / `approveInput`: Aside can ask for
  approval with an **interactive prompt** on its terminal. Driven from chat
  there's no one to answer it. When `autoApprove` is `true` (default), the bridge
  watches the agent's output and, the moment it matches `approvePromptRegex`,
  sends `approveInput` to the agent's stdin to accept and continue. **This grants
  every approval automatically**: anyone authorized to message the bot can
  approve anything the agent asks (see Security). Set `autoApprove: false` to
  leave such prompts unanswered. If your Aside build words its prompt or accept
  key differently, tune `approvePromptRegex` (a case-insensitive regex string)
  and `approveInput` (the keystrokes to send, e.g. `"y\n"` for a `y/N` prompt,
  or `"\r"` to confirm a selector's default).
- `stream` / `streamThrottleMs`: when `true` (default), the bot sends a
  placeholder and edits it in place as the agent streams output, at most once
  per `streamThrottleMs` (to respect platform edit rate limits). Set
  `stream: false` for a single final message instead.
- `verbose`: when `false` (default), the chat shows only the agent's final
  answer. The "Thinking" notes, `repl(...)` tool calls, page snapshots and
  citation tags are stripped (like Aside's own chat UI), and the answer's
  Markdown (`**bold**`, `` `code` ``, links) is rendered via Telegram formatting.
  If the answer can't be picked out of the terminal output, it's read from
  Aside's own copy of the session instead. Set `verbose: true` to forward the
  full raw transcript as plain text (handy for debugging).
- `context` / `contextMaxChars`: fallback continuity. A resumed session already
  holds the conversation, so nothing is replayed. Only a message that has to
  start a new session while the chat still has history (a `/btw` task in its
  own session, a stored id that was rejected, or `sessionRegex: null`) gets the
  recent turns prepended,
  bounded by a **character budget** (`contextMaxChars`, oldest turns dropped
  first). `/new` clears the history; `context: false` turns replay off.
- `summary` / `summaryMarker` / `summaryPrompt`: a long task streams a lot of
  intermediate text into the one chat message. With `summary: true`, each prompt
  asks the agent to end with `summaryMarker` on its own line followed by the
  reply you should see, and the moment that marker appears the bridge
  **replaces everything streamed so far** with that reply alone. The full answer
  is still what's remembered for follow-ups. If the agent skips the marker, the
  full answer is shown as usual and a warning is logged, so this can only add a
  step, never lose the result. Off by default because it appends an instruction
  to every prompt. `{marker}` in `summaryPrompt` is replaced with
  `summaryMarker`.
- `voice` / `voiceApiKey` / `voiceId` / `voiceModelId`: **voice mode**. With
  `voice: true` and an [ElevenLabs](https://elevenlabs.io) API key, the reply is
  synthesized and delivered as a **voice note** instead of text, and the streamed
  message is deleted once the voice note is in. Voice mode **implies summary
  mode** (it speaks the recap, or the full answer if there is none), so there's
  no need to also set `summary: true`. Put the key in the `ELEVENLABS_API_KEY`
  environment variable (preferred, keeps it out of the config file) or in
  `voiceApiKey`. `voiceId` picks the voice (any voice id from your ElevenLabs
  account) and `voiceModelId` the model. If the key is missing or synthesis
  fails, the reply is shown as text, so voice can only upgrade a reply, never
  lose it. Toggle it from chat with `/voice`; the change is saved to the config
  and survives restarts.

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

- `baseUrl`: any OpenAI-compatible `/audio/transcriptions` endpoint, e.g.
  `https://api.groq.com/openai/v1` for Groq, `https://openrouter.ai/api/v1` for
  OpenRouter, or `http://localhost:8000/v1` for a self-hosted whisper server if
  you'd rather no audio left the machine.
- `apiKey` / `apiKeyEnv`: `apiKey` wins if set; otherwise the named environment
  variable is read. Prefer the env var, since it never touches disk.
- `language`: an ISO-639-1 hint like `"en"`. `null` auto-detects.
- `prompt` (optional, not set by default): a Whisper prompt to steer spelling of
  names and jargon. OpenRouter ignores it, so there the bridge instead sends the
  words listed in `~/.aside-remote/vocabulary.txt` (one per line, `#` for
  comments) through to Groq. The file is re-read for every voice note.
- `echoTranscript`: post `🎙️ <what I heard>` before running the task. Leave this
  on: it's the only way to notice a mistranscription before the agent acts on it.
- `enabled`: two independent killswitches. `attachments.enabled: false` refuses
  files; `voice.enabled: false` refuses voice notes. Either refusal happens
  **before the first byte is downloaded**.
- `attachments.dir`: where downloads land. `null` means
  `<ASIDE_REMOTE_HOME>/attachments`. A leading `~` is expanded. The agent has to
  be allowed to read here (see [Permissions](#permissions)).

> Tip: tokens live in `config.json`. Keep `~/.aside-remote/` private (the CLI
> creates it `0700`/`0600`). The repo `.gitignore` already excludes config.
> Prefer `OPENAI_API_KEY` in the environment over `voice.apiKey` on disk.

## Troubleshooting

**The bot ignores everything I send.** Telegram hands each update to exactly one
`getUpdates` caller, so a second bridge on the same token silently steals your
messages. Only run one. The bridge logs this:

```
[telegram-mybot] getUpdates rejected: Conflict: terminated by other getUpdates request
[telegram-mybot] another process is polling this bot token. Stop it, or updates
                 will go to whichever instance wins the race.
```

Restarting the bridge can briefly show that same warning, because Telegram holds
the old long-poll open for up to 30s. It clears on its own.

**The bot ignores plain messages in a group.** That's Telegram's privacy mode;
see [Groups and forum topics](#groups-and-forum-topics).

**A task goes quiet, then "This is taking longer than usual".** Either a slow
page, or the agent is waiting on something nobody can answer from chat, most
often a Guard permission question (see [Permissions](#permissions)). Tap Stop
if it's stuck.

## Security

- Always set `allowedChatIds` (the wizard does this for you). With it empty, the
  bot is **open** and anyone who finds it can control your browser.
- The bridge only acts on messages from authorized chats; others get a polite
  "not authorized" with their chat id so you can choose to allow them. In a
  group, `allowedUserIds` limits who can drive the agent; everyone else is
  ignored, button taps included.
- Attachments are **never downloaded until the sender is authorized**, so a
  stranger can't make the bridge pull bytes onto your disk. Files land in
  `~/.aside-remote/attachments/` (`0700`/`0600`), namespaced per chat. They are
  kept for the agent to re-read; delete the directory whenever you like.
- Voice recordings are deleted immediately after transcription. Only the text
  survives, in `history.json`.
- Sending a voice note ships that audio to whatever `voice.baseUrl` points at
  (OpenAI by default). Point it at a local whisper server to avoid that.
- Any local image path (`.png`, `.jpg`, `.webp`, `.gif`) that appears in the
  agent's output is uploaded to the chat.
- `autoApprove` is **on by default**, so the bridge accepts every approval Aside
  asks for on its terminal without a human in the loop. That keeps remote tasks
  from hanging, but it also means an authorized chat can approve sensitive
  actions. Set `autoApprove: false` if you'd rather a prompted task wait.

## Adding a new channel (for contributors)

A channel is a class extending `Channel` (`src/channels/base.js`):

- Required: `static type`, `static async setup(io)` (the `channels add` wizard),
  `start({ onMessage, onAction, control, signal })`, and
  `sendText(chatId, text, opts)` returning the sent message's id.
- Optional: `editText` (live streaming), `deleteMessage`, `sendTyping`,
  `sendImage` / `sendImages`, `sendVoice`, and inline buttons: render
  `opts.buttons` and report taps through `onAction`.
- Voice-style channels can override `wantsPlaceholder` (no "Thinking..."
  message), `forcesSummary` and `summaryPrompt`. `control` gives them stop,
  status, reset and steer as plain calls, for platforms with no slash commands.

Two ways to ship it:

1. **Built in:** add `src/channels/<platform>.js` and register it in
   `src/channels/index.js`.
2. **As its own module:** keep it outside this repo and point the channel's
   `module` field in `config.json` at it (an absolute or `~/` path, a path
   relative to `ASIDE_REMOTE_HOME`, or a package name). Export the class with a
   matching static `type`; `Channel` and `log` can be imported from this
   package. The bridge imports it at startup, and if it fails to load, logs why
   and starts the other channels without it.
   ```json
   { "channels": [{ "id": "my-channel", "type": "my-platform", "module": "~/my-channel/index.js" }] }
   ```

To support voice/files, have `start()` include an `attachments` array on each
message (see `base.js` for the shape). Keep `download()` **lazy**: the bridge
calls it only after authorization, which is what keeps unauthorized senders from
writing to your disk.

The CLI, config, bridge, sessions, and access control all work against the
`Channel` interface, so nothing else needs to change.

## Roadmap

**Reliability & control**

- In-chat approve/deny buttons for Aside's approval prompts, instead of
  `autoApprove` accepting everything.
- Concurrency caps (per-chat and global) on spawned agent processes.

**More channels** (each is a `Channel` class, built in or loaded as a module)

- Slack, Discord, iMessage, WhatsApp.

**Richer input & output**

- Outbound files: send the agent's generated documents back as attachments
  (only images today).
- Per-message model / speed / effort controls (`/model`, `/fast`, `/effort`).
  Aside already exposes `--model` / `--speed` / `--effort` / `--account`.

## License

MIT, see [LICENSE](./LICENSE).
