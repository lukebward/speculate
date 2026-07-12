# Live GitHub E2E Test — Design Spec

- **Date:** 2026-07-12
- **Status:** Design approved; pending implementation plan
- **Topic:** Real end-to-end speculation test against real GitHub (no injected latency)

## Context

The benchmark (`bench/bench.ts`) and integration tests exercise speculation against
`mock/mock-github.ts`, a stand-in MCP server that injects per-call latency with
`setTimeout` (`SPECULATE_MOCK_LATENCY_MS`). That proves the mechanism deterministically
but never touches a real upstream. We want an end-to-end test that drives speculation
against a **real** MCP server doing **real** work, so latency is genuine rather than
hardcoded.

## Goal

A gated, flake-resistant e2e test that replays a GitHub lister→getter session through
the speculate proxy against **real GitHub**, and asserts:

1. the getter call is served from a prefetch (speculation actually fired), and
2. the prefetch-served bytes are identical to a direct, unwrapped upstream call,

while **measuring but not asserting** the latency delta (off vs on).

## Non-goals

- Not replacing the mock/bench — they remain the deterministic, hermetic baseline.
- Not asserting a latency number (network jitter would flake CI).
- No changes to `src/` (profiles, learner, proxy). Purely additive test (+ optional npm script).
- Not installing the real `github-mcp-server`; reuse speculate's bundled `gh` tools.

## Chosen approach

**Upstream = speculate's bundled shell server, driven against real GitHub via `gh`.**

- Reuses already-authenticated infrastructure (`gh` CLI); zero install.
- The shell server exposes `gh_pr_list` / `gh_pr_view` / `gh_issue_list` / `gh_issue_view`
  (`shell/catalog.ts`), each a fixed `gh … --json …` command registered with
  `readOnlyHint: true`.

### Two design-critical constraints (discovered during scoping)

**A. gh tools have no repo parameter.** `gh_pr_list` is
`gh pr list --json number,title,author,updatedAt`; its only params are `limit`/`state`.
The target repo is selected by the ambient `gh` context, injected as
**`GH_REPO=<owner/repo>`** in the server process env (documented `gh` override).
Default `cli/cli`, overridable via `SPECULATE_E2E_REPO`.
- Fallback if `GH_REPO` is insufficient: a per-test `--commands` registry file with the
  repo baked into the command line (still read-only; repo is not a model-supplied param).

**B. No curated gh prediction rule.** `src/profiles/shell.ts` pairs only git/fs tools
(`status→diff`, `log→show`, …). There is no `gh_*_list → gh_*_view` prior, so speculation
must come from the **learner**, which arms a pair only after one sighting. The session
therefore runs each pair **twice**: a warm-up pass (teaches the transition + arg-flow) and
a measured pass (hits).

### Harness

Spawn the proxy over stdio (same pattern as `bench.ts` / `integration.test.ts`):

- Proxy config: one server `workspace` = `tsx shell/speculate-shell.ts` (server cwd = repo
  root so the `gitRemote:/github/i` probe enables the gh tools),
  `env: { GH_REPO: <repo> }`, `mode: 'annotated'` (gh tools are `readOnlyHint`-annotated,
  hence eligible without a strict allowlist), `persistence: { enabled: false }` (hermetic,
  in-process learning).
- Client: `StdioClientTransport` → `src/cli.ts --config <tmp>`.

### Session script (per pair, e.g. PRs)

The learner grounds a getter's args from the trigger's parsed result — it records `arg`,
`parsed`-path, and `const` candidate sources — and arms a non-primed pair after ~2
observations. So each pass derives the view's `number` from *that pass's own* list result,
which is exactly what the learner's parsed-path prediction resolves to; this also makes it
immune to PR-list reordering between passes.

1. **Warm-up ×2:** twice — `gh_pr_list` → read top PR `number` from *its* result →
   `gh_pr_view({ number })`. Teaches the `gh_pr_list → gh_pr_view` transition and its
   parsed-path arg source.
2. **Think-gap ≈ 500 ms** — models *agent* think-time, NOT injected upstream latency; the
   window during which the prefetch runs.
3. **Measured:** `gh_pr_list` → read top PR `number` from *its* result →
   `gh_pr_view({ number })` ← expected prefetch hit (the learner predicted `gh_pr_view`
   for that same top PR).

Repeat the same shape for `gh_issue_list → gh_issue_view`.

### Assertions (flake-resistant)

- **Speculation fired:** `speculate__stats` shows `hits ≥ 1`, and a
  `learned:*gh_pr_list→gh_pr_view` (and issue equivalent) rule with `hits ≥ 1`.
  Tolerance: accept `hits + joins ≥ 1` if the think-gap yields an in-flight join rather
  than a clean hit.
- **Byte-correct:** capture the measured-pass `gh_pr_view(N)` result; separately call an
  **unwrapped** shell server for `gh_pr_view(N)`; assert the serialized result text is
  **byte-identical** (speculate's stated guarantee). Same N, seconds apart → stable.

### Latency (report-only)

Run one `mode: 'off'` pass of the same session; print an off-vs-on per-call table and
`estimatedSavedMs` (bench-style). **Not asserted.**

### Gating (keeps `npm test` hermetic)

`describe.skipIf(...)` — skip unless ALL of:

- `process.env.SPECULATE_E2E_LIVE === '1'` (opt-in),
- `gh auth status` exits 0,
- target repo returns ≥1 open PR and ≥1 open issue (probed once at setup).

Log a clear skip reason. Add an optional `package.json` script `test:e2e`.

## Files

- **New:** `test/e2e-github-live.test.ts`
- **Optional edit:** `package.json` (add `test:e2e` script)
- **Unchanged:** all of `src/`, `shell/`, `mock/`, `bench/`

## Success criteria

- With `SPECULATE_E2E_LIVE=1` + authed `gh` + reachable network: test passes, asserting a
  real prefetch hit and byte-identical results against real GitHub.
- Without those: test skips cleanly; `npm test` unaffected (hermetic, offline-safe).
- Zero `src/` changes.

## Risks / mitigations

| Risk | Mitigation |
|------|------------|
| Network / rate limits | One session = a handful of gh reads; gated + opt-in. |
| PR/issue list reordering between passes | Derive the view's `number` from each pass's own list result, so the learner's parsed-path prediction matches by construction. |
| Clean hit vs in-flight join | Think-gap tuned; assertion tolerant of `hits + joins`. |
| `GH_REPO` ineffective | Fallback to a `--commands` registry file with repo baked in. |
| First-sighting learner miss | Explicit two-pass session (warm-up then measured). |

## Verification during implementation

- Confirm `GH_REPO` redirects the fixed `gh` command (else use the `--commands` fallback).
- Confirm a single think-gap reliably yields a clean `hit` (else assert `hits + joins ≥ 1`).
- Confirm the bundled shell server enables gh tools when cwd has a GitHub remote.
