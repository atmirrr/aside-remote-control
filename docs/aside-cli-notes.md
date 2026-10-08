# Aside CLI notes

Verified 2026-10-08, Aside CLI 1.26.1008.1938, macOS. Probe raw output lives in
`.agent/probes/` (git-excluded). Probe sessions were archived after each run.

## U3 — `aside exec` equivalence: confirmed

`aside exec "<prompt>"` and `aside "<prompt>"` produce structurally identical
output (session line, thinking, answer), both exit 0. Raw transcripts:
`u3-exec.raw` / `u3-root.raw`. The bridge therefore defaults `agent.newArgs`
to `["exec"]`, which also makes the first positional unambiguously the prompt
(a one-word prompt equal to a root subcommand runs as a task, not a subcommand).

## U1 evidence — session id on stdout

Both forms print `created new session: <16-char id>` to stdout. That is the id
`aside session list` reports. Shape for a sessionRegex (M4 wires this):
`created new session: ([A-Za-z0-9_-]{8,64})`.

## `aside session list`

Works piped. Line shape: `<16-char id> <state> persistent <title> <ISO-8601>`;
states seen: idle, interrupted. Titles are private user data — never copy real
ones into tests/docs/commits.

## Misc

- macOS has no `timeout` binary — use the shell's own timeouts.
- `aside exec --help` confirms `--speed default|fast`, `--effort` (8 levels),
  `--permission ask|guard|full-access`, `--model provider/model`.
