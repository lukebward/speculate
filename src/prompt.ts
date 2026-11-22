/**
 * What a prompt names (DESIGN.md §13): the identifiers in the person's own
 * words, laid out as a result the learner can read.
 *
 * The first call of an exchange takes its arguments from the prompt: "read
 * issue 41", "review https://github.com/acme/api/pull/7", "what does
 * src/app.ts do". No earlier call holds those values, so nothing that
 * follows calls can predict it. The learner already knows how to follow a
 * value from a result into the next call's arguments; this module gives it
 * the prompt as such a result, and the transition learner does the rest:
 * after two prompts that named an issue, "the number after the word issue"
 * is a learned source for `issue_number`, and the read starts while the
 * model is still reading the prompt.
 *
 * Only identifiers are taken: numbers (and the word before each), links,
 * owner/name pairs, paths and quoted strings. The prose is not kept. What
 * this returns lives in memory for the exchange; what the learner stores is
 * the PATH it read a value from (`named.issue`), never the value.
 */

/** The learner's name for the prompt as the call a first call follows. No tool can have it. */
export const PROMPT_TOOL = '@prompt';

/** How much of a prompt is read. A pasted log is not a place to look for a subject. */
const MAX_PROMPT_CHARS = 4_000;
const MAX_LINKS = 3;
const MAX_REPOS = 2;
const MAX_PATHS = 3;
const MAX_QUOTED = 3;
const MAX_NUMBERS = 4;
const MAX_NAMED = 6;
const MAX_QUOTED_CHARS = 200;

export interface PromptLink {
  url: string;
  host: string;
  /** The path's segments, as written. */
  path: string[];
}

export interface PromptFacts {
  /** A number by the word before it: "issue 41" is `issue: 41`. First mention wins. */
  named?: Record<string, number>;
  links?: PromptLink[];
  /** `owner/name` pairs that are not paths or links. */
  repos?: Array<{ owner: string; name: string; full: string }>;
  paths?: string[];
  /** Text inside double quotes or backticks. */
  quoted?: string[];
  /** Whole numbers, in order of first mention. */
  numbers?: number[];
}

const LINK = /https?:\/\/[^\s<>"'`)\]]+/g;
const QUOTED = /"([^"\n]{1,200})"|`([^`\n]{1,200})`|“([^”\n]{1,200})”/g;
const SLASHED = /(?<![\w./~-])(~|\.{1,2})?(\/?[\w.-]+(?:\/[\w.-]+)+)\/?(?![\w/-])/g;
const NUMBER = /(?<![\w.])#?(\d{1,15})(?![\w]|\.\d)/g;
const WORD_BEFORE = /([A-Za-z][A-Za-z_-]{0,30})[\s:]*#?$/;

/**
 * The identifiers in a prompt, or null when it names none. Never throws.
 * Key order is the order the learner breaks ties in: the specific reading
 * of a value (the number after "issue") comes before the bare one.
 */
export function promptFacts(text: string): PromptFacts | null {
  try {
    return read(text);
  } catch {
    return null;
  }
}

function read(text: string): PromptFacts | null {
  if (typeof text !== 'string') return null;
  const input = text.slice(0, MAX_PROMPT_CHARS);
  const named = new Map<string, number>();
  const numbers: number[] = [];
  const note = (value: number, label?: string): void => {
    if (!Number.isSafeInteger(value)) return;
    if (label !== undefined && label.length > 0 && !named.has(label) && named.size < MAX_NAMED) named.set(label, value);
    if (!numbers.includes(value) && numbers.length < MAX_NUMBERS) numbers.push(value);
  };

  const links: PromptLink[] = [];
  const withoutLinks = input.replace(LINK, (raw) => {
    const url = raw.replace(/[.,;:!?]+$/, '');
    const parts = /^https?:\/\/([^/?#]+)([^?#]*)/.exec(url);
    // A link that carries a login is not something to hold on to.
    if (parts && !parts[1]!.includes('@') && links.length < MAX_LINKS) {
      const path = parts[2]!.split('/').filter(Boolean).slice(0, 8);
      links.push({ url, host: parts[1]!, path });
      // `.../pull/7` names a number the way "pull 7" does.
      for (let i = 1; i < path.length; i++) {
        if (/^\d{1,15}$/.test(path[i]!) && /^[A-Za-z][A-Za-z_-]{0,30}$/.test(path[i - 1]!)) {
          note(Number(path[i]), path[i - 1]!.toLowerCase());
        }
      }
    }
    return ' ';
  });

  const quoted: string[] = [];
  for (const match of withoutLinks.matchAll(QUOTED)) {
    const inner = (match[1] ?? match[2] ?? match[3] ?? '').trim();
    if (inner.length === 0 || inner.length > MAX_QUOTED_CHARS || quoted.includes(inner)) continue;
    if (quoted.length < MAX_QUOTED) quoted.push(inner);
  }

  const repos: NonNullable<PromptFacts['repos']> = [];
  const paths: string[] = [];
  for (const match of withoutLinks.matchAll(SLASHED)) {
    const lead = match[1] ?? '';
    // The full stop that ends the sentence is not part of the name.
    const body = match[2]!.replace(/[.-]+$/, '');
    const parts = body.split('/').filter(Boolean);
    // `owner/name`: two words, no leading mark, no file extension on the second.
    const pair = lead === '' && !body.startsWith('/') && parts.length === 2 && !parts[1]!.includes('.') &&
      /^[A-Za-z0-9]/.test(parts[0]!) && /[A-Za-z]/.test(body);
    if (pair) {
      const full = `${parts[0]!}/${parts[1]!}`;
      if (repos.length < MAX_REPOS && !repos.some((repo) => repo.full === full)) {
        repos.push({ owner: parts[0]!, name: parts[1]!, full });
      }
    } else if (/[A-Za-z]/.test(body)) {
      const path = `${lead}${body}`;
      if (paths.length < MAX_PATHS && !paths.includes(path)) paths.push(path);
    }
  }

  // Numbers inside a path or a pair are part of that name, not a subject of their own.
  const prose = withoutLinks.replace(SLASHED, (raw) => ' '.repeat(raw.length));
  for (const match of prose.matchAll(NUMBER)) {
    const before = WORD_BEFORE.exec(prose.slice(Math.max(0, match.index - 40), match.index));
    note(Number(match[1]), before?.[1]?.toLowerCase());
  }

  const facts: PromptFacts = {
    ...(named.size > 0 ? { named: Object.fromEntries(named) } : {}),
    ...(links.length > 0 ? { links } : {}),
    ...(repos.length > 0 ? { repos } : {}),
    ...(paths.length > 0 ? { paths } : {}),
    ...(quoted.length > 0 ? { quoted } : {}),
    ...(numbers.length > 0 ? { numbers } : {}),
  };
  return Object.keys(facts).length > 0 ? facts : null;
}
