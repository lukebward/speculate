/**
 * Config loading and validation.
 */
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { parseJsonc } from './jsonc.js';
import { configRuleSpecSchema } from './configRules.js';
import { builtinProfiles } from './profiles/index.js';
import type { SpeculateConfig } from './types.js';

/**
 * `${VAR}` placeholder in a header VALUE, resolved from the environment at
 * config load (see resolveHeaderValue). Deliberately narrow: a shell-style
 * `${VAR:-default}` is NOT matched, so it stays a literal rather than
 * silently resolving to something the user did not intend.
 */
const ENV_PLACEHOLDER = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
/**
 * RFC 9110 field-name token. Anything else is rejected at load.
 *
 * Exported for hostConfig.ts, which must apply the SAME rule before `on`
 * rewrites a remote server into a `wrap --header` invocation, but cannot
 * import this module (zod plus every profile) into the session-start `sync`
 * path. It keeps its own copy; a test pins the two together.
 */
export const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

/**
 * One HTTP header value, with `${VAR}` placeholders resolved from the
 * environment, so a bearer token never has to be written into the config
 * file (which is commonly checked in).
 *
 * Contract, and why each half of it is loud rather than lenient:
 *   - An UNSET (or empty) variable is a fatal config error naming the
 *     variable. One lenient alternative, substituting nothing, would send
 *     `Authorization: Bearer ` upstream; the other, leaving the text
 *     alone, would send the literal `${GITHUB_TOKEN}`. Both produce a
 *     confusing 401 from the server instead of a clear message here, and
 *     the second one puts a placeholder on the wire. An empty variable
 *     counts as unset for the same reason: an empty token is never what
 *     anybody meant.
 *   - A CR or LF anywhere in the RESULT is fatal. Values come from the
 *     environment, so this is the header-injection boundary.
 * There is no escape for a literal `${NAME}`; a header value that genuinely
 * needs one is not a case worth a syntax.
 *
 * THROWN MESSAGES NEVER CONTAIN THE RESOLVED VALUE, because they are printed.
 */
export function resolveHeaderValue(
  name: string,
  raw: string,
  env: Record<string, string | undefined> = process.env,
): string {
  if (!HEADER_NAME.test(name)) {
    throw new Error(`'${name}' is not a valid HTTP header name`);
  }
  let unset: string | null = null;
  let empty: string | null = null;
  const resolved = raw.replace(ENV_PLACEHOLDER, (_match, variable: string) => {
    const value = env[variable];
    if (value === undefined) {
      unset ??= variable;
      return '';
    }
    if (value === '') {
      empty ??= variable;
      return '';
    }
    return value;
  });
  if (unset !== null) {
    throw new Error(
      `environment variable ${unset} is not set (referenced as \${${unset}}): ` +
        `export it before starting Speculate, or write the value inline`,
    );
  }
  if (empty !== null) {
    throw new Error(
      `environment variable ${empty} is set but empty (referenced as \${${empty}}): ` +
        `an empty credential is never intended`,
    );
  }
  if (/[\r\n]/.test(resolved)) {
    throw new Error('resolved header value contains a newline (header injection)');
  }
  return resolved;
}

const serverSchema = z
  .object({
    command: z.string().optional(),
    args: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
    url: z.string().url().optional(),
    /**
     * Extra HTTP request headers for a `url` upstream: how an authenticated
     * remote MCP server is reached. Values may carry `${VAR}` placeholders.
     * ONCE RESOLVED THESE ARE SECRETS: never print a value (see doctor.ts and
     * Upstream#redact).
     */
    headers: z.record(z.string(), z.string()).optional(),
    profile: z.string().optional(),
    /** Declarative prediction rules (see src/configRules.ts) — teach
     * Speculate any server's workflow shape straight from the config. */
    rules: z.array(configRuleSpecSchema).optional(),
    allowTools: z.array(z.string()).optional(),
    denyTools: z.array(z.string()).optional(),
    speculation: z
      .object({
        defaultTtlMs: z.number().int().nonnegative().optional(),
        ttlMsByTool: z.record(z.string(), z.number().int().nonnegative()).optional(),
        /** §6.2: TTL multiplier for long-horizon predictions; 1 disables it. */
        longHorizonTtlFactor: z.number().positive().max(1).optional(),
        maxPerMinute: z.number().int().positive().optional(),
        maxConcurrent: z.number().int().positive().optional(),
      })
      .optional(),
  })
  .refine((s) => (s.command ? !s.url : !!s.url), {
    message: 'server must have exactly one of `command` (stdio) or `url` (http)',
  })
  .refine((s) => !s.headers || !!s.url, {
    message:
      '`headers` applies to `url` (http) servers only; a stdio server takes credentials via `env`',
  });

const configSchema = z.object({
  mode: z.enum(['strict', 'annotated', 'off']).default('strict'),
  maxPredictionsPerTrigger: z.number().int().positive().max(16).default(3),
  servers: z.record(z.string().regex(/^[A-Za-z0-9_-]+$/), serverSchema),
  log: z.enum(['stderr', 'off']).default('stderr'),
  /** §13.6: learned-state persistence. Enabled by default; results never persist. */
  persistence: z
    .object({
      enabled: z.boolean().default(true),
      /** Override the state-file location (default: XDG state dir, per
       * config file). Relative paths resolve against the proxy's cwd. */
      path: z.string().min(1).optional(),
    })
    .optional(),
});

/**
 * Profiles that existed in ≤0.10 and no longer do. Referencing one is a
 * warning, not a fatal: the rest of the config still loads. Shared with
 * `speculate wrap --profile` (wrap.ts), which degrades the same way.
 */
export const RETIRED_PROFILES: ReadonlySet<string> = new Set(['shell']);

export function parseConfig(raw: unknown): SpeculateConfig {
  const result = configSchema.safeParse(raw);
  if (!result.success) {
    // Pretty, pointered messages instead of a raw ZodError dump.
    const lines = result.error.issues.map(
      (issue) => `  ${issue.path.length ? issue.path.join('.') : '(root)'}: ${issue.message}`,
    );
    throw new Error(`invalid config:\n${lines.join('\n')}`);
  }
  const cfg = result.data as SpeculateConfig;
  // Environment interpolation runs AFTER the shape is known good, so its
  // messages carry the same `servers.<name>.headers.<Header>: …` pointer the
  // schema issues do. Every header is checked before anything throws: a
  // config with two unset variables names both, not just the first.
  const headerIssues: string[] = [];
  for (const [name, sc] of Object.entries(cfg.servers)) {
    if (!sc.headers) continue;
    const resolved: Record<string, string> = {};
    for (const [header, raw] of Object.entries(sc.headers)) {
      try {
        resolved[header] = resolveHeaderValue(header, raw);
      } catch (err) {
        headerIssues.push(`  servers.${name}.headers.${header}: ${(err as Error).message}`);
      }
    }
    sc.headers = resolved;
  }
  if (headerIssues.length > 0) {
    throw new Error(`invalid config:\n${headerIssues.join('\n')}`);
  }
  return cfg;
}

export function loadConfig(path: string): SpeculateConfig {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    throw new Error(`cannot read config ${path}: ${(err as Error).message}`);
  }
  let json: unknown;
  try {
    // Tolerant parse: comments and trailing commas are allowed in configs.
    json = parseJsonc(text);
  } catch (err) {
    throw new Error(`config ${path} is not valid JSON: ${(err as Error).message}`);
  }
  const cfg = parseConfig(json);
  if (Object.keys(cfg.servers).length === 0) {
    throw new Error(`config ${path}: at least one upstream server is required`);
  }
  // Catch typo'd profile names here so `validate` catches them, not just run.
  // 'none' is the explicit opt-out from profiles AND fingerprinting (§13.11).
  for (const [name, sc] of Object.entries(cfg.servers)) {
    if (sc.profile && RETIRED_PROFILES.has(sc.profile)) {
      // A ≤0.10 config naming a profile 0.11 retired must not take the
      // user's healthy servers down with it: warn, drop the profile (the
      // server is then fingerprinted like any unprofiled one), carry on.
      process.stderr.write(
        `[speculate] warning: config ${path}: server '${name}' uses profile '${sc.profile}', ` +
          `retired in 0.11 with CLI speculation — ignoring it (delete that line).\n`,
      );
      delete (sc as { profile?: string }).profile;
      continue;
    }
    if (sc.profile && sc.profile !== 'none' && !Object.hasOwn(builtinProfiles, sc.profile)) {
      throw new Error(
        `config ${path}: server '${name}' references unknown profile '${sc.profile}' (available: ${Object.keys(builtinProfiles).join(', ')})`,
      );
    }
  }
  return cfg;
}
