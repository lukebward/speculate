/**
 * Plugin-declared server discovery (the §13.23 fifth row; spec:
 * docs/superpowers/specs/2026-08-05-plugin-wrap-design.md).
 *
 * Every layout here mirrors what Claude Code 2.1.222 was MEASURED to write:
 * `plugins/installed_plugins.json` (version 2, per-plugin install arrays),
 * `settings.json` `enabledPlugins`, the versioned cache directory, and — for
 * a directory-sourced marketplace — the live source directory winning over
 * the cache copy.
 */
import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readClaudeServers, type PluginScopedServer } from '../src/hostConfig.js';

let home: string;
let cwd: string;
let savedConfigDir: string | undefined;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'speculate-phome-'));
  cwd = mkdtempSync(join(tmpdir(), 'speculate-pproj-'));
  savedConfigDir = process.env.CLAUDE_CONFIG_DIR;
  delete process.env.CLAUDE_CONFIG_DIR;
});
afterEach(() => {
  if (savedConfigDir !== undefined) process.env.CLAUDE_CONFIG_DIR = savedConfigDir;
  rmSync(home, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

function writeJson(path: string, data: unknown): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2));
}

/** The measured cache layout: cache/<marketplace>/<plugin>/<version>/. */
function installPlugin(opts: {
  plugin?: string;
  marketplace?: string;
  version?: string;
  mcpJson?: unknown;
  pluginJson?: unknown;
  enabled?: boolean;
}): string {
  const plugin = opts.plugin ?? 'testplug';
  const marketplace = opts.marketplace ?? 'probe-mkt';
  const key = `${plugin}@${marketplace}`;
  const root = join(home, '.claude', 'plugins', 'cache', marketplace, plugin, opts.version ?? '1.0.0');
  mkdirSync(join(root, '.claude-plugin'), { recursive: true });
  writeJson(
    join(root, '.claude-plugin', 'plugin.json'),
    opts.pluginJson ?? { name: plugin, version: opts.version ?? '1.0.0' },
  );
  if (opts.mcpJson !== undefined) writeJson(join(root, '.mcp.json'), opts.mcpJson);
  const installedPath = join(home, '.claude', 'plugins', 'installed_plugins.json');
  let installed: { version: number; plugins: Record<string, unknown[]> };
  try {
    installed = JSON.parse(readFileSync(installedPath, 'utf8'));
  } catch {
    installed = { version: 2, plugins: {} };
  }
  installed.plugins[key] = [
    { scope: 'user', installPath: root, version: opts.version ?? '1.0.0' },
  ];
  writeJson(installedPath, installed);
  if (opts.enabled !== false) {
    writeJson(join(home, '.claude', 'settings.json'), { enabledPlugins: { [key]: true } });
  } else {
    writeJson(join(home, '.claude', 'settings.json'), { enabledPlugins: { [key]: false } });
  }
  return root;
}

function discover(): PluginScopedServer[] {
  return readClaudeServers({ home, cwd }).pluginServers;
}

describe('plugin server discovery', () => {
  it('reads a bare-map .mcp.json and qualifies names the way the host does', () => {
    installPlugin({ mcpJson: { probesrv: { command: 'node', args: ['s.js'] } } });
    const servers = discover();
    expect(servers).toHaveLength(1);
    expect(servers[0]!.qualifiedName).toBe('plugin:testplug:probesrv');
    expect(servers[0]!.pluginKey).toBe('testplug@probe-mkt');
    expect(servers[0]!.serverName).toBe('probesrv');
    expect(servers[0]!.unwrappableReason).toBeNull();
  });

  it('reads the mcpServers-wrapped .mcp.json form too', () => {
    installPlugin({ mcpJson: { mcpServers: { alpha: { type: 'http', url: 'https://a.example/mcp' } } } });
    expect(discover().map((s) => s.qualifiedName)).toEqual(['plugin:testplug:alpha']);
  });

  it('reads plugin.json mcpServers, with .mcp.json winning a name collision', () => {
    installPlugin({
      pluginJson: {
        name: 'testplug',
        version: '1.0.0',
        mcpServers: {
          fromplugin: { command: 'a' },
          both: { command: 'plugin-json-version' },
        },
      },
      mcpJson: { both: { command: 'mcp-json-version' } },
    });
    const byName = new Map(discover().map((s) => [s.serverName, s]));
    expect([...byName.keys()].sort()).toEqual(['both', 'fromplugin']);
    expect(byName.get('both')!.entry.command).toBe('mcp-json-version');
  });

  it('follows a plugin.json mcpServers string path relative to the root', () => {
    const root = installPlugin({
      pluginJson: {
        name: 'testplug',
        version: '1.0.0',
        mcpServers: '${CLAUDE_PLUGIN_ROOT}/servers.json',
      },
    });
    writeJson(join(root, 'servers.json'), { pathed: { command: 'x' } });
    expect(discover().map((s) => s.serverName)).toEqual(['pathed']);
  });

  it('interpolates ${CLAUDE_PLUGIN_ROOT} and ${CLAUDE_PROJECT_DIR} per element', () => {
    const root = installPlugin({
      mcpJson: {
        probesrv: {
          command: 'node',
          args: ['${CLAUDE_PLUGIN_ROOT}/server.js', '--proj', '${CLAUDE_PROJECT_DIR}'],
          env: { PLUGIN_HOME: '${CLAUDE_PLUGIN_ROOT}' },
        },
        remote: {
          type: 'http',
          url: 'https://api.example/mcp',
          headers: { 'X-From': '${CLAUDE_PLUGIN_ROOT}' },
        },
      },
    });
    const byName = new Map(discover().map((s) => [s.serverName, s]));
    const stdio = byName.get('probesrv')!;
    expect(stdio.entry.args).toEqual([`${root}/server.js`, '--proj', cwd]);
    expect(stdio.entry.env).toEqual({ PLUGIN_HOME: root });
    expect(stdio.root).toBe(root);
    expect((byName.get('remote')!.entry.headers as Record<string, string>)['X-From']).toBe(root);
  });

  it('contributes nothing for a plugin disabled via enabledPlugins', () => {
    installPlugin({ mcpJson: { probesrv: { command: 'node' } }, enabled: false });
    expect(discover()).toEqual([]);
  });

  it('lets a project-level enabledPlugins:false override a user-level true', () => {
    installPlugin({ mcpJson: { probesrv: { command: 'node' } } });
    writeJson(join(cwd, '.claude', 'settings.json'), {
      enabledPlugins: { 'testplug@probe-mkt': false },
    });
    expect(discover()).toEqual([]);
  });

  // Measured on Claude Code 2.1.222: with a directory-sourced marketplace,
  // an edit to the SOURCE .mcp.json takes effect while the cache copy is
  // ignored — the live source directory is the plugin root.
  it('prefers a directory-sourced marketplace root over the cache copy', () => {
    const sourceMkt = mkdtempSync(join(tmpdir(), 'speculate-mkt-'));
    try {
      const sourceRoot = join(sourceMkt, 'testplug');
      mkdirSync(join(sourceRoot, '.claude-plugin'), { recursive: true });
      writeJson(join(sourceRoot, '.claude-plugin', 'plugin.json'), { name: 'testplug', version: '1.0.0' });
      writeJson(join(sourceRoot, '.mcp.json'), { probesrv: { command: 'source-version' } });
      writeJson(join(sourceMkt, '.claude-plugin', 'marketplace.json'), {
        name: 'probe-mkt',
        plugins: [{ name: 'testplug', source: './testplug' }],
      });
      installPlugin({ mcpJson: { probesrv: { command: 'cache-version' } } });
      writeJson(join(home, '.claude', 'plugins', 'known_marketplaces.json'), {
        'probe-mkt': {
          source: { source: 'directory', path: sourceMkt },
          installLocation: sourceMkt,
        },
      });
      const servers = discover();
      expect(servers[0]!.entry.command).toBe('source-version');
      expect(servers[0]!.root).toBe(sourceRoot);
    } finally {
      rmSync(sourceMkt, { recursive: true, force: true });
    }
  });

  it('falls back to the recorded installPath for non-directory marketplaces', () => {
    const root = installPlugin({ mcpJson: { probesrv: { command: 'node' } } });
    writeJson(join(home, '.claude', 'plugins', 'known_marketplaces.json'), {
      'probe-mkt': {
        source: { source: 'github', repo: 'someone/probe-mkt' },
        installLocation: join(home, '.claude', 'plugins', 'marketplaces', 'probe-mkt'),
      },
    });
    expect(discover()[0]!.root).toBe(root);
  });

  it('refuses entries carrying host expansions a wrapped copy cannot honor', () => {
    installPlugin({
      mcpJson: {
        data: { command: 'node', args: ['${CLAUDE_PLUGIN_DATA}/state.js'] },
        userconf: { type: 'http', url: 'https://x.example/mcp', headers: { K: '${user_config.token}' } },
        helper: { type: 'http', url: 'https://y.example/mcp', headersHelper: './helper.sh' },
        envvar: { command: 'node', args: ['s.js'], env: { TOKEN: '${MY_SECRET}' } },
        fine: { type: 'http', url: 'https://z.example/mcp', headers: { Authorization: 'Bearer ${MY_TOKEN}' } },
      },
    });
    const reasons = new Map(discover().map((s) => [s.serverName, s.unwrappableReason]));
    expect(reasons.get('data')).toMatch(/CLAUDE_PLUGIN_DATA/);
    expect(reasons.get('userconf')).toMatch(/user_config/);
    expect(reasons.get('helper')).toMatch(/headersHelper/);
    // The host resolves ${VAR} from the session env for stdio children; a
    // wrapped copy would pass the literal through — refused.
    expect(reasons.get('envvar')).toMatch(/placeholders/);
    // HTTP headers keep their ${VAR} contract from v0.14: resolved at launch.
    expect(reasons.get('fine')).toBeNull();
  });

  it('reads the project record disabledMcpServers list verbatim', () => {
    installPlugin({ mcpJson: { probesrv: { command: 'node' } } });
    writeFileSync(
      join(home, '.claude.json'),
      JSON.stringify({
        projects: { [cwd]: { disabledMcpServers: ['plugin:testplug:probesrv', 'other'] } },
      }),
    );
    const view = readClaudeServers({ home, cwd });
    expect(view.disabledMcpServers).toEqual(['plugin:testplug:probesrv', 'other']);
  });

  it('is empty and quiet with no plugins tree at all', () => {
    const view = readClaudeServers({ home, cwd });
    expect(view.pluginServers).toEqual([]);
    expect(view.disabledMcpServers).toEqual([]);
    expect(view.warnings).toEqual([]);
  });

  it('tolerates a single-record (non-array) install entry', () => {
    const root = join(home, '.claude', 'plugins', 'cache', 'm', 'p', '1.0.0');
    mkdirSync(root, { recursive: true });
    writeJson(join(root, '.mcp.json'), { s: { command: 'node' } });
    writeJson(join(home, '.claude', 'plugins', 'installed_plugins.json'), {
      version: 2,
      plugins: { 'p@m': { scope: 'user', installPath: root, version: '1.0.0' } },
    });
    writeJson(join(home, '.claude', 'settings.json'), { enabledPlugins: { 'p@m': true } });
    expect(discover().map((s) => s.qualifiedName)).toEqual(['plugin:p:s']);
  });

  // Measured on Claude Code 2.1.222: a plugin present in
  // installed_plugins.json with NO enabledPlugins entry anywhere is NOT
  // loaded by the host. Treating it as enabled would wrap (and run) a
  // server the user never had running — consent widening.
  it('requires an explicit enabledPlugins true: installed-but-unlisted contributes nothing', () => {
    const root = join(home, '.claude', 'plugins', 'cache', 'mkt', 'testplug', '1.0.0');
    mkdirSync(root, { recursive: true });
    writeJson(join(root, '.mcp.json'), { probesrv: { command: 'node' } });
    writeJson(join(home, '.claude', 'plugins', 'installed_plugins.json'), {
      version: 2,
      plugins: { 'testplug@mkt': [{ scope: 'user', installPath: root, version: '1.0.0' }] },
    });
    // No settings.json at all.
    expect(discover()).toEqual([]);
  });

  // Measured on Claude Code 2.1.222: the merge is MOST SPECIFIC WINS —
  // user-level false plus project-level true LOADS the plugin. Any-false-wins
  // would diverge in both directions.
  it('lets a project-level enabledPlugins:true override a user-level false', () => {
    installPlugin({ mcpJson: { probesrv: { command: 'node' } }, enabled: false });
    writeJson(join(cwd, '.claude', 'settings.json'), {
      enabledPlugins: { 'testplug@probe-mkt': true },
    });
    expect(discover().map((s) => s.serverName)).toEqual(['probesrv']);
  });

  it('resolves a qualified-name collision across marketplaces deterministically, with a warning', () => {
    installPlugin({ marketplace: 'a-mkt', mcpJson: { s: { command: 'from-a' } } });
    const rootB = join(home, '.claude', 'plugins', 'cache', 'b-mkt', 'testplug', '1.0.0');
    mkdirSync(join(rootB, '.claude-plugin'), { recursive: true });
    writeJson(join(rootB, '.claude-plugin', 'plugin.json'), { name: 'testplug', version: '1.0.0' });
    writeJson(join(rootB, '.mcp.json'), { s: { command: 'from-b' } });
    const installedPath = join(home, '.claude', 'plugins', 'installed_plugins.json');
    const installed = JSON.parse(readFileSync(installedPath, 'utf8'));
    installed.plugins['testplug@b-mkt'] = [{ scope: 'user', installPath: rootB, version: '1.0.0' }];
    writeJson(installedPath, installed);
    writeJson(join(home, '.claude', 'settings.json'), {
      enabledPlugins: { 'testplug@a-mkt': true, 'testplug@b-mkt': true },
    });
    const view = readClaudeServers({ home, cwd });
    const dupes = view.pluginServers.filter((s) => s.qualifiedName === 'plugin:testplug:s');
    expect(dupes).toHaveLength(1);
    // Sorted key order: a-mkt wins, every run.
    expect(dupes[0]!.entry.command).toBe('from-a');
    expect(view.warnings.join('\n')).toContain('more than one installed plugin');
  });

  it('ignores an install record scoped to a different project', () => {
    const root = join(home, '.claude', 'plugins', 'cache', 'mkt', 'testplug', '1.0.0');
    mkdirSync(root, { recursive: true });
    writeJson(join(root, '.mcp.json'), { probesrv: { command: 'node' } });
    writeJson(join(home, '.claude', 'plugins', 'installed_plugins.json'), {
      version: 2,
      plugins: {
        'testplug@mkt': [
          { scope: 'project', projectPath: '/somewhere/else', installPath: root, version: '1.0.0' },
        ],
      },
    });
    writeJson(join(home, '.claude', 'settings.json'), { enabledPlugins: { 'testplug@mkt': true } });
    expect(discover()).toEqual([]);
  });

  it('interpolates a root containing replacement metacharacters verbatim', () => {
    const root = installPlugin({
      version: 'v$$1',
      mcpJson: { probesrv: { command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/server.js'] } },
    });
    expect(root).toContain('$$');
    expect(discover()[0]!.entry.args).toEqual([`${root}/server.js`]);
  });
});
