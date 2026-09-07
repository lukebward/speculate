# Durable Usage Stats Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `speculate stats` for durable machine-wide MCP and CLI speculation usage, with source and workspace breakdowns.

**Architecture:** Each MCP proxy and CLI daemon writes a uniquely named, owner-only session snapshot beneath the shared Speculate state directory. A reader validates and aggregates those snapshots, while a separate command module renders human or JSON output. Existing live stats stay unchanged, and `speculate try` disables the recorder to preserve its zero-write contract.

**Tech Stack:** TypeScript 7, Node.js 18+ built-ins, Vitest 4, existing CLI/persistence conventions.

## Global Constraints

- Add only `speculate stats` and `speculate stats --json`; no alias, reset, filters, migration, or new dependency.
- Collection begins with this version; do not infer historical usage.
- Persist only source, absolute workspace path, timestamps, and aggregate counters.
- Never persist command arguments, tool/server names, results, templates, or cache contents.
- Create the usage directory as `0700`; write snapshots as `0600` using temporary-file rename.
- Recording failures are best-effort and never affect normal proxy or CLI behavior.
- Preserve `speculate__stats`, `speculate exec --stats`, and the zero-write behavior of `speculate try`.
- Add no comments unless a short why-comment is required by a hidden invariant.

## File Map

- Create `src/usage.ts`: snapshot schema, recorder, validation, aggregation.
- Create `src/stats.ts`: argument parsing and human/JSON presentation.
- Create `test/usage.test.ts` and `test/stats.test.ts`.
- Modify `src/persistence.ts`: expose the existing shared state directory.
- Modify `src/metrics.ts`, `src/proxy.ts`, `src/cli.ts`: MCP recording and command registration.
- Modify `src/execCache.ts`, `src/execDaemon.ts`: CLI recording, including asynchronous waste.
- Modify `src/tryRun.ts`: child environment disables durable usage.
- Modify focused tests, `README.md`, `DESIGN.md`, and `tasks/todo.md`.

---

### Task 1: Persist and Aggregate Session Snapshots

**Files:**
- Create: `src/usage.ts`
- Create: `test/usage.test.ts`
- Modify: `src/persistence.ts:98-121`
- Modify: `test/persistence.test.ts:145-160`

**Interfaces:**
- Produces: `defaultStateDirectory(): string`
- Produces: `UsageCounters`, `UsageSnapshot`, `UsageTotals`, `UsageReport`
- Produces: `UsageRecorder.update(counters: UsageCounters): void`
- Produces: `UsageRecorder.close(): void`
- Produces: `createUsageRecorder(options, env?): UsageRecorder | null`
- Produces: `readUsageReport(directory?): UsageReport`

- [ ] **Step 1: Write failing path and recorder tests**

Add to `test/persistence.test.ts`:

```ts
expect(defaultStateDirectory()).toBe(`${sep}xdg-state${sep}speculate`);
expect(defaultStatePath('/proj/speculate.config.json')).toMatch(/state-[0-9a-f]+\.json$/);
```

Create `test/usage.test.ts` with this shared fixture and assertions:

```ts
const counters = (overrides: Partial<UsageCounters> = {}): UsageCounters => ({
  hits: 0,
  joins: 0,
  misses: 0,
  speculativeCalls: 0,
  wasted: 0,
  estimatedSavedMs: 0,
  ...overrides,
});

const recorder = new UsageRecorder({
  source: 'mcp',
  workspace: '/workspace/a',
  directory,
  sessionId: 'a',
  now: () => now,
  flushDelayMs: 0,
});
recorder.update(counters({ hits: 2, misses: 1, estimatedSavedMs: 750 }));
recorder.close();

expect(readdirSync(directory)).toEqual(['1000-a.json']);
expect(statSync(directory).mode & 0o777).toBe(0o700);
expect(statSync(join(directory, '1000-a.json')).mode & 0o777).toBe(0o600);
expect(JSON.parse(readFileSync(join(directory, '1000-a.json'), 'utf8'))).toMatchObject({
  version: 1,
  sessionId: 'a',
  source: 'mcp',
  workspace: resolve('/workspace/a'),
  counters: { hits: 2, misses: 1, estimatedSavedMs: 750 },
});
```

Add a simultaneous-session case that creates IDs `a` and `b` in the same directory and expects two independent files. Add an environment case:

```ts
expect(
  createUsageRecorder(
    { source: 'mcp', workspace: '/workspace/a', directory },
    { SPECULATE_USAGE_OFF: '1' },
  ),
).toBeNull();
```

- [ ] **Step 2: Run the tests and verify the missing imports fail**

Run:

```bash
npx vitest run test/persistence.test.ts test/usage.test.ts
```

Expected: FAIL because `defaultStateDirectory` and `src/usage.ts` do not exist.

- [ ] **Step 3: Expose the existing state directory**

Refactor `src/persistence.ts` without changing generated state-file paths:

```ts
export function defaultStateDirectory(): string {
  const xdg = process.env.XDG_STATE_HOME;
  const stateHome =
    xdg && xdg.length > 0 && isAbsolute(xdg)
      ? xdg
      : process.platform === 'win32' && process.env.LOCALAPPDATA
        ? process.env.LOCALAPPDATA
        : join(homedir(), '.local', 'state');
  return join(stateHome, 'speculate');
}

export function defaultStatePathForKey(key: string): string {
  const hash = createHash('sha256').update(key).digest('hex').slice(0, 16);
  return join(defaultStateDirectory(), `state-${hash}.json`);
}
```

- [ ] **Step 4: Implement the recorder schema**

Create `src/usage.ts` with these exact public shapes:

```ts
export type UsageSource = 'mcp' | 'cli';

export interface UsageCounters {
  hits: number;
  joins: number;
  misses: number;
  speculativeCalls: number;
  wasted: number;
  estimatedSavedMs: number;
}

export interface UsageSnapshot {
  version: 1;
  sessionId: string;
  source: UsageSource;
  workspace: string;
  startedAt: number;
  updatedAt: number;
  endedAt?: number;
  counters: UsageCounters;
}

export interface UsageRecorderOptions {
  source: UsageSource;
  workspace: string;
  directory?: string;
  sessionId?: string;
  now?: () => number;
  flushDelayMs?: number;
  log?: (line: string) => void;
}
```

`UsageRecorder` must:

1. Resolve the workspace to an absolute path.
2. Default the directory to `join(defaultStateDirectory(), 'usage')`.
3. Default the session ID to `randomUUID()` and filename to `<startedAt>-<sessionId>.json`.
4. Write an initial zero snapshot.
5. Copy complete counter snapshots in `update()`.
6. Flush immediately when `flushDelayMs === 0`; otherwise schedule only the first unsaved flush for 1 second and `unref()` it.
7. On `close()`, clear the timer, set `endedAt`, and synchronously flush once.
8. Use `mkdirSync(directory, { recursive: true, mode: 0o700 })`, `writeFileSync(tmp, json, { mode: 0o600 })`, and `renameSync(tmp, path)`.
9. Warn once on failure through an injectable logger, then continue.

Tests must also assert that the temporary file is absent after a successful flush, `endedAt` equals the close time, a one-second fake-timer flush captures the latest counters, and two failed flush attempts emit only one warning.

Implement:

```ts
export function createUsageRecorder(
  options: UsageRecorderOptions,
  env: NodeJS.ProcessEnv = process.env,
): UsageRecorder | null {
  return env.SPECULATE_USAGE_OFF === '1' ? null : new UsageRecorder(options);
}
```

- [ ] **Step 5: Write failing aggregation/validation tests**

Seed one MCP snapshot for `/workspace/a` and one CLI snapshot for `/workspace/b`; assert:

```ts
expect(report.totals).toMatchObject({
  sessions: 2,
  hits: 2,
  joins: 1,
  misses: 2,
  speculativeCalls: 6,
  wasted: 1,
  estimatedSavedMs: 2500,
  hitRate: 0.6,
  wastePerHit: 1 / 3,
});
expect(report.bySource.mcp.sessions).toBe(1);
expect(report.bySource.cli.joins).toBe(1);
expect(report.workspaces.map((row) => row.workspace)).toEqual([
  resolve('/workspace/a'),
  resolve('/workspace/b'),
]);
```

Add malformed JSON, version `2`, negative count, relative workspace, `Infinity`, and missing-directory cases. Invalid records increment `ignoredRecords`; a missing directory returns zero sessions and zero ignored records.

- [ ] **Step 6: Run the aggregation tests and verify they fail**

Run:

```bash
npx vitest run test/usage.test.ts
```

Expected: FAIL because report aggregation is missing.

- [ ] **Step 7: Implement strict validation and aggregation**

Add:

```ts
export interface UsageTotals extends UsageCounters {
  sessions: number;
  hitRate: number | null;
  wastePerHit: number | null;
}

export interface UsageReport {
  since: string | null;
  updatedAt: string | null;
  ignoredRecords: number;
  totals: UsageTotals;
  bySource: Record<UsageSource, UsageTotals>;
  workspaces: Array<UsageTotals & { workspace: string }>;
}
```

Validation accepts only version `1`, non-empty session IDs, `mcp|cli`, absolute workspaces, valid millisecond timestamps, safe non-negative integer counts, and finite non-negative saved time. `readUsageReport()` must read only `.json` files, count rejected records, derive:

```ts
const used = totals.hits + totals.joins;
const eligible = used + totals.misses;
const hitRate = eligible === 0 ? null : used / eligible;
const wastePerHit = used === 0 ? null : totals.wasted / used;
```

Use earliest `startedAt` and latest `updatedAt` as ISO strings. Group by both source values and workspace path. Sort workspaces by descending `estimatedSavedMs`, then path.

- [ ] **Step 8: Verify and commit**

Run:

```bash
npx vitest run test/persistence.test.ts test/usage.test.ts
npm run build
```

Expected: selected tests pass and the build exits 0.

Commit:

```bash
git add src/persistence.ts src/usage.ts test/persistence.test.ts test/usage.test.ts
git commit -m "feat: persist durable usage snapshots"
```

---

### Task 2: Present Human and JSON Stats

**Files:**
- Create: `src/stats.ts`
- Create: `test/stats.test.ts`

**Interfaces:**
- Consumes: `UsageReport`, `readUsageReport(directory?)`
- Produces: `StatsArgs`, `parseStatsArgs`, `formatUsageReport`, `runStats`

- [ ] **Step 1: Write failing parser, formatter, and empty-state tests**

Assert:

```ts
expect(parseStatsArgs([])).toEqual({ json: false });
expect(parseStatsArgs(['--json'])).toEqual({ json: true });
expect(parseStatsArgs(['--bogus'])).toEqual({
  error: "unknown stats argument '--bogus'",
});
```

For a two-session fixture with 90,000ms saved, assert human output contains:

```text
Speculate stats (all time since 2026-07-14)
Estimated time saved: 1m 30s
Prefetch hits: 4 (3 ready, 1 joined)
Hit rate: 66.7%
Speculative calls: 8
Wasted calls: 2 (0.50 per hit)
Sessions: 2
MCP: 1m 10s saved
CLI: 20s saved
/workspace/a: 1m 30s saved
Ignored records: 1
```

For no snapshots, assert exit `0` and:

```text
No Speculate usage recorded yet.
Collection starts after installing this version.
```

For `--json`, parse stdout and expect exact equality with the `UsageReport`.

- [ ] **Step 2: Run the tests and verify the module is missing**

Run:

```bash
npx vitest run test/stats.test.ts
```

Expected: FAIL because `src/stats.ts` does not exist.

- [ ] **Step 3: Implement formatting and command execution**

Create:

```ts
export interface StatsArgs {
  json: boolean;
}

export function parseStatsArgs(argv: string[]): StatsArgs | { error: string } {
  if (argv.length === 0) return { json: false };
  if (argv.length === 1 && argv[0] === '--json') return { json: true };
  return { error: `unknown stats argument '${argv[0]}'` };
}
```

Formatting rules:

- `<1000ms`: rounded milliseconds.
- `<60s`: rounded seconds.
- `<60m`: whole minutes plus seconds.
- Otherwise: whole hours plus minutes.
- Percentages: one decimal; empty denominator: `—`.
- Human workspace order uses the report's deterministic order.
- JSON is `JSON.stringify(report, null, 2) + '\n'`.

Implement:

```ts
export function runStats(
  args: StatsArgs,
  options: {
    directory?: string;
    read?: (directory?: string) => UsageReport;
    write?: (text: string) => void;
  } = {},
): number {
  const report = (options.read ?? readUsageReport)(options.directory);
  const output = args.json
    ? JSON.stringify(report, null, 2) + '\n'
    : formatUsageReport(report);
  (options.write ?? ((text) => process.stdout.write(text)))(output);
  return 0;
}
```

- [ ] **Step 4: Verify and commit**

Run:

```bash
npx vitest run test/stats.test.ts test/usage.test.ts
npm run build
```

Expected: selected tests pass and the build exits 0.

Commit:

```bash
git add src/stats.ts test/stats.test.ts
git commit -m "feat: format cumulative usage stats"
```

---

### Task 3: Record MCP Usage

**Files:**
- Modify: `src/metrics.ts:33-79,120-185`
- Modify: `src/proxy.ts:50-76,93,294-302`
- Modify: `src/cli.ts:343-359`
- Modify: `test/metrics.test.ts`
- Modify: `test/integration.test.ts:30-83`

**Interfaces:**
- Consumes: `UsageCounters`, `UsageRecorder`, `createUsageRecorder`
- Adds: `Metrics` option `onUsage?: (counters: UsageCounters) => void`
- Adds: `SpeculateProxy` option `usageRecorder?: UsageRecorder | null`

- [ ] **Step 1: Write a failing Metrics notification test**

```ts
const snapshots: UsageCounters[] = [];
const m = new Metrics({
  mode: 'strict',
  log: 'off',
  onUsage: (snapshot) => snapshots.push(snapshot),
});
m.record({ type: 'predicted', server: 's', tool: 't' });
expect(snapshots).toEqual([]);
m.record({ type: 'miss', server: 's', tool: 't' });
m.record({ type: 'speculated', server: 's', tool: 't' });
m.record({ type: 'hit', server: 's', tool: 't', savedMs: 250 });
expect(snapshots.at(-1)).toEqual({
  hits: 1,
  joins: 0,
  misses: 1,
  speculativeCalls: 1,
  wasted: 0,
  estimatedSavedMs: 250,
});
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run:

```bash
npx vitest run test/metrics.test.ts -t "publishes common durable counters"
```

Expected: FAIL because `Metrics` rejects `onUsage`.

- [ ] **Step 3: Publish lightweight counters from Metrics**

Store the optional callback. Mark usage changed only for `speculated`, `hit`, `joined`, `miss`, `expired`, `invalidated`, and `spec_error`. After the switch, publish:

```ts
{
  hits: this.hits,
  joins: this.joins,
  misses: this.misses,
  speculativeCalls: this.speculativeCalls,
  wasted: this.wasted,
  estimatedSavedMs: this.estimatedSavedMs,
}
```

Do not publish for events outside the durable schema.

- [ ] **Step 4: Write a failing real-proxy recording test**

Set `XDG_STATE_HOME` to the integration harness directory in the spawned proxy environment. Add a miss and a hit/join, close the client, poll `readUsageReport(join(h.dir, 'speculate', 'usage'))`, and assert:

```ts
expect(report.bySource.mcp.sessions).toBe(1);
expect(report.bySource.mcp.hits + report.bySource.mcp.joins).toBeGreaterThanOrEqual(1);
expect(report.bySource.mcp.estimatedSavedMs).toBeGreaterThan(0);
expect(report.workspaces[0]?.workspace).toBe(resolve(process.cwd()));
```

- [ ] **Step 5: Run the integration test and verify no record appears**

Run:

```bash
npx vitest run test/integration.test.ts -t "records durable MCP usage"
```

Expected: FAIL because `runProxy()` does not construct a recorder.

- [ ] **Step 6: Inject and close the recorder**

Add to `SpeculateProxy`:

```ts
private readonly usageRecorder: UsageRecorder | null;
```

Extend constructor options with `usageRecorder?: UsageRecorder | null`, then:

```ts
this.usageRecorder = opts.usageRecorder ?? null;
this.metrics = new Metrics({
  mode: config.mode,
  log: config.log,
  now,
  onUsage: (counters) => this.usageRecorder?.update(counters),
});
```

Close the recorder in a `finally` block around transport/upstream shutdown. In `runProxy()`:

```ts
const usageRecorder = createUsageRecorder({
  source: 'mcp',
  workspace: process.cwd(),
});
const proxy = new SpeculateProxy(config, { statePath, usageRecorder });
```

- [ ] **Step 7: Verify and commit**

Run:

```bash
npx vitest run test/metrics.test.ts test/integration.test.ts
npm run build
```

Expected: selected tests pass and the build exits 0.

Commit:

```bash
git add src/metrics.ts src/proxy.ts src/cli.ts test/metrics.test.ts test/integration.test.ts
git commit -m "feat: record cumulative MCP usage"
```

---

### Task 4: Record CLI Daemon Usage

**Files:**
- Modify: `src/execCache.ts:32-110`
- Modify: `src/execDaemon.ts:221-245,268-316,344-453,496-532`
- Modify: `test/execCache.test.ts`
- Modify: `test/execDaemon.test.ts`
- Modify: `test/execClient.test.ts`

**Interfaces:**
- Adds: `ExecCache` option `onWaste?: () => void`
- Adds: `DaemonOptions.usageRecorder?: UsageRecorder | null`
- Preserves: `DaemonStats` and `speculate exec --stats` output

- [ ] **Step 1: Write a failing asynchronous-waste test**

```ts
let notifications = 0;
const cache = new ExecCache({ onWaste: () => notifications++ });
cache.beginSpeculative('key', 100, async () => {
  throw new Error('failed');
});
await Promise.resolve();
await Promise.resolve();
expect(cache.wasted).toBe(1);
expect(notifications).toBe(1);
```

- [ ] **Step 2: Run the cache test and verify the option is rejected**

Run:

```bash
npx vitest run test/execCache.test.ts -t "notifies when asynchronous"
```

Expected: FAIL because `ExecCache` has no `onWaste`.

- [ ] **Step 3: Centralize waste notifications**

Store the callback and replace direct waste increments with:

```ts
private recordWaste(count = 1): void {
  if (count === 0) return;
  this.wasted += count;
  this.onWaste?.();
}
```

Use it for expired lookup, doomed completion, rejected speculative execution, invalidation, and sweeping.
Swallow callback failures so an observer can never change cache behavior.

- [ ] **Step 4: Write a failing daemon persistence test**

Start an isolated daemon with an injected immediate recorder, issue `git status`, close it, then assert:

```ts
const report = readUsageReport(usageDirectory);
expect(report.bySource.cli.sessions).toBe(1);
expect(report.bySource.cli.misses).toBe(1);
```

Extract the existing socket helper so the new case can issue `{ op: 'exec' }`. Pass `usageRecorder: null` in existing daemon/client test setups that are not testing persistence, preventing writes to the developer's real state.
For spawned real-CLI cases, add `SPECULATE_USAGE_OFF: '1'` to the child environment because constructor injection is not available across the process boundary.

- [ ] **Step 5: Run the daemon test and verify the report stays empty**

Run:

```bash
npx vitest run test/execDaemon.test.ts -t "records durable CLI usage"
```

Expected: FAIL because the daemon ignores the recorder.

- [ ] **Step 6: Normalize and flush daemon counters**

Default `usageRecorder` to:

```ts
opts.usageRecorder === undefined
  ? createUsageRecorder({ source: 'cli', workspace: root })
  : opts.usageRecorder;
```

Publish:

```ts
const durableCounters = (): UsageCounters => ({
  hits: stats.hits,
  joins: stats.joins,
  misses: stats.misses,
  speculativeCalls: stats.speculated,
  wasted: stats.wasted + cache.wasted,
  estimatedSavedMs: stats.estimatedSavedMs,
});
```

Update after each supported exec request and from `ExecCache.onWaste`. Before daemon close returns, publish once more and close the recorder exactly once. Unsupported commands remain excluded because `unsupported` is not in `UsageCounters`.

- [ ] **Step 7: Verify and commit**

Run:

```bash
npx vitest run test/execCache.test.ts test/execDaemon.test.ts test/execClient.test.ts
npm run build
```

Expected: selected tests pass and the build exits 0.

Commit:

```bash
git add src/execCache.ts src/execDaemon.ts test/execCache.test.ts test/execDaemon.test.ts test/execClient.test.ts
git commit -m "feat: record cumulative CLI usage"
```

---

### Task 5: Register the Command, Preserve Trials, and Document It

**Files:**
- Modify: `src/cli.ts:31-72,91-120,203-230`
- Modify: `src/tryRun.ts:149-154`
- Modify: `test/stats.test.ts`
- Modify: `test/hostConfig.test.ts`
- Modify: `README.md:17-76`
- Modify: `DESIGN.md` observability/persistence sections
- Modify: `tasks/todo.md`

**Interfaces:**
- Consumes: `parseStatsArgs`, `runStats`
- Produces: top-level `speculate stats [--json]`
- Produces: `tryClientEnv(env): NodeJS.ProcessEnv`

- [ ] **Step 1: Write failing real-CLI tests**

Spawn `node_modules/.bin/tsx src/cli.ts` with an isolated `XDG_STATE_HOME`, seed one usage record, and assert:

```ts
const human = await runCli(['stats'], stateHome);
expect(human.code).toBe(0);
expect(human.stdout).toContain('Estimated time saved: 2s');

const json = await runCli(['stats', '--json'], stateHome);
expect(json.code).toBe(0);
expect(JSON.parse(json.stdout).totals.estimatedSavedMs).toBe(1500);

const bad = await runCli(['stats', '--bogus'], stateHome);
expect(bad.code).toBe(2);
expect(bad.stderr).toContain("unknown stats argument '--bogus'");
```

- [ ] **Step 2: Run the CLI test and verify `stats` is unknown**

Run:

```bash
npx vitest run test/stats.test.ts -t "exposes stats through the real CLI"
```

Expected: FAIL because the top-level parser does not recognize `stats`.

- [ ] **Step 3: Register the top-level command**

In `src/cli.ts`:

1. Add `stats` to `Args['command']`.
2. Add `stats` to `REST_COMMANDS`.
3. Add `speculate stats [--json]` to help.
4. Import `parseStatsArgs` and `runStats`.
5. Before the `exec` branch, parse `args.rest`, call `fail('stats: ' + error)` for errors, otherwise set `process.exitCode = runStats(statsArgs)` and return.

Do not add a `usage` alias.

- [ ] **Step 4: Write a failing trial-environment test**

```ts
expect(tryClientEnv({ KEEP: 'yes' })).toEqual({
  KEEP: 'yes',
  SPECULATE_USAGE_OFF: '1',
});
```

- [ ] **Step 5: Run the trial test and verify the helper is missing**

Run:

```bash
npx vitest run test/hostConfig.test.ts -t "disables durable usage"
```

Expected: FAIL because `tryClientEnv` does not exist.

- [ ] **Step 6: Disable recording inside trial clients**

Implement:

```ts
export function tryClientEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...env, SPECULATE_USAGE_OFF: '1' };
}
```

Pass `env: tryClientEnv(process.env)` with `stdio: 'inherit'` to the Claude child spawn. Every wrapped process launched by that temporary client inherits the flag.

- [ ] **Step 7: Update documentation and task tracking**

Add to README:

```markdown
`speculate stats` shows cumulative estimated time saved, hit rate, waste, and per-workspace usage across MCP and CLI speculation. Use `speculate stats --json` for structured output. Collection starts with this version; `speculate try` remains zero-write and is excluded.
```

Distinguish durable `speculate stats` from current-session `speculate__stats`. Update DESIGN.md to record that aggregate session snapshots contain only workspace, source, timestamps, and counters; caches/results remain memory-only.

Update `tasks/todo.md` as each implementation task completes:

```markdown
# Durable Usage Stats

- [x] Approve design
- [x] Write implementation plan
- [ ] Persist and aggregate usage snapshots
- [ ] Format human and JSON stats
- [ ] Record MCP usage
- [ ] Record CLI usage
- [ ] Register the command and preserve zero-write trials
- [ ] Run focused tests, full tests, and build
- [ ] Review the final diff

## Review

Pending implementation and verification.
```

- [ ] **Step 8: Run complete verification**

Run:

```bash
npx vitest run test/usage.test.ts test/stats.test.ts test/metrics.test.ts test/integration.test.ts test/execCache.test.ts test/execDaemon.test.ts test/execClient.test.ts test/hostConfig.test.ts test/persistence.test.ts
npm test
npm run build
git diff --check
```

Expected: focused and full tests pass, build exits 0, and diff check prints no output.

- [ ] **Step 9: Review scope and finish**

Run:

```bash
git status --short
git diff --stat HEAD~5
git diff HEAD~5 -- src test README.md DESIGN.md tasks/todo.md
```

Confirm all approved constraints, mark every tracker checkbox complete, replace the Review section with actual commands/results, then commit:

```bash
git add src test README.md DESIGN.md tasks/todo.md
git commit -m "feat: add durable usage stats command"
```
