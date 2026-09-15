# Observer compatibility

Checked 2026-09-14 with Claude Code 2.1.268, Codex CLI 0.154.0, and Node
22.14.0. Speculate 0.23.0 packages the experimental `run` observer described
here; the tested client versions identify the evidence and are not general
minimum-version claims.

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
| Observer performance benefit | Replay speedup/waste gates failed; native speedup unverified | Replay speedup/waste gates failed; native speedup unverified |

Native-account smoke checks ran on macOS. Native-account routing and MCP transfer both require a completed native response and the expected final output; process exit zero alone is insufficient. The transfer smoke passed all three public modes for both clients and observed no duplicate MCP execution. Its `registeredRoutes` field was sampled after child shutdown, so a zero there is not route-ownership history. Ownership was instead established by the fixture's wrapper initialization.

## Preserved native behavior

The launcher forwards native arguments and inherits the existing environment. It does not select a model, effort, provider, account, approval policy, sandbox, or transport. Proxy mode changes only the launched process's active base URL and forwards request and response bytes and end-to-end headers. Native account probes confirmed this path for Claude's current account route and Codex's built-in ChatGPT route without extracting or replacing credentials.

Model/provider discovery, retries, and inference remain client-owned. The relay does not automatically replay a partially forwarded request. A failed relay preflight falls back to hook mode; unsupported provider routing also remains hook-only. A later fresh launch constructs new temporary endpoints rather than reusing a failed launch's override. Recovery tests verify fresh-launch isolation, native retry boundaries, temporary-file cleanup, and revocation of queued, in-flight, and ready speculative work after detected tracking loss. The post-CI production snapshot `894a8e3` passed all 1,365 tests with 8 skipped; see the [verification artifact](observer-verification-results.json).

## Permission and configuration boundaries

Speculation still requires `readOnlyHint: true` and the host's effective permission for the specific tool route. Results are reused only when the requested arguments exactly match the speculative call; argument matching is separate from the host permission check.

For Claude, the launcher accepts only an exact existing MCP allow rule for speculative work. Deny, ask, approval-required, malformed, wildcard, managed-only, or otherwise ambiguous policy causes abstention. Without `--strict-mcp-config`, temporary launch MCP configuration retains inherited sources under their existing ownership and policy. With strict MCP configuration, only explicit per-run sources are considered; ambient servers are excluded. Authorization is checked again before speculative execution and before publishing a result.

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

The new observer remains experimental. The full replay passed correctness, no-extra-model-call, relay-overhead, and mixed-p95 gates for both clients, but failed median speedup and settled-waste gates. Native transfer is verified; native speedup, live API-key routing, and native hook delivery remain unverified. See [observer results](observer-results.md), [native routing](observer-native-routing.md), [native tool shapes](observer-native-tool-shapes.md), and the [sanitized transfer results](observer-native-transfer-results.json).

Official client contracts:

- [Claude LLM gateway](https://code.claude.com/docs/en/llm-gateway)
- [Claude hooks](https://code.claude.com/docs/en/hooks)
- [Claude settings](https://code.claude.com/docs/en/configuration)
- [Codex configuration](https://learn.chatgpt.com/docs/config-file/config-reference)
- [Codex hooks](https://learn.chatgpt.com/docs/hooks)
- [Responses WebSocket mode](https://developers.openai.com/api/docs/guides/websocket-mode)
