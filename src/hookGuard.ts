/**
 * Settings hooks a served call must not bypass (DESIGN.md §4).
 *
 * A served call still runs through Claude Code's PreToolUse hooks: the mod
 * answers it only after they let it through unchanged (hooks/register.ts).
 * What a served call skips is PostToolUse, because no tool ran. A mod cannot
 * raise that event itself.
 *
 * A catch-all PostToolUse hook (no matcher, `*`, `.*`) is an observer of
 * every tool, typically a logger or notifier; it misses served reads, which
 * the documentation says. A PostToolUse hook whose matcher names tools was
 * written for those tools, to post-process or annotate their results. A
 * tool such a hook matches is never served, so the hook keeps seeing every
 * call it was written for. Matching errs wide: a targeted matcher is read as
 * a regular expression tested anywhere in the name, which also covers exact
 * names and `a|b` lists, and one that does not compile matches every tool.
 */

const POST_TOOL_EVENTS = ['PostToolUse', 'PostToolUseFailure'] as const;
const CATCH_ALL = new Set(['', '*', '.*', '.+']);

export type ToolWatch = (toolName: string) => boolean;

/** A predicate over full tool names (`mcp__server__tool`) from merged settings. */
export function settingsToolWatch(settings: unknown): ToolWatch {
  const hooks = record(settings) ? settings['hooks'] : undefined;
  if (!record(hooks)) return () => false;
  const matchers: Array<(name: string) => boolean> = [];
  for (const event of POST_TOOL_EVENTS) {
    const groups = hooks[event];
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      if (!record(group) || !Array.isArray(group['hooks']) || group['hooks'].length === 0) continue;
      const matcher = group['matcher'];
      if (matcher === undefined || matcher === null) continue;
      if (typeof matcher !== 'string') {
        matchers.push(() => true);
        continue;
      }
      if (CATCH_ALL.has(matcher.trim())) continue;
      matchers.push(compile(matcher));
    }
  }
  if (matchers.length === 0) return () => false;
  return (name) => matchers.some((matches) => matches(name));
}

function compile(matcher: string): (name: string) => boolean {
  try {
    const pattern = new RegExp(matcher);
    return (name) => pattern.test(name);
  } catch {
    return () => true;
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
