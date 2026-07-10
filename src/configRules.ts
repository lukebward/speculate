/**
 * Declarative, user-authored prediction rules (DESIGN.md §5.2).
 *
 * Vetted profiles ship hand-written Tier-1 rules in TypeScript; this module
 * gives config authors the same power for ANY upstream MCP server without
 * writing code: a server entry in `speculate.config.json` embeds an array of
 * rule specs (validated by `configRuleSpecSchema`, embedded into config.ts's
 * server schema by the maintainer), and `compileConfigRules` turns each spec
 * into ordinary `Rule` objects the predictor runs alongside profile rules.
 *
 * A spec names a trigger tool and the follow-up calls to prefetch, with
 * argument templates filled in from the observed trigger call:
 *
 *   {
 *     "trigger": "list_pull_requests",
 *     "predict": [{
 *       "tool": "get_pull_request",
 *       "args": {
 *         "owner": "$args.owner",
 *         "repo": "$args.repo",
 *         "pull_number": "$item.number"
 *       },
 *       "confidence": 0.5,
 *       "forEach": "$parsed",
 *       "limit": 2
 *     }]
 *   }
 *
 * Selector language — applies to TOP-LEVEL string values in `args` and to
 * `forEach`:
 *
 * - `"$args"` / `"$args.<dot.path>"` — from the trigger call's arguments.
 * - `"$parsed"` / `"$parsed.<dot.path>"` — from the trigger call's parsed
 *   result. Per §5.1, `parsed === null` means "no result access": every
 *   `$parsed` selector (even bare `"$parsed"`) then fails closed.
 * - `"$item"` / `"$item.<dot.path>"` — the current element of the `forEach`
 *   array. Schema-rejected unless `forEach` is present on the same entry.
 * - Dot paths traverse object keys and numeric array indices
 *   (`items.0.number`) via own-property access only: `constructor`,
 *   `toString`, inherited `__proto__` and other prototype members are never
 *   reachable, and primitives (strings, numbers) are not traversed. Keys
 *   that themselves contain `.` are not addressable.
 * - A leading `"$$"` escapes a literal `$`: `"$$100"` → the string `"$100"`.
 * - Any other string, and every non-string JSON value (number, boolean,
 *   null, nested object/array), is a literal passed through as-is. There is
 *   NO deep selector interpolation inside nested objects/arrays: a
 *   `"$args.x"` string nested inside an object literal stays the literal
 *   string `"$args.x"`.
 * - Any other `"$…"` string (e.g. `"$foo.bar"`) is rejected at parse time
 *   with a pointer at the selector language.
 *
 * Runtime semantics follow the Rule contract in types.ts: fail closed (a
 * selector that does not resolve drops that prediction — or that forEach
 * element — rather than emitting a partial call), never throw, and return
 * fresh argument objects on every `predict()` invocation.
 */
import { z } from 'zod';
import type { ObservedCall, Prediction, Rule } from './types.js';

const DEFAULT_CONFIDENCE = 0.4;
const DEFAULT_LIMIT = 2;
const MAX_LIMIT = 4;
/** Per-element confidence decay for forEach fan-out: element k gets ×0.7^k. */
const FOREACH_DECAY = 0.7;

// ---------------------------------------------------------------------------
// Selector language
// ---------------------------------------------------------------------------

type SelectorRoot = 'args' | 'parsed' | 'item';

interface Selector {
  root: SelectorRoot;
  /** Dot-path segments after the root (possibly empty). */
  path: string[];
}

/** `$args` / `$parsed` / `$item`, optionally followed by non-empty `.segment`s. */
const SELECTOR_RE = /^\$(args|parsed|item)(\.[^.]+)*$/;

/** True when a top-level string is in selector position (`$…` but not `$$…`). */
function isSelectorString(value: string): boolean {
  return value.startsWith('$') && !value.startsWith('$$');
}

function parseSelector(value: string): Selector | null {
  if (!SELECTOR_RE.test(value)) return null;
  const segments = value.slice(1).split('.');
  return { root: segments[0] as SelectorRoot, path: segments.slice(1) };
}

// ---------------------------------------------------------------------------
// Schema (one rule spec, as written in speculate.config.json)
// ---------------------------------------------------------------------------

/** Plain JSON — the only values a config file can carry. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);

const SELECTOR_HINT =
  'strings starting with "$" must be "$args", "$parsed" or "$item", optionally ' +
  'followed by a dot path (e.g. "$parsed.items.0.number"); write "$$" for a literal "$"';

/**
 * One template value in `args`. Only the TOP-LEVEL string is checked as a
 * selector — strings nested inside object/array literals are literals and
 * deliberately not validated (no deep interpolation).
 */
const argValueSchema = jsonValueSchema.superRefine((value, ctx) => {
  if (typeof value !== 'string' || !isSelectorString(value)) return;
  if (parseSelector(value) === null) {
    ctx.addIssue({
      code: 'custom',
      message: `unknown selector ${JSON.stringify(value)}: ${SELECTOR_HINT}`,
    });
  }
});

/**
 * `forEach` must be a `$args…`/`$parsed…` selector. A literal (or `$$…`)
 * string could never resolve to an array, and `$item` is what `forEach`
 * itself defines — both are config mistakes worth rejecting at parse time.
 */
const forEachSchema = z.string().superRefine((value, ctx) => {
  const selector = isSelectorString(value) ? parseSelector(value) : null;
  if (selector === null) {
    ctx.addIssue({
      code: 'custom',
      message:
        `forEach must be a "$args…" or "$parsed…" selector resolving to an array ` +
        `(e.g. "$parsed" or "$parsed.items"); got ${JSON.stringify(value)}`,
    });
  } else if (selector.root === 'item') {
    ctx.addIssue({
      code: 'custom',
      message: 'forEach cannot use "$item": forEach is what defines "$item"',
    });
  }
});

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

const predictEntrySchema = z
  .object({
    /** Tool to prefetch when the trigger fires. */
    tool: z.string().min(1),
    /** Argument template; top-level string values use the selector language. */
    args: z.record(z.string(), argValueSchema),
    /** Static prior confidence; clamped into [0,1]. */
    confidence: z.number().transform(clamp01).default(DEFAULT_CONFIDENCE),
    /** Selector that must resolve to an array; "$item" binds each element. */
    forEach: forEachSchema.optional(),
    /** Max forEach fan-out; only meaningful alongside forEach. */
    limit: z.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
  })
  .superRefine((entry, ctx) => {
    if (entry.forEach !== undefined) return;
    for (const [key, value] of Object.entries(entry.args)) {
      if (typeof value !== 'string' || !isSelectorString(value)) continue;
      if (parseSelector(value)?.root === 'item') {
        ctx.addIssue({
          code: 'custom',
          path: ['args', key],
          message: `"$item" requires "forEach" on the same predict entry to define what the item is`,
        });
      }
    }
  });

const specSchema = z.object({
  /** Tool name (unprefixed, server-local) whose completed calls fire the rule. */
  trigger: z.string().min(1),
  predict: z.array(predictEntrySchema).min(1),
});

/** A parsed rule spec (defaults applied, confidence clamped). */
export type ConfigRuleSpec = z.output<typeof specSchema>;
/** The raw shape users write in speculate.config.json. */
export type ConfigRuleSpecInput = z.input<typeof specSchema>;

/** Zod schema for ONE rule spec (embed into config.ts's server schema). */
export const configRuleSpecSchema: z.ZodType<ConfigRuleSpec, ConfigRuleSpecInput> = specSchema;

type PredictEntry = ConfigRuleSpec['predict'][number];

// ---------------------------------------------------------------------------
// Runtime resolution
// ---------------------------------------------------------------------------

/** Sentinel for "this selector did not resolve" (fail closed, §5.1). */
const UNRESOLVED: unique symbol = Symbol('speculate.unresolved');
type Unresolved = typeof UNRESOLVED;

interface ResolveContext {
  args: Record<string, unknown>;
  parsed: unknown;
  /** True only inside a forEach iteration; "$item" fails closed otherwise. */
  itemBound: boolean;
  item?: unknown;
}

function resolveSelector(selector: Selector, ctx: ResolveContext): unknown | Unresolved {
  let current: unknown;
  switch (selector.root) {
    case 'args':
      current = ctx.args;
      break;
    case 'parsed':
      // §5.1: parsed === null means "no result access" — fail closed even
      // for bare "$parsed".
      if (ctx.parsed === null) return UNRESOLVED;
      current = ctx.parsed;
      break;
    case 'item':
      // The schema rejects "$item" without forEach; this guard is for
      // callers that bypass the schema.
      if (!ctx.itemBound) return UNRESOLVED;
      current = ctx.item;
      break;
  }
  for (const segment of selector.path) {
    // Own-property access on objects/arrays only: primitives are not
    // traversed and prototype members ("constructor", "toString",
    // inherited "__proto__", Array.prototype methods) are unreachable.
    if (current === null || typeof current !== 'object' || !Object.hasOwn(current, segment)) {
      return UNRESOLVED;
    }
    if (Array.isArray(current) && !/^\d+$/.test(segment)) {
      return UNRESOLVED; // arrays traverse by numeric index only (no 'length')
    }
    current = (current as Record<string, unknown>)[segment];
  }
  // `undefined` anywhere along the path (including as a final own value)
  // means "did not resolve".
  return current === undefined ? UNRESOLVED : current;
}

/**
 * Best-effort deep copy so every predict() returns fresh, independent arg
 * objects (Rule contract): plain objects and arrays are rebuilt from their
 * own enumerable properties; primitives pass through; exotic values (class
 * instances, functions) pass by reference — config literals are always plain
 * JSON, and parsed results practically are too. Cycles overflow the stack
 * and are caught by predict()'s outer try/catch (fail closed).
 */
function materialize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(materialize);
  if (value !== null && typeof value === 'object') {
    const proto: unknown = Object.getPrototypeOf(value);
    if (proto === Object.prototype || proto === null) {
      const out: Record<string, unknown> = {};
      for (const [key, entry] of Object.entries(value)) {
        // defineProperty keeps an own '__proto__' key (JSON.parse can
        // produce one) an own property instead of reparenting `out`.
        Object.defineProperty(out, key, {
          value: materialize(entry),
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
      return out;
    }
  }
  return value;
}

/**
 * Materialize one template value. Only a TOP-LEVEL string is interpreted as
 * a selector or "$$" escape; every non-string value — including objects and
 * arrays that may contain "$…" strings — is a literal copied through as-is
 * (no deep interpolation).
 */
function resolveArgValue(template: JsonValue, ctx: ResolveContext): unknown | Unresolved {
  if (typeof template === 'string') {
    if (template.startsWith('$$')) return template.slice(1); // "$$100" → "$100"
    if (template.startsWith('$')) {
      const selector = parseSelector(template);
      if (selector === null) return UNRESOLVED; // unparseable "$…": fail closed
      const resolved = resolveSelector(selector, ctx);
      return resolved === UNRESOLVED ? UNRESOLVED : materialize(resolved);
    }
    return template;
  }
  return materialize(template);
}

/** Fill an arg template; ANY unresolved selector drops the whole prediction. */
function resolveArgs(
  template: Record<string, JsonValue>,
  ctx: ResolveContext,
): Record<string, unknown> | Unresolved {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(template)) {
    const resolved = resolveArgValue(value, ctx);
    if (resolved === UNRESOLVED) return UNRESOLVED;
    out[key] = resolved;
  }
  return out;
}

/** Round to 4 decimals so 0.7^k decay chains stay test-stable. */
function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

// ---------------------------------------------------------------------------
// Compilation
// ---------------------------------------------------------------------------

function compileEntry(server: string, trigger: string, entry: PredictEntry, index: number): Rule {
  // Server label in the id: feedback must never bleed between servers
  // that share rule shapes (review finding, §13.7).
  const id = `config:${server}:${trigger}→${entry.tool}#${index}`;
  return {
    id,
    trigger,
    predict(call: ObservedCall): Prediction[] {
      try {
        const ctx: ResolveContext = { args: call.args, parsed: call.parsed, itemBound: false };

        if (entry.forEach === undefined) {
          const args = resolveArgs(entry.args, ctx);
          if (args === UNRESOLVED) return [];
          // `server` comes from the observed call, not compile time: the
          // predictor feeds each server's rules only its own calls, and the
          // call's label is authoritative. Key is stamped by the predictor.
          return [{ server: call.server, tool: entry.tool, args, confidence: entry.confidence, ruleId: id }];
        }

        const selector = parseSelector(entry.forEach);
        if (selector === null || selector.root === 'item') return []; // schema-bypassed spec: fail closed
        const list = resolveSelector(selector, ctx);
        if (list === UNRESOLVED || !Array.isArray(list)) return [];

        const predictions: Prediction[] = [];
        const count = Math.min(entry.limit, list.length);
        for (let k = 0; k < count; k++) {
          // An element that fails to resolve is dropped; survivors keep
          // their position-based decay slot (element k → ×0.7^k).
          const args = resolveArgs(entry.args, { ...ctx, itemBound: true, item: list[k] });
          if (args === UNRESOLVED) continue;
          predictions.push({
            server: call.server,
            tool: entry.tool,
            args,
            confidence: round4(entry.confidence * FOREACH_DECAY ** k),
            ruleId: id,
          });
        }
        return predictions;
      } catch {
        return []; // Rule contract: predict() must never throw
      }
    },
  };
}

/**
 * Compile parsed rule specs into predictor Rules — one Rule per
 * (spec, predict-entry) pair, with ids `config:<trigger>→<tool>#<i>`.
 *
 * `server` is the config-file server label the specs are attached to; it is
 * accepted for call-site clarity and future diagnostics, but emitted
 * predictions stamp `call.server` (the observed call's label is
 * authoritative — see compileEntry). Pass specs through
 * `configRuleSpecSchema` first: compilation assumes defaults are applied,
 * confidence is clamped, and selectors are well-formed (malformed ones fail
 * closed at runtime rather than throwing).
 */
export function compileConfigRules(server: string, specs: ConfigRuleSpec[]): Rule[] {
  const rules: Rule[] = [];
  for (const spec of specs) {
    spec.predict.forEach((entry, index) => {
      rules.push(compileEntry(server, spec.trigger, entry, index));
    });
  }
  return rules;
}
