# Jev semantic ranking

Jev can judge which of Speculate's existing concrete candidates the agent is
likely to request soon. Speculate still generates every server, tool and argument
object locally and applies its existing execution gates. Jev supplies probabilities;
it cannot create calls or grant permission.

The integration is optional and off by default. It runs with a context-aware
`speculate run` session for either Claude Code or Codex. Standalone wrappers and
calls without verified conversation context retain local prediction.

## Enable a session

Set `TYPESAFE_API_KEY` in the environment used to launch Speculate. Keep the key
out of configuration files. Create a JSONC configuration:

```json
{
  "servers": {},
  "semanticRanking": {
    "mode": "shadow",
    "model": "jev-1.13.0",
    "timeoutMs": 150,
    "maxCandidates": 16,
    "horizonMs": 30000,
    "maxRequestsPerMinute": 60,
    "maxRequestsPerSession": 1000
  }
}
```

Launch either client:

```bash
speculate run claude --config speculate.config.json --observe hooks
speculate run codex --config speculate.config.json --observe hooks
```

Put native client arguments after `--`. The configuration selects semantic
behavior; the existing native MCP registrations still determine tool routing.
Use `--json-report report.json` to save session diagnostics.

| Mode | Behavior |
| --- | --- |
| `off` | Local prediction only; no Jev requests or semantic context retention |
| `shadow` | Submit baseline predictions immediately; measure Jev judgments without changing execution |
| `rank` | Use Jev probabilities to rank concrete candidates before admission, with bounded baseline fallback |

The bounded settings are:

| Setting | Default | Accepted range |
| --- | --- | --- |
| `timeoutMs` | 150 | 1–500 ms, including correlation and IPC |
| `maxCandidates` | 16 | 1–16 |
| `horizonMs` | 30,000 | 1–30,000 ms; also capped by effective tool TTL |
| `maxRequestsPerMinute` | 60 | 1–60 |
| `maxRequestsPerSession` | 1,000 | 1–1,000 |

A missing key, unavailable provider, exhausted request budget or unverifiable
conversation does not prevent the agent from running. Speculate falls back to
current eligible baseline predictions. A mutation, new real call or changed
permission can instead make the pending batch stale; stale batches are dropped.

## Data sent to TypeSafe

Both `shadow` and `rank` send bounded task text, recent real-call metadata and
candidate argument projections to TypeSafe. Secret filtering does not anonymize
ordinary private content. Enable either mode only when that external processing
fits your workspace.

The projection excludes raw tool results, environment variables, credentials and
full transcripts. It does not crawl the repository. Context stays isolated by
verified conversation identity, including subagents. Semantic evaluation state is
launch-local, and reports contain aggregates rather than prompts or arguments.

## What the score means

Each candidate receives a separate probability of an **exact real request within
a bounded window**. Several candidates can score highly. General relevance is
insufficient: a different file or different arguments do not consume the same
prefetch.

Demand-window outcomes are separate from Speculate's existing next-call
calibration. They are also separate from actual cache hits and time saved. A
request may arrive too early for prefetching to help, or the result may expire.
Provider latency consumes the available head start.

The integration preserves the existing read-only, host-authorization, TTL,
feedback, concurrency and rate gates. Stream-derived exact calls bypass judging.
The session transition generator still limits its frontier to three candidates;
Jev cannot recover a candidate the generators never offered.

## Evaluation and limits

Use shadow mode to inspect probabilities, candidate coverage, provider latency
and fallback rates before enabling rank mode. Compare actual task time, hits,
joins and waste with mode off using the same workload and learning state.
Synthetic or injected-provider tests establish behavior, not live Jev accuracy or
native-client speedup.

The reproducible comparison in `test/jev-integration.test.ts` uses the real
proxy, socket bridge and semantic service with an injected HTTP provider. For
both host identities, two exact file candidates compete for one prefetch slot:

| Mode | Observed prefetch | Provider requests |
| --- | --- | --- |
| `off` | `read({"path":"README.md"})` | 0 |
| `shadow` | `read({"path":"README.md"})` | 1 |
| `rank` | `read({"path":"src/auth.ts"})` | 1 |

Run `npx vitest run test/jev-integration.test.ts` from the repository. The
injected probabilities are 0.01 for the README and 0.99 for the authentication
file. The fixture also verifies provider-failure fallback, stale-task rejection
and demand arriving before a shadow response. It does not run native clients
or measure live provider latency, accuracy, cost or saved wait.

The initial 150 ms deadline includes correlation, IPC and provider time. Requests
are not retried. Provider errors and rate limits trigger bounded cooldowns;
request budgets apply even to canceled requests. Model versions are pinned so
changes in model behavior can be evaluated separately. Configuration accepts
`jev-x.y.z` version identifiers; moving aliases such as `jev-latest` are rejected.

A score is not permission, and a higher score is not evidence of measured time
saved. See [Safety](safety.md) for the underlying execution guarantees and
[Configuration](configuration.md) for baseline speculation settings.
