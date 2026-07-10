/**
 * Runtime package version. Works from both source (tsx: src/version.ts →
 * ../package.json) and build output (node: dist/src/version.js →
 * ../../package.json).
 */
import { readFileSync } from 'node:fs';

export const VERSION: string = (() => {
  for (const rel of ['../package.json', '../../package.json']) {
    try {
      const pkg = JSON.parse(
        readFileSync(new URL(rel, import.meta.url), 'utf8'),
      ) as { name?: string; version?: string };
      if (pkg.name === 'speculate-mcp' && typeof pkg.version === 'string') {
        return pkg.version;
      }
    } catch {
      // try the next candidate
    }
  }
  return '0.0.0-unknown';
})();
