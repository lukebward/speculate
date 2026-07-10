/**
 * Config loading and validation.
 */
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import type { SpeculateConfig } from './types.js';

const serverSchema = z
  .object({
    command: z.string().optional(),
    args: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
    url: z.string().url().optional(),
    profile: z.string().optional(),
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
});

export function parseConfig(raw: unknown): SpeculateConfig {
  return configSchema.parse(raw) as SpeculateConfig;
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
  return cfg;
}
