/**
 * Vetted filesystem profile (§13.15) — for the reference
 * @modelcontextprotocol/server-filesystem tool surface.
 *
 * Validated against the bundled mock (mock/mock-filesystem.ts), which
 * mirrors the reference server's PLAIN-TEXT result formats: directory
 * listings as "[FILE] name" / "[DIR] name" lines, search results as one
 * path per line. The parsers here own those text contracts (§5.1).
 *
 * Curation note: every allowlisted tool only reads the tree; none touches
 * read receipts, billing, or remote services.
 */
import type { Prediction, ResultParser, Rule, ServerProfile } from '../types.js';

const READ_ONLY_TOOLS = [
  'read_file',
  'read_text_file',
  'read_media_file',
  'read_multiple_files',
  'list_directory',
  'list_directory_with_sizes',
  'directory_tree',
  'search_files',
  'get_file_info',
  'list_allowed_directories',
];

const firstText = (result: Parameters<ResultParser>[0]): string | null => {
  if (result.isError) return null;
  const content: unknown = result.content;
  if (!Array.isArray(content)) return null;
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue;
    const b = block as { type?: unknown; text?: unknown };
    if (b.type === 'text') return typeof b.text === 'string' ? b.text : null;
  }
  return null;
};

/** "[FILE] a" / "[DIR] b" lines → [{type:'file'|'dir', name}]; null otherwise. */
const parseListing: ResultParser = (result) => {
  try {
    const text = firstText(result);
    if (text === null) return null;
    const entries: Array<{ type: 'file' | 'dir'; name: string }> = [];
    for (const line of text.split('\n')) {
      const m = /^\[(FILE|DIR)\]\s+(.+?)(?:\s+\(\d+\s+\w+\))?$/.exec(line.trim());
      if (!m) continue;
      entries.push({ type: m[1] === 'FILE' ? 'file' : 'dir', name: m[2]! });
    }
    return entries.length > 0 ? entries : null;
  } catch {
    return null;
  }
};

/** One absolute path per line → string[]; "No matches found" → []. */
const parseSearchResults: ResultParser = (result) => {
  try {
    const text = firstText(result);
    if (text === null) return null;
    if (/^no matches found/i.test(text.trim())) return [];
    const paths = text
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.startsWith('/'));
    return paths.length > 0 ? paths : null;
  } catch {
    return null;
  }
};

const joinPath = (dir: string, name: string): string =>
  dir.endsWith('/') ? `${dir}${name}` : `${dir}/${name}`;

/** Parent directory by string math; null at/above the root. */
const parentDir = (path: string): string | null => {
  const cut = path.lastIndexOf('/');
  if (cut <= 0) return null;
  return path.slice(0, cut);
};

const rules: Rule[] = [
  {
    // Listing a directory → reading its first files.
    id: 'fs:list→read',
    trigger: 'list_directory',
    predict(call): Prediction[] {
      const dir = call.args['path'];
      if (typeof dir !== 'string' || dir.length === 0) return [];
      if (!Array.isArray(call.parsed)) return [];
      const confidences = [0.5, 0.35];
      const files = (call.parsed as Array<{ type?: unknown; name?: unknown }>)
        .filter((e) => e !== null && typeof e === 'object' && e.type === 'file')
        .slice(0, 2);
      return files.flatMap((e, i) =>
        typeof e.name === 'string' && e.name.length > 0
          ? [
              {
                server: call.server,
                tool: 'read_text_file',
                args: { path: joinPath(dir, e.name) },
                confidence: confidences[i]!,
                ruleId: 'fs:list→read',
              },
            ]
          : [],
      );
    },
  },
  {
    // Reading a file → listing its siblings (the §5.2 design example).
    id: 'fs:read→dir',
    trigger: 'read_text_file',
    predict(call): Prediction[] {
      const path = call.args['path'];
      if (typeof path !== 'string') return [];
      const dir = parentDir(path);
      if (dir === null) return [];
      return [
        {
          server: call.server,
          tool: 'list_directory',
          args: { path: dir },
          confidence: 0.4,
          ruleId: 'fs:read→dir',
        },
      ];
    },
  },
  {
    // Search hits → reading the top matches.
    id: 'fs:search→read',
    trigger: 'search_files',
    predict(call): Prediction[] {
      if (!Array.isArray(call.parsed)) return [];
      const confidences = [0.5, 0.35];
      return (call.parsed as unknown[])
        .filter((p): p is string => typeof p === 'string' && p.startsWith('/'))
        .slice(0, 2)
        .map((path, i) => ({
          server: call.server,
          tool: 'read_text_file',
          args: { path },
          confidence: confidences[i]!,
          ruleId: 'fs:search→read',
        }));
    },
  },
];

export const filesystemProfile: ServerProfile = {
  name: 'filesystem',
  validatedAgainst:
    'speculate mock-filesystem v0.1 (mirrors @modelcontextprotocol/server-filesystem text formats)',
  readOnlyAllowlist: [...READ_ONLY_TOOLS],
  // No change-push from the reference server, so freshness rests on short
  // TTLs alone — local trees change often.
  defaultTtlMs: 15_000,
  ttlMsByTool: {},
  parsers: {
    list_directory: parseListing,
    list_directory_with_sizes: parseListing,
    search_files: parseSearchResults,
  },
  canonicalizers: {},
  rules,
  primes: [
    ['get_file_info', 'read_text_file'],
    ['list_allowed_directories', 'list_directory'],
  ],
};
