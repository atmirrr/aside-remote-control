# Testing harness

`npm test` → `test/run.mjs`. Works on Node 18, 20, 22, 24.

## Runner

Each `test/*.test.mjs` file runs sequentially in its own `node --test` child
with a fresh temp `ASIDE_REMOTE_HOME` (created and removed per file), then exit
codes are aggregated. Rationale: Node ≥ 21 rejects a directory positional to
`--test`, and `--test-concurrency` only exists on Node ≥ 20.10 — per-file
children avoid both while keeping the Node 18 floor.

Run one file manually:

```bash
ASIDE_REMOTE_HOME=$(mktemp -d) node --test test/format.test.mjs
```

## Invariants (test/invariants.test.mjs)

- I1: package.json declares no dependency entries.
- I2: no API newer than Node 18 (banned-API regex list) and every import
  specifier is relative or `node:`-prefixed. Escape hatch per line:
  `// invariants-ignore: <reason>`.
- I3: no `createServer`/`.listen` in `src/` or `bin/`. (Hermetic test fixtures
  may run loopback servers — that is not the bridge listening.)

## Fixtures and helpers

- `test/fixtures/fake-aside.mjs` — stand-in aside CLI: canned output, hangs,
  detached grandchild, session list/stop/resume/steer/queue emulation against
  a state file. Configured via `FAKE_ASIDE` / `FAKE_ASIDE_STATE` env.
- `test/helpers.mjs` — `makeBridge()`, `makeChannel()`, `waitFor()` for new
  tests. Existing tests keep their own stubs.

Tests are hermetic: no real aside, no network, temp `ASIDE_REMOTE_HOME`, no
sleeps over 200 ms (poll with `waitFor`).
