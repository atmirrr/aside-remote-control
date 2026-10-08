# Chat commands

All in-chat commands live in one registry (`src/chat-commands.js`) and are
dispatched through the bridge. Command shape:

```js
{ name, description, usage?, admin?, hidden?, aliases?, run(ctx, args) }
```

- `ctx` = `{ bridge, channel, chatId, userId, from, role, reply(text, opts) }`
- `run` may return the reply promise; failures are caught by the bridge and
  sent to the chat as `Command /<name> failed: ...`.

## Adding a command

1. `defineCommand({ ... })` in `src/chat-commands.js` (or a file it imports).
2. Add a test (parser and/or dispatch via `test/helpers.mjs`).
3. Add a row to the README In-chat commands table — the invariants suite
   (I10) fails otherwise.

## Parsing

`parseCommand(text, { botUsername })` — `^/([A-Za-z0-9_]+)(?:@([A-Za-z0-9_]+))?(?:\s+([\s\S]*))?$`.

- Only messages **without attachments** are parsed (a caption is never a
  command).
- The name is lowercased; args keep their case and are trimmed.
- `/cmd@otherbot` (username differs case-insensitively from the bot's own) is
  silently ignored — it targets another bot in a group.
- An unknown `/word` is **not** a command: it runs as an agent task (I8).

## Help and menu

`helpText()` generates `/help` from the registry (hidden commands excluded)
and must contain "Aside Remote Control". The Telegram channel publishes the
same visible list via `setMyCommands` at startup unless `commands.menu` is
`false`; `commands.hidden` lists names to skip. Menu failures are `log.warn`
only — the bridge keeps running.
