/**
 * Registry of vetted server profiles (DESIGN.md §4), keyed by built-in
 * profile name as referenced from `ServerConfig.profile`.
 */
import type { ArgsCanonicalizer, ResultParser, ServerProfile } from '../types.js';
import { filesystemProfile } from './filesystem.js';
import { githubProfile } from './github.js';
import { shellProfile } from './shell.js';
import { slackProfile } from './slack.js';

export const builtinProfiles: Record<string, ServerProfile> = {
  github: githubProfile,
  shell: shellProfile,
  filesystem: filesystemProfile,
  slack: slackProfile,
};

/**
 * Prototype-safe per-tool profile accessors. Profile records are indexed by
 * upstream-controlled tool names, so a tool named `constructor` or
 * `hasOwnProperty` must resolve to "no entry", never to Object.prototype
 * members (the predictor was hardened this way; every consumer must be).
 */
export function profileCanonicalizer(
  profile: ServerProfile | undefined,
  tool: string,
): ArgsCanonicalizer | undefined {
  if (!profile || !Object.hasOwn(profile.canonicalizers, tool)) return undefined;
  return profile.canonicalizers[tool];
}

export function profileParser(
  profile: ServerProfile | undefined,
  tool: string,
): ResultParser | undefined {
  if (!profile || !Object.hasOwn(profile.parsers, tool)) return undefined;
  return profile.parsers[tool];
}

/**
 * §13.11 fingerprinting: score builtin profiles against a live tool list.
 * A server is recognized when most of a profile's vetted read-only tools
 * are present. Returns the best profile at or above the threshold.
 */
export function detectProfile(
  toolNames: string[],
  threshold = 0.6,
): { profile: ServerProfile; score: number } | null {
  const names = new Set(toolNames);
  let best: ServerProfile | null = null;
  let bestScore = 0;
  for (const profile of Object.values(builtinProfiles)) {
    const list = profile.readOnlyAllowlist;
    if (list.length === 0) continue;
    const score = list.filter((t) => names.has(t)).length / list.length;
    if (score > bestScore) {
      bestScore = score;
      best = profile;
    }
  }
  return best && bestScore >= threshold ? { profile: best, score: bestScore } : null;
}

export function profileTtlMs(
  profile: ServerProfile | undefined,
  tool: string,
): number | undefined {
  if (!profile || !Object.hasOwn(profile.ttlMsByTool, tool)) return undefined;
  return profile.ttlMsByTool[tool];
}
