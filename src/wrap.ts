/**
 * `speculate wrap` — zero-config speculation (DESIGN.md §13.9).
 *
 * Instead of writing a speculate.config.json and re-pointing the host at
 * it, the user prefixes their EXISTING server command:
 *
 *   { "command": "npx",
 *     "args": ["-y", "github:lukebward/speculate", "wrap", "--",
 *              "github-mcp-server", "stdio"] }
 *
 * or wraps a workspace for CLI speculation with no command at all:
 *
 *   { "args": ["...", "wrap", "--workspace", "."] }
 *
 * Defaults chosen for the zero-config path: mode `annotated` (there is no
 * allowlist to consult, so `readOnlyHint` is the only signal — documented
 * trade-off, overridable with --mode/--allow), persistence on (keyed by
 * the wrapped command line), known servers auto-matched to vetted profiles.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { builtinProfiles } from './profiles/index.js';
import type { SpeculateConfig, SpeculationMode } from './types.js';

export interface WrapArgs {
  mode: SpeculationMode;
  profile: string | null;
  allow: string[];
  workspace: string | null;
  /** Custom command registry file for --workspace mode (§13.10). */
  commands: string | null;
  command: string[];
}

/** Substring → vetted profile, checked against the wrapped command line. */
const PROFILE_AUTODETECT: [string, string][] = [
  ['github-mcp-server', 'github'],
  ['speculate-shell', 'shell'],
];

export function parseWrapArgs(argv: string[]): WrapArgs | { error: string } {
  const out: WrapArgs = { mode: 'annotated', profile: null, allow: [], workspace: null, commands: null, command: [] };
  let i = 0;
  for (; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--') {
      out.command = argv.slice(i + 1);
      break;
    }
    if (a === '--mode') {
      const m = argv[++i];
      if (m !== 'strict' && m !== 'annotated' && m !== 'off') {
        return { error: `--mode must be strict|annotated|off (got '${m ?? ''}')` };
      }
      out.mode = m;
    } else if (a === '--profile') {
      const p = argv[++i];
      if (!p) return { error: '--profile requires a name' };
      out.profile = p;
    } else if (a === '--allow') {
      const list = argv[++i];
      if (!list) return { error: '--allow requires a comma-separated tool list' };
      out.allow.push(...list.split(',').map((s) => s.trim()).filter(Boolean));
    } else if (a === '--workspace') {
      const w = argv[++i];
      if (!w) return { error: '--workspace requires a directory' };
      out.workspace = resolve(w);
    } else if (a === '--commands') {
      const c = argv[++i];
      if (!c) return { error: '--commands requires a file path' };
      out.commands = resolve(c);
    } else {
      return { error: `unknown wrap argument '${a}' (flags go before '--', the wrapped command after)` };
    }
  }
  if (out.workspace && out.command.length > 0) {
    return { error: '--workspace and a wrapped command are mutually exclusive' };
  }
  if (out.commands && !out.workspace) {
    return { error: '--commands requires --workspace (it feeds the bundled shell server)' };
  }
  if (!out.workspace && out.command.length === 0) {
    return { error: "wrap needs a server command after '--' (or --workspace <dir>)" };
  }
  if (out.profile && out.profile !== 'none' && !Object.hasOwn(builtinProfiles, out.profile)) {
    return {
      error: `unknown profile '${out.profile}' (available: ${Object.keys(builtinProfiles).join(', ')}, none)`,
    };
  }
  return out;
}

/**
 * Locate the bundled shell server relative to this module: dist/src/cli.js →
 * dist/shell/speculate-shell.js in a build; falls back to tsx + the .ts
 * source when running from a source checkout.
 */
export function resolveShellServerCommand(): { command: string; args: string[] } {
  const builtJs = fileURLToPath(new URL('../shell/speculate-shell.js', import.meta.url));
  if (existsSync(builtJs)) {
    return { command: process.execPath, args: [builtJs] };
  }
  const tsSource = fileURLToPath(new URL('../shell/speculate-shell.ts', import.meta.url));
  const tsx = fileURLToPath(new URL('../node_modules/.bin/tsx', import.meta.url));
  if (existsSync(tsSource) && existsSync(tsx)) {
    return { command: tsx, args: [tsSource] };
  }
  throw new Error(
    'cannot locate the bundled speculate-shell server (looked for dist/shell/speculate-shell.js); run npm run build',
  );
}

/** Build the in-memory SpeculateConfig for a wrap invocation. */
export function buildWrapConfig(args: WrapArgs): { config: SpeculateConfig; stateKey: string } {
  if (args.workspace) {
    const shell = resolveShellServerCommand();
    return {
      config: {
        mode: args.mode,
        maxPredictionsPerTrigger: 3,
        log: 'stderr',
        servers: {
          workspace: {
            command: shell.command,
            args: [
              ...shell.args,
              '--cwd',
              args.workspace,
              ...(args.commands ? ['--commands', args.commands] : []),
            ],
            profile: 'shell',
            ...(args.allow.length ? { allowTools: args.allow } : {}),
          },
        },
      },
      stateKey: `wrap-workspace:${args.workspace}`,
    };
  }

  const commandLine = args.command.join(' ');
  const profile =
    args.profile ??
    PROFILE_AUTODETECT.find(([needle]) => commandLine.includes(needle))?.[1] ??
    null;
  return {
    config: {
      mode: args.mode,
      maxPredictionsPerTrigger: 3,
      log: 'stderr',
      servers: {
        upstream: {
          command: args.command[0]!,
          args: args.command.slice(1),
          ...(profile ? { profile } : {}),
          ...(args.allow.length ? { allowTools: args.allow } : {}),
        },
      },
    },
    stateKey: `wrap:${commandLine}`,
  };
}
