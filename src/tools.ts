/**
 * What Speculate knows about each MCP tool (DESIGN.md §4).
 *
 * Eligibility is affirmative and learned from the host. A tool is a
 * speculation target only after a real call through Claude Code reported it
 * read-only (`isReadOnly`, which Claude Code sets from the server's own
 * `readOnlyHint`) and answered with plain content blocks a prefetched result
 * can stand in for. Unknown means no. A tool that later reports otherwise
 * loses eligibility on that call.
 *
 * The facts persist across sessions so a known read can be prefetched before
 * its first real call of the session. They hold tool names and argument KEY
 * shapes only, never argument values or results.
 */
import type { SecretGuard } from './privacy.js';
import type { EligibilityDecision } from './types.js';

export interface ToolFact {
  /** The host's last verdict: true when the tool ran read-only. */
  readOnly: boolean;
  /** The real result was content blocks, so a prefetched result can be served. */
  servable: boolean;
  /** Sorted argument key sets seen on real calls, most recent first. */
  shapes: string[];
  lastSeen: number;
}

/** server -> tool -> fact */
export type ToolFacts = Record<string, Record<string, ToolFact>>;

const MAX_SHAPES = 8;
const MAX_TOOLS = 2_048;
const MAX_LABEL = 512;

export function argShape(args: Record<string, unknown>): string {
  return Object.keys(args).sort().join(',');
}

export class ToolKnowledge {
  private facts = new Map<string, Map<string, ToolFact>>();
  private readonly suspended = new Map<string, string>();
  private hooked: (server: string, tool: string) => boolean = () => false;
  private mutations = 0;

  constructor(private readonly now: () => number = Date.now) {}

  get revision(): number {
    return this.mutations;
  }

  /** Records what a real call through the host revealed about its tool. */
  record(
    server: string,
    tool: string,
    observed: { readOnly: boolean; servable: boolean; args: Record<string, unknown> },
  ): void {
    let byTool = this.facts.get(server);
    if (!byTool) {
      byTool = new Map();
      this.facts.set(server, byTool);
    }
    const prior = byTool.get(tool);
    const shape = argShape(observed.args);
    const shapes = [shape, ...(prior?.shapes ?? []).filter((s) => s !== shape)].slice(0, MAX_SHAPES);
    byTool.set(tool, {
      readOnly: observed.readOnly,
      servable: observed.servable,
      shapes,
      lastSeen: this.now(),
    });
    this.mutations++;
  }

  fact(server: string, tool: string): ToolFact | undefined {
    return this.facts.get(server)?.get(tool);
  }

  /** True only when the host affirmatively reported the tool read-only. */
  isReadOnly(server: string, tool: string): boolean {
    return this.fact(server, tool)?.readOnly === true;
  }

  eligibility(server: string, tool: string): EligibilityDecision {
    const fact = this.fact(server, tool);
    if (!fact) return { eligible: false, reason: 'unknown' };
    if (!fact.readOnly) return { eligible: false, reason: 'not-read-only' };
    if (!fact.servable) return { eligible: false, reason: 'not-servable' };
    const suspension = this.suspended.get(suspensionKey(server, tool));
    if (suspension) return { eligible: false, reason: `suspended:${suspension}` };
    if (this.hooked(server, tool)) return { eligible: false, reason: 'tool-hooks' };
    return { eligible: true, reason: 'read-only' };
  }

  /** Whether a real call with exactly these argument keys has been seen. */
  hasShape(server: string, tool: string, keys: readonly string[]): boolean {
    const shape = [...keys].sort().join(',');
    return this.fact(server, tool)?.shapes.includes(shape) === true;
  }

  servers(): string[] {
    return [...this.facts.keys()];
  }

  tools(server: string): string[] {
    return [...(this.facts.get(server)?.keys() ?? [])];
  }

  /**
   * Tools that settings hooks (PreToolUse/PostToolUse) watch. Serving a
   * prefetched result answers the call above those hooks, so a watched tool
   * is never speculated: the hooks keep seeing every call they were written
   * to see.
   */
  setHooked(predicate: (server: string, tool: string) => boolean): void {
    this.hooked = predicate;
  }

  suspend(server: string, tool: string, reason: string): void {
    this.suspended.set(suspensionKey(server, tool), reason);
  }

  resetSuspension(server: string, tool: string): void {
    this.suspended.delete(suspensionKey(server, tool));
  }

  isSuspended(server: string, tool: string): boolean {
    return this.suspended.has(suspensionKey(server, tool));
  }

  exportState(): ToolFacts {
    const out: ToolFacts = {};
    for (const [server, byTool] of this.facts) {
      out[server] = Object.fromEntries([...byTool].map(([tool, fact]) => [tool, { ...fact, shapes: [...fact.shapes] }]));
    }
    return out;
  }

  importState(raw: unknown): void {
    const facts = new Map<string, Map<string, ToolFact>>();
    for (const [server, byTool] of Object.entries(validFacts(raw))) {
      facts.set(server, new Map(Object.entries(byTool)));
    }
    this.facts = facts;
    this.mutations++;
  }
}

function suspensionKey(server: string, tool: string): string {
  return `${server}\0${tool}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validFact(value: unknown): ToolFact | null {
  if (!isRecord(value)) return null;
  const { readOnly, servable, shapes, lastSeen } = value;
  if (typeof readOnly !== 'boolean' || typeof servable !== 'boolean') return null;
  if (typeof lastSeen !== 'number' || !Number.isFinite(lastSeen) || lastSeen < 0) return null;
  if (!Array.isArray(shapes)) return null;
  const clean = shapes
    .filter((shape): shape is string => typeof shape === 'string' && shape.length <= MAX_LABEL * 4)
    .slice(0, MAX_SHAPES);
  return { readOnly, servable, shapes: clean, lastSeen };
}

function validFacts(raw: unknown): ToolFacts {
  const out: ToolFacts = {};
  if (!isRecord(raw)) return out;
  let count = 0;
  for (const [server, byTool] of Object.entries(raw)) {
    if (server.length === 0 || server.length > MAX_LABEL || !isRecord(byTool)) continue;
    for (const [tool, value] of Object.entries(byTool)) {
      if (tool.length === 0 || tool.length > MAX_LABEL || count >= MAX_TOOLS) continue;
      const fact = validFact(value);
      if (!fact) continue;
      (out[server] ??= {})[tool] = fact;
      count++;
    }
  }
  return out;
}

/** Drops malformed, expired, and credential-shaped entries before storage. */
export function sanitizeToolFacts(
  raw: unknown,
  cutoff: number,
  guard: SecretGuard,
): { value: ToolFacts; removedSensitive: number; removedExpired: number } {
  const value: ToolFacts = {};
  let removedSensitive = 0;
  let removedExpired = 0;
  for (const [server, byTool] of Object.entries(validFacts(raw))) {
    if (guard.isSensitive(server)) {
      removedSensitive += Object.keys(byTool).length;
      continue;
    }
    for (const [tool, fact] of Object.entries(byTool)) {
      if (fact.lastSeen < cutoff) {
        removedExpired++;
        continue;
      }
      if (guard.isSensitive(tool)) {
        removedSensitive++;
        continue;
      }
      const shapes = fact.shapes.filter((shape) => !guard.isSensitive(shape));
      removedSensitive += fact.shapes.length - shapes.length;
      (value[server] ??= {})[tool] = { ...fact, shapes };
    }
  }
  return { value, removedSensitive, removedExpired };
}

/** Per tool, the most recently observed verdict wins; shapes are unioned. */
export function mergeToolFacts(a: ToolFacts | undefined, b: ToolFacts | undefined): ToolFacts {
  const out: ToolFacts = {};
  for (const source of [validFacts(a), validFacts(b)]) {
    for (const [server, byTool] of Object.entries(source)) {
      for (const [tool, fact] of Object.entries(byTool)) {
        const prior = out[server]?.[tool];
        if (!prior) {
          (out[server] ??= {})[tool] = { ...fact, shapes: [...fact.shapes] };
          continue;
        }
        const [newer, older] = fact.lastSeen >= prior.lastSeen ? [fact, prior] : [prior, fact];
        out[server]![tool] = {
          ...newer,
          shapes: [...new Set([...newer.shapes, ...older.shapes])].slice(0, MAX_SHAPES),
        };
      }
    }
  }
  return out;
}
