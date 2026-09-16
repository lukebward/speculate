import { sessionObserverHookPath } from '../packageResources.js';
import type { AgentKind, SessionLaunchCoordinates } from '../observerTypes.js';

const hookEvents = [
  'SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse',
  'PostToolUseFailure', 'SubagentStart', 'SubagentStop', 'Stop', 'SessionEnd',
] as const;

export function observerHookCommand(): string {
  const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
  return `${quote(process.execPath)} ${quote(sessionObserverHookPath())}`;
}

export function mergeObserverHooks(
  existing: unknown,
  handler: Readonly<Record<string, unknown>>,
): Record<string, unknown> | null {
  if (existing !== undefined && (existing === null || typeof existing !== 'object' || Array.isArray(existing))) return null;
  const hooks = structuredClone(existing ?? {}) as Record<string, unknown>;
  for (const event of hookEvents) {
    const current = hooks[event];
    if (current !== undefined && !Array.isArray(current)) return null;
    hooks[event] = [...((current as unknown[] | undefined) ?? []), { hooks: [handler] }];
  }
  return hooks;
}

export function observerEnvironment(
  existing: NodeJS.ProcessEnv,
  coordinates: SessionLaunchCoordinates,
  agent: AgentKind,
): NodeJS.ProcessEnv {
  return {
    ...existing,
    SPECULATE_OBSERVER_SOCKET: coordinates.socketPath,
    SPECULATE_OBSERVER_CAPABILITY: coordinates.capability,
    SPECULATE_OBSERVER_LAUNCH_ID: coordinates.launchId,
    SPECULATE_OBSERVER_CLIENT: agent,
  };
}
