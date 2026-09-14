# Native account routing through a transparent loopback relay

Tested 2026-09-14 with Claude Code `2.1.268` authenticated through `claude.ai` and Codex CLI `0.154.0` authenticated through ChatGPT. Authentication status was supplied through sanitized CLI status; no credential store or token value was read.

Both tests used an empty temporary working directory, a tiny prompt requesting only `OK`, no explicit model override, a 120-second process cap, discarded native-client stdout/stderr, and a scratch HTTP/WebSocket relay bound to `127.0.0.1`. The relay streamed request and response bytes without inspecting or logging bodies. It recorded only method, destination path, status, transport, and header names. No durable client configuration was written.

## Claude Code native subscription

Launch isolation:

- `--safe-mode` disabled customizations, hooks, and MCP while retaining native auth and model selection.
- `--no-session-persistence` prevented transcript persistence.
- `--tools ""` removed tool definitions for the smoke.
- Only `ANTHROPIC_BASE_URL` was changed, pointing at the loopback relay. The relay forwarded to `https://api.anthropic.com`.
- No API key, auth token, OAuth token, provider, or model variable/flag was added or changed.

Observed traffic:

1. `HEAD /api/hello` -> `200`.
2. Two `POST /v1/messages?beta=true` requests -> `200` for both.
3. Claude exited `0`, without timeout or signal.

Observed model-request header names:

`accept`, `accept-encoding`, `anthropic-beta`, `anthropic-dangerous-direct-browser-access`, `anthropic-version`, `authorization`, `connection`, `content-length`, `content-type`, `host`, `user-agent`, `x-app`, `x-claude-code-session-id`, `x-stainless-arch`, `x-stainless-lang`, `x-stainless-os`, `x-stainless-package-version`, `x-stainless-retry-count`, `x-stainless-runtime`, `x-stainless-runtime-version`, `x-stainless-timeout`.

Conclusion: Claude's existing `claude.ai` subscription credential and native model selection work through an `ANTHROPIC_BASE_URL` loopback relay to `api.anthropic.com`. The relay must preserve the authorization, Anthropic beta/version, and Claude session-id headers and the request bytes. This smoke selected HTTP streaming; it did not exercise Bedrock, Vertex, Foundry, custom gateways, or an Anthropic WebSocket path.

## Codex native ChatGPT account

Launch isolation:

- `codex exec --ephemeral` prevented session persistence.
- The run used an empty non-repository directory, ignored execpolicy rules, disabled hooks for this invocation, and selected the read-only sandbox with `approval_policy="never"`.
- Only `openai_base_url` was changed with a session-only `-c` override pointing at the loopback relay. The relay forwarded to `https://chatgpt.com/backend-api/codex`.
- No API key, auth token, provider, profile, model, or transport override was added or changed.

Observed traffic:

1. Two authenticated `GET /backend-api/codex/models?client_version=0.154.0` requests -> `200` for both.
2. Codex selected WebSocket itself and requested `GET /backend-api/codex/responses` -> `101 Switching Protocols`.
3. Codex completed over the tunneled WebSocket and exited `0`, without timeout or signal.

Observed model-discovery request header names:

`accept`, `authorization`, `chatgpt-account-id`, `host`, `originator`, `user-agent`, `version`.

Observed Responses WebSocket request header names:

`authorization`, `chatgpt-account-id`, `connection`, `host`, `openai-beta`, `originator`, `sec-websocket-extensions`, `sec-websocket-key`, `sec-websocket-version`, `session-id`, `thread-id`, `upgrade`, `user-agent`, `version`, `x-client-request-id`, `x-codex-beta-features`, `x-codex-routing-hint`, `x-codex-turn-metadata`, `x-codex-window-id`.

Observed upgrade response header names:

`cf-cache-status`, `cf-ray`, `connection`, `cross-origin-opener-policy`, `date`, `nel`, `referrer-policy`, `report-to`, `sec-websocket-accept`, `sec-websocket-extensions`, `server`, `set-cookie`, `strict-transport-security`, `upgrade`, `x-content-type-options`, `x-models-etag`, `x-openai-proxy-wasm`.

Conclusion: for the built-in OpenAI provider under a native ChatGPT account, a session-only `openai_base_url` override routes model discovery and the client-selected Responses WebSocket through loopback while retaining native account headers and model/provider selection. Production proxy mode must support `/models` plus WebSocket upgrade and bidirectional frames; forcing HTTP would break native transport parity.

## Launcher implications

- The two native subscription paths are viable without credential extraction or replacement: override only the active base URL, forward bytes and all end-to-end headers, and restore nothing because the override exists only in the launched child.
- A launch-owned relay can correlate Claude by `x-claude-code-session-id`. Codex runtime traffic provides `session-id`, `thread-id`, `x-codex-turn-metadata`, `x-client-request-id`, and `x-codex-window-id`; preserve them and use only the minimum stable identifiers after fixtures establish lifecycle behavior.
- Codex's upstream base includes `/backend-api/codex`; the relay must prepend that base path when forwarding the relative `/models` and `/responses` requests generated from the loopback `openai_base_url`.
- Keep hook-only fallback for failed relay health, unsupported providers, or unavailable transport support. Provider-specific Claude cloud routes and Codex custom providers still require their own fixtures.
- Initial parser-only attempts exited before contacting a model endpoint: Claude's variadic `--tools` consumed a trailing prompt until argument order was corrected, and `codex exec` rejected the top-level-only `--ask-for-approval` flag. Neither attempt made a model request.
