/**
 * Custom read-only command registry for speculate-shell (DESIGN.md §13.10):
 * "anything an agent can use should be predictable."
 *
 * Users declare CLI commands in a JSONC file; each becomes an MCP tool
 * (annotated readOnlyHint) behind the proxy, so the entire prediction stack
 * — profiles, morphology priming, the learner, persistence — applies to any
 * tool an agent shells out to.
 *
 * Trust boundary, stated plainly: DECLARING A COMMAND ASSERTS IT IS
 * READ-ONLY. The registry author controls the fixed argv prefix (same trust
 * as their own shell); what the registry makes safe is the MODEL-supplied
 * part — parameters are typed, validated, and structurally incapable of
 * becoming flags or shell syntax:
 * - execFile only (no shell), fixed binary + fixed argv prefix per tool;
 * - number params are bounded; enum params come from the declared set
 *   (values themselves validated at load time); string params are
 *   length-capped, NUL-free, may not start with '-', and may be further
 *   constrained by an anchored pattern;
 * - flag names are validated at load time; user values are only ever
 *   appended as flag VALUES or trailing positionals.
 */
import { z } from 'zod';
import { readFileSync } from 'node:fs';
import { parseJsonc } from '../src/jsonc.js';

export const TOOL_NAME_RE = /^[a-z][a-z0-9_]{0,63}$/;
const FLAG_RE = /^--?[A-Za-z0-9][\w-]*$/;
/** Enum values: conservative charset, never flag-like. */
const ENUM_VALUE_RE = /^[A-Za-z0-9][\w./:-]{0,127}$/;

const DEFAULT_STRING_MAX = 256;
const NUMBER_MIN_DEFAULT = 0;
const NUMBER_MAX_DEFAULT = 1_000_000;

const numberParam = z.object({
  type: z.literal('number'),
  flag: z.string().regex(FLAG_RE).optional(),
  min: z.number().optional(),
  max: z.number().optional(),
  integer: z.boolean().optional(),
  required: z.boolean().optional(),
  description: z.string().max(200).optional(),
});

const enumParam = z.object({
  type: z.literal('enum'),
  values: z.array(z.string().regex(ENUM_VALUE_RE)).min(1).max(32),
  flag: z.string().regex(FLAG_RE).optional(),
  required: z.boolean().optional(),
  description: z.string().max(200).optional(),
});

const stringParam = z.object({
  type: z.literal('string'),
  pattern: z.string().max(200).optional(),
  maxLength: z.number().int().min(1).max(1024).optional(),
  flag: z.string().regex(FLAG_RE).optional(),
  required: z.boolean().optional(),
  description: z.string().max(200).optional(),
});

const paramSchema = z.discriminatedUnion('type', [numberParam, enumParam, stringParam]);

const commandSpecSchema = z.object({
  description: z.string().max(500).optional(),
  /** Fixed argv: binary first, then trusted flags/args (author-controlled). */
  command: z.array(z.string().min(1).max(512)).min(1).max(32),
  /** Model-facing parameters, appended after the fixed argv. */
  params: z.record(z.string().regex(/^[a-z][a-z0-9_]{0,31}$/), paramSchema).optional(),
});

export const commandRegistrySchema = z
  .record(z.string().regex(TOOL_NAME_RE), commandSpecSchema)
  .refine((r) => Object.keys(r).length <= 64, { message: 'at most 64 custom commands' });

export type CommandSpec = z.infer<typeof commandSpecSchema>;
export type CommandRegistry = z.infer<typeof commandRegistrySchema>;

export function loadCommandRegistry(path: string): CommandRegistry {
  const raw = parseJsonc(readFileSync(path, 'utf8'));
  const result = commandRegistrySchema.safeParse(raw);
  if (!result.success) {
    const lines = result.error.issues
      .map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`invalid command registry ${path}:\n${lines}`);
  }
  // Compile string patterns now so a bad regex fails at startup, loudly.
  for (const [name, spec] of Object.entries(result.data)) {
    for (const [pname, p] of Object.entries(spec.params ?? {})) {
      if (p.type === 'string' && p.pattern !== undefined) {
        try {
          anchoredPattern(p.pattern);
        } catch (err) {
          throw new Error(
            `invalid command registry ${path}: ${name}.params.${pname}.pattern: ${(err as Error).message}`,
          );
        }
      }
    }
  }
  return result.data;
}

function anchoredPattern(pattern: string): RegExp {
  return new RegExp(`^(?:${pattern})$`);
}

export class ParamError extends Error {}

/**
 * Validate one model-supplied value against its declared param spec and
 * render it as an argv string. Throws ParamError with a clean message.
 */
export function renderParamValue(name: string, spec: CommandSpec['params'] extends undefined ? never : NonNullable<CommandSpec['params']>[string], value: unknown): string {
  switch (spec.type) {
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new ParamError(`${name}: expected a number`);
      }
      if (spec.integer !== false && !Number.isInteger(value)) {
        throw new ParamError(`${name}: expected an integer`);
      }
      const min = spec.min ?? NUMBER_MIN_DEFAULT;
      const max = spec.max ?? NUMBER_MAX_DEFAULT;
      if (value < min || value > max) {
        throw new ParamError(`${name}: out of range [${min}, ${max}]`);
      }
      return String(value);
    }
    case 'enum': {
      if (typeof value !== 'string' || !spec.values.includes(value)) {
        throw new ParamError(`${name}: expected one of ${spec.values.join(', ')}`);
      }
      return value;
    }
    case 'string': {
      if (typeof value !== 'string') throw new ParamError(`${name}: expected a string`);
      const max = spec.maxLength ?? DEFAULT_STRING_MAX;
      if (value.length === 0 || value.length > max) {
        throw new ParamError(`${name}: length must be 1..${max}`);
      }
      if (value.includes('\0')) throw new ParamError(`${name}: NUL not allowed`);
      if (value.startsWith('-')) {
        // Structurally never a flag, no matter what the binary does with it.
        throw new ParamError(`${name}: may not start with '-'`);
      }
      if (spec.pattern !== undefined && !anchoredPattern(spec.pattern).test(value)) {
        throw new ParamError(`${name}: does not match required pattern`);
      }
      return value;
    }
  }
}

/**
 * Build the final argv for a call: fixed prefix, then declared params in
 * declaration order (flag params as `flag value`, unflagged as trailing
 * positionals). Unknown arg names are rejected by the MCP input schema
 * before we get here; missing optional params are simply omitted.
 */
export function buildArgv(
  spec: CommandSpec,
  args: Record<string, unknown>,
): { bin: string; argv: string[] } {
  const [bin, ...fixed] = spec.command;
  const flags: string[] = [];
  const positionals: string[] = [];
  for (const [pname, p] of Object.entries(spec.params ?? {})) {
    const value = args[pname];
    if (value === undefined || value === null) {
      if (p.required) throw new ParamError(`${pname}: required`);
      continue;
    }
    const rendered = renderParamValue(pname, p, value);
    if (p.flag) flags.push(p.flag, rendered);
    else positionals.push(rendered);
  }
  return { bin: bin!, argv: [...fixed, ...flags, ...positionals] };
}

/** zod raw shape for the MCP inputSchema of a command spec. */
export function inputShapeFor(spec: CommandSpec): Record<string, z.ZodType> {
  const shape: Record<string, z.ZodType> = {};
  for (const [pname, p] of Object.entries(spec.params ?? {})) {
    let t: z.ZodType;
    if (p.type === 'number') {
      let n = z.number();
      if (p.integer !== false) n = n.int();
      t = n.min(p.min ?? NUMBER_MIN_DEFAULT).max(p.max ?? NUMBER_MAX_DEFAULT);
    } else if (p.type === 'enum') {
      t = z.enum(p.values as [string, ...string[]]);
    } else {
      t = z.string().min(1).max(p.maxLength ?? DEFAULT_STRING_MAX);
    }
    if (p.description) t = t.describe(p.description);
    shape[pname] = p.required ? t : t.optional();
  }
  return shape;
}
