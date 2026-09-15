# Speculate

[![npm](https://img.shields.io/npm/v/speculate-mcp)](https://www.npmjs.com/package/speculate-mcp)
[![CI](https://github.com/lukebward/speculate/actions/workflows/ci.yml/badge.svg)](https://github.com/lukebward/speculate/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/speculate-mcp)](LICENSE)

Speculate is a local Model Context Protocol (MCP) proxy that reduces tool wait.
It learns likely read-only calls from your traffic, starts useful calls early,
and serves only exact upstream results when the agent asks for them.

![Demo: repeated GitHub workflow with prefetched results](https://raw.githubusercontent.com/lukebward/speculate/main/demo/speculate-demo.gif)

## Quick start

Requires Node.js 18 or later:

```bash
npm install -g speculate-mcp
speculate run claude
# or
speculate run codex
```

`speculate run` starts the native client with context-aware prefetching. At
launch, it requests model-proxy mode, activates it only after verifying the
native route and temporary controls, and otherwise starts with supported hooks.
The launcher preserves the native account, provider, model, effort, arguments,
permission policy, sandbox, and transport selection.

```bash
speculate run claude --observe hooks   # require hook observation
speculate run codex --observe off -- exec  # disable session observation
```

The active observation mode is reported at startup. See
[Getting started](https://lukebward.github.io/speculate/getting-started/) for
client-specific scope, supported signals, and persistent MCP setup.

## Choose how to use Speculate

### Context-aware sessions

Use native arguments after `--`:

```bash
speculate run claude -- --print "Summarize this workspace."
speculate run codex -- exec "Summarize this workspace."
```

Add `--json-report <path>` before `--` for an aggregate session report.
`--observe hooks` selects supported native hooks explicitly. `--observe off`
retains ordinary MCP prediction while disabling session observation.

For speculative work, Speculate requires host permission for the specific tool
route as well as its read-only policy. Reusing a result separately requires an
exact argument match. It never acquires native credentials or adds permissions.
Codex's native opaque executor does not expose individual streamed MCP calls,
so prompt and learned-transition signals remain its supported native paths.

Context-aware prefetching is Speculate's standard native session path. Its
model and hook observation stages still have measured limits: native MCP
transfer and result integrity passed for both clients, while native day-to-day
speedup, native hook delivery, and live API-key routing remain unverified. See the
[observer results](https://lukebward.github.io/speculate/observer-results/) and
[compatibility matrix](https://lukebward.github.io/speculate/observer-compatibility/).

### Persistent MCP setup for Claude Code and Codex

Use `speculate on` to install persistent wrappers for supported MCP servers:

```bash
speculate on                       # enable both clients
speculate status                   # inspect both clients
speculate on --client claude       # target only Claude Code
speculate on --client codex        # target only Codex
speculate off                      # restore managed registrations for both
```

`on`, `off`, `status`, `sync`, and `auth` accept
`--client claude|codex|both`. Registration-sync hooks discover newly added
supported servers; `on` by itself does not add model or conversation
observation. Restart the clients after setup. In Codex, review and trust the
Speculate registration-sync hook through `/hooks`; Speculate does not approve
it for you. A newly wrapped server may take another session to load.

Claude Code setup covers user servers and approved servers in known projects.
Codex setup covers enabled user-level servers on the same host. Built-in tools,
shell commands, hosted connectors, and unsupported registrations remain outside
MCP wrapping.

### Other MCP clients

For another client that launches stdio servers, replace the server command and
arguments with a wrapper entry:

```json
{
  "command": "npx",
  "args": ["-y", "speculate-mcp", "wrap", "--", "github-mcp-server", "stdio"]
}
```

Keep the server's existing environment and arguments. Remote Streamable HTTP
servers use `wrap --url`; the [setup guide](https://lukebward.github.io/speculate/getting-started/)
covers headers, OAuth, and migration from retired launch paths.

## How it works

Speculate learns repeated call sequences per workspace, upstream, and account.
It can also use explicit prediction rules. A prediction must identify a tool
and exact arguments. If the result is ready, the real call consumes it from a
short-lived, single-use memory buffer. If it is still running, the real call
joins it. A miss goes upstream normally.

Calls classified as mutations clear that server's buffer. Speculate never
generates or combines tool results, and it does not make predictor model calls.

## Safety and local data

Speculative calls require `readOnlyHint: true`. Managed `on` and `wrap` setup
defaults to `annotated` mode, which trusts that server hint; an explicit config
file defaults to `strict`, which also requires an allowlist. Incorrect
annotations can make unsafe tools eligible, and reads can still disclose
intent, consume quota, incur charges, or have service-visible effects.

Full tool results stay in bounded session memory. Learned patterns persist
locally and can include private argument values despite secret filtering.
Registration backups and Speculate OAuth credentials are stored separately.
See [Safety and storage](https://lukebward.github.io/speculate/safety/) before
enabling speculation on sensitive or metered servers.

## Evidence and status

Measured benefit depends on the workload. The maintained core qualification
preserved the v0.20 predictor's behavior. A separate 1,000-record observer
replay passed correctness checks but failed its speedup and speculative-waste
gates for both clients. A later 60-record synthetic multi-turn diagnostic
reduced warm cross-server task time by about 40% for both client fixtures, with
all 66 speculative calls consumed. That diagnostic used fixed synthetic timing
and is not native performance evidence.

Run `speculate stats` to inspect useful predictions, waste, and estimated time
saved. Use `speculate doctor --config <path>` to diagnose an explicit wrapper
configuration, and `speculate status` to inspect managed activation. The
[benchmark documentation](https://lukebward.github.io/speculate/design/local-learning-benchmark/)
records methods, historical results, and limitations.

## Documentation

- [Getting started](https://lukebward.github.io/speculate/getting-started/)
- [Commands](https://lukebward.github.io/speculate/commands/)
- [Configuration](https://lukebward.github.io/speculate/configuration/)
- [Safety](https://lukebward.github.io/speculate/safety/)
- [Design](https://lukebward.github.io/speculate/design/)
- [Contributing](CONTRIBUTING.md)

[MIT license](LICENSE)
