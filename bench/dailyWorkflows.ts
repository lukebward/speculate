/** Deterministic, privacy-local workflow plans for the daily benchmark. */

export type DailyStep =
  | { kind: 'call'; tool: string; args: Record<string, unknown> }
  | { kind: 'think'; ms: number }
  | { kind: 'mutate'; operation: string }
  | { kind: 'turn'; label: string };

export interface GeneratedDailyWorkflow {
  id: string;
  version: number;
  seed: number;
  session: number;
  steps: DailyStep[];
}

export const DAILY_WORKFLOW_IDS = [
  'git-inspection',
  'code-navigation',
  'documentation',
  'mutation-freshness',
  'negative-control',
] as const;

export type DailyWorkflowId = (typeof DAILY_WORKFLOW_IDS)[number];

/** A stable small PRNG; changing it requires bumping every workflow version. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 0x1_0000_0000;
  };
}

export function generateDailyWorkflow(
  id: DailyWorkflowId,
  seed: number,
  session: number,
): GeneratedDailyWorkflow {
  if (!Number.isSafeInteger(seed) || seed < 0 || seed > 0xffff_ffff) {
    throw new Error('seed must be an unsigned 32-bit integer');
  }
  if (!Number.isSafeInteger(session) || session < 0) {
    throw new Error('session must be a non-negative safe integer');
  }
  const random = seededRandom(mixSeed(id, seed, session));
  return { id, version: 1, seed, session, steps: generators[id](random, session) };
}

const think = (random: () => number): DailyStep => ({
  kind: 'think',
  ms: 60 + Math.floor(random() * 181),
});

const generators: Record<
  DailyWorkflowId,
  (random: () => number, session: number) => DailyStep[]
> = {
  'git-inspection': (random, session) => {
    const rank = Math.floor(random() * 3);
    const ref = session % 2 === 0 ? 'HEAD' : 'feature/cache';
    const follow = Math.floor(random() * 3);
    const steps: DailyStep[] = [
      { kind: 'turn', label: 'inspect recent repository work' },
      { kind: 'call', tool: 'list_commits', args: { ref, limit: 5 } },
      think(random),
      { kind: 'call', tool: 'show_commit', args: { selectionRank: rank } },
      think(random),
    ];
    if (follow === 0) {
      steps.push({ kind: 'call', tool: 'list_branches', args: {} }, think(random), {
        kind: 'call', tool: 'show_branch', args: { selectionRank: rank % 2 },
      });
    } else if (follow === 1) {
      steps.push({ kind: 'call', tool: 'list_tags', args: {} }, think(random), {
        kind: 'call', tool: 'show_tag', args: { selectionRank: 0 },
      });
    } else {
      steps.push({ kind: 'call', tool: 'changed_files', args: { selectionRank: rank } });
    }
    return steps;
  },
  'code-navigation': (random, session) => {
    const queries = ['refreshToken', 'Router', 'clearCache', 'validateToken'];
    const query = queries[(session + Math.floor(random() * queries.length)) % queries.length]!;
    const rank = Math.floor(random() * 3);
    const detail = random() < 0.5 ? 'get_symbol' : 'find_references';
    return [
      { kind: 'turn', label: 'trace a code path' },
      { kind: 'call', tool: 'search_files', args: { query } },
      think(random),
      { kind: 'call', tool: 'read_file', args: { selectionRank: rank } },
      think(random),
      { kind: 'call', tool: 'list_symbols', args: { fromPrevious: 'path' } },
      think(random),
      { kind: 'call', tool: detail, args: { selectionRank: Math.floor(random() * 2) } },
    ];
  },
  documentation: (random, session) => {
    const topics = ['typescript decorators', 'node streams', 'vitest timers', 'mcp resources'];
    const topic = topics[(session + Math.floor(random() * topics.length)) % topics.length]!;
    const rank = Math.floor(random() * 3);
    return [
      { kind: 'turn', label: 'research a library question' },
      { kind: 'call', tool: 'search_docs', args: { topic, limit: 5 } },
      think(random),
      { kind: 'call', tool: 'resolve_doc', args: { selectionRank: rank } },
      think(random),
      { kind: 'call', tool: 'fetch_doc', args: { fromPrevious: 'id' } },
      { kind: 'turn', label: 'follow a related topic' },
      { kind: 'call', tool: 'search_docs', args: { topic: `${topic} examples`, limit: 5 } },
    ];
  },
  'mutation-freshness': (random, session) => {
    const path = session % 2 === 0 ? 'src/auth.ts' : 'src/cache.ts';
    return [
      { kind: 'call', tool: 'list_files', args: { directory: 'src' } },
      think(random),
      { kind: 'call', tool: 'read_file', args: { path } },
      { kind: 'mutate', operation: `append-fixture-${session % 2}` },
      { kind: 'call', tool: 'read_file', args: { path } },
    ];
  },
  'negative-control': (random) => {
    const tools = ['lookup_a', 'lookup_b', 'lookup_c', 'lookup_d'];
    const steps: DailyStep[] = [];
    for (let i = 0; i < 10; i++) {
      steps.push({
        kind: 'call',
        tool: tools[Math.floor(random() * tools.length)]!,
        args: { value: Math.floor(random() * 1_000_000) },
      });
      if (i !== 9) steps.push(think(random));
    }
    return steps;
  },
};

function mixSeed(id: string, seed: number, session: number): number {
  let hash = (2166136261 ^ seed ^ session) >>> 0;
  for (let i = 0; i < id.length; i++) {
    hash ^= id.charCodeAt(i);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  hash ^= Math.imul(session + 1, 0x9e3779b1);
  return hash >>> 0;
}
