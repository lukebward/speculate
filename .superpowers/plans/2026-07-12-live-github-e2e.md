# Live GitHub E2E Test Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a gated end-to-end test that drives speculation through the proxy against speculate's own bundled `gh` server hitting **real GitHub** (real latency, no injected `setTimeout`), asserting a real prefetch hit and byte-identical results.

**Architecture:** One new vitest file spawns `src/cli.ts` (the proxy) over stdio wrapping `shell/speculate-shell.ts` (the bundled workspace server) in `annotated` mode, pointed at a real repo via `GH_REPO`. It replays a lister→getter session (`gh_pr_list`→`gh_pr_view`, `gh_issue_list`→`gh_issue_view`), lets the **learner** arm the pair over two warm-up cycles, then asserts the measured getter is served from a prefetch and matches a direct unwrapped call. No `src/` changes.

**Tech Stack:** TypeScript, vitest, `@modelcontextprotocol/sdk` (Client + StdioClientTransport), `tsx`, the `gh` CLI.

## Global Constraints

- **No `src/` changes.** Additive only: one new test file + one `package.json` script. Do not touch `src/`, `shell/`, `mock/`, `bench/`, or any profile/learner code.
- **Branch:** all work on `test/live-github-e2e`; never commit to `main`. Commits follow the user's git workflow (confirm before pushing; no AI-attribution trailers).
- **Gating:** the live test runs only when `SPECULATE_E2E_LIVE=1` **and** `gh auth status` succeeds. Otherwise it skips cleanly so plain `npm test` stays hermetic and offline-safe.
- **Target repo:** `process.env.SPECULATE_E2E_REPO ?? 'cli/cli'`, injected as `GH_REPO` in the wrapped server's env.
- **Determinism rules (copied from spec):** two warm-up cycles; derive each `gh_*_view` `number` from *that pass's own* list result; assert via `speculate__stats` (`hits + joins ≥ 1` and a `learned:` rule), **not** via wall-clock thresholds (latency is logged, never asserted).
- **Requires devDeps** (`tsx` at `node_modules/.bin/tsx`) — present after `npm install`.
- **TDD note:** this file *is* the deliverable and exercises already-shipped behavior against a live upstream, so each task's "run" step validates the real path (green). Each task lists a concrete fallback if the live run is red.

---

### Task 1: Harness, gating, and tool-exposure check

**Files:**
- Create: `test/e2e-github-live.test.ts`

**Interfaces:**
- Produces (used by later tasks, exact names/signatures):
  - `const ROOT: string`, `const TSX: string`, `const REPO: string`, `const THINK_GAP_MS = 500`
  - `const LIVE: { ok: boolean; reason: string }`
  - `startWrappedShell(mode: 'annotated' | 'off'): Promise<{ client: Client; dir: string }>`
  - `timedCall(client: Client, name: string, args: Record<string, unknown>): Promise<{ ms: number; result: CallToolResult }>`
  - `payloadText(result: CallToolResult): string`
  - `parsePayload<T>(result: CallToolResult): T`
  - `readStats(client: Client): Promise<StatsReport>`
  - `topNumber(client: Client, listTool: 'gh_pr_list' | 'gh_issue_list'): Promise<number>` — calls the lister and returns `output[0].number`, failing if the repo has no open items.

- [ ] **Step 1: Write the file with harness, gating, and the exposure test**

```ts
/**
 * Live e2e: real MCP client ↔ Speculate proxy ↔ bundled gh workspace server ↔
 * real GitHub. Real latency, no injected sleep. Gated: runs only with
 * SPECULATE_E2E_LIVE=1 and an authenticated gh; otherwise skipped so `npm test`
 * stays hermetic. Target repo via SPECULATE_E2E_REPO (default cli/cli).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { StatsReport } from '../src/types.js';

const ROOT = new URL('..', import.meta.url).pathname;
const TSX = join(ROOT, 'node_modules', '.bin', 'tsx');
const REPO = process.env.SPECULATE_E2E_REPO ?? 'cli/cli';
const THINK_GAP_MS = 500;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function liveReady(): { ok: boolean; reason: string } {
  if (process.env.SPECULATE_E2E_LIVE !== '1')
    return { ok: false, reason: 'set SPECULATE_E2E_LIVE=1 to run the live GitHub e2e' };
  try {
    execFileSync('gh', ['auth', 'status'], { stdio: 'ignore' });
  } catch {
    return { ok: false, reason: 'gh is not authenticated (run: gh auth login)' };
  }
  return { ok: true, reason: '' };
}
const LIVE = liveReady();
if (!LIVE.ok) console.warn(`[e2e-github-live] SKIP: ${LIVE.reason}`);

interface Harness {
  client: Client;
  dir: string;
}
const harnesses: Harness[] = [];

async function startWrappedShell(mode: 'annotated' | 'off'): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'speculate-e2e-'));
  const configPath = join(dir, 'config.json');
  writeFileSync(
    configPath,
    JSON.stringify({
      mode,
      log: 'off',
      persistence: { enabled: false },
      servers: {
        workspace: {
          command: TSX,
          args: [join(ROOT, 'shell', 'speculate-shell.ts'), '--cwd', ROOT],
          // getDefaultEnvironment() supplies PATH/HOME for gh; we add the repo.
          env: { GH_REPO: REPO },
          profile: 'none',
        },
      },
    }),
  );
  const client = new Client({ name: 'e2e-live', version: '0.0.0' }, { capabilities: {} });
  const transport = new StdioClientTransport({
    command: TSX,
    args: [join(ROOT, 'src', 'cli.ts'), '--config', configPath],
    env: { ...process.env } as Record<string, string>,
    stderr: 'inherit',
  });
  await client.connect(transport);
  const h = { client, dir };
  harnesses.push(h);
  return h;
}

afterEach(async () => {
  while (harnesses.length) {
    const h = harnesses.pop()!;
    await h.client.close().catch(() => {});
    rmSync(h.dir, { recursive: true, force: true });
  }
});

async function timedCall(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<{ ms: number; result: CallToolResult }> {
  const t0 = performance.now();
  const result = (await client.callTool({ name, arguments: args })) as CallToolResult;
  return { ms: performance.now() - t0, result };
}

function payloadText(result: CallToolResult): string {
  return (
    (result.content as { type: string; text?: string }[]).find((c) => c.type === 'text')?.text ?? ''
  );
}
function parsePayload<T>(result: CallToolResult): T {
  return JSON.parse(payloadText(result)) as T;
}
async function readStats(client: Client): Promise<StatsReport> {
  const { result } = await timedCall(client, 'speculate__stats', {});
  return parsePayload<StatsReport>(result);
}

// gh catalog tools return { exitCode, output: [...] }; the top item's number.
async function topNumber(
  client: Client,
  listTool: 'gh_pr_list' | 'gh_issue_list',
): Promise<number> {
  const { result } = await timedCall(client, listTool, { limit: 10 });
  const out = parsePayload<{ output: { number: number }[] }>(result).output;
  expect(out.length, `repo ${REPO} must have an open ${listTool === 'gh_pr_list' ? 'PR' : 'issue'}`).toBeGreaterThan(0);
  return out[0].number;
}

describe.skipIf(!LIVE.ok)('live github e2e', () => {
  it('exposes gh tools, read-only annotated, targeting the configured repo', async () => {
    const { client } = await startWrappedShell('annotated');
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain('gh_pr_list');
    expect(names).toContain('gh_pr_view');
    expect(names).toContain('speculate__stats');
    expect(tools.find((t) => t.name === 'gh_pr_list')!.annotations?.readOnlyHint).toBe(true);
    // Real call proves GH_REPO redirection + auth in the child.
    const n = await topNumber(client, 'gh_pr_list');
    expect(n).toBeGreaterThan(0);
  }, 60_000);
});
```

- [ ] **Step 2: Run it live — expect PASS**

Run: `SPECULATE_E2E_LIVE=1 npx vitest run test/e2e-github-live.test.ts -t 'exposes gh tools'`
Expected: 1 passed. Proves the shell server launches, the gh probe enables gh tools, `GH_REPO` redirects to `cli/cli`, and gh auth works in the child.

**Fallback if red:** if gh tools are absent → the child's cwd lacks a GitHub remote or `gh` isn't on the child PATH: pass full env `env: { ...process.env, GH_REPO: REPO }` in `startWrappedShell`. If the `gh` call errors with auth → same widening (adds `HOME`/keychain access). Re-run.

- [ ] **Step 3: Confirm it skips without the flag**

Run: `npx vitest run test/e2e-github-live.test.ts`
Expected: test suite skipped (0 failed); stderr shows `[e2e-github-live] SKIP: set SPECULATE_E2E_LIVE=1 …`.

- [ ] **Step 4: Commit**

```bash
git add test/e2e-github-live.test.ts
git commit -m "test: live github e2e harness + gating + tool-exposure check"
```

---

### Task 2: Learner prefetches `gh_pr_view` from a real `gh_pr_list`

**Files:**
- Modify: `test/e2e-github-live.test.ts` (add one `it` inside the existing `describe.skipIf(!LIVE.ok)`)

**Interfaces:**
- Consumes: `startWrappedShell`, `timedCall`, `topNumber`, `readStats`, `sleep`, `THINK_GAP_MS`, `REPO` (from Task 1).
- Produces: proves `stats.hits + stats.joins ≥ 1` and a `learned:*gh_pr_view` rule for the PR pair.

- [ ] **Step 1: Add the PR prefetch-hit test**

```ts
  it('learner prefetches gh_pr_view from a real gh_pr_list (real latency)', async () => {
    const { client } = await startWrappedShell('annotated');

    // Warm-up ×2: teach gh_pr_list → gh_pr_view(top-of-that-list).
    for (let i = 0; i < 2; i++) {
      const n = await topNumber(client, 'gh_pr_list');
      await timedCall(client, 'gh_pr_view', { number: n });
    }

    // Measured pass: 3rd gh_pr_list arms the learned prefetch of gh_pr_view(top);
    // the think-gap is the window it runs in. Deriving `n` from THIS list's
    // result makes it match the learner's parsed-path prediction by construction.
    await sleep(THINK_GAP_MS);
    const n = await topNumber(client, 'gh_pr_list');
    await sleep(THINK_GAP_MS);
    const view = await timedCall(client, 'gh_pr_view', { number: n });
    expect(view.result.isError ?? false).toBe(false);

    const stats = await readStats(client);
    console.log(`[e2e-github-live] PR gh_pr_view served in ${view.ms.toFixed(0)}ms; ` +
      `hits=${stats.hits} joins=${stats.joins} savedMs≈${stats.estimatedSavedMs}`);
    expect(stats.hits + stats.joins, 'a prefetch should have served gh_pr_view').toBeGreaterThanOrEqual(1);
    expect(
      stats.perRule.some((r) => r.ruleId.startsWith('learned:') && r.ruleId.includes('gh_pr_view')),
      'a learned gh_pr_list→gh_pr_view rule should exist',
    ).toBe(true);
  }, 90_000);
```

- [ ] **Step 2: Run it live — expect PASS**

Run: `SPECULATE_E2E_LIVE=1 npx vitest run test/e2e-github-live.test.ts -t 'learner prefetches gh_pr_view'`
Expected: 1 passed; console shows a low served-ms and `hits`/`joins ≥ 1`.

**Fallback if red:**
- `hits+joins == 0`: widen the second `sleep` to `THINK_GAP_MS * 3` (give the prefetch more time), and keep the tolerant `hits + joins` assertion (a fast link may yield a join, not a clean hit).
- No `learned:` rule: add a third warm-up cycle (the learner's `minObservations`), or confirm `profile: 'none'` (a profile allowlist must not gate the learner in annotated mode).
- Still red: anchor with a config rule instead of the learner — add `rules: [{ trigger: 'gh_pr_list', predict: [{ tool: 'gh_pr_view', args: { number: '$item.number' }, forEach: '$parsed.output', limit: 1, confidence: 0.7 }] }]` to the server config and assert a `config:` rule fired. (Document the switch; it still exercises real gh with real latency.)

- [ ] **Step 3: Commit**

```bash
git add test/e2e-github-live.test.ts
git commit -m "test: live gh_pr_list→gh_pr_view learner prefetch hit"
```

---

### Task 3: Speculated bytes equal a direct unwrapped call (PRs)

**Files:**
- Modify: `test/e2e-github-live.test.ts` (add one `it` inside the `describe`)

**Interfaces:**
- Consumes: `startWrappedShell`, `timedCall`, `topNumber`, `payloadText`, `readStats`, `sleep`, `THINK_GAP_MS`.
- Produces: asserts byte-identity of the prefetch-served `gh_pr_view` result vs an `off`-mode (pass-through) call for the same number.

- [ ] **Step 1: Add the correctness test**

```ts
  it('speculated gh_pr_view bytes are byte-identical to a direct upstream call', async () => {
    const on = await startWrappedShell('annotated');
    for (let i = 0; i < 2; i++) {
      const w = await topNumber(on.client, 'gh_pr_list');
      await timedCall(on.client, 'gh_pr_view', { number: w });
    }
    await sleep(THINK_GAP_MS);
    const n = await topNumber(on.client, 'gh_pr_list');
    await sleep(THINK_GAP_MS);
    const speculated = payloadText((await timedCall(on.client, 'gh_pr_view', { number: n })).result);

    // Confirm this really came from a prefetch (not a live fallback).
    const stats = await readStats(on.client);
    expect(stats.hits + stats.joins).toBeGreaterThanOrEqual(1);

    // Direct, unwrapped: off-mode proxy is a pure pass-through to the same server.
    const off = await startWrappedShell('off');
    const direct = payloadText((await timedCall(off.client, 'gh_pr_view', { number: n })).result);

    expect(speculated).toBe(direct);
  }, 90_000);
```

- [ ] **Step 2: Run it live — expect PASS**

Run: `SPECULATE_E2E_LIVE=1 npx vitest run test/e2e-github-live.test.ts -t 'byte-identical'`
Expected: 1 passed — the prefetch-served bytes equal the direct call's bytes.

**Fallback if red:** if the two payloads differ, the PR was edited in the sub-second window between fetches. `gh_pr_view` returns only `number,title,body,state,author` (no timestamps), so this is rare; if it flakes, compare on a **closed** PR (immutable): set the view number to a fixed merged PR via a new `SPECULATE_E2E_PR` env (default a known merged PR number in `cli/cli`) for this test only. Document the choice.

- [ ] **Step 3: Commit**

```bash
git add test/e2e-github-live.test.ts
git commit -m "test: live gh_pr_view speculated bytes == direct upstream"
```

---

### Task 4: Issue pair + `test:e2e` script

**Files:**
- Modify: `test/e2e-github-live.test.ts` (add one `it`)
- Modify: `package.json` (add `test:e2e` script)

**Interfaces:**
- Consumes: `startWrappedShell`, `timedCall`, `topNumber`, `readStats`, `sleep`, `THINK_GAP_MS` (from Task 1).
- Produces: the same prefetch-hit assertion for `gh_issue_list → gh_issue_view`, and a runnable `npm run test:e2e`.

- [ ] **Step 1: Add the issue-pair test**

```ts
  it('learner prefetches gh_issue_view from a real gh_issue_list (real latency)', async () => {
    const { client } = await startWrappedShell('annotated');
    for (let i = 0; i < 2; i++) {
      const n = await topNumber(client, 'gh_issue_list');
      await timedCall(client, 'gh_issue_view', { number: n });
    }
    await sleep(THINK_GAP_MS);
    const n = await topNumber(client, 'gh_issue_list');
    await sleep(THINK_GAP_MS);
    const view = await timedCall(client, 'gh_issue_view', { number: n });
    expect(view.result.isError ?? false).toBe(false);

    const stats = await readStats(client);
    console.log(`[e2e-github-live] issue gh_issue_view served in ${view.ms.toFixed(0)}ms; ` +
      `hits=${stats.hits} joins=${stats.joins} savedMs≈${stats.estimatedSavedMs}`);
    expect(stats.hits + stats.joins).toBeGreaterThanOrEqual(1);
    expect(
      stats.perRule.some((r) => r.ruleId.startsWith('learned:') && r.ruleId.includes('gh_issue_view')),
    ).toBe(true);
  }, 90_000);
```

- [ ] **Step 2: Add the npm script**

In `package.json`, inside `"scripts"`, add:

```json
    "test:e2e": "SPECULATE_E2E_LIVE=1 vitest run test/e2e-github-live.test.ts",
```

- [ ] **Step 3: Run the whole live file — expect all PASS**

Run: `npm run test:e2e`
Expected: 4 passed (exposure, PR prefetch, byte-identity, issue prefetch); console lines report served-ms and `savedMs`.

**Fallback if red:** if `cli/cli` has no open *issues* at run time, `topNumber` fails the guard — set `SPECULATE_E2E_REPO` to a repo with both open PRs and issues, or drop the issue assertion to `it.skipIf(noIssues)`. (PRs are the primary coverage.)

- [ ] **Step 4: Confirm the default suite is unaffected**

Run: `npm test`
Expected: existing suite passes; the live file is skipped (no `SPECULATE_E2E_LIVE`), unchanged count except the skip.

- [ ] **Step 5: Commit**

```bash
git add test/e2e-github-live.test.ts package.json
git commit -m "test: live gh issue pair + test:e2e script"
```

---

## Self-Review

- **Spec coverage:** upstream = bundled gh via `GH_REPO` (Task 1) ✓; two-pass learner warm-up + measured hit (Tasks 2, 4) ✓; correctness byte-identity vs direct (Task 3) ✓; latency measured-not-asserted (console logs in Tasks 2–4) ✓; gating via `SPECULATE_E2E_LIVE` + `gh auth` (Task 1) ✓; env-configurable repo (Task 1) ✓; new file + optional `package.json` script, zero `src/` changes (all tasks) ✓; annotated-mode eligibility via `readOnlyHint` (Task 1 asserts it) ✓.
- **Placeholder scan:** no TBD/TODO; every code step is complete; fallbacks are concrete.
- **Type consistency:** helper names/signatures defined in Task 1 (`startWrappedShell`, `timedCall`, `topNumber`, `payloadText`, `parsePayload`, `readStats`) are reused verbatim in Tasks 2–4; `StatsReport` fields used (`hits`, `joins`, `estimatedSavedMs`, `perRule[].ruleId`) match live output and `src/types.ts`.

## Execution Handoff

Two execution options:
1. **Subagent-Driven (recommended)** — a fresh subagent per task, review between tasks.
2. **Inline Execution** — execute tasks in this session with checkpoints.
