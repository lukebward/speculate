# Observer compatibility

Checked 2026-09-14 with Claude Code 2.1.268, Codex CLI 0.154.0, Node 22.14.0, and the unreleased source-built session launcher. Published Speculate 0.22.0 does not include the experimental `run` observer described here.

Fixtures and reports contain synthetic protocol data or aggregate counters. Raw prompts, tool arguments and results, reasoning, headers, credentials, account identifiers, and transcripts are not written to observer reports.

## Current matrix

| Capability | Claude Code 2.1.268 | Codex CLI 0.154.0 |
| --- | --- | --- |
| Default launch mode | Hook observation | Hook observation |
| Explicit model proxy | Messages JSON/SSE and native account route passed | Responses JSON/SSE/WebSocket and native ChatGPT account route passed |
| Registered MCP transfer | One correct wrapper-owned read in off/hooks/proxy; one upstream call | One correct wrapper-owned read in off/hooks/proxy; one upstream call |
| Native stream-call shape | Flat `mcp__alias__tool` name and inline schema verified | MCP tools deferred behind opaque `functions.exec`; direct native stream-call prediction unavailable |
| Flat Responses function fixture | Not applicable | Supported API variant only; not the installed native default |
| Native hooks | Temporary configuration supported; live delivery gate pending | Temporary configuration supported only when already trusted; live delivery gate pending |
| Live API-key forwarding | Unverified; no key was available | Unverified; no key was available |
| Provider variants | Bedrock, Vertex, Foundry, and custom gateways unverified | Custom providers and non-ChatGPT account routes unverified |
| Observer performance benefit | Pending | Pending |

Native-account routing and MCP transfer both require a completed native response and the expected final output; process exit zero alone is insufficient. The transfer smoke passed all three public modes for both clients and observed no duplicate MCP execution. Its `registeredRoutes` field was sampled after child shutdown, so a zero there is not route-ownership history. Ownership was instead established by the fixture's wrapper initialization.

## Preserved native behavior

The launcher forwards native arguments and inherits the existing environment. It does not select a model, effort, provider, account, approval policy, sandbox, or transport. Proxy mode changes only the launched process's active base URL and forwards request and response bytes and end-to-end headers. Native account probes confirmed this path for Claude's current account route and Codex's built-in ChatGPT route without extracting or replacing credentials.

Model/provider discovery, retries, and inference remain client-owned. The relay does not automatically replay a partially forwarded request. A failed relay preflight falls back to hook mode; unsupported provider routing also remains hook-only. A later fresh launch constructs new temporary endpoints rather than reusing a failed launch's override. Task 9 recovery verification is still in progress, so these are conservative operating rules rather than a completed recovery gate.

## Permission and configuration boundaries

Speculation still requires `readOnlyHint: true` and the host's effective permission for the exact route and arguments.

For Claude, the launcher accepts only an exact existing MCP allow rule for speculative work. Deny, ask, approval-required, malformed, wildcard, managed-only, or otherwise ambiguous policy causes abstention. Temporary launch MCP configuration is merged without `--strict-mcp-config`, so unrelated inherited tools remain under Claude's existing ownership and policy.

For Codex, enabled/disabled tool lists and per-tool approval modes are read from native effective configuration. Prompted or denied tools are not speculated. Temporary hooks require native trust; the launcher does not bypass it. Config forms whose precedence cannot be verified are forwarded unchanged while the affected observer capability abstains.

Codex 0.154.0 treats quotes in a `-c` MCP alias path as literal alias characters. The launcher emits verified bare segments only and leaves unsupported alias segments native. It also abstains for unsupported config-source arguments rather than reconstructing user configuration. Existing model, effort, account, WebSocket selection, sandbox, and approval policy remain unchanged.

## Tool-shape boundary

Claude advertises MCP tools as flat model-facing names with their schemas, so a complete structured tool call can be correlated directly to a registered route.

Installed Codex 0.154.0 advertises a custom `functions.exec` tool and defers individual MCP registrations behind it. The observer preserves that free-form program unchanged and never parses, evaluates, or speculatively executes it. Prompt and transition observations can still predict registered read-only MCP routes. Flat Responses function-call fixtures exercise a supported API form, but they do not establish native-default Codex stream-call coverage.

## Diagnostics and limits

`speculate run` supports `--observe off|hooks|proxy` and an optional `--json-report <path>`. Hook mode is the default. Off mode disables the new observers while retaining existing Speculate prediction; it is not a no-Speculate control. Proxy mode reports an explicit downgrade when its route or preflight cannot be verified.

Reports contain client/version, requested and active mode, transport, aggregate source counts, aggregate relay counts, disabled-capability reasons, and exit status. They do not contain route names, prompts, arguments, results, model text, headers, or credentials. Full results stay in the existing bounded, short-lived in-memory cache.

Prediction remains local and does not make an additional model call. Existing
cache lifetime, concurrency, rate, retained-byte, and observation-size limits
remain in force for observer-triggered work.

The new observer remains experimental. Correct native transfer is verified, while deterministic observer benefit, relay p95 overhead, mixed-task regression, settled waste, live API-key routing, and recovery gates remain pending. See [observer results](observer-results.md), [native routing](observer-native-routing.md), [native tool shapes](observer-native-tool-shapes.md), and the [sanitized transfer results](observer-native-transfer-results.json).

Official client contracts:

- [Claude LLM gateway](https://code.claude.com/docs/en/llm-gateway)
- [Claude hooks](https://code.claude.com/docs/en/hooks)
- [Claude settings](https://code.claude.com/docs/en/configuration)
- [Codex configuration](https://learn.chatgpt.com/docs/config-file/config-reference)
- [Codex hooks](https://learn.chatgpt.com/docs/hooks)
- [Responses WebSocket mode](https://developers.openai.com/api/docs/guides/websocket-mode)
