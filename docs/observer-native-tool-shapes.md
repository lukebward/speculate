# Native MCP tool shape probe

Tested 2026-09-14 with Claude Code 2.1.268 and Codex CLI 0.154.0. The sanitized machine-readable capture is [`native-tool-shapes.json`](../test/fixtures/observer/native-tool-shapes.json).

## Method and isolation

A temporary stdio MCP server exposed one tool under alias `shape_probe`:

```json
{
  "name": "lookup",
  "title": "Synthetic Lookup",
  "description": "Looks up one synthetic record.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "query": { "type": "string", "description": "Synthetic query." },
      "limit": { "type": "integer", "minimum": 1, "maximum": 3, "default": 1 }
    },
    "required": ["query"],
    "additionalProperties": false
  },
  "annotations": {
    "title": "Synthetic Lookup",
    "readOnlyHint": true,
    "destructiveHint": false,
    "idempotentHint": true,
    "openWorldHint": false
  }
}
```

Both clients ran in an empty temporary directory with a scratch-only MCP registration, no model override, no session persistence, hooks disabled for the invocation, and a prompt asking for `OK` without tool use. Claude used `--strict-mcp-config`; Codex used `--ignore-user-config`, which retains native authentication but excludes persistent MCP configuration. No durable client configuration or hook trust changed.

The local endpoint parsed each first model request in memory, selected only synthetic tool or namespace metadata, and discarded the body. It retained method/path, request count, and header names only. Header values, authentication values, system text, user text, model identity, and non-synthetic tool definitions were not retained. Codex's authenticated `/models` discovery request alone was forwarded to `chatgpt.com`; neither client's model-generation request was forwarded, so no paid/live model inference occurred. The fake supplied no model response; neither run is a completed model session, regardless of Codex returning exit code 0 after its failed WebSocket attempts.

## Claude: flat MCP name and inline schema

Claude sent the synthetic tool directly in the top-level model request `tools` array at `$.tools[23]`:

```json
{
  "name": "mcp__shape_probe__lookup",
  "description": "Looks up one synthetic record.",
  "input_schema": {
    "type": "object",
    "properties": {
      "query": { "type": "string", "description": "Synthetic query." },
      "limit": { "type": "integer", "minimum": 1, "maximum": 3, "default": 1 }
    },
    "required": ["query"],
    "additionalProperties": false
  }
}
```

Observed facts:

- Alias and tool use the flat canonical name `mcp__<alias>__<tool>`; the underscore in `shape_probe` is preserved.
- MCP `inputSchema` becomes Anthropic `input_schema` without structural changes in this fixture.
- MCP `title` and `annotations` were absent from the model-facing tool definition. `description` remained verbatim.
- The MCP server completed `initialize`, `notifications/initialized`, and `tools/list` before the request (the captured model shape itself also proves the list result was consumed).

The fake returned an error, so Claude made two `POST /v1/messages` attempts and exited 1. It also made one `HEAD /api/hello`. Model-request header names were:

`accept`, `accept-encoding`, `anthropic-beta`, `anthropic-dangerous-direct-browser-access`, `anthropic-version`, `authorization`, `connection`, `content-length`, `content-type`, `host`, `user-agent`, `x-app`, `x-claude-code-session-id`, `x-stainless-arch`, `x-stainless-lang`, `x-stainless-os`, `x-stainless-package-version`, `x-stainless-retry-count`, `x-stainless-runtime`, `x-stainless-runtime-version`, `x-stainless-timeout`.

The current flat `mcp__alias__tool` fixtures therefore match Claude's actual model wire shape.

## Codex: deferred tools behind `functions.exec`

Codex also completed MCP `initialize`, `notifications/initialized`, and `tools/list`. Nevertheless, the synthetic alias string and its schema were absent everywhere in each captured Responses WebSocket request.

Instead, the request had this sanitized structure at `$.input[0].tools[0]`:

```json
{
  "type": "namespace",
  "name": "functions",
  "tools": [
    { "type": "custom", "name": "exec", "format": "<custom grammar>" },
    { "type": "function", "name": "wait", "parameters": {}, "strict": "<boolean>" },
    { "type": "function", "name": "request_user_input", "parameters": {}, "strict": "<boolean>" },
    { "type": "function", "name": "request_user_input_async", "parameters": {}, "strict": "<boolean>" }
  ]
}
```

The observed `functions.exec` description says that nested tools are exposed on the JavaScript `tools` object, names are normalized to identifiers such as `mcp__…`, deferred nested tools may be omitted from the description, and `ALL_TOOLS` enumerates callable nested tools. Only those boolean characteristics were retained; the description itself was discarded.

Therefore:

- Codex 0.154.0 does not send this MCP tool as a flat Responses function definition on the initial request, despite having already fetched the MCP tool list.
- The first model-visible callable is the custom `functions.exec` tool inside the `functions` namespace. The per-MCP alias/schema is deferred behind that runtime.
- It is a supported inference from the `exec` contract that this route's runtime identifier is `tools.mcp__shape_probe__lookup`. This probe did not fabricate a model response or execute a tool, so the exact emitted `functions.exec` argument text for a real MCP invocation remains unverified.
- Task 4/5 fixtures should represent the observed namespace/custom-tool envelope. A flat Codex `mcp__alias__tool` tool-call fixture is not representative of the initial native model request. Opaque `functions.exec` code remains observation-only and is never evaluated or prefetched.

Codex made one authenticated `GET /models`, then three WebSocket upgrades to `GET /responses` after the fake closed each request without a response. Model-discovery header names were `accept`, `authorization`, `chatgpt-account-id`, `host`, `originator`, `user-agent`, `version`. WebSocket header names were `authorization`, `chatgpt-account-id`, `connection`, `host`, `openai-beta`, `originator`, `sec-websocket-extensions`, `sec-websocket-key`, `sec-websocket-version`, `session-id`, `thread-id`, `upgrade`, `user-agent`, `version`, `x-client-request-id`, `x-codex-beta-features`, `x-codex-routing-hint`, `x-codex-turn-metadata`, `x-codex-window-id`.

## Fixture consequence

Use one host-specific normalization boundary:

```ts
type NativeObservedTool =
  | { client: 'claude'; canonicalName: string; inputSchema: unknown }
  | { client: 'codex'; namespace: 'functions'; customTool: 'exec'; deferred: true };
```

Claude can map the model request name directly to `(alias, tool)`. Codex must retain wrapper/bridge route identity separately and must not claim that a flat name was observed in the first provider request. The model relay can observe `functions.exec` context and boundaries while abstaining from extracting executable calls. Prompt and transition prediction can use the live MCP registry independently; direct stream prediction requires a visible, complete structured tool call with a verified route and schema.

## Claude temporary alias ownership

A separate isolated Claude 2.1.268 startup probe verified `claude --print --mcp-config=<path>` without `--strict-mcp-config`. Synthetic inherited user configuration and temporary launch configuration both defined `dup_alias`; each also defined a distinct alias.

| Definition | Initialized and listed | Advertised to provider |
| --- | --- | --- |
| Inherited `dup_alias` | No | No |
| Temporary `dup_alias` | Yes | Yes |
| Distinct inherited alias | Yes | Yes |
| Distinct temporary alias | Yes | Yes |

The temporary duplicate therefore owns the launch route while unrelated inherited aliases remain present. The fake provider returned HTTP 400 after recording only synthetic tool names; no model inference occurred. The probe used temporary configuration, a synthetic API sentinel, and loopback endpoints, then removed its scratch files. This verifies registration precedence, not tool preauthorization or every plugin/connector source.

`claude mcp list` did not apply the launch table and was unsuitable for this check. The actual `--print` startup provided the evidence above.

## Codex execution window

A separate Codex 0.154.0 native-account invocation through the production relay completed one synthetic local MCP lookup and returned the expected final `OK`. The process exited 0 after 9.36 seconds and emitted `turn.completed`. Authentication, model, and effort remained native; the probe used an ephemeral read-only session and disabled hooks.

| Relative time | Boundary |
| --- | --- |
| 6,905 ms | Completed provider `custom_tool_call` named `exec` |
| 6,957 ms | Its provider response completed |
| 7,187–7,264 ms | Actual local MCP call |
| 7,278 ms | Next `response.create`, referencing the completed response |

The completed-response to linked-continuation window enclosed the entire MCP call. One verified thread and the response chain supplied context; no `stream_id` appeared. Native CLI MCP lifecycle events bracketed the local call within 1–2 ms. Provider events alone exposed neither the nested route nor its actual execution interval.

This establishes an ordinary execution window, not safe correlation for arbitrary parallel or subagent activity. Production correlation still requires wrapper-authoritative route, arguments, and timing, full interval containment, and unambiguous context tracking. Missing boundaries or overlapping possible contexts must abstain. The probe did not inspect or retain the opaque program, prompts, arguments, results, credentials, or response text; only the final equality check and sanitized lifecycle evidence were retained.
