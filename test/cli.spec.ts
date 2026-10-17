/**
 * The npm entry point (dist/src/cli.js). Its 0.x compatibility matters most:
 * registrations a 0.x install wrapped still launch this exact file with
 * `wrap`, and must keep working after `npm update -g speculate-mcp`.
 */
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../dist/src/cli.js', import.meta.url));

function cli(args: string[], input?: string) {
  return spawnSync(process.execPath, [CLI, ...args], { input, encoding: 'utf8' });
}

describe('speculate CLI', () => {
  it('passes a 0.x stdio wrap straight through: stdin, stdout, and exit status', () => {
    const echo = 'process.stdin.pipe(process.stdout); process.stdin.on("end", () => process.exit(7))';
    const ran = cli(['wrap', '--mode', 'annotated', '--', process.execPath, '-e', echo], '{"jsonrpc":"2.0"}\n');
    expect(ran.stdout).toBe('{"jsonrpc":"2.0"}\n');
    expect(ran.status).toBe(7);
    expect(ran.stderr).toContain('passing through');
  });

  it('explains how to restore a 0.x remote wrap it cannot pass through', () => {
    const ran = cli(['wrap', '--url', 'https://example.com/mcp', '--header', 'Authorization: Bearer x']);
    expect(ran.status).toBe(1);
    expect(ran.stdout).toBe('');
    expect(ran.stderr).toContain('speculate install');
    expect(ran.stderr).not.toContain('Bearer');
  });

  it('reports a missing wrapped command instead of hanging', () => {
    const ran = cli(['wrap', '--mode', 'annotated']);
    expect(ran.status).toBe(1);
  });

  it('prints help and its version, and rejects unknown commands', () => {
    expect(cli(['--help']).stdout).toContain('speculate [install]');
    expect(cli(['--version']).stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
    expect(cli(['bogus']).status).toBe(2);
  });
});
