import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

interface SpeculatePackage {
  packageJson: URL;
  manifest: { name?: string; version?: string };
}

export function findSpeculatePackage(
  moduleUrl: URL | string,
  accepts: (located: SpeculatePackage) => boolean = () => true,
): SpeculatePackage | null {
  for (const relativePackageJson of ['../package.json', '../../package.json']) {
    try {
      const packageJson = new URL(relativePackageJson, moduleUrl);
      const manifest = JSON.parse(readFileSync(packageJson, 'utf8')) as SpeculatePackage['manifest'];
      const located = { packageJson, manifest };
      if (manifest.name === 'speculate-mcp' && accepts(located)) return located;
    } catch {}
  }
  return null;
}

export function sessionObserverHookPath(): string {
  const located = findSpeculatePackage(import.meta.url, ({ packageJson }) => (
    existsSync(fileURLToPath(new URL('./plugin/hooks/session-observer.mjs', packageJson)))
  ));
  if (!located) throw new Error('session observer hook resource is missing');
  return fileURLToPath(new URL('./plugin/hooks/session-observer.mjs', located.packageJson));
}
