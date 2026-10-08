# Control plane

The bridge no longer awaits each task inline in the channel poll loop. Every
message is **submitted** to a scheduler and the loop keeps reading — so
`/cancel`, `/queue`, and messages from other chats always work, even mid-task.

## Scheduler

- Global FIFO across chats; per-chat order is preserved (a chat with a running
  task is skipped, never reordered).
- `agent.maxConcurrent` (default `1` — same effective behaviour as v0.1.0)
  caps parallel agent processes; `agent.maxQueuePerChat` (default `5`) caps
  one chat's backlog.
- A task that must wait gets one `⏳ Queued (#n)` reply; an idle chat with free
  capacity gets none. Over the cap: `Queue is full (N). /cancel to clear.`

## Cancellation

- The agent is spawned `detached` (its own process group). Cancel/timeout/
  stall/shutdown kill the **group** — SIGTERM, SIGKILL after 3 s, falling back
  to `child.kill` — so the pty wrapper can no longer orphan the real agent.
- `Agent.run` resolves `{ cancelled: true, code: -4, text, raw }` on abort.
- `/cancel`: aborts the running task and drops the queue. The streamed
  placeholder becomes `🛑 Cancelled.`; a cancelled turn leaves no trace in
  history. `/new` cancels first, so a finishing task can't re-populate history.
- Shutdown (SIGINT/SIGTERM): stops polling, aborts every running task, waits
  ≤ 5 s, exits 0. A second signal exits immediately.

## Commands

`/cancel` · `/queue [clear]` · `/status` now shows the running task, elapsed
time, preview, and queued count — keeping the session line first.
