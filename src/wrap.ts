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
import { RETIRED_PROFILES, resolveHeaderValue } from './config.js';
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
  /**
   * A remote (streamable-HTTP) upstream instead of a wrapped child process.
   * Exclusive with `command`: there is nothing to spawn.
   */
  url: string | null;
  /**
   * Request headers for `url`, already env-resolved. SECRETS: never print a
   * value (see Upstream#redact).
   */
  headers: Record<string, string>;
}

/** Substring → vetted profile, checked against the wrapped command line. */
const PROFILE_AUTODETECT: [string, string][] = [
  ['github-mcp-server', 'github'],
];

export function parseWrapArgs(argv: string[]): WrapArgs | { error: string } {
  const out: WrapArgs = {
    mode: 'annotated',
    profile: null,
    allow: [],
    sniff: false,
    command: [],
    url: null,
    headers: {},
  };
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
    } else if (a === '--url') {
      const u = argv[++i];
      if (!u) return { error: '--url requires a URL' };
      let parsed: URL;
      try {
        parsed = new URL(u);
      } catch {
        return { error: `--url is not a valid URL: '${u}'` };
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return { error: `--url must be http or https (got '${parsed.protocol}')` };
      }
      out.url = u;
    } else if (a === '--header') {
      const raw = argv[++i];
      if (!raw) return { error: '--header requires a "Name: value" pair' };
      // First colon only: a value may contain colons (a URL, a timestamp).
      const split = raw.indexOf(':');
      if (split <= 0) {
        return { error: `--header must be "Name: value" (got '${raw}')` };
      }
      const name = raw.slice(0, split).trim();
      const value = raw.slice(split + 1).trim();
      try {
        // Same contract as a config file's headers, from the same function:
        // ${VAR} resolved here, an unset variable fatal and named.
        out.headers[name] = resolveHeaderValue(name, value);
      } catch (err) {
        return { error: `--header ${name}: ${(err as Error).message}` };
      }
    } else {
      return { error: `unknown wrap argument '${a}' (flags go before '--', the wrapped command after)` };
    }
  }
  // Exactly one upstream: a remote URL or a child process, never both.
  if (out.url && out.command.length > 0) {
    return { error: "--url wraps a remote server; drop the command after '--'" };
  }
  if (!out.url && out.command.length === 0) {
    return { error: "wrap needs a server command after '--', or --url <url> for a remote server" };
  }
  if (out.url && out.sniff) {
    // Sniffing degrades to piping the WRAPPED COMMAND's bytes; with no child
    // to pipe to, "non-MCP client" has no safe fallback to offer.
    return { error: '--sniff applies to a wrapped command, not to --url' };
  }
  if (!out.url && Object.keys(out.headers).length > 0) {
    return { error: '--header applies to --url servers only (a stdio server takes env vars)' };
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
    // Autodetect reads the command line; a remote server has none, and is
    // fingerprinted from its tool list at runtime instead (§13.11).
    (args.url ? null : PROFILE_AUTODETECT.find(([needle]) => commandLine.includes(needle))?.[1]) ??
    null;
  // The state key must NEVER carry the headers: it names the on-disk state
  // file. The URL alone identifies the upstream.
  const upstream = args.url
    ? {
        url: args.url,
        ...(Object.keys(args.headers).length ? { headers: { ...args.headers } } : {}),
      }
    : { command: args.command[0]!, args: args.command.slice(1) };
  return {
    config: {
      mode: args.mode,
      maxPredictionsPerTrigger: 3,
      log: 'stderr',
      servers: {
        upstream: {
          ...upstream,
          ...(profile ? { profile } : {}),
          ...(args.allow.length ? { allowTools: args.allow } : {}),
        },
      },
    },
    stateKey: args.url ? `wrap:url:${args.url}` : `wrap:${commandLine}`,
  };
}
