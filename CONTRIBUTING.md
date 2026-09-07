# Contributing

```bash
npm install     # builds dist/ via the prepare hook
npm test        # unit and end-to-end suite
npm run build   # rebuild before benchmarking source changes
npm run bench   # paired off/on repeated workflows, with persisted learning
npm run eval    # offline prediction recall, headline and floor
npm run demo    # the README demo, against the bundled mock
```

The [benchmark methodology](docs/design/local-learning-benchmark.md) is the
authoritative reference for commands, accounting, interpretation, and historical
results. Use `bench` (also available as `bench:repeated`) for the general learner;
pass `--baseline /path/to/built/checkout` to compare releases. `bench:mock` keeps
the older GitHub-rule mechanics demonstration. `eval`, `bench:remote`, and the
opt-in real filesystem/Git E2Es remain separate instruments with distinct claims.

Fixtures belong in `bench/` and `test/`; production learning must stay generic,
including comments. Never tune on held-out answers. Hosted scenarios live in
`bench/scenarios.ts`. Add only short list/detail workflows whose tools the
server annotates read-only, because these run against somebody else's service.

The test suite needs Node >= 20.19 (vitest's native rolldown binding; npm
silently skips it on older Node). The floor for *using* Speculate is
unchanged at Node >= 18.

Regenerating the README demo needs ffmpeg on PATH:

```bash
npm run demo:gif
```

## Layout

| Path | What lives there |
|---|---|
| `src/proxy.ts` | request router |
| `src/executor.ts` | speculation and the drain queue |
| `src/predictor.ts`, `learner.ts`, `priming.ts` | prediction |
| `src/cache.ts` | the single-use, short-TTL buffer |
| `src/policy.ts`, `budget.ts` | safety and limits |
| `src/manage.ts`, `sync.ts`, `wrap.ts` | `on` / `off` / `sync` / explicit `wrap` |
| `src/oauthProvider.ts`, `oauthStore.ts`, `authCommand.ts` | `speculate auth` |
| `mock/`, `bench/`, `eval/`, `demo/` | instruments and fixtures |

Architecture, measured results, threat model, and the design history
(including the changes that measurement killed): [`docs/design/`](docs/design/),
published at <https://lukebward.github.io/speculate/design/>.
