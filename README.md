# Aside Remote Control

Remote-control your [Aside](https://aside.com) browser agent from chat apps. Send a message, the agent runs it as a full task in your local browser, and replies back in the chat. **Telegram** is supported today; the channel layer is pluggable so Slack/Discord/etc. can be added without touching the core.

- Zero runtime dependencies (Node 18+ standard library only).
- No webhook, no public URL, no hosted backend. Pure long-polling.
- Live streaming: the reply updates in place as the agent works.
- Clean replies: just the answer (tool-call transcript stripped), with Markdown rendered. `verbose` shows the full transcript.
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
| anything else | Run as a task in the browser |

## Configuration

State lives in `~/.aside-remote/` (override with `ASIDE_REMOTE_HOME`):

- `config.json` — channels (incl. bot tokens) and agent settings
- `sessions.json` — per-chat → Aside session id map

`config.json` agent block (defaults shown):

```json
{
  "agent": {
    "command": "aside",
    "newArgs": [],
    "continueArgs": ["--session", "{session}"],
    "sessionRegex": null,
    "timeoutMs": 1800000,
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

> Tip: tokens live in `config.json`. Keep `~/.aside-remote/` private (the CLI
> creates it `0700`/`0600`). The repo `.gitignore` already excludes config.

## Security

- Always set `allowedChatIds` (the wizard does this for you). With it empty, the
  bot is **open** and anyone who finds it can control your browser.
- The bridge only acts on messages from authorized chats; others get a polite
  "not authorized" with their chat id so you can choose to allow them.

## Adding a new channel (for contributors)

1. Create `src/channels/<platform>.js` extending `Channel` (`src/channels/base.js`).
   Implement `static type`, `static async setup(io)`, `start({ onMessage, signal })`,
   `sendText`, and optionally `sendTyping` / `sendImage`.
2. Register it in `src/channels/index.js`.

That's it — the CLI, config, bridge, sessions, and access control all work
against the `Channel` interface, so no other file needs changes.

## Roadmap

**Reliability & control**

- Approval handling — when Aside suspends a task waiting on an approval, surface
  it in chat (notify, or an inline approve/deny) instead of hanging to the timeout.
- `/cancel` — stop a running task without waiting for the timeout.
- Concurrency caps (per-chat and global) on spawned agent processes.

**More channels** (each is just a new `Channel` subclass — see below)

- Slack, Discord, iMessage, WhatsApp.

**Richer input & output**

- Voice notes → tasks (transcribe incoming voice messages).
- Image input — send a photo as context for a task.
- Image display — return screenshots and generated/referenced images inline in chat.
- Per-message model / speed / effort controls (`/model`, `/fast`, `/effort`) —
  Aside already exposes `--model` / `--speed` / `--effort` / `--account`.

## License

MIT — see [LICENSE](./LICENSE).
