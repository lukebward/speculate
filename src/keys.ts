/**
 * Canonical cache keying (DESIGN.md §6.1).
 */
import type { ArgsCanonicalizer, CacheKey } from './types.js';

/** Stable stringify: objects get sorted keys at every depth. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

export function canonicalKey(
  server: string,
  tool: string,
  args: Record<string, unknown>,
  canonicalizer?: ArgsCanonicalizer,
): CacheKey {
  const canonical = canonicalizer ? canonicalizer(args) : args;
  return `${server} ${tool} ${stableStringify(canonical)}`;
}

export function keyServer(key: CacheKey): string {
  return key.split(' ', 1)[0]!;
}

export function keyTool(key: CacheKey): string {
  return key.split(' ', 3)[1] ?? '';
}

/**
 * Recover the canonical args object from a key. Null when unparseable.
 * Callers on hot paths should call this once per key and reuse the result
 * (see SpeculationCache near-miss telemetry).
 */
export function parseKeyArgs(key: CacheKey): Record<string, unknown> | null {
  // Key layout: "<server> <tool> <json>"; server/tool never contain spaces,
  // but the JSON may (string values), so split at the first two spaces only.
  const first = key.indexOf(' ');
  const second = first === -1 ? -1 : key.indexOf(' ', first + 1);
  if (second === -1) return null;
  try {
    const parsed = JSON.parse(key.slice(second + 1));
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * Near-miss telemetry (§6.1, §9): number of top-level argument entries that
 * differ between two already-parsed canonical arg objects (symmetric
 * difference of key/value pairs).
 */
export function argsDistance(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
): number {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  let d = 0;
  for (const k of keys) {
    if (stableStringify(a[k]) !== stableStringify(b[k])) d++;
  }
  return d;
}
