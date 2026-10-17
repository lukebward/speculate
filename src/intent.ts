/**
 * Prompt intent (DESIGN.md §13): the person's own words name the first read.
 *
 * `prompt.submit` fires before the model has read the prompt, which is the
 * earliest moment any signal exists. A few unambiguous phrasings map to one
 * concrete read: reviewing a GitHub pull request by URL, or listing a
 * directory. Anything looser maps to nothing. A wrong guess costs one wasted
 * read; a vague one would cost one on most prompts.
 *
 * Each mapping names a tool and exact arguments. The speculator then admits
 * it only for a tool that already ran read-only through the host with exactly
 * those argument keys, so a mapping never invents an argument shape.
 */

export interface IntentMapping {
  tool: string;
  args: Record<string, unknown>;
  /** Stable identity for feedback; never contains argument values. */
  ruleId: string;
}

const PULL_URL =
  /^(?:please\s+)?(?:review|inspect|read|open|check)\s+(?:the\s+)?(?:(?:pull request|pr)\s+(?:at\s+)?)?https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/([1-9]\d*)\.?$/i;
const WORKSPACE_LISTING =
  /^(?:please\s+)?(?:list|show)(?:\s+me)?\s+(?:(?:the\s+)?(?:contents|files|entries)\s+(?:in|of)\s+)?(?:the\s+)?(?:workspace|current|working)(?:\s+directory)?\.?$/i;
const ABSOLUTE_LISTING =
  /^(?:please\s+)?(?:list|show)(?:\s+me)?\s+(?:(?:the\s+)?(?:contents|files|entries)\s+(?:in|of)\s+)?(\/[^\s"'`]+?)\.?$/i;

/** Candidate reads for one prompt, most specific first; [] when none apply. */
export function intentMappings(text: string, cwd: string): IntentMapping[] {
  const input = text.trim();

  const pull = PULL_URL.exec(input);
  if (pull) {
    const pullNumber = Number(pull[3]);
    if (!Number.isSafeInteger(pullNumber)) return [];
    const owner = pull[1]!;
    const repo = pull[2]!;
    return [
      { tool: 'get_pull_request', args: { owner, repo, pull_number: pullNumber }, ruleId: 'intent:pull-request' },
      { tool: 'pull_request_read', args: { owner, repo, pullNumber, method: 'get' }, ruleId: 'intent:pull-request' },
    ];
  }

  if (WORKSPACE_LISTING.test(input)) {
    return [{ tool: 'list_directory', args: { path: cwd }, ruleId: 'intent:list-directory' }];
  }

  const absolute = ABSOLUTE_LISTING.exec(input);
  if (absolute) {
    return [{ tool: 'list_directory', args: { path: absolute[1]! }, ruleId: 'intent:list-directory' }];
  }
  return [];
}
