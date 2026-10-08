# Per-chat settings, roles, and argv hardening

## Settings

`settings.json` holds per-chat overrides for `model`, `speed`, `effort`,
`permission`, `verbose` (built on `jsonStore()` in `src/config.js`). Effective
value = chat setting → `agent.defaults.<field>` → unset (the CLI's own
default). `/model`, `/fast`, `/effort`, `/verbose` validate every input
(usage text on rejection, I7); `reset` clears; the no-arg form shows the
current effective value and its source.

Flags (`--model/--speed/--effort/--permission`) are emitted after `newArgs`
with the prompt last — and **only for new sessions**. A continued session
takes no flags (§4.1); the setting reply notes "applies to the next new
session".

## Roles

`roles.admins: []` (default) — every authorized sender is admin (I8).
Admin-flagged commands (currently `/permission`) answer `Admins only.`
otherwise. `permissions.allowChatOverride: true` additionally gates
`/permission`; `full-access` needs the literal confirm word.

## Argv hardening (I8-sanctioned default change)

- `agent.newArgs` now defaults to `["exec"]` (U3 confirmed in
  `docs/aside-cli-notes.md`): a one-word prompt equal to a root subcommand
  runs as a task, not a subcommand.
- `Agent.guardPrompt` minimally rewrites prompts starting with `-` (flag
  injection) or equal to a root subcommand word (`Do this task: …`) — covers
  configs that keep `newArgs: []` too.

## Conversation commands

`/retry` re-runs the last composed task from memory (refused while running or
with nothing stored); `/undo` pops the last user+assistant pair via
`history.pop`; `/history [n]` lists up to 20 recent turns, 200 chars each.
`/whoami` appends user id, role, and chat type. Telegram now reports `userId`
and `chatType` per message; `Channel.isAuthorized(chatId, userId?)` takes the
optional second parameter (back-compat).
