/**
 * speculate-shell — read-only workspace commands as an MCP server, built to
 * sit behind Speculate (DESIGN.md §13.8, "Tier A" CLI speculation).
 *
 * Exposes a fixed, allowlisted set of read-only git/filesystem/search tools
 * so the proxy's prediction machinery (profiles, config rules, the learner)
 * applies to CLI workflows exactly as it does to API-backed MCP servers.
 *
 * Security posture (treat every argument as attacker-controlled — the model
 * can be prompt-injected):
 * - execFile with a FIXED binary per tool, never a shell: strings cannot
 *   become syntax.
 * - No user string may become a flag: refs/globs are regex-validated and
 *   must not start with '-'; paths are containment-checked against the
 *   workspace root; free-text (search patterns) only ever appears after
 *   a `--` separator.
 * - git's config-driven code-execution paths are disabled per invocation:
 *   hooks (core.hooksPath), fsmonitor, external diff drivers
 *   (--no-ext-diff), pagers, terminal prompts. GIT_OPTIONAL_LOCKS=0 keeps
 *   even `git status` from writing the index — the readOnlyHint on these
 *   tools is meant literally.
 * - Timeouts and output caps bound resource use.
 *
 * Freshness: a debounced watcher on the workspace emits tools/list_changed
 * whenever files change; Speculate's documented response (§3.4) is to flush
 * that server's speculation buffer, so locally-edited state invalidates in
 * ~300 ms without waiting out the TTL.
 *
 * Capability baseline: nothing here exceeds what an agent with shell access
 * already has — the hardening exists to prevent writes and injection, not
 * to be a read sandbox.
 */
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, statSync, watch } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import {
  ParamError,
  TOOL_NAME_RE,
  buildArgv,
  inputShapeFor,
  loadCommandRegistry,
  type CommandRegistry,
  type CommandSpec,
} from './commands.js';
import { CATALOG, probePasses } from './catalog.js';

const EXEC_TIMEOUT_MS = 10_000;
const MAX_OUTPUT_BYTES = 512 * 1024;
const WATCH_DEBOUNCE_MS = 300;

// A directory guaranteed to contain no hooks; --no-ext-diff etc. below.
const EMPTY_HOOKS_DIR = mkdtempSync(join(tmpdir(), 'speculate-nohooks-'));

/** Common hardening for every git invocation. */
const GIT_BASE_ARGS = [
  '-c',
  `core.hooksPath=${EMPTY_HOOKS_DIR}`,
  '-c',
  'core.fsmonitor=false',
  '--no-pager',
];

const GIT_ENV = {
  GIT_OPTIONAL_LOCKS: '0',
  GIT_TERMINAL_PROMPT: '0',
  GIT_PAGER: 'cat',
  LC_ALL: 'C',
};

// ---------------------------------------------------------------------------
// Argument validation (fail closed; nothing user-supplied may become a flag)
// ---------------------------------------------------------------------------

/** Git ref/rev: conservative charset, no leading '-', no whitespace. */
const REF_RE = /^[A-Za-z0-9][A-Za-z0-9_./~^@{}-]{0,255}$/;
/** rg glob: conservative charset, no leading '-'. */
const GLOB_RE = /^[A-Za-z0-9_*.{},/[\]!-]{1,256}$/;

class ArgError extends Error {}

function validateRef(ref: string): string {
  if (!REF_RE.test(ref) || ref.startsWith('-')) {
    throw new ArgError(`invalid ref '${ref.slice(0, 64)}'`);
  }
  return ref;
}

function validateGlob(glob: string): string {
  if (glob.startsWith('-') || !GLOB_RE.test(glob)) {
    throw new ArgError(`invalid glob '${glob.slice(0, 64)}'`);
  }
  return glob;
}

/**
 * Resolve a user path against the workspace and require containment.
 * Defense-in-depth: the agent can read outside anyway via its own shell,
 * but this server never operates outside its --cwd.
 */
function validatePath(root: string, userPath: string): string {
  if (userPath.startsWith('-')) throw new ArgError(`invalid path '${userPath.slice(0, 64)}'`);
  if (userPath.includes('\0')) throw new ArgError('invalid path (NUL)');
  const abs = isAbsolute(userPath) ? userPath : resolve(root, userPath);
  const normalizedRoot = resolve(root);
  if (abs !== normalizedRoot && !abs.startsWith(normalizedRoot + sep)) {
    throw new ArgError(`path escapes the workspace: '${userPath.slice(0, 128)}'`);
  }
  return abs;
}

/** Workspace-relative form for handing to git/rg (keeps output readable). */
function relForExec(root: string, abs: string): string {
  const normalizedRoot = resolve(root);
  return abs === normalizedRoot ? '.' : abs.slice(normalizedRoot.length + 1);
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

function run(
  cwd: string,
  bin: string,
  args: string[],
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolvePromise) => {
    execFile(
      bin,
      args,
      {
        cwd,
        timeout: EXEC_TIMEOUT_MS,
        maxBuffer: MAX_OUTPUT_BYTES,
        env: { ...process.env, ...GIT_ENV },
        windowsHide: true,
      },
      (err, stdout, stderr) => {
        const anyErr = err as (Error & { code?: number | string; killed?: boolean }) | null;
        if (anyErr && (anyErr.killed || anyErr.code === 'ETIMEDOUT')) {
          resolvePromise({ stdout: '', stderr: `timed out after ${EXEC_TIMEOUT_MS} ms`, code: 124 });
          return;
        }
        const code = typeof anyErr?.code === 'number' ? anyErr.code : anyErr ? 1 : 0;
        resolvePromise({ stdout: stdout ?? '', stderr: stderr ?? '', code });
      },
    );
  });
}

type Payload = Record<string, unknown>;

function okResult(payload: Payload) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(payload) }] };
}

function errResult(message: string) {
  return {
    isError: true,
    content: [{ type: 'text' as const, text: JSON.stringify({ error: message }) }],
  };
}

// ---------------------------------------------------------------------------
// Output parsers (our own command output → structured JSON payloads)
// ---------------------------------------------------------------------------

function parseStatusPorcelainV2(out: string): Payload {
  let branch = '';
  let upstream: string | undefined;
  let ahead = 0;
  let behind = 0;
  const entries: { path: string; status: string; staged: boolean }[] = [];
  for (const line of out.split('\n')) {
    if (line.startsWith('# branch.head ')) branch = line.slice(14);
    else if (line.startsWith('# branch.upstream ')) upstream = line.slice(18);
    else if (line.startsWith('# branch.ab ')) {
      const m = /\+(\d+) -(\d+)/.exec(line);
      if (m) {
        ahead = Number(m[1]);
        behind = Number(m[2]);
      }
    } else if (line.startsWith('1 ') || line.startsWith('2 ')) {
      const xy = line.slice(2, 4);
      const path = line.split(' ').slice(8).join(' ');
      entries.push({ path, status: xy.trim(), staged: xy[0] !== '.' });
    } else if (line.startsWith('? ')) {
      entries.push({ path: line.slice(2), status: '??', staged: false });
    }
  }
  return { branch, upstream, ahead, behind, entries };
}

const LOG_FIELD_SEP = '\x1f';
const LOG_RECORD_SEP = '\x1e';

function parseLog(out: string): Payload {
  const commits = out
    .split(LOG_RECORD_SEP)
    .map((r) => r.trim())
    .filter(Boolean)
    .map((record) => {
      const [sha, authorName, date, subject] = record.split(LOG_FIELD_SEP);
      return { sha: sha ?? '', authorName: authorName ?? '', date: date ?? '', subject: subject ?? '' };
    })
    .filter((c) => c.sha.length > 0);
  return { commits };
}

function parseBranches(out: string): Payload {
  const branches = out
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [name, sha, head] = line.split(LOG_FIELD_SEP);
      return { name: name ?? '', sha: sha ?? '', current: head === '*' };
    });
  return { current: branches.find((b) => b.current)?.name ?? '', branches };
}

function parseRgLines(out: string, cap: number): Payload {
  const matches: { file: string; line: number; text: string }[] = [];
  for (const raw of out.split('\n')) {
    if (matches.length >= cap) break;
    if (!raw) continue;
    // rg -n --no-heading: file:line:text (file may not contain ':' on our
    // validated inputs often enough; split conservatively on first two).
    const first = raw.indexOf(':');
    const second = first === -1 ? -1 : raw.indexOf(':', first + 1);
    if (second === -1) continue;
    const lineNo = Number(raw.slice(first + 1, second));
    if (!Number.isInteger(lineNo)) continue;
    matches.push({
      file: raw.slice(0, first),
      line: lineNo,
      text: raw.slice(second + 1).slice(0, 500),
    });
  }
  return { matches, truncated: matches.length >= cap };
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

function parseCliArgs(argv: string[]): {
  cwd: string;
  watch: boolean;
  commandsPath: string | null;
  auto: boolean;
} {
  let cwd = process.cwd();
  let watchFs = true;
  let auto = true;
  let commandsPath: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--cwd') {
      const v = argv[++i];
      if (!v) throw new Error('--cwd requires a path');
      cwd = resolve(v);
    } else if (argv[i] === '--no-watch') {
      watchFs = false;
    } else if (argv[i] === '--no-auto') {
      auto = false;
    } else if (argv[i] === '--commands') {
      const v = argv[++i];
      if (!v) throw new Error('--commands requires a path');
      commandsPath = resolve(v);
    }
  }
  if (!existsSync(cwd)) throw new Error(`workspace does not exist: ${cwd}`);
  return { cwd, watch: watchFs, commandsPath, auto };
}

async function main(): Promise<void> {
  const opts = parseCliArgs(process.argv.slice(2));
  const root = resolve(opts.cwd);
  const isGitRepo = existsSync(join(root, '.git'));
  const hasRg = await run(root, 'rg', ['--version']).then((r) => r.code === 0).catch(() => false);

  const server = new McpServer({ name: 'speculate-shell', version: '0.1.0' });

  /** Wraps a handler: ArgError → clean isError result; never throws. */
  const guarded = (fn: (args: Record<string, unknown>) => Promise<ReturnType<typeof okResult> | ReturnType<typeof errResult>>) => {
    return async (args: Record<string, unknown>) => {
      try {
        return await fn(args);
      } catch (err) {
        if (err instanceof ArgError) return errResult(err.message);
        return errResult(`internal: ${(err as Error).message}`);
      }
    };
  };

  const git = (args: string[]) => run(root, 'git', [...GIT_BASE_ARGS, ...args]);

  if (isGitRepo) {
    server.registerTool(
      'git_status',
      {
        description: 'Working-tree status: branch, ahead/behind, staged/modified/untracked entries.',
        inputSchema: {},
        annotations: { readOnlyHint: true },
      },
      guarded(async () => {
        const r = await git(['status', '--porcelain=v2', '--branch', '--untracked-files=normal']);
        if (r.code !== 0) return errResult(r.stderr.trim() || `git status failed (${r.code})`);
        return okResult(parseStatusPorcelainV2(r.stdout));
      }),
    );

    server.registerTool(
      'git_diff',
      {
        description: 'Unified diff of the working tree (or the index with staged=true), optionally limited to one path.',
        inputSchema: {
          staged: z.boolean().optional().describe('diff the index (staged changes) instead of the working tree'),
          path: z.string().max(1024).optional().describe('limit the diff to this file or directory'),
        },
        annotations: { readOnlyHint: true },
      },
      guarded(async (a) => {
        const args = ['diff', '--no-ext-diff', '--no-color'];
        if (a.staged === true) args.push('--cached');
        if (typeof a.path === 'string') {
          args.push('--', relForExec(root, validatePath(root, a.path)));
        }
        const r = await git(args);
        if (r.code !== 0 && r.code !== 1) return errResult(r.stderr.trim() || `git diff failed (${r.code})`);
        return okResult({ diff: r.stdout.slice(0, MAX_OUTPUT_BYTES) });
      }),
    );

    server.registerTool(
      'git_log',
      {
        description: 'Recent commits (sha, author, date, subject), newest first.',
        inputSchema: {
          count: z.number().int().min(1).max(50).optional().describe('number of commits (default 10)'),
          path: z.string().max(1024).optional().describe('limit history to this file or directory'),
        },
        annotations: { readOnlyHint: true },
      },
      guarded(async (a) => {
        const count = typeof a.count === 'number' ? a.count : 10;
        const args = [
          'log',
          `--max-count=${count}`,
          `--pretty=format:%H${LOG_FIELD_SEP}%an${LOG_FIELD_SEP}%aI${LOG_FIELD_SEP}%s${LOG_RECORD_SEP}`,
        ];
        if (typeof a.path === 'string') {
          args.push('--', relForExec(root, validatePath(root, a.path)));
        }
        const r = await git(args);
        if (r.code !== 0) return errResult(r.stderr.trim() || `git log failed (${r.code})`);
        return okResult(parseLog(r.stdout));
      }),
    );

    server.registerTool(
      'git_show',
      {
        description: 'Show one commit: stat + patch. ref may be a sha, branch, tag, or rev expression.',
        inputSchema: {
          ref: z.string().min(1).max(256).describe('commit-ish (sha/branch/tag/HEAD~n)'),
          path: z.string().max(1024).optional().describe('limit the patch to this file or directory'),
        },
        annotations: { readOnlyHint: true },
      },
      guarded(async (a) => {
        const ref = validateRef(String(a.ref));
        const args = ['show', '--no-ext-diff', '--no-color', '--stat', '--patch', ref];
        if (typeof a.path === 'string') {
          args.push('--', relForExec(root, validatePath(root, a.path)));
        }
        const r = await git(args);
        if (r.code !== 0) return errResult(r.stderr.trim() || `git show failed (${r.code})`);
        return okResult({ ref, text: r.stdout.slice(0, MAX_OUTPUT_BYTES) });
      }),
    );

    server.registerTool(
      'git_branch',
      {
        description: 'Local branches with head shas; marks the current branch.',
        inputSchema: {},
        annotations: { readOnlyHint: true },
      },
      guarded(async () => {
        const r = await git([
          'for-each-ref',
          'refs/heads',
          `--format=%(refname:short)${LOG_FIELD_SEP}%(objectname:short)${LOG_FIELD_SEP}%(HEAD)`,
        ]);
        if (r.code !== 0) return errResult(r.stderr.trim() || `git for-each-ref failed (${r.code})`);
        return okResult(parseBranches(r.stdout));
      }),
    );
  }

  server.registerTool(
    'list_dir',
    {
      description: 'List a directory in the workspace: names, kinds, sizes.',
      inputSchema: {
        path: z.string().max(1024).optional().describe('directory to list (default: workspace root)'),
      },
      annotations: { readOnlyHint: true },
    },
    guarded(async (a) => {
      const abs = validatePath(root, typeof a.path === 'string' ? a.path : '.');
      // Pure Node — no subprocess needed for a directory listing.
      const entries = readdirSync(abs, { withFileTypes: true })
        .slice(0, 500)
        .map((d) => {
          let sizeBytes: number | undefined;
          if (d.isFile()) {
            try {
              sizeBytes = statSync(join(abs, d.name)).size;
            } catch {
              // race with deletion: report the entry without a size
            }
          }
          return {
            name: d.name,
            type: d.isDirectory() ? 'dir' : d.isSymbolicLink() ? 'symlink' : 'file',
            ...(sizeBytes !== undefined ? { sizeBytes } : {}),
          };
        });
      return okResult({ path: relForExec(root, abs), entries });
    }),
  );

  if (hasRg) {
    server.registerTool(
      'search',
      {
        description: 'Search file contents with ripgrep (regex), returning file/line/text matches.',
        inputSchema: {
          pattern: z.string().min(1).max(512).describe('regex pattern'),
          path: z.string().max(1024).optional().describe('search under this path (default: workspace root)'),
          glob: z.string().max(256).optional().describe("filter files, e.g. '*.ts'"),
          maxResults: z.number().int().min(1).max(500).optional().describe('cap matches (default 100)'),
        },
        annotations: { readOnlyHint: true },
      },
      guarded(async (a) => {
        const cap = typeof a.maxResults === 'number' ? a.maxResults : 100;
        const args = [
          '--no-config',
          '-n',
          '--no-heading',
          '--color=never',
          '--max-columns=500',
          '--max-count',
          String(cap),
        ];
        if (typeof a.glob === 'string') args.push('--glob', validateGlob(a.glob));
        // Free text only ever after `--`: it can never be parsed as a flag.
        args.push('--', String(a.pattern));
        args.push(relForExec(root, validatePath(root, typeof a.path === 'string' ? a.path : '.')));
        const r = await run(root, 'rg', args);
        // rg exits 1 on "no matches" — that's a valid empty result.
        if (r.code !== 0 && r.code !== 1) return errResult(r.stderr.trim() || `rg failed (${r.code})`);
        return okResult(parseRgLines(r.stdout, cap));
      }),
    );
  }

  // Shared registration for declared commands (§13.10) and the built-in
  // catalog (§13.11). Declaring/curating a command asserts it is read-only;
  // model-supplied params are typed/validated and can never become flags.
  const takenNames = new Set<string>([
    ...(isGitRepo ? ['git_status', 'git_diff', 'git_log', 'git_show', 'git_branch'] : []),
    'list_dir',
    ...(hasRg ? ['search'] : []),
  ]);
  const registerCommand = (name: string, spec: CommandSpec, origin: string): boolean => {
    if (takenNames.has(name)) {
      process.stderr.write(
        `[speculate-shell] skipping ${origin} command '${name}': name already taken\n`,
      );
      return false;
    }
    if (!TOOL_NAME_RE.test(name)) return false; // schemas enforce; belt and braces
    takenNames.add(name);
    server.registerTool(
      name,
      {
        description: spec.description ?? `Read-only command: ${spec.command.join(' ')}`,
        inputSchema: inputShapeFor(spec),
        annotations: { readOnlyHint: true },
      },
      guarded(async (a) => {
        let bin: string;
        let argv: string[];
        try {
          ({ bin, argv } = buildArgv(spec, a));
        } catch (err) {
          if (err instanceof ParamError) return errResult(err.message);
          throw err;
        }
        const r = await run(root, bin, argv);
        if (!(spec.okExitCodes ?? [0]).includes(r.code)) {
          return errResult(`exit ${r.code}: ${r.stderr.trim().slice(0, 2000) || '(no stderr)'}`);
        }
        const trimmed = r.stdout.trimStart();
        // JSON stdout flows through as structure so the prediction stack
        // can mine it; anything else is passed as capped text.
        if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
          try {
            return okResult({ exitCode: r.code, output: JSON.parse(trimmed) as unknown });
          } catch {
            // fall through to text
          }
        }
        return okResult({ exitCode: r.code, output: r.stdout.slice(0, MAX_OUTPUT_BYTES) });
      }),
    );
    return true;
  };

  // User registry first: explicit declarations win name collisions.
  let customCommands: CommandRegistry = {};
  if (opts.commandsPath) {
    customCommands = loadCommandRegistry(opts.commandsPath); // throws loudly on bad specs
    for (const [name, spec] of Object.entries(customCommands)) {
      registerCommand(name, spec, 'custom');
    }
  }

  // §13.11 dynamic catalog: the workspace decides which curated read-only
  // tools are relevant (binary on PATH + marker files + git remote shape).
  let autoCount = 0;
  if (opts.auto) {
    let gitRemoteUrl: string | null = null;
    if (isGitRepo) {
      const r = await git(['config', '--get', 'remote.origin.url']);
      if (r.code === 0) gitRemoteUrl = r.stdout.trim() || null;
    }
    const ctx = { root, gitRemoteUrl };
    for (const entry of CATALOG) {
      if (!probePasses(entry.probe, ctx)) continue;
      if (registerCommand(entry.name, entry.spec, 'catalog')) autoCount++;
    }
  }

  // Freshness: workspace changes flush Speculate's buffer for this server
  // (tools/list_changed → §3.4 invalidation), debounced so edit bursts cost
  // one flush. Failures degrade to TTL-only freshness — never fatal.
  if (opts.watch) {
    try {
      let timer: NodeJS.Timeout | null = null;
      const watcher = watch(root, { recursive: true }, () => {
        if (timer) return;
        timer = setTimeout(() => {
          timer = null;
          server.sendToolListChanged();
        }, WATCH_DEBOUNCE_MS);
        timer.unref();
      });
      watcher.unref();
      process.on('exit', () => watcher.close());
    } catch (err) {
      process.stderr.write(
        `[speculate-shell] fs watch unavailable (${(err as Error).message}); relying on TTLs\n`,
      );
    }
  }

  await server.connect(new StdioServerTransport());
  const customCount = Object.keys(customCommands).length;
  process.stderr.write(
    `[speculate-shell] serving ${root} (git: ${isGitRepo ? 'yes' : 'no'}, rg: ${hasRg ? 'yes' : 'no'}, watch: ${opts.watch ? 'on' : 'off'}${customCount ? `, custom: ${customCount}` : ''}${autoCount ? `, auto-detected: ${autoCount}` : ''})\n`,
  );
}

main().catch((err) => {
  process.stderr.write(`[speculate-shell] fatal: ${(err as Error).message}\n`);
  process.exit(1);
});
