import { sessionObserverHookPath } from '../packageResources.js';
const hookEvents = [
    'SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse',
    'PostToolUseFailure', 'SubagentStart', 'SubagentStop', 'Stop', 'SessionEnd',
];
export function observerHookCommand() {
    const quote = (value) => `'${value.replace(/'/g, `'\\''`)}'`;
    return `${quote(process.execPath)} ${quote(sessionObserverHookPath())}`;
}
export function mergeObserverHooks(existing, handler) {
    if (existing !== undefined && (existing === null || typeof existing !== 'object' || Array.isArray(existing)))
        return null;
    const hooks = structuredClone(existing ?? {});
    for (const event of hookEvents) {
        const current = hooks[event];
        if (current !== undefined && !Array.isArray(current))
            return null;
        hooks[event] = [...(current ?? []), { hooks: [handler] }];
    }
    return hooks;
}
export function observerEnvironment(existing, coordinates, agent) {
    return {
        ...existing,
        SPECULATE_OBSERVER_SOCKET: coordinates.socketPath,
        SPECULATE_OBSERVER_CAPABILITY: coordinates.capability,
        SPECULATE_OBSERVER_LAUNCH_ID: coordinates.launchId,
        SPECULATE_OBSERVER_CLIENT: agent,
    };
}
