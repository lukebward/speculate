import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { findSpeculatePackage, sessionObserverHookPath } from '../src/packageResources.js';
import { VERSION } from '../src/version.js';

describe('package resources', () => {
  it.each([
    ['source', new URL('../src/packageResources.ts', import.meta.url)],
    ['compiled', new URL('../dist/src/packageResources.js', import.meta.url)],
  ])('resolves the package from the %s module layout', (_layout, moduleUrl) => {
    const located = findSpeculatePackage(moduleUrl);

    expect(located?.packageJson.href).toBe(new URL('../package.json', import.meta.url).href);
    expect(located?.manifest.name).toBe('speculate-mcp');
  });

  it('continues when the nearer package does not satisfy the caller', () => {
    const root = mkdtempSync(join(tmpdir(), 'speculate-package-resources-'));
    try {
      mkdirSync(join(root, 'dist', 'src'), { recursive: true });
      mkdirSync(join(root, 'plugin', 'hooks'), { recursive: true });
      writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'speculate-mcp', version: '1.2.3' }));
      writeFileSync(join(root, 'dist', 'package.json'), JSON.stringify({ name: 'speculate-mcp' }));
      writeFileSync(join(root, 'plugin', 'hooks', 'session-observer.mjs'), '');
      const moduleUrl = pathToFileURL(join(root, 'dist', 'src', 'module.js'));

      const versionPackage = findSpeculatePackage(
        moduleUrl,
        ({ manifest }) => typeof manifest.version === 'string',
      );
      const resourcePackage = findSpeculatePackage(moduleUrl, ({ packageJson }) => (
        existsSync(fileURLToPath(new URL('./plugin/hooks/session-observer.mjs', packageJson)))
      ));

      expect(fileURLToPath(versionPackage!.packageJson)).toBe(join(root, 'package.json'));
      expect(fileURLToPath(resourcePackage!.packageJson)).toBe(join(root, 'package.json'));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('continues past a non-object package manifest', () => {
    const root = mkdtempSync(join(tmpdir(), 'speculate-package-resources-'));
    try {
      mkdirSync(join(root, 'dist', 'src'), { recursive: true });
      writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'speculate-mcp', version: '1.2.3' }));
      writeFileSync(join(root, 'dist', 'package.json'), 'null');

      const located = findSpeculatePackage(
        pathToFileURL(join(root, 'dist', 'src', 'module.js')),
      );

      expect(fileURLToPath(located!.packageJson)).toBe(join(root, 'package.json'));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('serves version and hook resources from the resolved package', () => {
    const manifest = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { version: string };

    expect(VERSION).toBe(manifest.version);
    expect(sessionObserverHookPath()).toBe(
      fileURLToPath(new URL('../plugin/hooks/session-observer.mjs', import.meta.url)),
    );
  });
});
