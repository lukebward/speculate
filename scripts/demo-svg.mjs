// Run the demo, capture stdout, render the SVG. Windows-safe: no /tmp, no
// shell redirects — everything goes through execFileSync + a real tempdir.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// scripts/demo-svg.mjs lives one level under the repo root, so '..' from
// this file's URL already lands on the root — same pattern as bench.ts.
const root = fileURLToPath(new URL('..', import.meta.url));
const tsxCli = join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const out = execFileSync(process.execPath, [tsxCli, join(root, 'demo', 'demo.ts')], {
  encoding: 'utf8',
});
const dir = mkdtempSync(join(tmpdir(), 'speculate-demo-'));
const capture = join(dir, 'capture.txt');
writeFileSync(capture, out);
execFileSync(
  process.execPath,
  [join(root, 'scripts', 'gen-demo-svg.mjs'), capture, join(root, 'demo', 'speculate-demo.svg')],
  { stdio: 'inherit' },
);
rmSync(dir, { recursive: true, force: true });
