/**
 * §13.11 dynamic catalog: probe gating (PATH scan, markers, git remote) and
 * live auto-registration through real MCP. Environment-sensitive entries
 * (docker/kubectl: bare binary probes) are never asserted absent.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { binaryOnPath, probePasses } from '../shell/catalog.js';

const ROOT = new URL('..', import.meta.url).pathname;
const TSX = join(ROOT, 'node_modules', '.bin', 'tsx');
const SHELL_SERVER = join(ROOT, 'shell', 'speculate-shell.ts');

const cleanups: string[] = [];
const clients: Client[] = [];
afterAll(async () => {
  for (const c of clients) await c.close().catch(() => {});
  for (const d of cleanups) rmSync(d, { recursive: true, force: true });
});

function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(d);
  return d;
}

function fakeBin(dir: string, name: string, script: string): void {
  const p = join(dir, name);
  writeFileSync(p, `#!/bin/sh\n${script}\n`);
  chmodSync(p, 0o755);
}

async function spawnServer(cwd: string, env: Record<string, string>): Promise<Client> {
  const client = new Client({ name: 'cat-test', version: '0' }, { capabilities: {} });
  const transport = new StdioClientTransport({
    command: TSX,
    args: [SHELL_SERVER, '--cwd', cwd, '--no-watch'],
    env: { ...process.env, ...env } as Record<string, string>,
    stderr: 'ignore',
  });
  await client.connect(transport);
  clients.push(client);
  return client;
}

describe('probe primitives', () => {
  it('binaryOnPath finds executables via an explicit PATH', () => {
    const bin = tmp('cat-bin-');
    fakeBin(bin, 'somebin', 'exit 0');
    expect(binaryOnPath('somebin', { PATH: bin })).toBe(true);
    expect(binaryOnPath('missing', { PATH: bin })).toBe(false);
    expect(binaryOnPath('somebin', { PATH: '' })).toBe(false);
  });

  it('probePasses gates on markers and git remote', () => {
    const bin = tmp('cat-bin-');
    fakeBin(bin, 'toolx', 'exit 0');
    const root = tmp('cat-root-');
    const env = { PATH: bin };

    expect(probePasses({ bin: 'toolx' }, { root, gitRemoteUrl: null, env })).toBe(true);
    expect(
      probePasses({ bin: 'toolx', markers: ['package.json'] }, { root, gitRemoteUrl: null, env }),
    ).toBe(false);
    writeFileSync(join(root, 'package.json'), '{}');
    expect(
      probePasses({ bin: 'toolx', markers: ['package.json'] }, { root, gitRemoteUrl: null, env }),
    ).toBe(true);
    expect(
      probePasses({ bin: 'toolx', gitRemote: /github/ }, { root, gitRemoteUrl: null, env }),
    ).toBe(false);
    expect(
      probePasses(
        { bin: 'toolx', gitRemote: /github/ },
        { root, gitRemoteUrl: 'git@github.com:a/b.git', env },
      ),
    ).toBe(true);
  });
});

describe('auto-registration through MCP', () => {
  it('npm tools appear only next to a package.json; gh needs a github remote', async () => {
    // Plain dir with package.json: npm_* yes (npm is on PATH in this repo's
    // toolchain), gh_* no (no git repo, no remote).
    const root = tmp('cat-ws-');
    writeFileSync(join(root, 'package.json'), '{"name":"x","version":"0.0.0"}');
    const client = await spawnServer(root, {});
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain('npm_outdated');
    expect(names).toContain('npm_ls');
    expect(names.some((n) => n.startsWith('gh_'))).toBe(false);
    for (const t of tools) expect(t.annotations?.readOnlyHint).toBe(true);
  }, 30_000);

  it('gh tools appear in a github-remote repo (stub gh) and execute via execFile', async () => {
    const bin = tmp('cat-bin-');
    fakeBin(bin, 'gh', `echo '[{"number": 7, "title": "stub"}]'`);
    const root = tmp('cat-repo-');
    const git = (...args: string[]) =>
      execFileSync('git', args, {
        cwd: root,
        env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
      });
    git('init', '-q', '-b', 'main');
    git('remote', 'add', 'origin', 'git@github.com:acme/api.git');

    const client = await spawnServer(root, { PATH: `${bin}${delimiter}${process.env.PATH}` });
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain('gh_pr_list');
    expect(names).toContain('gh_issue_view');

    const res = (await client.callTool({ name: 'gh_pr_list', arguments: { limit: 5 } })) as {
      content: { type: string; text?: string }[];
    };
    const payload = JSON.parse(res.content.find((c) => c.type === 'text')!.text!) as {
      exitCode: number;
      output: unknown;
    };
    expect(payload.exitCode).toBe(0);
    expect(payload.output).toEqual([{ number: 7, title: 'stub' }]); // JSON stdout mined as structure
  }, 30_000);

  it('a failing catalog binary yields isError, and --no-auto disables the catalog', async () => {
    const bin = tmp('cat-bin-');
    fakeBin(bin, 'gh', 'echo "boom" >&2; exit 3');
    const root = tmp('cat-repo2-');
    const git = (...args: string[]) =>
      execFileSync('git', args, {
        cwd: root,
        env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
      });
    git('init', '-q', '-b', 'main');
    git('remote', 'add', 'origin', 'https://github.com/acme/api');

    const client = await spawnServer(root, { PATH: `${bin}${delimiter}${process.env.PATH}` });
    const res = (await client.callTool({ name: 'gh_pr_list', arguments: {} })) as {
      isError?: boolean;
      content: { type: string; text?: string }[];
    };
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain('exit 3');

    // --no-auto: same workspace, no catalog tools at all.
    const bare = new Client({ name: 'cat-test', version: '0' }, { capabilities: {} });
    const transport = new StdioClientTransport({
      command: TSX,
      args: [SHELL_SERVER, '--cwd', root, '--no-watch', '--no-auto'],
      env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}` } as Record<string, string>,
      stderr: 'ignore',
    });
    await bare.connect(transport);
    clients.push(bare);
    const { tools } = await bare.listTools();
    expect(tools.map((t) => t.name).some((n) => n.startsWith('gh_'))).toBe(false);
  }, 30_000);
});
