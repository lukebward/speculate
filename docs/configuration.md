# Configuration

Speculate needs no configuration — the zero-config default is `annotated` mode
with a learner that picks up your own traffic. A config file adds per-server
modes, allow/denylists, TTLs, budgets, and declarative prediction rules.

```bash
speculate init      # writes a starter config
```

The file is JSON with comments (JSONC).

```json title="speculate.config.json"
{
  "mode": "strict",
  "maxPredictionsPerTrigger": 3,
  "log": "stderr",
  "servers": {
    "github": {
      "command": "npx",
      "args": ["tsx", "mock/mock-github.ts"],
      "env": { "SPECULATE_MOCK_LATENCY_MS": "400" },
      "speculation": {
        "defaultTtlMs": 30000,
        "maxPerMinute": 30,
        "maxConcurrent": 2
      }
    }
  }
}
```

## Top level

| Field | Type | Default | Meaning |
|---|---|---|---|
| `mode` | `strict` \| `annotated` \| `off` | `annotated` | Eligibility policy — see [Safety](safety.md#eligibility) |
| `maxPredictionsPerTrigger` | number | `3` | Per-trigger prediction cap |
| `log` | `stderr` \| `off` | `stderr` | Decision log destination (JSONL) |
| `servers` | object | — | Upstream servers, keyed by name |
| `persistence` | object | enabled | `{ enabled?, path? }` — learned transition model and rule feedback |

!!! note "Persistence never holds results"

    What survives a session is tool names and argument templates. Tool results
    are never written to disk.

## Per-server

### Transport

=== "stdio"

    | Field | Type | Meaning |
    |---|---|---|
    | `command` | string | Executable to spawn |
    | `args` | string[] | Arguments |
    | `env` | object | Extra environment variables |

=== "streamable HTTP"

    | Field | Type | Meaning |
    |---|---|---|
    | `url` | string | Upstream endpoint |
    | `headers` | object | Extra request headers — how an authenticated remote is reached |

    `${VAR}` placeholders in header values are resolved from the environment at
    load, so the token need not live in the config file.

    !!! danger "A hand-set `Authorization` header and `speculate auth` are mutually exclusive"

        Enforced as such. The transport spreads configured headers *after* the
        OAuth bearer, so a stale hand-set header would silently shadow a valid
        token and present as an inexplicable 401.

### Eligibility

| Field | Type | Meaning |
|---|---|---|
| `allowTools` | string[] | Tools the operator vouches for — the whole `strict`-mode allowlist |
| `denyTools` | string[] | Never speculate on these, regardless of mode |
| `rules` | rule[] | Declarative prediction rules (below) |

!!! warning "`profile` is accepted and ignored"

    Vetted per-server profiles were removed. The field stays valid so an older
    config still loads — Speculate warns and drops it rather than failing a
    working setup over a dead line. See
    [why they went](design/implementation-notes.md#1325-vetted-profiles-removed-2026-08-03).

### `speculation`

| Field | Type | Meaning |
|---|---|---|
| `defaultTtlMs` | number | Cache TTL for this server's entries |
| `ttlMsByTool` | object | Per-tool TTL overrides; `0` disables |
| `longHorizonTtlFactor` | number in (0,1] | TTL multiplier for long-horizon ("standing") predictions |
| `maxPerMinute` | number | Speculative-call rate budget |
| `maxConcurrent` | number | Speculative-call concurrency budget |

!!! warning "Read before lowering `longHorizonTtlFactor`"

    It defaults to `1` — no shortening — on measured grounds. If you lower it,
    watch `expired` and `perRule['opener:*'].wasted`. The measurement is in
    [§13.19](design/implementation-notes.md#1319-v013-measuring-how-stale-a-served-prefetch-was-2026-08-02).

## Prediction rules

Rules are the only hand-written prediction source, and you need them for one
thing: **skipping the warm-up.** A rule fires on the first call, where the
learner must watch a transition happen before predicting it.

``` { .js .annotate }
"rules": [
  {
    "trigger": "list_pull_requests",     // (1)!
    "predict": [
      {
        "tool": "get_pull_request",
        "forEach": "$parsed",            // (2)!
        "limit": 3,
        "confidence": 0.6,
        "args": {
          "owner": "$args.owner",        // (3)!
          "repo": "$args.repo",
          "pullNumber": "$item.number"   // (4)!
        }
      }
    ]
  }
]
```

1.  A server-local (unprefixed) tool name. Completed calls to it fire the rule.
2.  A selector that must resolve to an array. Each element binds `$item`.
3.  `$args.*` reads the **trigger call's** arguments.
4.  `$item.*` reads the current `forEach` element — and requires `forEach` on
    the same predict entry.

| Field | Required | Meaning |
|---|---|---|
| `trigger` | yes | Tool name whose completed calls fire the rule |
| `predict[].tool` | yes | Tool to prefetch |
| `predict[].args` | yes | Argument template; string values use the selector language |
| `predict[].confidence` | no | Static prior, clamped into [0,1] |
| `predict[].forEach` | no | Selector resolving to an array; binds `$item` per element |
| `predict[].limit` | no | Max `forEach` fan-out |

### Selectors

| Selector | Resolves to |
|---|---|
| `$args.<path>` | A value from the trigger call's arguments |
| `$parsed.<path>` | A value from the trigger call's parsed result |
| `$item.<path>` | A value from the current `forEach` element |

!!! info "Selectors fail closed"

    A selector that doesn't resolve cancels that prediction rather than
    guessing. `$parsed` being unavailable — the server answered in non-JSON
    text — means the same thing.

!!! warning "Non-JSON servers can be learned but not ruled"

    Rules copy values out of a parsed result; they do not compute them. A server
    that answers in plain text keeps memorisation across repeats and nothing
    else.

The starter file is
[`speculate.config.example.json`](https://github.com/lukebward/speculate/blob/main/speculate.config.example.json).
