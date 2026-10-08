# Ops

## /health (admin)

Version, uptime, Node version, `aside --version` (cached 60 s), running/queued
counts, the last task error (time + first line), and the scheduler job count.
No paths, no secrets — and every log line is redacted anyway (see below).

## Logging

When stdout is not a TTY (service logs), every `log.*` line is prefixed with
an ISO timestamp. `redact()` masks Telegram bot tokens (`\d{6,}:[A-Za-z0-9_-]{30,}`)
and every API key the bridge knows about (voice/tts keys and channel tokens,
registered from config at startup) — applied inside `log` itself.

## Service units

`aside-remote service print --launchd|--systemd` prints a unit file (absolute
node + script paths, `KeepAlive`/`Restart=always`, `ASIDE_REMOTE_HOME`
forwarded when set). It never installs. To use it:

```bash
aside-remote service print --launchd > ~/Library/LaunchAgents/com.aside-remote.bridge.plist
launchctl load ~/Library/LaunchAgents/com.aside-remote.bridge.plist
# systemd:
aside-remote service print --systemd | sudo tee /etc/systemd/system/aside-remote.service
sudo systemctl enable --now aside-remote
```

## doctor

`aside-remote doctor [--online]` — ✓/✗ lines for: Node ≥ 18, `aside` on PATH
(+ version), config readable with 0600 mode, channels present, voice/tts/
outbound sanity; `--online` adds a live `getMe` per Telegram channel. Exit 1
on any ✗.
