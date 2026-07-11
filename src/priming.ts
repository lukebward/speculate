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
 * A prime is a THRESHOLD change, not knowledge: the transition still only
 * predicts after the user's own traffic exhibits it once (arguments are
 * always learned from real calls), and from then on it grows, decays, and
 * persists exactly like any learned transition. Cost of a wrong prior: one
 * Set entry; the feedback loop suppresses primes that never pay.
 */

const LISTER_PREFIX = /^(list|search|find|query|browse|enumerate)[_-]?(.*)$/;
const GETTER_PREFIX = /^(get|show|read|fetch|describe|view)[_-]?(.*)$/;
const LISTER_SUFFIX = /^(.*?)[_-](list|search)$/;
const GETTER_SUFFIX = /^(.*?)[_-](get|show|read|fetch)$/;

/** Normalize a stem: case/punctuation-insensitive, singular/plural-tolerant. */
function stem(raw: string): string {
  let s = raw.toLowerCase().replace(/[_-]/g, '');
  if (s.endsWith('es')) s = s.slice(0, -2);
  else if (s.endsWith('s')) s = s.slice(0, -1);
  return s;
}

function listerStem(tool: string): string | null {
  const pre = LISTER_PREFIX.exec(tool);
  if (pre && pre[2]) return stem(pre[2]);
  const suf = LISTER_SUFFIX.exec(tool);
  if (suf && suf[1]) return stem(suf[1]);
  return null;
}

function getterStem(tool: string): string | null {
  const pre = GETTER_PREFIX.exec(tool);
  if (pre && pre[2]) return stem(pre[2]);
  const suf = GETTER_SUFFIX.exec(tool);
  if (suf && suf[1]) return stem(suf[1]);
  return null;
}

/**
 * Lister → getter pairs among the given tool names, matched on normalized
 * stems: ['list_issues','get_issue'] → [['list_issues','get_issue']].
 * Deterministic order (input order, listers outer).
 */
export function morphologicalPairs(toolNames: string[]): Array<[string, string]> {
  const getters: Array<{ tool: string; stem: string }> = [];
  for (const t of toolNames) {
    const s = getterStem(t);
    if (s) getters.push({ tool: t, stem: s });
  }
  const pairs: Array<[string, string]> = [];
  for (const t of toolNames) {
    const s = listerStem(t);
    if (!s) continue;
    for (const g of getters) {
      if (g.tool !== t && g.stem === s) pairs.push([t, g.tool]);
    }
  }
  return pairs;
}
