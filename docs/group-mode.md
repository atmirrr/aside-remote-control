# Group mode

Per-channel config on a channel entry (`channels[].groups`):

```json
{ "groups": { "mode": "mention", "requireUserAllowlist": true, "allowedUserIds": ["123456789"] } }
```

- **Default (no `groups` key):** today's behaviour — an allowed chat id lets
  every member drive the agent.
- **`mode: "mention"`:** in groups the bot acts only on a command addressed
  to it (`/cmd@YourBot`), an `@YourBot` mention (entity-based or plain text),
  or a reply to one of the bot's messages. Mentions are stripped from the
  task text. Bare commands and plain messages are ignored. Private chats are
  unaffected.
- **`requireUserAllowlist: true`:** the sender must be in `allowedUserIds`
  even when the group id itself is allowed (an empty list stays open, same
  rule as chat allowlists).

Group members share **one context**: the session and history are keyed by
channel + chat, not by user — `/new` clears it for everyone in the group.

## BotFather privacy mode

By default bots have **privacy mode enabled** (`/setprivacy` in BotFather):
the bot only receives group messages that mention it, reply to it, or carry a
command addressed to it — exactly the `mention` mode surface. If you disable
privacy mode the bot sees every group message; keep `mode: "mention"` if you
want the bot to stay quiet otherwise, or leave `groups` unset to act on
everything it can see.
