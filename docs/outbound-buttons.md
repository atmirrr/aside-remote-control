# Outbound files, completion ping, buttons, approve-by-rerun

## Outbound files (5a)

`Channel.sendFile(chatId, path, caption)` (Telegram: sendDocument via
multipart). The bridge sends files the agent's answer *referenced* (via
`findFilePaths`) only when `outbound.dirs` is non-empty, and each path must
pass `checkOutboundPath`: realpath inside a configured dir, regular file,
≤ `outbound.maxBytes` (45 MB), basename not denylisted (`.env*`, `id_rsa*`,
`*.pem`, `*.key`), never `config.json` inside the bridge home, and ≤
`outbound.maxFiles` (5) per answer. Rejections are `log.warn` with a reason —
never echoed to chat. Legacy `sendImage` (no allowlist) is untouched.

## Completion ping (5b)

`notify.doneAfterSec` (> 0): a separate `✅ Done in 4m12s` message after any
task that ran at least that long, success or failure (Telegram does not
push-notify on edits). Cancelled tasks are skipped.

## Inline buttons (5c)

`sendText(chatId, text, { buttons: [[{ text, data }]] })` renders an
inline keyboard; `callback_data` is asserted ≤ 64 bytes. Polling requests
`callback_query` updates; a tap is answered with `answerCallbackQuery`, then
flows through the normal message path (data becomes the text) — same registry,
same I4 authorization.

## Approve-by-rerun (5d)

When a task **stalls** and `permissions.escalation` is true (default false)
and the effective permission isn't already `full-access`, the reply carries
`🔓 Re-run with full access` → hidden admin `/rerun <token>`. The token is
random, in memory, chat-bound, single-use, 10-minute TTL; the tap removes the
keyboard. It re-runs the stored prompt once with `--permission full-access`
and never changes the stored setting. Honest limitation: this starts a fresh
attempt — the CLI exposes no way to approve the original stalled run.
