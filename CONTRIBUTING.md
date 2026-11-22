# Contributing

Speculate is a Claude Code mod. The repository root is the plugin: Claude Code
loads `hooks/register.ts`, which imports the core in `src/` as it is.

```bash
npm install
npm test             # the core's unit specs (vitest, test/*.spec.ts)
npm run test:mod     # the mod in Claude Code's own test kit (tests/*.test.ts)
npm run validate     # what Claude Code would refuse in the manifest or hooks
npm run typecheck    # the core with no Node types, then everything with them
npm run eval         # offline prediction recall, headline and floor
npm run bench:live   # opt-in: real sessions against hosted MCP servers, mod off and on
npm run bench:replay # sessions a live run kept (--keep), replayed through the core offline
```

`test:mod` and `validate` need Claude Code 2.1.326 or later on PATH. To run
your checkout in a real session, start `claude --plugin-dir .`; edits reload
when the turn that made them ends.

`bench:live` does nothing unless `SPECULATE_BENCH_LIVE=1` is set: it starts
real Claude Code sessions, spends model tokens, and calls other people's
servers. `--scenario mockgithub` runs the same sessions against the bundled
mock server with 1.5 s added to every call: it spends model tokens and
nobody's server time. The [benchmark guide](docs/design/local-learning-benchmark.md) says
how to run it and what a result must report.

Try a change to prediction against `bench:replay` first. It costs nothing and
takes a second, and it shows which recorded call a change wins or loses. It is
not a measurement: confirm with `bench:live`.

## Rules for `src/`

- **No Node, no packages.** A hooks module runs with no Node and imports only
  its own files and `claude-code`. `tsconfig.core.json` type-checks `src/`
  with no Node types to hold that line.
- **No `$`.** The core never touches the host. Hooks build a `SpeculationIo`
  of closures and pass it in.
- Production learning stays generic, comments included. Fixtures belong in
  `test/`, `tests/`, `mock/`, `eval/`, and `bench/`; never tune on held-out
  answers.

## Layout

| Path | What lives there |
|---|---|
| `hooks/register.ts` | the mod: serving, learning, signals, `/speculate` |
| `src/speculator.ts` | the read path the hooks call into |
| `src/executor.ts`, `budget.ts` | prefetching, the drain queue, limits |
| `src/predictor.ts`, `learner.ts`, `priming.ts`, `intent.ts`, `prompt.ts` | prediction |
| `src/cache.ts` | the single-use, short-TTL buffer |
| `src/tools.ts`, `hookGuard.ts`, `sideEffects.ts` | eligibility, settings-hook rules, and which built-in calls flush |
| `src/persistence.ts`, `privacy.ts` | the stored memory and its filtering |
| `dist/src/cli.js` | the npm command: `speculate install`, and 0.x `wrap` compatibility (its path is fixed: 0.x wrote it into registrations) |
| `mock/`, `eval/` | the mock MCP servers and the offline evaluation |
| `bench/` | the live benchmark (paired real sessions, mod off and on, against hosted MCP servers and a slow mock one) and the offline replay of the sessions it kept |

Architecture, measured results, threat model, and the design history
(including the changes that measurement killed): [`docs/design/`](docs/design/),
published at <https://lukebward.github.io/speculate/design/>.
