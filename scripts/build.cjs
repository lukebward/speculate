// Start from source only: deleted modules must not survive in published dist/.
const { rmSync } = require('node:fs');
const { execFileSync } = require('node:child_process');
const { dirname, resolve } = require('node:path');
const compiler = resolve(dirname(require.resolve('typescript/package.json')), require('typescript/package.json').bin.tsc);
rmSync('dist', { recursive: true, force: true });
execFileSync(process.execPath, [compiler], { stdio: 'inherit' });
