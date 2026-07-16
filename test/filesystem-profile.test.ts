/**
 * Filesystem profile (§13.15): parser contracts for the reference server's
 * text formats, and per-rule prediction behavior. Mirrors the shapes served
 * by mock/mock-filesystem.ts.
 */
import { describe, expect, it } from 'vitest';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { filesystemProfile } from '../src/profiles/filesystem.js';
import type { ObservedCall } from '../src/types.js';

const text = (t: string): CallToolResult => ({ content: [{ type: 'text', text: t }] });
const errResult = (t: string): CallToolResult => ({
  isError: true,
  content: [{ type: 'text', text: t }],
});

function observed(tool: string, args: Record<string, unknown>, result: CallToolResult): ObservedCall {
  const parser = filesystemProfile.parsers[tool];
  return {
    server: 'fs',
    tool,
    args,
    result,
    parsed: parser ? parser(result) : null,
    timestamp: 1_000,
    latencyMs: 100,
  };
}

function rule(id: string) {
  const r = filesystemProfile.rules.find((r) => r.id === id);
  expect(r, `rule ${id} exists`).toBeDefined();
  return r!;
}

describe('filesystem profile parsers', () => {
  it('parses [FILE]/[DIR] listing lines, with and without sizes', () => {
    const parse = filesystemProfile.parsers['list_directory']!;
    expect(parse(text('[FILE] app.ts\n[DIR] lib\n[FILE] util.ts'))).toEqual([
      { type: 'file', name: 'app.ts' },
      { type: 'dir', name: 'lib' },
      { type: 'file', name: 'util.ts' },
    ]);
    expect(filesystemProfile.parsers['list_directory_with_sizes']!(
      text('[FILE] app.ts (52 bytes)\n[DIR] lib'),
    )).toEqual([
      { type: 'file', name: 'app.ts' },
      { type: 'dir', name: 'lib' },
    ]);
  });

  it('listing parser fails closed on errors and non-listing text', () => {
    const parse = filesystemProfile.parsers['list_directory']!;
    expect(parse(errResult('ENOTDIR'))).toBeNull();
    expect(parse(text('plain prose, no entries'))).toBeNull();
    expect(parse({ content: [] })).toBeNull();
  });

  it('parses search results as paths; "No matches found" is an empty list', () => {
    const parse = filesystemProfile.parsers['search_files']!;
    expect(parse(text('/ws/src/app.ts\n/ws/src/lib/limiter.ts'))).toEqual([
      '/ws/src/app.ts',
      '/ws/src/lib/limiter.ts',
    ]);
    expect(parse(text('No matches found'))).toEqual([]);
    expect(parse(errResult('boom'))).toBeNull();
  });
});

describe('filesystem profile rules', () => {
  it('list_directory → read_text_file for the first files, dirs skipped', () => {
    const call = observed(
      'list_directory',
      { path: '/ws/src' },
      text('[DIR] lib\n[FILE] app.ts\n[FILE] util.ts\n[FILE] extra.ts'),
    );
    const preds = rule('fs:list→read').predict(call);
    expect(preds.map((p) => p.args)).toEqual([
      { path: '/ws/src/app.ts' },
      { path: '/ws/src/util.ts' },
    ]);
    expect(preds.every((p) => p.tool === 'read_text_file')).toBe(true);
    expect(preds[0]!.confidence).toBeGreaterThan(preds[1]!.confidence);
  });

  it('list rule fails closed without a path or parse', () => {
    expect(rule('fs:list→read').predict(observed('list_directory', {}, text('[FILE] a')))).toEqual([]);
    expect(
      rule('fs:list→read').predict(observed('list_directory', { path: '/ws' }, errResult('x'))),
    ).toEqual([]);
  });

  it('read_text_file → sibling list_directory; root-level reads predict nothing', () => {
    const preds = rule('fs:read→dir').predict(
      observed('read_text_file', { path: '/ws/src/app.ts' }, text('contents')),
    );
    expect(preds).toEqual([
      expect.objectContaining({ tool: 'list_directory', args: { path: '/ws/src' } }),
    ]);
    expect(
      rule('fs:read→dir').predict(observed('read_text_file', { path: '/top' }, text('x'))),
    ).toEqual([]);
    expect(rule('fs:read→dir').predict(observed('read_text_file', {}, text('x')))).toEqual([]);
  });

  it('search_files → read_text_file for the top matches', () => {
    const preds = rule('fs:search→read').predict(
      observed(
        'search_files',
        { path: '/ws', pattern: 'limiter' },
        text('/ws/src/lib/limiter.ts\n/ws/src/app.ts\n/ws/README.md'),
      ),
    );
    expect(preds.map((p) => p.args['path'])).toEqual(['/ws/src/lib/limiter.ts', '/ws/src/app.ts']);
    expect(
      rule('fs:search→read').predict(
        observed('search_files', { path: '/ws', pattern: 'zzz' }, text('No matches found')),
      ),
    ).toEqual([]);
  });

  it('profile shape: reads allowlisted, no write ever listed', () => {
    expect(filesystemProfile.readOnlyAllowlist).toContain('read_text_file');
    expect(filesystemProfile.readOnlyAllowlist).toContain('list_directory');
    for (const w of ['write_file', 'edit_file', 'create_directory', 'move_file']) {
      expect(filesystemProfile.readOnlyAllowlist).not.toContain(w);
    }
    for (const [prev, next] of filesystemProfile.primes ?? []) {
      expect(filesystemProfile.readOnlyAllowlist).toContain(next);
      expect(typeof prev).toBe('string');
    }
  });
});
