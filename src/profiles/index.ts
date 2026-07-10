/**
 * Registry of vetted server profiles (DESIGN.md §4), keyed by built-in
 * profile name as referenced from `ServerConfig.profile`.
 */
import type { ServerProfile } from '../types.js';
import { githubProfile } from './github.js';

export const builtinProfiles: Record<string, ServerProfile> = {
  github: githubProfile,
};
