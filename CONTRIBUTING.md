# Contributing

```bash
npm install     # builds dist/ via the prepare hook
npm test        # unit and end-to-end suite
npm run bench   # speculation off vs on, bundled mock upstream
npm run eval    # offline prediction recall, headline and floor
npm run demo    # the README demo, against the bundled mock
```

Two instruments, and every performance claim has to name which one it came
from: `eval` measures **prediction quality** (offline recall against a fixed
corpus, with an adversarial floor as the control), `bench` measures
**mechanics** (proxy overhead and cache hits against a mock with injected
latency). Neither is a claim about a real server.

For that there is a live benchmark, opt-in, needing a credential, and making
read-only calls only:

```bash
SPECULATE_E2E_LIVE=1 GITHUB_TOKEN=$(gh auth token) npm run bench:remote
```

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
| `src/manage.ts`, `sync.ts`, `tryRun.ts` | `on` / `off` / `sync` / `try` |
| `src/oauthProvider.ts`, `oauthStore.ts`, `authCommand.ts` | `speculate auth` |
| `mock/`, `bench/`, `eval/`, `demo/` | instruments and fixtures |

Architecture, measured results, threat model, and the design history
(including the changes that measurement killed): [DESIGN.md](DESIGN.md).
