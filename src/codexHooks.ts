/** Persistent Codex SessionStart sync, using Codex's documented hook sources. */
import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { CodexConfigRead, CodexConfigWrite, CodexConfigWriteResult } from './codexClient.js';

const MARKER = 'speculate-codex-auto-sync-v1';
const STATUS_MESSAGE = 'Speculate: sync MCP servers';
const MAX_HOOK_BYTES = 8 * 1024 * 1024;
type ObjectValue = Record<string, unknown>;
export interface CodexHookClient {
  codexHome: string;
  bin: string;
  readConfig(cwd: string | null): Promise<CodexConfigRead>;
  writeConfig(params: CodexConfigWrite): Promise<CodexConfigWriteResult>;
}
export interface CodexHookOptions {
  client: CodexHookClient;
  cwd: string;
  self: { command: string; args: string[] };
}
export class CodexHookError extends Error {}

function object(value: unknown): value is ObjectValue {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function quotePosix(value: string): string { return `'${value.replace(/'/g, `'\\''`)}'`; }
function quotePowerShell(value: string): string { return `'${value.replace(/'/g, "''")}'`; }

export function codexSessionHook(options: CodexHookOptions): ObjectValue {
  const payload = Buffer.from(JSON.stringify({ self: options.self, codexHome: options.client.codexHome,
    codexBin: options.client.bin })).toString('base64');
  // Keep the hook harmless after an npm uninstall and independent of GUI PATH.
  // Hook stdin is session metadata; it is deliberately not passed to the CLI.
  const script = `/* ${MARKER} */const {spawnSync}=require('node:child_process');` +
    `const p=JSON.parse(Buffer.from('${payload}','base64').toString());` +
    `spawnSync(p.self.command,[...p.self.args,'sync','--client','codex','--quiet','--codex-bin',p.codexBin],` +
    `{env:{...process.env,CODEX_HOME:p.codexHome},stdio:'ignore',timeout:45000,windowsHide:true});`;
  const powerShell = `& ${quotePowerShell(options.self.command)} '-e' ${quotePowerShell(script)}`;
  return {
    type: 'command',
    command: [options.self.command, '-e', script].map(quotePosix).join(' '),
    // The outer command works from either cmd.exe or PowerShell. The encoded
    // inner invocation keeps spaces, quotes, and shell metacharacters literal.
    commandWindows: `powershell.exe -NoProfile -NonInteractive -EncodedCommand ${Buffer.from(powerShell, 'utf16le').toString('base64')}`,
    async: true,
    timeout: 50,
    statusMessage: STATUS_MESSAGE,
  };
}

function owned(value: unknown): boolean {
  return object(value) && value.type === 'command' && value.statusMessage === STATUS_MESSAGE &&
    typeof value.command === 'string' && value.command.includes(`/* ${MARKER} */`);
}
function eventGroups(hooks: ObjectValue): unknown[] {
  if (hooks.SessionStart === undefined) return [];
  if (!Array.isArray(hooks.SessionStart)) throw new CodexHookError('Codex SessionStart hooks have an unsupported shape; existing hooks were kept.');
  return hooks.SessionStart;
}
function containsOwned(hooks: ObjectValue): boolean {
  return eventGroups(hooks).some((group) => object(group) && Array.isArray(group.hooks) && group.hooks.some(owned));
}
function updatedGroups(hooks: ObjectValue, handler: ObjectValue | null): unknown[] {
  const groups = eventGroups(hooks);
  if (handler && groups.some((group) => object(group) && group.matcher === 'startup|resume|clear|compact' &&
    Array.isArray(group.hooks) && group.hooks.some((hook) => isDeepStrictEqual(hook, handler))) &&
    groups.flatMap((group) => object(group) && Array.isArray(group.hooks) ? group.hooks : []).filter(owned).length === 1) {
    return groups;
  }
  const next: unknown[] = [];
  for (const group of groups) {
    if (!object(group) || !Array.isArray(group.hooks)) throw new CodexHookError('Codex SessionStart hooks have an unsupported shape; existing hooks were kept.');
    const remaining = group.hooks.filter((hook) => !owned(hook));
    if (remaining.length === group.hooks.length) next.push(group);
    else if (remaining.length) next.push({ ...group, hooks: remaining });
  }
  if (handler) next.push({ matcher: 'startup|resume|clear|compact', hooks: [handler] });
  return next;
}

function readJson(path: string): { original: string | null; document: ObjectValue; hooks: ObjectValue } {
  try {
    if (lstatSync(path).isSymbolicLink()) throw new CodexHookError('Automatic Codex sync is unavailable because hooks.json is a symlink; the existing hook file was kept.');
  } catch (error) {
    if (error instanceof CodexHookError) throw error;
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new CodexHookError('Codex hooks.json could not be inspected safely; existing hooks were kept.');
  }
  if (!existsSync(path)) return { original: null, document: {}, hooks: {} };
  try {
    if (statSync(path).size > MAX_HOOK_BYTES) throw new Error();
    const original = readFileSync(path, 'utf8');
    const document: unknown = JSON.parse(original);
    if (!object(document) || (document.hooks !== undefined && !object(document.hooks))) throw new Error();
    return { original, document, hooks: (document.hooks as ObjectValue | undefined) ?? {} };
  } catch { throw new CodexHookError('Codex hooks.json could not be read safely; existing hooks were kept.'); }
}
function writeJson(path: string, snapshot: ReturnType<typeof readJson>, groups: unknown[]): void {
  const hooks = { ...snapshot.hooks };
  if (groups.length) hooks.SessionStart = groups; else delete hooks.SessionStart;
  const document = { ...snapshot.document };
  if (Object.keys(hooks).length) document.hooks = hooks; else delete document.hooks;
  const serialized = `${JSON.stringify(document, null, 2)}\n`;
  if (Buffer.byteLength(serialized) > MAX_HOOK_BYTES) throw new CodexHookError('Codex hook configuration would exceed 8 MiB; existing hooks were kept.');
  if ((existsSync(path) ? readFileSync(path, 'utf8') : null) !== snapshot.original) {
    throw new CodexHookError('Codex hooks changed during setup; retry to preserve the latest hooks.');
  }
  if (!Object.keys(document).length) { if (existsSync(path)) unlinkSync(path); return; }
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, serialized, { flag: 'wx', mode: 0o600 });
    renameSync(temporary, path);
  } finally { if (existsSync(temporary)) unlinkSync(temporary); }
}

async function inlineSource(options: CodexHookOptions) {
  const view = await options.client.readConfig(options.cwd);
  const user = view.layers.find((layer) => layer.name.type === 'user' && !layer.name.profile && !layer.disabledReason && typeof layer.name.file === 'string');
  if (!user?.name.file) throw new CodexHookError('Codex did not provide a writable hook configuration layer.');
  if (user.config.hooks !== undefined && !object(user.config.hooks)) throw new CodexHookError('Codex inline hooks have an unsupported shape; existing hooks were kept.');
  return { view, user, hooks: (user.config.hooks as ObjectValue | undefined) ?? {} };
}

/** Install one handler without replacing other handlers or approving hook trust. */
export async function installCodexSessionHook(options: CodexHookOptions): Promise<{ changed: boolean; source: string }> {
  const path = join(options.client.codexHome, 'hooks.json');
  const json = readJson(path);
  const inline = await inlineSource(options);
  const features = inline.view.config.features;
  if (object(features) && (features.hooks === false || features.codex_hooks === false)) {
    throw new CodexHookError('Automatic Codex sync is unavailable because Codex hooks are disabled. Enable hooks in Codex before retrying setup.');
  }
  if (inline.view.config.allow_managed_hooks_only === true) {
    throw new CodexHookError('Automatic Codex sync is unavailable because Codex policy allows only managed hooks.');
  }
  const handler = codexSessionHook(options);
  // Keep an existing source, including user-authored JSON metadata. Prefer an
  // existing inline table when no hooks.json exists to avoid Codex's duplicate-source warning.
  const useInline = !containsOwned(json.hooks) && (containsOwned(inline.hooks) ||
    (json.original === null && Object.hasOwn(inline.user.config, 'hooks')));
  const current = useInline ? inline.hooks : json.hooks;
  const next = updatedGroups(current, handler);
  let consolidated = false;
  if (!useInline && containsOwned(inline.hooks)) {
    const remaining = updatedGroups(inline.hooks, null);
    await options.client.writeConfig({ filePath: inline.user.name.file!, expectedVersion: inline.user.version,
      edits: [{ keyPath: 'hooks.SessionStart', value: remaining.length ? remaining : null, mergeStrategy: 'replace' }] });
    consolidated = true;
  }
  if (isDeepStrictEqual(eventGroups(current), next)) return { changed: consolidated, source: useInline ? inline.user.name.file! : path };
  if (useInline) {
    await options.client.writeConfig({ filePath: inline.user.name.file!, expectedVersion: inline.user.version,
      edits: [{ keyPath: 'hooks.SessionStart', value: next, mergeStrategy: 'replace' }] });
  } else {
    mkdirSync(options.client.codexHome, { recursive: true, mode: 0o700 });
    writeJson(path, json, next);
  }
  return { changed: true, source: useInline ? inline.user.name.file! : path };
}

/** Remove only our handlers, including duplicates; leave all unrelated data. */
export async function removeCodexSessionHook(options: CodexHookOptions): Promise<boolean> {
  const path = join(options.client.codexHome, 'hooks.json');
  const json = readJson(path);
  const inline = await inlineSource(options);
  let changed = false;
  if (containsOwned(json.hooks)) { writeJson(path, json, updatedGroups(json.hooks, null)); changed = true; }
  if (containsOwned(inline.hooks)) {
    const next = updatedGroups(inline.hooks, null);
    await options.client.writeConfig({ filePath: inline.user.name.file!, expectedVersion: inline.user.version,
      edits: [{ keyPath: 'hooks.SessionStart', value: next.length ? next : null, mergeStrategy: 'replace' }] });
    changed = true;
  }
  return changed;
}

export async function codexSessionHookInstalled(options: CodexHookOptions): Promise<boolean> {
  const json = readJson(join(options.client.codexHome, 'hooks.json'));
  const inline = await inlineSource(options);
  return containsOwned(json.hooks) || containsOwned(inline.hooks);
}
