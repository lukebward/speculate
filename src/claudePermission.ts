import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { projectRoot } from './hostConfig.js';
import type { HostPermissionDecision } from './observerTypes.js';

const MAX_SOURCE_BYTES = 8 * 1024 * 1024;

export interface ClaudePermissionInput {
  cwd: string;
  home?: string;
  env: NodeJS.ProcessEnv;
  clientArgs: readonly string[];
  observerCommand: string;
}

export interface ClaudePermissionResult {
  decision: HostPermissionDecision;
  permissionContext: string | null;
  policyFingerprint?: string | null;
  reason?: string;
}

interface SettingsSource {
  value: Record<string, unknown>;
  grantsAllowed: boolean;
  digest: string;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readObject(path: string): SettingsSource | null | 'invalid' {
  try {
    const stat = statSync(path);
    if (!stat.isFile() || stat.size > MAX_SOURCE_BYTES) return 'invalid';
    const raw = readFileSync(path, 'utf8');
    const value = JSON.parse(raw) as unknown;
    if (!record(value)) return 'invalid';
    return { value, grantsAllowed: true, digest: createHash('sha256').update(raw).digest('hex') };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === 'ENOENT' || code === 'ENOTDIR' ? null : 'invalid';
  }
}

function macManagedSource(): SettingsSource | null | 'invalid' {
  if (process.platform !== 'darwin') return null;
  const domains = spawnSync('/usr/bin/defaults', ['domains'], { encoding: 'utf8', timeout: 1_000, maxBuffer: MAX_SOURCE_BYTES });
  if (domains.status !== 0) return 'invalid';
  if (!domains.stdout.split(',').map((item) => item.trim()).includes('com.anthropic.claudecode')) return null;
  const exported = spawnSync('/usr/bin/defaults', ['export', 'com.anthropic.claudecode', '-'], {
    encoding: 'buffer', timeout: 1_000, maxBuffer: MAX_SOURCE_BYTES,
  });
  if (exported.status !== 0 || !exported.stdout || exported.stdout.byteLength > MAX_SOURCE_BYTES) return 'invalid';
  const converted = spawnSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '-'], {
    input: exported.stdout, encoding: 'utf8', timeout: 1_000, maxBuffer: MAX_SOURCE_BYTES,
  });
  if (converted.status !== 0) return 'invalid';
  try {
    const outer = JSON.parse(converted.stdout) as unknown;
    if (!record(outer)) return 'invalid';
    const raw = outer.Settings;
    const value = typeof raw === 'string' ? JSON.parse(raw) as unknown : record(raw) ? raw : outer;
    if (!record(value)) return 'invalid';
    return { value, grantsAllowed: true, digest: createHash('sha256').update(exported.stdout).digest('hex') };
  } catch { return 'invalid'; }
}

function trustAccepted(home: string, env: NodeJS.ProcessEnv, cwd: string): boolean {
  const configDir = env.CLAUDE_CONFIG_DIR || join(home, '.claude');
  const state = readObject(resolve(configDir, '.claude.json')) ?? readObject(resolve(home, '.claude.json'));
  if (!state || state === 'invalid' || !record(state.value.projects)) return false;
  const root = resolve(projectRoot(cwd));
  for (const [key, value] of Object.entries(state.value.projects)) {
    if (resolve(key) === root && record(value)) return value.hasTrustDialogAccepted === true;
  }
  return false;
}

function values(value: unknown): string[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) return null;
  return value as string[];
}

function globMatches(pattern: string, canonical: string): boolean | null {
  if (pattern.includes('(') || pattern.includes(')')) return pattern.startsWith('mcp__') ? null : false;
  if (!pattern.startsWith('mcp__')) return false;
  if (!/^[A-Za-z0-9_.*:-]+$/.test(pattern)) return null;
  const expression = `^${pattern.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`;
  return new RegExp(expression).test(canonical);
}

function cliSettings(args: readonly string[], cwd: string): { source: SettingsSource | null; error?: string } {
  const valuesByFlag = new Map<string, string[]>();
  const policyFlags = new Set([
    '--setting-sources', '--permission-mode', '--bare', '--safe-mode', '--restricted', '--strict-mcp-config',
    '--disallowedTools', '--disallowed-tools',
  ]);
  let settings: SettingsSource | null = null;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === '--') break;
    const split = ['--allowedTools', '--allowed-tools', '--disallowedTools', '--disallowed-tools', '--settings',
      '--setting-sources', '--permission-mode'].find((flag) => arg === flag);
    const equal = ['--allowedTools=', '--allowed-tools=', '--disallowedTools=', '--disallowed-tools=', '--settings=',
      '--setting-sources=', '--permission-mode='].find((flag) => arg.startsWith(flag));
    if (split || equal) {
      const flag = (split ?? equal!.slice(0, -1));
      const value = split ? args[++index] : arg.slice(equal!.length);
      if (!value) return { source: null, error: 'unsupported-cli-policy' };
      const list = valuesByFlag.get(flag) ?? [];
      list.push(value);
      valuesByFlag.set(flag, list);
      continue;
    }
    if (policyFlags.has(arg)) return { source: null, error: 'unsupported-cli-policy' };
  }
  if ([...valuesByFlag.entries()].some(([, entries]) => entries.length > 1)) {
    return { source: null, error: 'ambiguous-cli-policy' };
  }
  if ((valuesByFlag.has('--allowedTools') && valuesByFlag.has('--allowed-tools')) ||
    (valuesByFlag.has('--disallowedTools') && valuesByFlag.has('--disallowed-tools'))) {
    return { source: null, error: 'ambiguous-cli-policy' };
  }
  if ([...valuesByFlag.keys()].some((flag) => policyFlags.has(flag))) {
    return { source: null, error: 'unsupported-cli-policy' };
  }
  const rawSettings = valuesByFlag.get('--settings')?.[0];
  if (rawSettings) {
    try {
      const inline: unknown | SettingsSource | null | 'invalid' = rawSettings.trim().startsWith('{')
        ? JSON.parse(rawSettings) as unknown
        : readObject(resolve(cwd, rawSettings));
      const inlineValue = record(inline) && 'value' in inline ? (inline as unknown as SettingsSource).value : inline;
      if (inline === 'invalid' || inline === null || !record(inlineValue)) {
        return { source: null, error: 'invalid-cli-settings' };
      }
      settings = record(inline) && 'value' in inline
        ? inline as unknown as SettingsSource
        : { value: inlineValue, grantsAllowed: true,
          digest: createHash('sha256').update(rawSettings).digest('hex') };
    } catch {
      return { source: null, error: 'invalid-cli-settings' };
    }
  }
  const allow = valuesByFlag.get('--allowedTools')?.[0] ?? valuesByFlag.get('--allowed-tools')?.[0];
  if (allow) {
    const value = settings?.value ?? {};
    const permissions = record(value.permissions) ? value.permissions : {};
    permissions.allow = [...(Array.isArray(permissions.allow) ? permissions.allow : []), ...allow.split(',').map((item) => item.trim())];
    value.permissions = permissions;
    settings = { value, grantsAllowed: true, digest: createHash('sha256').update(stableValue(value)).digest('hex') };
  }
  return { source: settings };
}

function relevantBlockingHook(settings: Record<string, unknown>, canonical: string, observerCommand: string): boolean | null {
  if (!record(settings.hooks)) return settings.hooks === undefined ? false : null;
  const groups = settings.hooks.PreToolUse;
  if (groups === undefined) return false;
  if (!Array.isArray(groups)) return null;
  for (const group of groups) {
    if (!record(group) || !Array.isArray(group.hooks)) return null;
    const matcher = group.matcher;
    let matches = true;
    if (matcher !== undefined) {
      if (typeof matcher !== 'string') return null;
      if (matcher === canonical) matches = true;
      else if (/^[A-Za-z0-9_:-]+$/.test(matcher)) matches = false;
      else {
        const result = globMatches(matcher, canonical);
        if (result !== true) return null;
        matches = true;
      }
    }
    if (!matches) continue;
    for (const hook of group.hooks) {
      if (!record(hook) || hook.type !== 'command' || typeof hook.command !== 'string') return null;
      if (hook.command !== observerCommand) return true;
    }
  }
  return false;
}

interface ClaudePermissionState {
  sources: Array<SettingsSource & { managed: boolean }>;
  managedOnly: boolean;
}

function readClaudePermissionState(input: ClaudePermissionInput): ClaudePermissionState | ClaudePermissionResult {
  const home = input.home ?? homedir();
  const root = projectRoot(input.cwd);
  const configDir = input.env.CLAUDE_CONFIG_DIR || join(home, '.claude');
  const managedPath = process.platform === 'darwin'
    ? '/Library/Application Support/ClaudeCode/managed-settings.json'
    : process.platform === 'win32'
      ? 'C:\\Program Files\\ClaudeCode\\managed-settings.json'
      : '/etc/claude-code/managed-settings.json';
  const alternateProvider = ['CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY']
    .some((key) => input.env[key] === '1' || input.env[key] === 'true');
  let managed: SettingsSource | null | 'invalid' = alternateProvider ? null : readObject(join(configDir, 'remote-settings.json'));
  if (managed === null && process.platform === 'win32') {
    return { decision: 'unverifiable', permissionContext: null, reason: 'unsupported-managed-policy-source' };
  }
  if (managed === null) managed = macManagedSource();
  if (managed === null) {
    try {
      if (readdirSync(join(resolve(managedPath, '..'), 'managed-settings.d')).some((name) => name.endsWith('.json'))) {
        managed = 'invalid';
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') managed = 'invalid';
    }
  }
  if (managed === null) managed = readObject(managedPath);
  if (managed === 'invalid') return { decision: 'unverifiable', permissionContext: null, reason: 'unreadable-policy-source' };
  const paths = [
    { path: join(configDir, 'settings.json'), grantsAllowed: true, managed: false },
    { path: join(root, '.claude', 'settings.json'), grantsAllowed: trustAccepted(home, input.env, input.cwd), managed: false },
    { path: join(root, '.claude', 'settings.local.json'), grantsAllowed: trustAccepted(home, input.env, input.cwd), managed: false },
  ];
  const sources: Array<SettingsSource & { managed: boolean }> = [];
  if (managed) sources.push({ ...managed, managed: true });
  for (const item of paths) {
    const source = readObject(item.path);
    if (source === 'invalid') return { decision: 'unverifiable', permissionContext: null, reason: 'unreadable-policy-source' };
    if (source) sources.push({ ...source, grantsAllowed: item.grantsAllowed, managed: item.managed });
  }
  const cli = cliSettings(input.clientArgs, input.cwd);
  if (cli.error) return { decision: 'unverifiable', permissionContext: null, reason: cli.error };
  if (cli.source) sources.push({ ...cli.source, managed: false });
  const managedOnly = sources.some((source) => source.managed && source.value.allowManagedPermissionRulesOnly === true);
  return { sources, managedOnly };
}

function evaluateClaudePermission(
  input: ClaudePermissionInput,
  target: { alias: string; tool: string },
  state: ClaudePermissionState,
): ClaudePermissionResult {
  const { sources, managedOnly } = state;
  const canonical = `mcp__${target.alias}__${target.tool}`;
  let exactAllow = false;
  for (const source of sources) {
    const permissions = source.value.permissions;
    if (permissions !== undefined && !record(permissions)) {
      return { decision: 'unverifiable', permissionContext: null, reason: 'invalid-permission-shape' };
    }
    const allow = values(record(permissions) ? permissions.allow : undefined);
    const deny = values(record(permissions) ? permissions.deny : undefined);
    const ask = values(record(permissions) ? permissions.ask : undefined);
    if (!allow || !deny || !ask) return { decision: 'unverifiable', permissionContext: null, reason: 'invalid-permission-rule' };
    for (const rule of [...deny, ...ask]) {
      const match = globMatches(rule, canonical);
      if (match === null) return { decision: 'unverifiable', permissionContext: null, reason: 'unsupported-permission-rule' };
      if (match) return { decision: deny.includes(rule) ? 'denied' : 'approval-required', permissionContext: null };
    }
    if ((!managedOnly || source.managed) && source.grantsAllowed && allow.includes(canonical)) exactAllow = true;
    const hook = relevantBlockingHook(source.value, canonical, input.observerCommand);
    if (hook === null) return { decision: 'unverifiable', permissionContext: null, reason: 'unsupported-hook-policy' };
    if (hook) return { decision: 'unverifiable', permissionContext: null, reason: 'blocking-hook' };
  }
  if (!exactAllow) return { decision: 'unverifiable', permissionContext: null, reason: 'no-exact-allow' };
  const permissionContext = createHash('sha256').update(JSON.stringify({
    cwd: resolve(input.cwd), args: input.clientArgs, sources: sources.map((source) => source.digest), canonical,
  })).digest('base64url');
  return { decision: 'allowed', permissionContext };
}

export function verifyClaudeMcpPreauthorization(
  input: ClaudePermissionInput,
  target: { alias: string; tool: string; requiresUserInteraction?: boolean },
): ClaudePermissionResult {
  const state = readClaudePermissionState(input);
  if ('decision' in state) return { ...state, policyFingerprint: null };
  const policyFingerprint = createHash('sha256').update(JSON.stringify({
    cwd: resolve(input.cwd),
    args: input.clientArgs,
    sources: state.sources.map((source) => ({
      digest: source.digest,
      grantsAllowed: source.grantsAllowed,
      managed: source.managed,
    })),
    managedOnly: state.managedOnly,
  })).digest('base64url');
  if (target.requiresUserInteraction) {
    return { decision: 'denied', permissionContext: null, policyFingerprint, reason: 'user-interaction' };
  }
  return { ...evaluateClaudePermission(input, target, state), policyFingerprint };
}

export function projectClaudeMcpPolicy(
  input: ClaudePermissionInput,
  alias: string,
): { enabled: boolean; allowTools: string[]; denyTools: string[] } {
  const state = readClaudePermissionState(input);
  if ('decision' in state) throw new Error(state.reason ?? 'Claude launch policy could not be verified');
  const prefix = `mcp__${alias}__`;
  const candidates = new Set<string>();
  for (const source of state.sources) {
    const permissions = source.value.permissions;
    if (permissions !== undefined && !record(permissions)) throw new Error('Claude launch policy could not be verified');
    const allow = values(record(permissions) ? permissions.allow : undefined);
    if (!allow) throw new Error('Claude launch policy could not be verified');
    for (const rule of allow) {
      if (!rule.startsWith(prefix) || rule.includes('*') || rule.includes('(') || rule.includes(')')) continue;
      const tool = rule.slice(prefix.length);
      if (tool && tool.length <= 512) candidates.add(tool);
    }
  }
  const allowTools = [...candidates].filter((tool) =>
    evaluateClaudePermission(input, { alias, tool }, state).decision === 'allowed');
  return { enabled: true, allowTools, denyTools: [] };
}

function stableValue(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableValue).join(',')}]`;
  if (record(value)) return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableValue(item)}`).join(',')}}`;
  return JSON.stringify(value);
}
