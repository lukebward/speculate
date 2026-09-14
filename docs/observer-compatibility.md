# Observer compatibility baseline

Checked 2026-09-14 against Speculate `0.22.0` at `d2445a52e9d1e5a9b158fdfa05c855064c23db55`. The local runtime was Node `v22.14.0` and npm `10.9.2`. The Headroom reference resolved to commit `aa4739e54ad46d48dd829f730af359c4824c04c4` with `git ls-remote https://github.com/headroomlabs-ai/headroom.git HEAD`.

The fixtures are sanitized protocol examples, not captured user traffic. IDs, prompts, headers, credentials, models, paths, and tool results are synthetic. No bearer token, account identifier, or transcript is stored.

## Tested matrix

| Client | Installed version | Offline model transport | Tool transport | Hooks | API-key forwarding | Native subscription forwarding |
| --- | --- | --- | --- | --- | --- | --- |
| Claude Code | `2.1.268` | Messages JSON and SSE pass through the loopback HTTP harness; count-tokens is described | Real MCP stdio round trip through Speculate and the mock GitHub server | Synthetic lifecycle/subagent fixture only; native ordering and permission behavior unverified | Unverified | Scratch HTTP relay passed with native `claude.ai`; production relay pending |
| Codex CLI | `0.154.0` | Responses JSON and SSE pass through the loopback HTTP harness; model listing is described; WebSocket continuation is fixture-only | Real MCP stdio round trip through Speculate and the mock GitHub server | Synthetic lifecycle/subagent fixture only; native ordering and trust behavior unverified | Unverified | Scratch WebSocket relay passed with native ChatGPT; production relay pending |

The unresolved API-key and production-relay forwarding rows block enabling the full model proxy by default. Hook-only observation can proceed independently. A separate isolated native Codex MCP smoke test passed, but that does not prove provider-request routing or account forwarding through the future relay.

Claude's current help exposes session-local `--settings`, `--mcp-config`, `--strict-mcp-config`, `--allowedTools`, `--disallowedTools`, `--permission-mode`, `--permission-prompts`, `--model`, `--betas`, stream JSON options, and `--agents`. Its documented gateway route uses `ANTHROPIC_BASE_URL`; a launcher must preserve auth variables and generated auth/version/beta headers.

Codex's current help exposes highest-precedence `-c key=value` overrides plus `--model`, `--profile`, `--sandbox`, `--ask-for-approval`, `--ephemeral`, `--ignore-user-config`, and `--ignore-rules`. Current configuration documents `openai_base_url` for the built-in provider and `model_providers.<id>.base_url` for custom providers. A launcher must preserve the selected provider, model, effort, credential source, and WebSocket setting.

The [CLI contract fixture](../test/fixtures/observer/client-cli-contracts.json) records command arguments, exit codes and public help/version output excerpts. [Native routing evidence](observer-native-routing.md) records the successful account smoke tests through a scratch relay.

Official contract references:

- [Claude LLM gateway](https://code.claude.com/docs/en/llm-gateway)
- [Claude hooks](https://code.claude.com/docs/en/hooks)
- [Claude settings](https://code.claude.com/docs/en/configuration)
- [Codex configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference)
- [Codex hooks](https://learn.chatgpt.com/docs/hooks)
- [Responses WebSocket mode](https://developers.openai.com/api/docs/guides/websocket-mode)
- [Headroom proxy reference](https://github.com/headroomlabs-ai/headroom/tree/aa4739e54ad46d48dd829f730af359c4824c04c4)

## Fixture and harness contract

[`claude.json`](../test/fixtures/observer/claude.json) covers a complete Messages request, prior tool results, tool aliases and schemas, deferred definitions, multiple streamed tool calls, partial JSON arguments, opaque thinking, auxiliary token counting, errors, cancellation, hooks, and subagents.

[`codex.json`](../test/fixtures/observer/codex.json) covers a complete Responses request, `previous_response_id` continuation, function outputs, aliases and schemas, deferred definitions, multiple calls, partial arguments, opaque encrypted reasoning, free-form code, SSE, WebSocket continuation, model listing, errors, cancellation, hooks, and subagents. WebSocket data is a transport description until Task 5 selects its dependency.

Each `createObserverHarness()` instance owns its servers, response queues, monotonic timestamps, temporary files, MCP clients, and cleanup. It exposes:

- `startProvider({ transport })` for loopback JSON or SSE HTTP. `websocket` fails explicitly until Task 5.
- `startToolServer({ alias, latencyMs })` for the real Speculate CLI over the existing synthetic GitHub MCP server.
- `exchange({ request, chunks, status?, headers?, provider? })` for an exact-byte request/response exchange. It returns response status/headers, the concatenated source and received buffers, provider call records, cancellation state, and monotonic request/chunk/completion times.
- `close()` to close clients and sockets and remove temporary files.

## Baseline evidence

`npm test -- test/observer-baseline.test.ts test/integration.test.ts` passed 2 files and 17 tests in 24.44 seconds. The provider cases proved exact request/response buffers, ordered SSE writes, and downstream cancellation before a later provider write. The MCP case proved literal result equality, a completed ready hit, an in-flight join, and write-triggered invalidation through the real proxy protocol. A standalone strict typecheck of the new helper and test also passed.

The pre-change full suite passed 43 files and 1,015 tests with 8 skipped in 85.53 seconds. The coordinator ran that suite before these fixtures were added; it is baseline evidence, not post-change verification.

`npm run bench:mock -- --latency 400` passed with 7 synthetic tool calls: 2.86 s tool wait with speculation off and 983 ms with strict speculation, 4 ready hits, 1 join, 7 speculative calls, and 0 recorded waste. This is a deterministic mock-mechanics baseline. It does not measure client task time, the new observer, real provider traffic, or a context-aware speedup.

Native account routing is proven through a scratch relay. Production relay authentication, live body normalization, native hook ordering, hook permission behavior, and lowest supported client versions remain unverified. Tasks 4 and 5 must extend or correct the synthetic fixtures from observed current-client behavior without checking credentials or user traffic into the repository.

Review regression tests passed 8/8 in 2.75 seconds, including HTTP status/header replay, multiple-provider selection, cancellation under backpressure and both streaming completion lifecycles. Strict TypeScript verification passed.
