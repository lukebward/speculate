/**
 * §13.12 vetted argv table: fail-closed classification, path/ref
 * validation, and the materialize() re-vetting gate that keeps learned
 * state (untrusted, on-disk) from assembling an argv the table wouldn't
 * accept from a user.
 */
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ARG_SEP, classify, materialize } from '../src/execTable.js';

let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'speculate-table-'));
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src', 'a.ts'), 'alpha\n');
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('classify accepts vetted read-only command lines', () => {
  it.each([
    [['git', 'status'], 'git_status'],
    [['git', 'status', '-s', '-b'], 'git_status'],
    [['git', 'status', '--porcelain=v2', '--branch'], 'git_status'],
    [['git', 'diff'], 'git_diff'],
    [['git', 'diff', '--cached', '--stat'], 'git_diff'],
    [['git', 'diff', '--', 'src/a.ts'], 'git_diff'],
    [['git', 'log', '--oneline', '-n', '5'], 'git_log'],
    [['git', 'log', '-3'], 'git_log'],
    [['git', 'log', '--max-count=10'], 'git_log'],
    [['git', 'show', 'HEAD'], 'git_show'],
    [['git', 'show', '--stat', 'abc1234'], 'git_show'],
    [['git', 'branch', '-a', '-v'], 'git_branch'],
    [['git', 'rev-parse', '--abbrev-ref', 'HEAD'], 'git_rev_parse'],
    [['rg', '-n', 'needle', '.'], 'rg'],
    [['rg', '-n', '-g', '*.ts', 'needle', 'src'], 'rg'],
    [['rg', '--fixed-strings', '--', '-dash-pattern', '.'], 'rg'],
    [['ls', '-la', 'src'], 'ls'],
    [['ls'], 'ls'],
  ])('%j → %s', (argv, tool) => {
    const cls = classify(argv as string[], root);
    expect(cls?.tool).toBe(tool);
  });

  it('gives sha-addressed git show a longer TTL than moving refs', () => {
    const sha = classify(['git', 'show', 'a'.repeat(40)], root)!;
    const head = classify(['git', 'show', 'HEAD'], root)!;
    expect(sha.ttlMs).toBeGreaterThan(head.ttlMs);
  });
});

describe('classify fails closed on anything outside the table', () => {
  it.each([
    [['git', 'push']],
    [['git', 'commit', '-m', 'x']],
    [['git', 'status', '--unknown-flag']],
    // Write-capable flag smuggling: --output writes a file.
    [['git', 'log', '--output=/tmp/evil']],
    [['git', 'diff', '--ext-diff']],
    // Positional git branch creates a branch.
    [['git', 'branch', 'new-branch']],
    // Refs that are flag-shaped or malformed.
    [['git', 'show', '--upload-pack=/bin/sh']],
    [['git', 'show', '-HEAD']],
    // Paths escaping the workspace.
    [['ls', '/etc']],
    [['rg', 'x', '../outside']],
    [['git', 'diff', '--', '../../etc/passwd']],
    // Unknown rg flags (e.g. --pre executes a command).
    [['rg', '--pre', 'sh', 'x']],
    [['rg', '-e']],
    // Path-less rg would search stdin, not the tree — left to passthrough.
    [['rg', 'needle']],
    [['rg', '-n', 'needle']],
    // Bare git diff rev args are ambiguous with paths: not ours.
    [['git', 'diff', 'HEAD~1']],
    [['rm', '-rf', '.']],
    [['bash', '-c', 'echo hi']],
    [[]],
  ])('%j → null', (argv) => {
    expect(classify(argv as string[], root)).toBeNull();
  });

  it('rejects NUL bytes and oversized tokens', () => {
    expect(classify(['git', 'status', 'a\0b'], root)).toBeNull();
    expect(classify(['rg', 'x'.repeat(5000)], root)).toBeNull();
  });
});

describe('materialize re-vets learned predictions', () => {
  it('round-trips every classifiable command', () => {
    const samples: string[][] = [
      ['git', 'status', '-s'],
      ['git', 'diff', '--cached'],
      ['git', 'log', '--oneline', '-n', '5'],
      ['git', 'show', 'HEAD'],
      ['git', 'branch', '-a'],
      ['git', 'rev-parse', '--abbrev-ref', 'HEAD'],
      ['rg', '-n', 'needle', 'src'],
      ['ls', '-la'],
    ];
    for (const argv of samples) {
      const cls = classify(argv, root)!;
      const again = materialize(cls.tool, cls.args, root);
      expect(again, argv.join(' ')).not.toBeNull();
      expect(classify(again!.argv, root)?.tool).toBe(cls.tool);
    }
  });

  it('refuses poisoned learned args (flag injection, path escape)', () => {
    expect(materialize('git_status', { flags: '--porcelain ; rm -rf /' }, root)).toBeNull();
    expect(materialize('git_status', { flags: '--output=/tmp/evil' }, root)).toBeNull();
    expect(materialize('git_show', { ref: '--upload-pack=/bin/sh', flags: '', paths: '' }, root)).toBeNull();
    expect(materialize('ls', { flags: '', paths: '/etc' }, root)).toBeNull();
    expect(
      materialize('rg', { pattern: 'x', argv: ['rg', '--pre', 'sh', 'x'].join(ARG_SEP) }, root),
    ).toBeNull();
    expect(materialize('not_a_tool', {}, root)).toBeNull();
  });
});
