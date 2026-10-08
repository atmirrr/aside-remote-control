# Scheduler

`/schedule <spec> <task…>` (admin), `/jobs`, `/unschedule <id>` (admin). Jobs
persist in `schedules.json`; on fire they re-check authorization (chat still
allowed, creator still admin), then enqueue through the **normal bridge
queue** — so `maxConcurrent`, per-chat caps, and `/cancel` all apply. Replies
are prefixed `⏰ <id>: ` and scheduled turns leave no history and never become
the `/retry` target.

## Grammar (deterministic, no NLP — that is the ceiling)

- `every <n>m|h|d` · `in <n>m|h|d` (one-shot) — bounded by `minIntervalSec`
- `daily HH:MM` · `weekdays HH:MM` · `weekly <sun…sat> HH:MM`
- `cron <m> <h> <dom> <mon> <dow>` — fields: `*`, `n`, `a-b`, `a,b`, `*/n`,
  `a-b/n`; dow 0–7 (0≡7 Sunday); when both dom and dow are restricted, either
  matches (standard cron OR semantics)
- `at YYYY-MM-DD HH:MM` (one-shot) · tasks ≤ 2000 chars

## Time

`schedule.timezone` (IANA, default process TZ) via
`Intl.DateTimeFormat#formatToParts`. The next-run search walks absolute time
and matches wall-clock minutes: spring-forward's nonexistent minute never
matches (fires at the next valid one) and fall-back's ambiguous minute fires
once (first match wins). Missed fires while the bridge was down are skipped;
next runs recompute at boot; past one-shots are removed.

## Lifecycle

One-shot jobs are removed after firing; repeating jobs reschedule. Three
consecutive failures/stalls/timeouts auto-disable the job with a chat notice.
Production wiring is one `setInterval(15 s).unref()` inside the bridge's
start/shutdown.
