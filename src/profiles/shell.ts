/**
 * Vetted profile for the bundled speculate-shell server (DESIGN.md §13.8):
 * read-only git/filesystem/search workspace tools.
 *
 * TTLs are short by design — local state churns — but the primary freshness
 * mechanism is the server's fs-watcher, which flushes the whole buffer via
 * tools/list_changed within ~300 ms of any workspace change. Results parse
 * via the generic JSON-in-text path (the server emits JSON text), so no
 * per-tool parsers are needed.
 */
import type { ArgsCanonicalizer, ObservedCall, Prediction, Rule, ServerProfile } from '../types.js';

const READ_TOOLS = [
  'git_status',
  'git_diff',
  'git_log',
  'git_show',
  'git_branch',
  'list_dir',
  'search',
];

/** The server defaults staged→false and count→10; keys must collide. */
const canonicalizeDiff: ArgsCanonicalizer = (args) => {
  const out: Record<string, unknown> = { ...args };
  if (out['staged'] === undefined) out['staged'] = false;
  return out;
};

const canonicalizeLog: ArgsCanonicalizer = (args) => {
  const out: Record<string, unknown> = { ...args };
  if (out['count'] === undefined) out['count'] = 10;
  return out;
};

function pred(
  tool: string,
  args: Record<string, unknown>,
  confidence: number,
  ruleId: string,
): Prediction {
  return { server: '', tool, args, confidence, ruleId };
}

const statusToDiff: Rule = {
  id: 'sh:status→diff',
  trigger: 'git_status',
  predict(call: ObservedCall): Prediction[] {
    // Only worth prefetching when something is actually dirty.
    const entries = (call.parsed as { entries?: unknown[] } | null)?.entries;
    if (!Array.isArray(entries) || entries.length === 0) return [];
    return [pred('git_diff', {}, 0.75, this.id)];
  },
};

const statusToStagedDiff: Rule = {
  id: 'sh:status→staged-diff',
  trigger: 'git_status',
  predict(call: ObservedCall): Prediction[] {
    const entries = (call.parsed as { entries?: { staged?: boolean }[] } | null)?.entries;
    if (!Array.isArray(entries) || !entries.some((e) => e && e.staged === true)) return [];
    return [pred('git_diff', { staged: true }, 0.45, this.id)];
  },
};

const statusToLog: Rule = {
  id: 'sh:status→log',
  trigger: 'git_status',
  predict(): Prediction[] {
    return [pred('git_log', {}, 0.35, 'sh:status→log')];
  },
};

const logToShow: Rule = {
  id: 'sh:log→show',
  trigger: 'git_log',
  predict(call: ObservedCall): Prediction[] {
    const commits = (call.parsed as { commits?: { sha?: unknown }[] } | null)?.commits;
    if (!Array.isArray(commits)) return [];
    const first = commits[0];
    if (!first || typeof first.sha !== 'string' || first.sha.length === 0) return [];
    return [pred('git_show', { ref: first.sha }, 0.5, this.id)];
  },
};

const branchToLog: Rule = {
  id: 'sh:branch→log',
  trigger: 'git_branch',
  predict(): Prediction[] {
    return [pred('git_log', {}, 0.4, 'sh:branch→log')];
  },
};

export const shellProfile: ServerProfile = {
  name: 'shell',
  validatedAgainst: 'bundled speculate-shell v0.1',
  readOnlyAllowlist: READ_TOOLS,
  defaultTtlMs: 15_000,
  ttlMsByTool: {
    // A sha-addressed commit doesn't change; branch tips do, but the
    // fs-watcher flush covers local movement.
    git_show: 60_000,
    git_log: 30_000,
  },
  parsers: {},
  canonicalizers: {
    git_diff: canonicalizeDiff,
    git_log: canonicalizeLog,
  },
  rules: [statusToDiff, statusToStagedDiff, statusToLog, logToShow, branchToLog],
};
