# AGENTS.md

Repo: zero-dependency Node >= 18 ES-module bridge. A Telegram chat drives the
operator's local Aside browser-agent CLI (`aside`) and gets the answer back.

## Commands

- `npm test` — runs `test/run.mjs`: each `test/*.test.mjs` in its own
  `node --test` child with a fresh temp `ASIDE_REMOTE_HOME`. Works on Node 18+.
- `node bin/aside-remote.js <command>` — `channels add|list|remove|test`, `start`.
- Never run `start` against a real config while a live bridge polls the same
  bot; tests use a temp `ASIDE_REMOTE_HOME` and stub channels/agents only.

## Repo map

- `bin/aside-remote.js`, `src/cli.js` — CLI entry + dispatcher
- `src/bridge.js` — auth → commands → per-chat queue → attachments → agent →
  streaming edits → history
- `src/agent.js` — spawns the agent CLI (optionally through a pty wrapper),
  timeouts, session recovery
- `src/channels/base.js|telegram.js|index.js` — Channel interface, Telegram
  long-polling, lazy downloads
- `src/config.js` — defaults, merge, atomic writes (0600 files, 0700 dir),
  sessions/history stores
- `src/util.js` — httpsJson/httpsGetBuffer/multipartPost, markdown, logging
- `src/transcribe.js` — OpenAI-compatible STT
- `test/` — node:test suites; `test/invariants.test.mjs` enforces invariants;
  `test/fixtures/fake-aside.mjs` + `test/helpers.mjs` serve new tests

## Invariants (enforced by test/invariants.test.mjs)

I1 zero dependencies · I2 Node >= 18 source floor (banned-API list; escape
hatch: `// invariants-ignore: <reason>` on a line) · I3 outbound-only
networking. Others (I4–I10) are enforced by the behavioural tests and review.

## Adding a chat command

Implement it in the command registry (`src/chat-commands.js`), add tests, add
a row to the README In-chat commands table, and update `docs/` if user-facing.

## Adding a channel

Drop a `Channel` subclass in `src/channels/`, register it in
`src/channels/index.js`; nothing else should change. Text-only in v1.

## Docs

README is the interface: every visible command and config key appears there.
Per-feature notes live in `docs/<feature>.md` (≤ 60 lines). Working state for
the milestone plan lives in `.agent/progress.md` (git-excluded).
