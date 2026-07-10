/**
 * Registry of vetted server profiles (DESIGN.md §4), keyed by built-in
 * profile name as referenced from `ServerConfig.profile`.
 */
import type { ArgsCanonicalizer, ResultParser, ServerProfile } from '../types.js';
import { githubProfile } from './github.js';

export const builtinProfiles: Record<string, ServerProfile> = {
  github: githubProfile,
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

export function profileTtlMs(
  profile: ServerProfile | undefined,
  tool: string,
): number | undefined {
  if (!profile || !Object.hasOwn(profile.ttlMsByTool, tool)) return undefined;
  return profile.ttlMsByTool[tool];
}
