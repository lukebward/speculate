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
 * Defaults chosen for the zero-config path: mode `annotated` (there is no
 * allowlist to consult, so `readOnlyHint` is the only signal — documented
 * trade-off, overridable with --mode/--allow), persistence on (keyed by
 * the wrapped command line), known servers auto-matched to vetted profiles.
 */
import { RETIRED_PROFILES } from './config.js';
import { builtinProfiles } from './profiles/index.js';
import type { SpeculateConfig, SpeculationMode } from './types.js';

export interface WrapArgs {
  mode: SpeculationMode;
  profile: string | null;
  allow: string[];
  /**
   * §13.12 protocol sniffing: engage the proxy only if the first client
   * line is an MCP initialize; otherwise degrade to a transparent pipe.
   * This is what makes blind wrapping (launcher shims) safe.
   */
  sniff: boolean;
  command: string[];
}

/** Substring → vetted profile, checked against the wrapped command line. */
const PROFILE_AUTODETECT: [string, string][] = [
  ['github-mcp-server', 'github'],
];

export function parseWrapArgs(argv: string[]): WrapArgs | { error: string } {
  const out: WrapArgs = { mode: 'annotated', profile: null, allow: [], sniff: false, command: [] };
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
    } else if (a === '--sniff') {
      out.sniff = true;
    } else {
      return { error: `unknown wrap argument '${a}' (flags go before '--', the wrapped command after)` };
    }
  }
  if (out.command.length === 0) {
    return { error: "wrap needs a server command after '--'" };
  }
  if (out.profile && RETIRED_PROFILES.has(out.profile)) {
    // Same contract a config file gets (config.ts): a ≤0.10 invocation naming
    // a profile 0.11 retired must not lose the user a working server. Warn,
    // drop the profile — the server is then fingerprinted like any unprofiled
    // one — and carry on.
    process.stderr.write(
      `[speculate] warning: profile '${out.profile}' was retired in 0.11 with CLI ` +
        `speculation — ignoring it (drop the --profile flag).\n`,
    );
    out.profile = null;
  } else if (out.profile && out.profile !== 'none' && !Object.hasOwn(builtinProfiles, out.profile)) {
    return {
      error: `unknown profile '${out.profile}' (available: ${Object.keys(builtinProfiles).join(', ')}, none)`,
    };
  }
  return out;
}

/** Build the in-memory SpeculateConfig for a wrap invocation. */
export function buildWrapConfig(args: WrapArgs): { config: SpeculateConfig; stateKey: string } {
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
