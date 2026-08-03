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

For that there is a live benchmark against real hosted servers. Opt-in, and
read-only by construction: every tool it calls is checked against the server's
own `readOnlyHint` annotation at run time, and anything not affirmatively
read-only aborts before a single call is made.

```bash
# needs no credential, so anyone can reproduce it
SPECULATE_E2E_LIVE=1 npm run bench:remote -- --scenario huggingface

# needs a token, which is never written to disk (the config carries the
# ${VAR} placeholder and the child proxy resolves it from its environment)
SPECULATE_E2E_LIVE=1 GITHUB_TOKEN=$(gh auth token) npm run bench:remote
```

Scenarios live in `bench/scenarios.ts`; adding one is a URL, the tools the
session calls, and how to find real arguments for them. The bar for adding a
server: it annotates those tools read-only, the workflow is a genuine
list-then-detail shape (which is what speculation can act on), and the calls
are few, because these hit somebody else's service.

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
