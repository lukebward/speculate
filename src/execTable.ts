/**
 * The vetted argv table for native-CLI speculation (DESIGN.md §13.12).
 *
 * `speculate exec` serves BYTE-FAITHFUL output of real commands, so unlike
 * the MCP shell server (which returns parsed JSON), the unit of caching
 * here is the command line itself. This table decides, fail-closed, which
 * command lines are (a) affirmatively read-only and (b) safe to re-execute
 * speculatively:
 *
 *   - fixed binary + subcommand per class, execFile only (no shell);
 *   - flags must come from a closed per-class set — an unknown flag makes
 *     the whole command unclassifiable (passthrough, never speculated);
 *   - free strings are typed: refs are regex-validated, paths are
 *     containment-checked against the workspace, patterns ride after `--`;
 *   - predictions materialize back through classify(), so learned state
 *     (untrusted: it lives on disk) can never assemble an argv this table
 *     wouldn't have accepted from the user.
 *
 * The learner's tool ids never contain spaces (its key format); variable
 * parts travel in args so argument templates can flow (e.g. git_log's
 * parsed shas → git_show's ref).
 */
import { existsSync } from 'node:fs';
import { isAbsolute, resolve, sep } from 'node:path';

export interface ClassifiedCommand {
  /** Learner tool id, e.g. 'git_status'. No spaces. */
  tool: string;
  /** Variable parts, all strings, for learner argument templates. */
  args: Record<string, string>;
  /** The command line to key the cache on and to execute (unhardened). */
  argv: string[];
  ttlMs: number;
}

const DEFAULT_TTL_MS = 15_000;
/** Content-addressed reads stay fresh far longer. */
const SHA_TTL_MS = 5 * 60_000;

/** Join/split for multi-token args stored as single learner strings. */
export const ARG_SEP = '\x1f';

const REF_RE = /^[A-Za-z0-9][A-Za-z0-9_./~^@{}-]{0,255}$/;
const GLOB_RE = /^[A-Za-z0-9_*.{},/[\]!-]{1,256}$/;
const RG_TYPE_RE = /^[a-z0-9+-]{1,20}$/;
const SHA_RE = /^[0-9a-f]{7,40}$/;

function validRef(ref: string): boolean {
  return REF_RE.test(ref) && !ref.startsWith('-');
}

/** Path must stay inside the workspace; never NUL, never flag-shaped. */
function validPath(root: string, p: string): boolean {
  if (p.startsWith('-') || p.includes('\0') || p.length > 1024) return false;
  const abs = isAbsolute(p) ? p : resolve(root, p);
  const normalizedRoot = resolve(root);
  return abs === normalizedRoot || abs.startsWith(normalizedRoot + sep);
}

interface FlagSpec {
  /** Boolean flags allowed for the class. */
  flags: Set<string>;
}

const GIT_STATUS_FLAGS = new Set([
  '-s',
  '--short',
  '-b',
  '--branch',
  '--porcelain',
  '--porcelain=v1',
  '--porcelain=v2',
  '-uno',
  '-uall',
  '--untracked-files=no',
  '--untracked-files=normal',
  '--untracked-files=all',
  '--no-color',
]);

const GIT_DIFF_FLAGS = new Set([
  '--cached',
  '--staged',
  '--stat',
  '--name-only',
  '--name-status',
  '--no-color',
  '--no-ext-diff',
]);

const GIT_LOG_FLAGS = new Set(['--oneline', '--stat', '--decorate', '--graph', '--no-color']);

const GIT_SHOW_FLAGS = new Set(['--stat', '--name-only', '--oneline', '--no-color']);

const GIT_BRANCH_FLAGS = new Set([
  '-a',
  '--all',
  '-r',
  '-v',
  '-vv',
  '--list',
  '--show-current',
  '--no-color',
]);

const GIT_REV_PARSE_FLAGS = new Set([
  '--abbrev-ref',
  '--short',
  '--show-toplevel',
  '--git-dir',
  '--is-inside-work-tree',
]);

const RG_BOOL_FLAGS = new Set([
  '-n',
  '--line-number',
  '-i',
  '--ignore-case',
  '-l',
  '--files-with-matches',
  '-c',
  '--count',
  '-w',
  '--word-regexp',
  '-F',
  '--fixed-strings',
  '-S',
  '--smart-case',
  '--no-heading',
  '--heading',
  '--hidden',
  '--no-ignore',
  '--color=never',
]);

/** rg value flags: flag token followed by a validated value token. */
const RG_VALUE_FLAGS: Record<string, (v: string) => boolean> = {
  '-g': (v) => GLOB_RE.test(v) && !v.startsWith('-'),
  '--glob': (v) => GLOB_RE.test(v) && !v.startsWith('-'),
  '-t': (v) => RG_TYPE_RE.test(v),
  '--type': (v) => RG_TYPE_RE.test(v),
  '-A': (v) => isBoundedInt(v, 0, 50),
  '-B': (v) => isBoundedInt(v, 0, 50),
  '-C': (v) => isBoundedInt(v, 0, 50),
  '-m': (v) => isBoundedInt(v, 1, 5000),
  '--max-count': (v) => isBoundedInt(v, 1, 5000),
};

const LS_LETTERS = new Set(['l', 'a', 'A', 'h', '1', 't', 'r', 'S', 'F']);

function isBoundedInt(v: string, min: number, max: number): boolean {
  if (!/^\d{1,6}$/.test(v)) return false;
  const n = Number(v);
  return Number.isInteger(n) && n >= min && n <= max;
}

// ---------------------------------------------------------------------------
// classify
// ---------------------------------------------------------------------------

/**
 * Classify an argv against the vetted table. Null means "not ours":
 * the caller runs it directly, uncached, unspeculated (fail open for
 * behavior, fail closed for speculation).
 */
export function classify(argv: string[], root: string): ClassifiedCommand | null {
  if (argv.length === 0 || argv.length > 64) return null;
  if (argv.some((t) => typeof t !== 'string' || t.includes('\0') || t.length > 4096)) return null;
  const [bin, ...rest] = argv;
  try {
    if (bin === 'git') return classifyGit(rest, root, argv);
    if (bin === 'rg') return classifyRg(rest, root, argv);
    if (bin === 'ls') return classifyLs(rest, root, argv);
  } catch {
    return null; // any surprise fails closed
  }
  return null;
}

function simpleFlagClass(
  tool: string,
  tokens: string[],
  spec: FlagSpec,
  argv: string[],
): ClassifiedCommand | null {
  const flags: string[] = [];
  for (const t of tokens) {
    if (!spec.flags.has(t)) return null;
    flags.push(t);
  }
  return {
    tool,
    args: { flags: [...flags].sort().join(' ') },
    argv,
    ttlMs: DEFAULT_TTL_MS,
  };
}

function classifyGit(rest: string[], root: string, argv: string[]): ClassifiedCommand | null {
  const sub = rest[0];
  const tokens = rest.slice(1);
  switch (sub) {
    case 'status':
      return simpleFlagClass('git_status', tokens, { flags: GIT_STATUS_FLAGS }, argv);
    case 'branch': {
      // Positional tokens create branches; only flags are acceptable.
      return simpleFlagClass('git_branch', tokens, { flags: GIT_BRANCH_FLAGS }, argv);
    }
    case 'diff': {
      const flags: string[] = [];
      const paths: string[] = [];
      let afterDashes = false;
      for (const t of tokens) {
        if (!afterDashes && t === '--') {
          afterDashes = true;
        } else if (!afterDashes && GIT_DIFF_FLAGS.has(t)) {
          flags.push(t);
        } else if (t.startsWith('-') && !afterDashes) {
          return null;
        } else {
          // Bare tokens are accepted as paths only — revs are ambiguous
          // with paths and stay out of the table (passthrough).
          if (!validPath(root, t)) return null;
          if (!afterDashes && !existsSync(resolve(root, t))) return null;
          paths.push(t);
        }
      }
      return {
        tool: 'git_diff',
        args: { flags: [...flags].sort().join(' '), paths: paths.join(ARG_SEP) },
        argv,
        ttlMs: DEFAULT_TTL_MS,
      };
    }
    case 'log': {
      const flags: string[] = [];
      let count = '';
      let path = '';
      let afterDashes = false;
      for (let i = 0; i < tokens.length; i++) {
        const t = tokens[i]!;
        if (!afterDashes && t === '--') {
          afterDashes = true;
        } else if (!afterDashes && GIT_LOG_FLAGS.has(t)) {
          flags.push(t);
        } else if (!afterDashes && (t === '-n' || t === '--max-count')) {
          const v = tokens[++i];
          if (v === undefined || !isBoundedInt(v, 1, 1000)) return null;
          count = v;
        } else if (!afterDashes && /^--max-count=\d{1,6}$/.test(t)) {
          const v = t.slice('--max-count='.length);
          if (!isBoundedInt(v, 1, 1000)) return null;
          count = v;
        } else if (!afterDashes && /^-\d{1,6}$/.test(t)) {
          const v = t.slice(1);
          if (!isBoundedInt(v, 1, 1000)) return null;
          count = v;
        } else if (!t.startsWith('-') || afterDashes) {
          if (path !== '' || !validPath(root, t)) return null;
          if (!afterDashes && !existsSync(resolve(root, t))) return null;
          path = t;
        } else {
          return null;
        }
      }
      return {
        tool: 'git_log',
        args: { flags: [...flags].sort().join(' '), count, path },
        argv,
        ttlMs: DEFAULT_TTL_MS,
      };
    }
    case 'show': {
      const flags: string[] = [];
      let ref = '';
      const paths: string[] = [];
      let afterDashes = false;
      for (const t of tokens) {
        if (!afterDashes && t === '--') {
          afterDashes = true;
        } else if (!afterDashes && GIT_SHOW_FLAGS.has(t)) {
          flags.push(t);
        } else if (!afterDashes && !t.startsWith('-')) {
          if (ref !== '' || !validRef(t)) return null;
          ref = t;
        } else if (afterDashes) {
          if (!validPath(root, t)) return null;
          paths.push(t);
        } else {
          return null;
        }
      }
      return {
        tool: 'git_show',
        args: { ref, flags: [...flags].sort().join(' '), paths: paths.join(ARG_SEP) },
        argv,
        ttlMs: SHA_RE.test(ref) ? SHA_TTL_MS : DEFAULT_TTL_MS,
      };
    }
    case 'rev-parse': {
      const flags: string[] = [];
      let ref = '';
      for (const t of tokens) {
        if (GIT_REV_PARSE_FLAGS.has(t)) {
          flags.push(t);
        } else if (!t.startsWith('-') && ref === '' && validRef(t)) {
          ref = t;
        } else {
          return null;
        }
      }
      return {
        tool: 'git_rev_parse',
        args: { flags: [...flags].sort().join(' '), ref },
        argv,
        ttlMs: DEFAULT_TTL_MS,
      };
    }
    default:
      return null;
  }
}

function classifyRg(tokens: string[], root: string, argv: string[]): ClassifiedCommand | null {
  let pattern: string | null = null;
  const paths: string[] = [];
  let afterDashes = false;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (!afterDashes && t === '--') {
      afterDashes = true;
    } else if (!afterDashes && RG_BOOL_FLAGS.has(t)) {
      // boolean flag, order preserved via argv
    } else if (!afterDashes && Object.hasOwn(RG_VALUE_FLAGS, t)) {
      const v = tokens[++i];
      if (v === undefined || !RG_VALUE_FLAGS[t]!(v)) return null;
    } else if (!afterDashes && /^(--glob|--type|--max-count)=/.test(t)) {
      const eq = t.indexOf('=');
      const validator = RG_VALUE_FLAGS[t.slice(0, eq)];
      if (!validator || !validator(t.slice(eq + 1))) return null;
    } else if (!afterDashes && t.startsWith('-')) {
      return null; // unknown flag: the whole line is not ours
    } else if (pattern === null) {
      if (!afterDashes && t.startsWith('-')) return null;
      pattern = t;
    } else {
      if (!validPath(root, t)) return null;
      paths.push(t);
    }
  }
  if (pattern === null || pattern.length > 512) return null;
  // A path-less `rg PATTERN` searches stdin, not the tree, when stdin isn't
  // a terminal — which is exactly how we'd have to run it. Rather than
  // guess the caller's stdin (and risk serving an empty-stdin "no match"
  // where the real shell would search files), leave it to passthrough. Only
  // rg WITH an explicit path is unambiguous and stdin-independent.
  if (paths.length === 0) return null;
  return {
    tool: 'rg',
    // The full argv also rides along (ARG_SEP-joined) so predictions can
    // only replay a literally-seen command line, flags included.
    args: { pattern, argv: argv.join(ARG_SEP) },
    argv,
    ttlMs: DEFAULT_TTL_MS,
  };
}

function classifyLs(tokens: string[], root: string, argv: string[]): ClassifiedCommand | null {
  const flags: string[] = [];
  const paths: string[] = [];
  for (const t of tokens) {
    if (/^-[A-Za-z0-9]+$/.test(t)) {
      if (![...t.slice(1)].every((ch) => LS_LETTERS.has(ch))) return null;
      flags.push(t);
    } else if (t.startsWith('-')) {
      return null;
    } else {
      if (!validPath(root, t)) return null;
      paths.push(t);
    }
  }
  return {
    tool: 'ls',
    args: { flags: [...flags].sort().join(' '), paths: paths.join(ARG_SEP) },
    argv,
    ttlMs: DEFAULT_TTL_MS,
  };
}

// ---------------------------------------------------------------------------
// materialize (predictions → argv, re-vetted)
// ---------------------------------------------------------------------------

/**
 * Turn a learner prediction back into an argv, then prove it through
 * classify() again. Learned state is untrusted input (it persists on
 * disk): nothing reaches execution without a fresh pass through the same
 * validation the user's own command lines get.
 */
export function materialize(
  tool: string,
  args: Record<string, unknown>,
  root: string,
): ClassifiedCommand | null {
  const s = (k: string): string => (typeof args[k] === 'string' ? (args[k] as string) : '');
  const splitFlags = (v: string): string[] => v.split(' ').filter(Boolean);
  const splitSep = (v: string): string[] => v.split(ARG_SEP).filter(Boolean);
  let argv: string[] | null = null;
  switch (tool) {
    case 'git_status':
      argv = ['git', 'status', ...splitFlags(s('flags'))];
      break;
    case 'git_branch':
      argv = ['git', 'branch', ...splitFlags(s('flags'))];
      break;
    case 'git_diff': {
      const paths = splitSep(s('paths'));
      argv = ['git', 'diff', ...splitFlags(s('flags')), ...(paths.length ? ['--', ...paths] : [])];
      break;
    }
    case 'git_log': {
      const count = s('count');
      const path = s('path');
      argv = [
        'git',
        'log',
        ...splitFlags(s('flags')),
        ...(count ? ['-n', count] : []),
        ...(path ? ['--', path] : []),
      ];
      break;
    }
    case 'git_show': {
      const ref = s('ref');
      const paths = splitSep(s('paths'));
      argv = [
        'git',
        'show',
        ...splitFlags(s('flags')),
        ...(ref ? [ref] : []),
        ...(paths.length ? ['--', ...paths] : []),
      ];
      break;
    }
    case 'git_rev_parse': {
      const ref = s('ref');
      argv = ['git', 'rev-parse', ...splitFlags(s('flags')), ...(ref ? [ref] : [])];
      break;
    }
    case 'rg':
      argv = splitSep(s('argv'));
      break;
    case 'ls': {
      const paths = splitSep(s('paths'));
      argv = ['ls', ...splitFlags(s('flags')), ...paths];
      break;
    }
    default:
      return null;
  }
  if (!argv || argv.length === 0) return null;
  const cls = classify(argv, root);
  return cls && cls.tool === tool ? cls : null;
}

/** Cache key: exact command line in an exact workspace. */
export function cacheKey(root: string, argv: string[]): string {
  return `${resolve(root)}\0${argv.join('\0')}`;
}

/**
 * Curated CLI priors (§13.9 semantics: one sighting arms the pair;
 * argument templates still come only from real traffic).
 */
export const CLI_PRIMES: Array<[string, string]> = [
  ['git_status', 'git_diff'],
  ['git_status', 'git_branch'],
  ['git_status', 'git_log'],
  ['git_log', 'git_show'],
  ['git_branch', 'git_status'],
  ['git_diff', 'git_status'],
];

/** Server label for CLI transitions in the learner. */
export const CLI_SERVER = 'cli';
