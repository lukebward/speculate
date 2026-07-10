// npm `prepare` hook: build dist/ when the toolchain is present. Skips
// cleanly under `npm install --omit=dev` (typescript is a devDependency),
// where dist/ either already exists (tarball) or the consumer builds
// explicitly.
try {
  require.resolve('typescript');
} catch {
  process.exit(0);
}
require('node:child_process').execSync('npx tsc', { stdio: 'inherit' });
