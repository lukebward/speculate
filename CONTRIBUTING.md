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
```

`test:mod` and `validate` need Claude Code 2.1.296 or later on PATH. To run
your checkout in a real session, start `claude --plugin-dir .`; edits reload
when the turn that made them ends.

## Rules for `src/`

- **No Node, no packages.** A hooks module runs with no Node and imports only
  its own files and `claude-code`. `tsconfig.core.json` type-checks `src/`
  with no Node types to hold that line.
- **No `$`.** The core never touches the host. Hooks build a `SpeculationIo`
  of closures and pass it in.
- Production learning stays generic, comments included. Fixtures belong in
  `test/`, `tests/`, `mock/`, and `eval/`; never tune on held-out answers.

## Layout

| Path | What lives there |
|---|---|
| `hooks/register.ts` | the mod: serving, learning, signals, `/speculate` |
| `src/speculator.ts` | the read path the hooks call into |
| `src/executor.ts`, `budget.ts` | prefetching, the drain queue, limits |
| `src/predictor.ts`, `learner.ts`, `priming.ts`, `intent.ts` | prediction |
| `src/cache.ts` | the single-use, short-TTL buffer |
| `src/tools.ts`, `hookGuard.ts` | eligibility and settings-hook rules |
| `src/persistence.ts`, `privacy.ts` | the stored memory and its filtering |
| `dist/src/cli.js` | the npm command: `speculate install`, and 0.x `wrap` compatibility (its path is fixed: 0.x wrote it into registrations) |
| `mock/`, `eval/` | the mock MCP servers and the offline evaluation |

Architecture, measured results, threat model, and the design history
(including the changes that measurement killed): [`docs/design/`](docs/design/),
published at <https://lukebward.github.io/speculate/design/>.
