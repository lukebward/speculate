import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export function sessionObserverHookPath(): string {
  for (const relativePackageJson of ['../package.json', '../../package.json']) {
    try {
      const packageJson = new URL(relativePackageJson, import.meta.url);
      const parsed = JSON.parse(readFileSync(packageJson, 'utf8')) as { name?: string };
      if (parsed.name !== 'speculate-mcp') continue;
      const hook = fileURLToPath(new URL('./plugin/hooks/session-observer.mjs', packageJson));
      if (existsSync(hook)) return hook;
    } catch {}
  }
  throw new Error('session observer hook resource is missing');
}
