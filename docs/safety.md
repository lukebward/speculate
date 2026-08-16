# Safety

The single most important rule: **a speculative call may only be issued if
Speculate affirmatively classifies the tool as read-only.** The failure mode
being prevented — speculatively firing a mutation the agent never requested — is
unrecoverable, so the policy is default-deny: unknown means no.

!!! danger "Speculating on writes is a permanent non-goal"

    This is not an MVP restriction to relax later. Executing a
    `create_*`/`update_*`/`delete_*` call the agent never made is unacceptable
    regardless of how confident the prediction is. Serving *cached reads* is a
    freshness trade-off; *executing writes* speculatively is a correctness
    violation.

## Eligibility

A tool is eligible only if both hold:

1. **Annotation check** — the tool's declared annotations include
   `readOnlyHint: true`. Tools with no annotations, or with `readOnlyHint`
   absent or false, are ineligible.
2. **Operator policy** — one of three modes:

| Mode | Behavior |
|---|---|
| `strict` | The tool must **also** be on an explicit `allowTools` allowlist |
| `annotated` | Annotation alone suffices unless the tool is denylisted (the zero-config default) |
| `off` | No speculation; pure pass-through proxy |

!!! warning "Annotations are untrusted hints"

    The MCP spec is explicit about this, which is why the annotation check alone
    is insufficient. In `annotated` mode a *falsely* annotated tool is doubly
    dangerous — it becomes speculation-eligible **and** stops triggering cache
    invalidation. That compounding is why `strict` exists.

## Hard rules, regardless of mode

- **Real calls are never blocked, transformed, or reordered** — including
  mutations. Speculate is a proxy first.
- **Speculative results are never fabricated or merged.** A cache hit returns
  exactly the bytes the upstream server returned earlier; a miss goes upstream.
  Speculate never synthesizes tool output.
- **Every real call is forwarded verbatim**, writes included, and the cache is
  flushed on any mutation.
- **Auth errors suspend, successes reset.** A speculative call failing with an
  auth or permission error is dropped (not cached) and that tool is suspended
  from speculation until a subsequent *real* call to the same tool succeeds.
- **Server→client requests from a speculative call are aborted, never
  surfaced.** The client never asked, so nothing may reach it — and a tool that
  needs user interaction is by definition not prefetchable.

## What the cache holds

Cached results are byte-identical, single-use, short-lived, and never hit the
disk. What Speculate persists is tool names and argument templates — never
results.

## Credentials

Speculate registers as its own OAuth client and never reads another
application's credential store, so refreshing its token cannot disturb Claude
Code's.

## Risks that read-only does not solve

!!! danger "Speculation reveals intent"

    A speculative call discloses to the upstream service — before the agent
    commits to anything — what the user is *probably* about to do. "Read-only"
    bounds state mutation, not information disclosure.

    Speculate's position: speculation only targets servers the session is
    already sending real traffic to, never a server the agent hasn't touched.
    Privacy-sensitive deployments should use per-server denylists or `off`.
    Documented, not solved.

**Reads with side effects.** Even a "read" can write an audit-log entry, trip a
read receipt, consume usage-based billing, or eat rate limit. This is why
`strict` mode requires human allowlisting and why per-server budgets exist.
Gmail's own prefetching produces 1–6% "false opens" in email analytics — the
cautionary example.

The full threat model, including the bounded latency cost on serial stdio
upstreams, is in the [design spec](design/index.md).
