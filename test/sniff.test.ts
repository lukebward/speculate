/**
 * §13.12 protocol sniffing: the first client line decides proxy vs pipe.
 *
 * Unit tests drive sniffFirstLine with in-memory streams; the e2e tests
 * spawn the real CLI with `wrap --sniff` and check both personalities —
 * a non-MCP command gets a byte-transparent pipe (same output, same exit
 * code), an MCP client gets the full speculation proxy.
 */
import { describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PassThrough } from 'node:stream';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { looksLikeMcpInitialize, sniffFirstLine } from '../src/sniff.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const TSX = process.execPath;
const TSX_CLI = join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const CLI = join(ROOT, 'src', 'cli.ts');
const MOCK = join(ROOT, 'mock', 'mock-github.ts');

const INITIALIZE_LINE = JSON.stringify({
  jsonrpc: '2.0',
  id: 0,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'test', version: '0' },
  },
});

describe('looksLikeMcpInitialize', () => {
  it('accepts a JSON-RPC initialize request', () => {
    expect(looksLikeMcpInitialize(INITIALIZE_LINE)).toBe(true);
  });

  it('rejects non-JSON, other methods, notifications, and non-objects', () => {
    expect(looksLikeMcpInitialize('hello world')).toBe(false);
    expect(looksLikeMcpInitialize('{"jsonrpc":"2.0","id":1,"method":"tools/list"}')).toBe(false);
    // No id → a notification, which is never the first client message.
    expect(looksLikeMcpInitialize('{"jsonrpc":"2.0","method":"initialize"}')).toBe(false);
    expect(looksLikeMcpInitialize('[1,2,3]')).toBe(false);
    expect(looksLikeMcpInitialize('"initialize"')).toBe(false);
  });
});

describe('sniffFirstLine', () => {
  it('detects MCP when initialize arrives, even split across chunks', async () => {
    const stdin = new PassThrough();
    const p = sniffFirstLine(stdin, { timeoutMs: 5_000 });
    stdin.write(INITIALIZE_LINE.slice(0, 20));
    await new Promise((r) => setTimeout(r, 10));
    stdin.write(INITIALIZE_LINE.slice(20) + '\n{"jsonrpc":"2.0"');
    const d = await p;
    expect(d.mcp).toBe(true);
    expect(d.ended).toBe(false);
    // Everything consumed is preserved for re-injection.
    expect(d.buffered.toString()).toBe(INITIALIZE_LINE + '\n{"jsonrpc":"2.0"');
  });

  it('decides non-MCP on a non-initialize first line', async () => {
    const stdin = new PassThrough();
    const p = sniffFirstLine(stdin, { timeoutMs: 5_000 });
    stdin.write('plain text input\nmore\n');
    const d = await p;
    expect(d.mcp).toBe(false);
    expect(d.buffered.toString()).toBe('plain text input\nmore\n');
  });

  it('decides non-MCP on EOF before any newline', async () => {
    const stdin = new PassThrough();
    const p = sniffFirstLine(stdin, { timeoutMs: 5_000 });
    stdin.end('no newline here');
    const d = await p;
    expect(d.mcp).toBe(false);
    expect(d.ended).toBe(true);
    expect(d.buffered.toString()).toBe('no newline here');
  });

  it('decides non-MCP when the timeout fires with no complete line', async () => {
    const stdin = new PassThrough();
    const d = await sniffFirstLine(stdin, { timeoutMs: 30 });
    expect(d.mcp).toBe(false);
    expect(d.ended).toBe(false);
  });

  it('decides non-MCP when the first line exceeds the size cap', async () => {
    const stdin = new PassThrough();
    const p = sniffFirstLine(stdin, { timeoutMs: 5_000, maxBytes: 64 });
    stdin.write(Buffer.alloc(100, 0x61)); // 'a' * 100, no newline
    const d = await p;
    expect(d.mcp).toBe(false);
  });
});

describe('wrap --sniff end to end', () => {
  it('pipes a non-MCP command transparently and forwards its exit code', async () => {
    const child = spawn(TSX, [TSX_CLI, CLI, 'wrap', '--sniff', '--', 'cat'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    child.stdin.end('first line\nsecond line\n');
    const out: Buffer[] = [];
    child.stdout.on('data', (c: Buffer) => out.push(c));
    const code = await new Promise<number>((r) => child.on('exit', (c) => r(c ?? -1)));
    expect(Buffer.concat(out).toString()).toBe('first line\nsecond line\n');
    expect(code).toBe(0);
  }, 30_000);

  it('propagates a non-zero exit code in pipe mode', async () => {
    const child = spawn(TSX, [TSX_CLI, CLI, 'wrap', '--sniff', '--', 'false'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    child.stdin.end('not mcp\n');
    const code = await new Promise<number>((r) => child.on('exit', (c) => r(c ?? -1)));
    expect(code).toBe(1);
  }, 30_000);

  it('runs the full proxy when the client speaks MCP', async () => {
    const client = new Client({ name: 'sniff-e2e', version: '0' }, { capabilities: {} });
    const transport = new StdioClientTransport({
      command: TSX,
      args: [TSX_CLI, CLI, 'wrap', '--sniff', '--', TSX, TSX_CLI, MOCK],
      env: { ...process.env } as Record<string, string>,
      stderr: 'pipe',
    });
    await client.connect(transport);
    try {
      const tools = await client.listTools();
      const names = tools.tools.map((t) => t.name);
      // The proxy is live: its own stats tool is served alongside upstream's.
      expect(names).toContain('speculate__stats');
      expect(names.length).toBeGreaterThan(1);
    } finally {
      await client.close();
    }
  }, 30_000);
});
