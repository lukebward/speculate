/**
 * Pre-loaded transition priors (DESIGN.md §13.9).
 *
 * Two sources feed learner.prime():
 * 1. Vetted profiles ship curated (prev → next) pairs.
 * 2. Tool-name morphology: MCP servers overwhelmingly pair enumeration
 *    tools with detail tools ("list_issues" → "get_issue",
 *    "search_users" → "get_user", "notion-search" → "notion-fetch"-style
 *    stems). Any eligible lister/getter pair sharing a stem is primed.
 *
 * A prime names a plausible transition, not invented arguments. When the
 * getter schema and the lister's real JSON result identify one unambiguous
 * complete argument set, schema-backed cold start may predict immediately.
 * Otherwise the transition still waits for the user's own traffic to exhibit
 * it once, then grows, decays, and persists like any learned transition.
 */

const LISTER_PREFIX = /^(list|search|find|query|browse|enumerate)[_-]?(.*)$/;
const GETTER_PREFIX = /^(get|show|read|fetch|describe|view)[_-]?(.*)$/;
const LISTER_SUFFIX = /^(.*?)[_-](list|search)$/;
const GETTER_SUFFIX = /^(.*?)[_-](get|show|read|fetch|view|describe)$/;

/**
 * Candidate stems for a noun: raw, minus trailing 's', minus trailing 'es'.
 * Pairing on candidate-set intersection is plural-tolerant in BOTH
 * directions — issues/issue, branches/branch, releases/release,
 * statuses/status — without a full stemming algorithm.
 */
function stemCandidates(raw: string): Set<string> {
  const s = raw.toLowerCase().replace(/[_-]/g, '');
  const out = new Set<string>();
  const add = (c: string) => {
    if (c.length > 0) out.add(c); // '' would pair everything with everything
  };
  add(s);
  if (s.endsWith('s')) add(s.slice(0, -1));
  if (s.endsWith('es')) add(s.slice(0, -2));
  return out;
}

function listerStems(tool: string): Set<string> | null {
  const pre = LISTER_PREFIX.exec(tool);
  if (pre && pre[2]) return stemCandidates(pre[2]);
  const suf = LISTER_SUFFIX.exec(tool);
  if (suf && suf[1]) return stemCandidates(suf[1]);
  return null;
}

function getterStems(tool: string): Set<string> | null {
  const pre = GETTER_PREFIX.exec(tool);
  if (pre && pre[2]) return stemCandidates(pre[2]);
  const suf = GETTER_SUFFIX.exec(tool);
  if (suf && suf[1]) return stemCandidates(suf[1]);
  return null;
}

function intersects(a: Set<string>, b: Set<string>): boolean {
  for (const x of a) if (b.has(x)) return true;
  return false;
}

/**
 * Lister → getter pairs among the given tool names, matched on stem
 * candidates: ['list_issues','get_issue'] → [['list_issues','get_issue']].
 * Deterministic order (input order, listers outer).
 */
export function morphologicalPairs(toolNames: string[]): Array<[string, string]> {
  const getters: Array<{ tool: string; stems: Set<string> }> = [];
  for (const t of toolNames) {
    const s = getterStems(t);
    if (s) getters.push({ tool: t, stems: s });
  }
  const pairs: Array<[string, string]> = [];
  for (const t of toolNames) {
    const s = listerStems(t);
    if (!s) continue;
    for (const g of getters) {
      if (g.tool !== t && intersects(s, g.stems)) pairs.push([t, g.tool]);
    }
  }
  return pairs;
}
