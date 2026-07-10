/**
 * Config loading and validation.
 */
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { configRuleSpecSchema } from './configRules.js';
import { builtinProfiles } from './profiles/index.js';
import type { SpeculateConfig } from './types.js';

const serverSchema = z
  .object({
    command: z.string().optional(),
    args: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
    url: z.string().url().optional(),
    profile: z.string().optional(),
    /** Declarative prediction rules (see src/configRules.ts) — teach
     * Speculate any server's workflow shape straight from the config. */
    rules: z.array(configRuleSpecSchema).optional(),
    allowTools: z.array(z.string()).optional(),
    denyTools: z.array(z.string()).optional(),
    speculation: z
      .object({
        defaultTtlMs: z.number().int().nonnegative().optional(),
        maxPerMinute: z.number().int().positive().optional(),
        maxConcurrent: z.number().int().positive().optional(),
      })
      .optional(),
  })
  .refine((s) => (s.command ? !s.url : !!s.url), {
    message: 'server must have exactly one of `command` (stdio) or `url` (http)',
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

export function parseConfig(raw: unknown): SpeculateConfig {
  const result = configSchema.safeParse(raw);
  if (!result.success) {
    // Pretty, pointered messages instead of a raw ZodError dump.
    const lines = result.error.issues.map(
      (issue) => `  ${issue.path.length ? issue.path.join('.') : '(root)'}: ${issue.message}`,
    );
    throw new Error(`invalid config:\n${lines.join('\n')}`);
  }
  return result.data as SpeculateConfig;
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
    json = JSON.parse(text);
  } catch (err) {
    throw new Error(`config ${path} is not valid JSON: ${(err as Error).message}`);
  }
  const cfg = parseConfig(json);
  if (Object.keys(cfg.servers).length === 0) {
    throw new Error(`config ${path}: at least one upstream server is required`);
  }
  // Catch typo'd profile names here so `validate` catches them, not just run.
  for (const [name, sc] of Object.entries(cfg.servers)) {
    if (sc.profile && !Object.hasOwn(builtinProfiles, sc.profile)) {
      throw new Error(
        `config ${path}: server '${name}' references unknown profile '${sc.profile}' (available: ${Object.keys(builtinProfiles).join(', ')})`,
      );
    }
  }
  return cfg;
}
