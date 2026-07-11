#!/usr/bin/env node
/**
 * PreToolUse hook: route read-only Bash commands through `speculate exec`
 * so the agent's NATIVE shell calls hit the per-workspace speculation
 * daemon (DESIGN.md §13.12) — the seam §13.8 called Tier B, delivered
 * without PATH shims or rc edits because the plugin system carries it.
 *
 * Deliberately dependency-free and standalone: plugins install as a git
 * checkout with no build step, so this file must run on bare `node`.
 *
 * Fail-open discipline (every guard falls through to "change nothing"):
 *  - only the Bash tool, only when SPECULATE_HOOK_OFF is unset;
 *  - only command strings whose semantics survive a prefix rewrite: no
 *    quoting, substitution, chaining, or redirection characters. Glob and
 *    brace characters are fine — the same shell expands them identically
 *    before and after the rewrite;
 *  - only commands the exec table could possibly serve (cheap prefix
 *    check here; `speculate exec` re-validates fully and passes anything
 *    else through untouched);
 *  - only when the `speculate` CLI is actually on PATH.
 *
 * On hosts whose PreToolUse doesn't support updatedInput, the emitted
 * JSON is ignored and the original command runs — still fail-open.
 *
 * Known UX note: rewriting changes permission-rule matching (an allow
 * rule for `git status:*` won't match `speculate exec -- git status`);
 * add an allow rule for `speculate exec:*` if you use fine-grained
 * Bash permissions.
 */
import { statSync } from 'node:fs';
import { delimiter, join } from 'node:path';

/** Semantics-changing shell syntax: never rewrite around these. */
const UNSAFE_CHARS = /[;&|<>$`"'\\()#\n\r]/;

/** Prefixes the exec table can serve (it re-validates the full argv). */
const REWRITABLE_PREFIXES = [
  'git status',
  'git diff',
  'git log',
  'git show',
  'git branch',
  'git rev-parse',
  'rg ',
  'ls ',
  'ls',
];

/**
 * Absolute path to the `speculate` executable on this process's PATH, or
 * null. We rewrite to the ABSOLUTE path, not the bare name: the rewritten
 * command runs in the host's persistent Bash shell, whose PATH can differ
 * from this hook's — resolving here and emitting the full path keeps a
 * PATH mismatch from turning a read-only command into an exit-127 failure
 * (which would breach fail-open). Must be a regular file, not a directory
 * named `speculate`.
 */
function speculateBin() {
  const path = process.env.PATH ?? '';
  for (const dir of path.split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, 'speculate');
    try {
      const st = statSync(candidate);
      if (st.isFile() && (st.mode & 0o111) !== 0) return candidate;
    } catch {
      // keep looking
    }
  }
  return null;
}

function rewritable(command) {
  if (typeof command !== 'string') return false;
  const trimmed = command.trim();
  if (trimmed.length === 0 || trimmed.length > 1500) return false;
  if (UNSAFE_CHARS.test(trimmed)) return false;
  // Already routed (bare name or absolute path): never double-wrap.
  if (/(^|\/)speculate(\s|$)/.test(trimmed)) return false;
  return REWRITABLE_PREFIXES.some(
    (p) => trimmed === p.trim() || trimmed.startsWith(p.endsWith(' ') ? p : `${p} `),
  );
}

async function main() {
  if (process.env.SPECULATE_HOOK_OFF === '1') return;

  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));

  if (input.tool_name !== 'Bash') return;
  const command = input.tool_input?.command;
  if (!rewritable(command)) return;
  const bin = speculateBin();
  if (!bin) return;

  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        updatedInput: {
          ...input.tool_input,
          command: `${bin} exec -- ${command.trim()}`,
        },
      },
    }),
  );
}

main().catch(() => {
  // Fail open: say nothing, change nothing.
});
