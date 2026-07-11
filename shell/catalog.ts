/**
 * Built-in read-only CLI catalog (DESIGN.md §13.11): the dynamic default.
 *
 * Instead of asking users to declare commands, Speculate ships curated,
 * safety-reviewed command templates and lets the WORKSPACE decide which
 * apply: each entry carries a relevance probe (binary on PATH, marker
 * files, git remote shape). `gh` tools appear only in a repo with a GitHub
 * remote; `npm` tools only next to a package.json; and so on. Zero
 * configuration; `--no-auto` disables, a user registry (--commands) always
 * wins name collisions. Note: some reads return secret-adjacent data by
 * nature (kubectl pod specs include plaintext env values) — within the
 * capability baseline (the agent already has shell access), but curators
 * must never add tools whose PURPOSE is credential output.
 *
 * Every entry has been reviewed as read-only. The same execution hardening
 * as user-declared commands applies (execFile, typed params, no
 * user-controlled flags). Curation rules for additions: no commands that
 * mutate, bill per call in surprising ways, or read secrets (`env`,
 * credential helpers, token printers are permanently out).
 */
import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import type { CommandSpec } from './commands.js';

export interface CatalogProbe {
  /** Binary that must be resolvable on PATH. */
  bin: string;
  /** Any-of marker files/dirs relative to the workspace root. */
  markers?: string[];
  /** git remote.origin.url must match (implies "is a git repo"). */
  gitRemote?: RegExp;
}

export interface CatalogEntry {
  name: string;
  probe: CatalogProbe;
  spec: CommandSpec;
}

const NAMESPACE_PARAM = {
  type: 'string',
  flag: '-n',
  pattern: '[a-z0-9][a-z0-9-]{0,62}',
  description: 'kubernetes namespace',
} as const;

export const CATALOG: CatalogEntry[] = [
  {
    name: 'gh_pr_list',
    probe: { bin: 'gh', gitRemote: /github/i },
    spec: {
      description: 'Open pull requests via the GitHub CLI (JSON).',
      command: ['gh', 'pr', 'list', '--json', 'number,title,author,updatedAt'],
      params: {
        limit: { type: 'number', flag: '--limit', min: 1, max: 50 },
        state: { type: 'enum', values: ['open', 'closed', 'merged', 'all'], flag: '--state' },
      },
    },
  },
  {
    name: 'gh_pr_view',
    probe: { bin: 'gh', gitRemote: /github/i },
    spec: {
      description: 'One pull request: title, body, state (JSON).',
      command: ['gh', 'pr', 'view', '--json', 'number,title,body,state,author'],
      params: {
        number: { type: 'number', min: 1, max: 1_000_000, required: true },
      },
    },
  },
  {
    name: 'gh_issue_list',
    probe: { bin: 'gh', gitRemote: /github/i },
    spec: {
      description: 'Open issues via the GitHub CLI (JSON).',
      command: ['gh', 'issue', 'list', '--json', 'number,title,state,updatedAt'],
      params: {
        limit: { type: 'number', flag: '--limit', min: 1, max: 50 },
        state: { type: 'enum', values: ['open', 'closed', 'all'], flag: '--state' },
      },
    },
  },
  {
    name: 'gh_issue_view',
    probe: { bin: 'gh', gitRemote: /github/i },
    spec: {
      description: 'One issue: title, body, state (JSON).',
      command: ['gh', 'issue', 'view', '--json', 'number,title,body,state'],
      params: {
        number: { type: 'number', min: 1, max: 1_000_000, required: true },
      },
    },
  },
  {
    name: 'npm_outdated',
    probe: { bin: 'npm', markers: ['package.json'] },
    spec: {
      description: 'Outdated npm dependencies (JSON).',
      command: ['npm', 'outdated', '--json'],
      okExitCodes: [0, 1], // exits 1 when outdated packages exist
    },
  },
  {
    name: 'npm_ls',
    probe: { bin: 'npm', markers: ['package.json'] },
    spec: {
      description: 'Installed dependency tree, depth 1 (JSON).',
      command: ['npm', 'ls', '--json', '--depth', '1'],
      okExitCodes: [0, 1], // exits 1 on peer-dep problems; output still useful
    },
  },
  {
    name: 'docker_ps',
    probe: { bin: 'docker' },
    spec: {
      description: 'Running containers (one JSON object per line).',
      command: ['docker', 'ps', '--format', 'json'],
    },
  },
  {
    name: 'docker_images',
    probe: { bin: 'docker' },
    spec: {
      description: 'Local images (one JSON object per line).',
      command: ['docker', 'images', '--format', 'json'],
    },
  },
  {
    name: 'kubectl_pods',
    probe: { bin: 'kubectl' },
    spec: {
      description: 'Pods in a namespace (JSON).',
      command: ['kubectl', 'get', 'pods', '-o', 'json'],
      params: { namespace: NAMESPACE_PARAM },
    },
  },
  {
    name: 'kubectl_deployments',
    probe: { bin: 'kubectl' },
    spec: {
      description: 'Deployments in a namespace (JSON).',
      command: ['kubectl', 'get', 'deployments', '-o', 'json'],
      params: { namespace: NAMESPACE_PARAM },
    },
  },
  {
    name: 'pip_list',
    probe: { bin: 'python3', markers: ['requirements.txt', 'pyproject.toml', 'setup.py'] },
    spec: {
      description: 'Installed Python packages (JSON).',
      command: ['python3', '-m', 'pip', 'list', '--format', 'json'],
    },
  },
];

/** PATH scan without spawning anything. */
export function binaryOnPath(bin: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const path = env.PATH ?? '';
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const dir of path.split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      try {
        if (existsSync(join(dir, bin + ext))) return true;
      } catch {
        // unreadable PATH entry: skip
      }
    }
  }
  return false;
}

export interface ProbeContext {
  root: string;
  /** remote.origin.url when the workspace is a git repo, else null. */
  gitRemoteUrl: string | null;
  env?: NodeJS.ProcessEnv;
}

export function probePasses(probe: CatalogProbe, ctx: ProbeContext): boolean {
  if (!binaryOnPath(probe.bin, ctx.env)) return false;
  if (probe.markers && !probe.markers.some((m) => existsSync(join(ctx.root, m)))) {
    return false;
  }
  if (probe.gitRemote && !(ctx.gitRemoteUrl && probe.gitRemote.test(ctx.gitRemoteUrl))) {
    return false;
  }
  return true;
}
