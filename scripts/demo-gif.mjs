// Run the demo, capture stdout, render the README GIF from that capture.
// Windows-safe: no /tmp, no shell redirects, everything through execFileSync
// and a real tempdir.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// scripts/demo-gif.mjs lives one level under the repo root, so '..' from
// this file's URL already lands on the root — same pattern as bench.ts.
const root = fileURLToPath(new URL('..', import.meta.url));
const tsxCli = join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs');
let out;
try {
  out = execFileSync(process.execPath, [tsxCli, join(root, 'demo', 'demo.ts')], {
    encoding: 'utf8',
  });
} catch (err) {
  // execFileSync's own error is a bare "Command failed"; without printing
  // what the demo actually wrote before dying, the failure is undiagnosable.
  if (err.stdout) process.stderr.write(err.stdout);
  if (err.stderr) process.stderr.write(err.stderr);
  throw err;
}
const dir = mkdtempSync(join(tmpdir(), 'speculate-demo-'));
try {
  const capture = join(dir, 'capture.txt');
  writeFileSync(capture, out);
  execFileSync(
    process.execPath,
    [
      join(root, 'scripts', 'gen-demo-gif.mjs'),
      capture,
      join(root, 'demo', 'speculate-demo.gif'),
    ],
    { stdio: 'inherit' },
  );
} finally {
  rmSync(dir, { recursive: true, force: true });
}
