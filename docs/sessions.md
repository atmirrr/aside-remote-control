# Aside session integration

The bridge now drives the CLI's real session machinery instead of replaying
history client-side.

- **Discovery (U1, verified):** a fresh run prints
  `created new session: <16-char id>` to stdout; the default `sessionRegex`
  binds it to the chat. While a session is bound, the bridge does **not**
  prepend client-side history — the session owns its context.
- **Continuation:** `agent.continueArgs` now defaults to
  `["session", "resume", "{session}"]` (users with explicit config keep
  theirs). A rejected id still self-heals into a fresh session.
- **Commands:** `/sessions [n]` lists recent sessions (id, state, title ≤ 40
  chars, `← bound` marker; unparseable lines fall back to raw). `/resume <id>`
  validates `^[A-Za-z0-9_-]{8,64}$`, checks the list, binds, and clears the
  chat's client-side history. `/steer <text>` interrupts a running task via
  `session steer` (needs a bound id and a running task). CLIs without session
  support get `This Aside CLI has no session support.`
- **Cancel:** `/cancel` group-kills the local process tree, then best-effort
  `session stop <id>` (U2: stop accepts ids; whether it halts a running task
  is unverified — see `docs/aside-cli-notes.md`). Failures are `log.warn`.

Session queries run through `src/aside-cli.js`: execFile, no shell, 15 s
timeout, output capped, `supportsSessions()` cached.
