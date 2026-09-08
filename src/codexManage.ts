/** Native Codex setup through its versioned configuration API. */
import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync,
  renameSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import {
  CodexClientError, startCodexClient, type CodexClient, type CodexConfigEdit,
  type CodexConfigLayer, type CodexConfigRead,
} from './codexClient.js';
import { HOST_HEADER_NAME, isWrappedEntry } from './hostConfig.js';
import { managedStatePath } from './manage.js';
import { probeRemote, type RemoteProber } from './remoteProbe.js';
import { oauthStorePath, readOAuthRecord } from './oauthStore.js';
import { speculateAuth } from './authCommand.js';
import type { SpeculationMode } from './types.js';

type Entry = Record<string, unknown>;
type Patch = Record<string, unknown>;
type Client = Pick<CodexClient, 'bin' | 'codexHome' | 'readConfig' | 'writeConfig' | 'close'> &
  Partial<Pick<CodexClient, 'listServers'>>;
interface ManagedEntry { before: Patch; after: Patch; previousAfter?: Patch; mode: SpeculationMode }
interface State { version: 1; configFile: string; enabled: boolean; entries: Record<string, ManagedEntry> }
class SetupError extends Error {}
const MAX_RESTORE_BYTES = 8 * 1024 * 1024;

export interface CodexManageOptions {
  self: { command: string; args: string[] };
  mode?: SpeculationMode | null;
  cwd?: string;
  codexBin?: string;
  statePath?: string;
  oauthStorePath?: string;
  log?: (line: string) => void;
  probeRemote?: RemoteProber;
  onNeedsAuth?: (servers: { name: string; url: string }[]) => Promise<boolean>;
  target?: string;
  forget?: boolean;
  /** Isolated clients make transaction and recovery tests independent of a local install. */
  startClient?: () => Promise<Client>;
}

function object(value: unknown): value is Entry {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function servers(config: Entry): Record<string, Entry> {
  if (!object(config.mcp_servers)) return {};
  return Object.fromEntries(Object.entries(config.mcp_servers).filter((pair): pair is [string, Entry] => object(pair[1])));
}
function label(name: string): string { return name.replace(/[\x00-\x1f\x7f]/g, '?'); }
function field(entry: Entry, key: string): unknown { return entry[key] ?? null; }
function matches(entry: Entry, patch: Patch): boolean {
  return Object.entries(patch).every(([key, value]) => isDeepStrictEqual(field(entry, key), value));
}
function matchesWrapped(entry: Entry, saved: ManagedEntry): boolean {
  return matches(entry, saved.after) || (saved.previousAfter !== undefined && matches(entry, saved.previousAfter));
}
function apply(entry: Entry, patch: Patch): Entry {
  const out = { ...entry };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete out[key]; else out[key] = value;
  }
  return out;
}
function edits(name: string, patch: Patch): CodexConfigEdit[] {
  return Object.entries(patch).map(([key, value]) => ({
    keyPath: `mcp_servers.${JSON.stringify(name)}.${JSON.stringify(key)}`,
    value, mergeStrategy: 'replace',
  }));
}

export function codexManagedStatePath(codexHome: string): string {
  const key = createHash('sha256').update(resolve(codexHome)).digest('hex').slice(0, 24);
  return join(dirname(managedStatePath()), 'codex', `${key}.json`);
}
function loadState(path: string, configFile: string): State {
  if (!existsSync(path)) return { version: 1, configFile, enabled: false, entries: {} };
  try {
    if (statSync(path).size > MAX_RESTORE_BYTES) throw new Error();
    const state: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (!object(state) || state.version !== 1 || state.configFile !== configFile ||
        typeof state.enabled !== 'boolean' || !object(state.entries) ||
        !Object.values(state.entries).every((entry) => object(entry) && object(entry.before) &&
          object(entry.after) && (entry.previousAfter === undefined || object(entry.previousAfter)) &&
          ['strict', 'annotated', 'off'].includes(String(entry.mode)))) throw new Error();
    return state as unknown as State;
  } catch {
    throw new SetupError('Codex restore record is invalid; keep it for recovery before changing server registrations.');
  }
}
function saveState(path: string, state: State): void {
  const serialized = JSON.stringify(state, null, 2);
  // Preflight the longest enabled/disabled spelling too: a full record must
  // remain writable when `off` changes true to false before restoring it.
  if (Buffer.byteLength(serialized) + (state.enabled ? 1 : 0) > MAX_RESTORE_BYTES) {
    throw new SetupError('Codex restore record would exceed 8 MiB; current registrations and the previous record were kept.');
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(temporary, 'wx', 0o600);
  try { writeFileSync(fd, serialized); fsyncSync(fd); }
  finally { closeSync(fd); }
  try { renameSync(temporary, path); }
  finally { if (existsSync(temporary)) unlinkSync(temporary); }
}
function lock(path: string): () => void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const lockPath = `${path}.lock`;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(lockPath, String(process.pid), { flag: 'wx', mode: 0o600 });
      return () => { try { unlinkSync(lockPath); } catch { /* Already removed. */ } };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      try {
        const pid = Number(readFileSync(lockPath, 'utf8'));
        if (!Number.isInteger(pid) || pid <= 0) throw new Error('busy');
        try { process.kill(pid, 0); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ESRCH') { unlinkSync(lockPath); continue; }
        }
      } catch { /* An incomplete or unreadable lock is still owned. */ }
      break;
    }
  }
  throw new SetupError('Another Codex setup operation is running; retry after it finishes.');
}

const TRANSPORT_FIELDS = new Set([
  'command', 'args', 'cwd', 'url', 'http_headers', 'env_http_headers',
  'bearer_token_env_var', 'http_headers_helper', 'auth', 'oauth', 'scopes',
  'experimental_environment', 'environment_id',
]);
function userLayer(view: CodexConfigRead): CodexConfigLayer {
  const layer = view.layers.find((candidate) => candidate.name.type === 'user' &&
    typeof candidate.name.file === 'string' && !candidate.name.profile && !candidate.disabledReason);
  if (!layer?.name.file) throw new SetupError('Codex did not provide a writable user configuration layer.');
  return layer;
}
function layeredTransport(view: CodexConfigRead, user: CodexConfigLayer, name: string): boolean {
  return view.layers.some((layer) => layer !== user && !layer.disabledReason &&
    Object.keys(servers(layer.config)[name] ?? {}).some((key) => TRANSPORT_FIELDS.has(key)));
}
function isCodexWrapped(entry: Entry): boolean {
  return typeof entry.command === 'string' && Array.isArray(entry.args) &&
    entry.args.includes('--codex-server') && isWrappedEntry(entry as { command: string; args: string[] });
}

type Plan = { patch: Patch } | { reason: string; needsAuth?: { name: string; url: string } };
function wrapPrefix(name: string, client: Client, mode: SpeculationMode, opts: CodexManageOptions): string[] {
  return [...opts.self.args, 'wrap', '--mode', mode, '--codex-server', name,
    '--codex-bin', client.bin, '--codex-home', client.codexHome];
}
async function planWrap(
  name: string, entry: Entry, client: Client, mode: SpeculationMode, opts: CodexManageOptions,
): Promise<Plan> {
  const bad = (reason: string): Plan => ({ reason });
  if (entry.enabled === false) return bad('disabled in Codex');
  if ((entry.environment_id != null && entry.environment_id !== 'local') ||
      (entry.experimental_environment != null && entry.experimental_environment !== 'local')) {
    return bad('remote executor transport; use an explicit wrapper in that environment');
  }
  if (Array.isArray(entry.env_vars) && entry.env_vars.some((item) => object(item) && item.source === 'remote')) {
    return bad('remote environment variables require a remote executor');
  }
  const prefix = wrapPrefix(name, client, mode, opts);
  if (typeof entry.command === 'string' && !entry.url) {
    if (entry.command.length === 0 || (entry.args !== undefined &&
        (!Array.isArray(entry.args) || !entry.args.every((arg) => typeof arg === 'string')))) {
      return bad('invalid stdio command or arguments');
    }
    if (entry.cwd !== undefined && typeof entry.cwd !== 'string') return bad('invalid working directory');
    return { patch: {
      command: opts.self.command,
      args: [...prefix, ...(typeof entry.cwd === 'string' ? ['--cwd', entry.cwd] : []),
        '--', entry.command, ...((entry.args as string[] | undefined) ?? [])],
      ...(entry.cwd !== undefined ? { cwd: null } : {}),
    } };
  }
  if (typeof entry.url !== 'string' || entry.command) return bad('unsupported or ambiguous transport');
  try {
    const url = new URL(entry.url);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error();
  } catch { return bad('invalid Streamable HTTP URL'); }
  if (entry.http_headers_helper != null) return bad('dynamic header helpers are owned by Codex');
  if (entry.auth === 'chatgpt') return bad('ChatGPT session authentication is owned by Codex');
  if (entry.oauth != null || entry.scopes != null) return bad('custom OAuth settings require an explicit wrapper');
  if (entry.auth != null && entry.auth !== 'oauth') return bad('unsupported authentication mode');

  const headers = new Map<string, { name: string; value: string; variable?: string }>();
  for (const key of ['http_headers', 'env_http_headers'] as const) {
    if (entry[key] === undefined) continue;
    if (!object(entry[key])) return bad('invalid HTTP headers');
    for (const [header, raw] of Object.entries(entry[key])) {
      if (!HOST_HEADER_NAME.test(header) || typeof raw !== 'string' || /[\r\n]/.test(raw)) return bad('invalid HTTP headers');
      if (key === 'env_http_headers') {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(raw)) return bad('unsupported header environment variable name');
        const value = process.env[raw];
        if (!value) return bad(`header environment variable ${raw} is not set`);
        headers.set(header.toLowerCase(), { name: header, value, variable: raw });
      } else headers.set(header.toLowerCase(), { name: header, value: raw });
    }
  }
  if (entry.bearer_token_env_var != null) {
    const variable = entry.bearer_token_env_var;
    if (typeof variable !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(variable)) return bad('invalid bearer token environment variable');
    const token = process.env[variable];
    if (!token) return bad(`bearer environment variable ${variable} is not set`);
    headers.set('authorization', { name: 'Authorization', value: `Bearer ${token}`, variable });
  }
  if ([...headers.values()].some((header) => /[\r\n]/.test(header.value))) return bad('invalid resolved HTTP headers');
  const storedOAuth = readOAuthRecord(opts.oauthStorePath ?? oauthStorePath(), entry.url)?.tokens;
  if (storedOAuth && headers.has('authorization')) return bad('both explicit authorization and Speculate OAuth are configured');
  const probe = await (opts.probeRemote ?? probeRemote)(entry.url,
    Object.fromEntries([...headers.values()].map((header) => [header.name, header.value])));
  if (probe.kind === 'needs-auth' && !storedOAuth) {
    return { reason: `needs a Speculate login; run speculate auth --client codex ${label(name)}`,
      needsAuth: { name, url: entry.url } };
  }
  if (probe.kind !== 'ok' && !(probe.kind === 'needs-auth' && storedOAuth)) {
    return bad('Streamable HTTP connection could not be verified; the server remains unchanged');
  }
  const args = [...prefix, '--url', entry.url];
  const variables: string[] = [];
  for (const header of headers.values()) {
    if (header.variable) {
      variables.push(header.variable);
      const bearer = entry.bearer_token_env_var === header.variable && header.name.toLowerCase() === 'authorization';
      args.push('--header', `${header.name}: ${bearer ? 'Bearer ' : ''}\${${header.variable}}`);
    } else args.push('--literal-header', `${header.name}: ${header.value}`);
  }
  const patch: Patch = { command: opts.self.command, args };
  for (const key of ['url', 'http_headers', 'env_http_headers', 'bearer_token_env_var', 'auth']) {
    if (entry[key] !== undefined) patch[key] = null;
  }
  if (variables.length) {
    const existing = Array.isArray(entry.env_vars) ? entry.env_vars : [];
    patch.env_vars = [...existing, ...[...new Set(variables)].filter((variable) => !existing.some((item) =>
      item === variable || (object(item) && item.name === variable)))];
  }
  return { patch };
}

interface Context {
  client: Client; view: CodexConfigRead; user: CodexConfigLayer; state: State;
  statePath: string; log: (line: string) => void; cwd: string;
}
async function withContext(
  opts: CodexManageOptions, mutate: boolean, action: (ctx: Context) => Promise<number>,
): Promise<number> {
  const log = opts.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  let client: Client | undefined;
  let unlock: (() => void) | undefined;
  try {
    const cwd = resolve(opts.cwd ?? process.cwd());
    client = await (opts.startClient?.() ?? startCodexClient({ bin: opts.codexBin, cwd }));
    const statePath = opts.statePath ?? codexManagedStatePath(client.codexHome);
    if (mutate) unlock = lock(statePath);
    const view = await client.readConfig(cwd);
    const user = userLayer(view);
    const state = loadState(statePath, user.name.file!);
    return await action({ client, view, user, state, statePath, log, cwd });
  } catch (error) {
    const message = error instanceof CodexClientError || error instanceof SetupError ? error.message :
      'Could not update Codex setup; no restore records were discarded.';
    log(`[speculate] ${message}`);
    return 1;
  } finally {
    unlock?.();
    await client?.close();
  }
}

async function activate(opts: CodexManageOptions, sync: boolean): Promise<number> {
  const needsAuth: { name: string; url: string }[] = [];
  const result = await withContext(opts, true, async (ctx) => {
    const { state, user, view, client, log } = ctx;
    if (sync && !state.enabled) {
      log('[speculate] Codex setup is off. Run speculate on --client codex first.');
      return 0;
    }
    state.enabled = true;
    const previousRecords = structuredClone(state.entries);
    const available = client.listServers ? new Map((await client.listServers()).map((entry) => [entry.name, entry])) : undefined;
    const requests: CodexConfigEdit[] = [];
    const undoRequests: CodexConfigEdit[] = [];
    const wrapped: string[] = [];
    const entries = servers(user.config);
    const effective = servers(view.config);
    let conflicts = 0;
    for (const [name, raw] of Object.entries(entries)) {
      let original = raw;
      const previous = Object.hasOwn(state.entries, name) ? state.entries[name] : undefined;
      if (previous) {
        if (matchesWrapped(raw, previous)) original = apply(raw, previous.before);
        else if (!matches(raw, previous.before)) {
          log(`[speculate] ${label(name)}: transport changed since setup; left unchanged. Use status --client codex to review.`);
          conflicts++; continue;
        }
      } else if (isCodexWrapped(raw) || isWrappedEntry(raw as { command?: string; args?: string[] })) {
        log(`[speculate] ${label(name)}: existing wrapper has no Codex restore record; left unchanged.`);
        continue;
      }
      if (layeredTransport(view, user, name)) {
        log(`[speculate] ${label(name)}: transport is also defined in another config layer; use an explicit wrapper there.`);
        continue;
      }
      if (!effective[name] || effective[name].enabled === false) {
        log(`[speculate] ${label(name)}: disabled or unavailable in this Codex context.`); continue;
      }
      if (available && (available.get(name)?.enabled !== true || available.get(name)?.disabledReason)) {
        log(`[speculate] ${label(name)}: Codex does not allow this server in the current context.`); continue;
      }
      const mode = opts.mode ?? previous?.mode ?? 'annotated';
      const prefix = wrapPrefix(name, client, mode, opts);
      if (previous && matchesWrapped(raw, previous) && raw.command === opts.self.command &&
          Array.isArray(raw.args) && isDeepStrictEqual(raw.args.slice(0, prefix.length), prefix)) continue;
      const plan = await planWrap(name, original, client, mode, opts);
      if ('reason' in plan) {
        log(`[speculate] ${label(name)}: ${plan.reason}`);
        if (plan.needsAuth) needsAuth.push(plan.needsAuth);
        continue;
      }
      if (matches(raw, plan.patch)) continue;
      const before = Object.fromEntries(Object.keys(plan.patch).map((key) => [key, field(original, key)]));
      // Save the inverse BEFORE asking Codex to commit. A killed process or a
      // lost response leaves a recoverable before/after record, never an orphan.
      const previousAfter = previous && matchesWrapped(raw, previous)
        ? Object.fromEntries(Object.keys(plan.patch).map((key) => [key, field(raw, key)])) : undefined;
      Object.defineProperty(state.entries, name, { value: { before, after: plan.patch, previousAfter, mode }, enumerable: true, configurable: true, writable: true });
      requests.push(...edits(name, plan.patch)); wrapped.push(name);
      undoRequests.push(...edits(name, Object.fromEntries(Object.keys(plan.patch).map((key) => [key, field(raw, key)]))));
    }
    saveState(ctx.statePath, state);
    if (requests.length) {
      await client.writeConfig({ filePath: user.name.file!, expectedVersion: user.version, edits: requests });
      if (client.listServers) {
        let allowed = false;
        try {
          const current = new Map((await client.listServers()).map((entry) => [entry.name, entry]));
          allowed = wrapped.every((name) => current.get(name)?.enabled === true && !current.get(name)?.disabledReason);
        } catch { /* An unverifiable launch policy is also a reason to undo setup. */ }
        if (!allowed) {
          // A managed allowlist can reject a changed command identity. Restore
          // exactly this operation while retaining unrelated intervening edits.
          const fresh = userLayer(await client.readConfig(ctx.cwd));
          const currentEntries = servers(fresh.config);
          if (fresh.name.file !== user.name.file || wrapped.some((name) =>
            !currentEntries[name] || !matches(currentEntries[name], state.entries[name].after))) {
            throw new SetupError('Codex transport changed during setup validation; kept the current entry and restore records.');
          }
          await client.writeConfig({ filePath: user.name.file!, expectedVersion: fresh.version, edits: undoRequests });
          state.entries = previousRecords;
          saveState(ctx.statePath, state);
          log('[speculate] Codex did not allow the wrapped registrations. This setup change was undone; previous registrations remain.');
          return 1;
        }
      }
      for (const name of wrapped) log(`[speculate] ${label(name)}: wrapped for Codex.`);
    }
    const projectOnly = Object.keys(effective).filter((name) => !Object.hasOwn(entries, name));
    for (const name of projectOnly) log(`[speculate] ${label(name)}: outside user configuration; left unchanged.`);
    log(`[speculate] Codex user configuration: ${user.name.file}`);
    log('[speculate] Policy checks use on-disk configuration; session-only --profile and -c overrides are not inherited.');
    log(`[speculate] ${wrapped.length} server(s) updated. Restart Codex to load changes. Rerun sync --client codex after adding servers.`);
    return conflicts ? 1 : 0;
  });
  // Browser interaction happens after the configuration transaction and lock.
  if (result === 0 && needsAuth.length && opts.onNeedsAuth && await opts.onNeedsAuth(needsAuth)) {
    return activate({ ...opts, onNeedsAuth: undefined }, sync);
  }
  return result;
}
export function speculateCodexOn(opts: CodexManageOptions): Promise<number> { return activate(opts, false); }
export function speculateCodexSync(opts: CodexManageOptions): Promise<number> { return activate(opts, true); }

async function restore(ctx: Context, only?: Set<string>): Promise<number> {
  const entries = servers(ctx.user.config);
  const requests: CodexConfigEdit[] = [];
  const restored: string[] = [];
  let conflicts = 0;
  for (const [name, record] of Object.entries(ctx.state.entries)) {
    if (only !== undefined && !only.has(name)) continue;
    const current = entries[name];
    if (!current || matches(current, record.before)) { restored.push(name); continue; }
    if (!matchesWrapped(current, record)) {
      ctx.log(`[speculate] ${label(name)}: transport changed since setup; kept the current entry and its restore record.`);
      conflicts++; continue;
    }
    requests.push(...edits(name, record.before)); restored.push(name);
  }
  if (only === undefined) ctx.state.enabled = false;
  // Keep every inverse until the host has acknowledged its atomic write.
  saveState(ctx.statePath, ctx.state);
  if (requests.length) await ctx.client.writeConfig({ filePath: ctx.user.name.file!, expectedVersion: ctx.user.version, edits: requests });
  for (const name of restored) { delete ctx.state.entries[name]; ctx.log(`[speculate] ${label(name)}: restored.`); }
  saveState(ctx.statePath, ctx.state);
  return conflicts ? 1 : 0;
}
export function speculateCodexOff(opts: CodexManageOptions): Promise<number> {
  return withContext(opts, true, async (ctx) => {
    const unrecorded = Object.entries(servers(ctx.user.config))
      .filter(([name, entry]) => isCodexWrapped(entry) && !Object.hasOwn(ctx.state.entries, name));
    const result = await restore(ctx);
    for (const [name] of unrecorded) {
      ctx.log(`[speculate] ${label(name)}: cannot restore without its Codex restore record; current wrapper retained.`);
    }
    const incomplete = result !== 0 || unrecorded.length > 0;
    ctx.log(incomplete ? '[speculate] Codex sync is off; some wrappers still need attention. Learning and authentication remain.'
      : '[speculate] Codex setup is off. Restart Codex to load restored entries. Learning and authentication remain.');
    return incomplete ? 1 : 0;
  });
}

export function speculateCodexStatus(opts: CodexManageOptions): Promise<number> {
  return withContext(opts, false, async (ctx) => {
    ctx.log(`[speculate] Codex user setup: ${ctx.state.enabled ? 'on' : 'off'} (${ctx.user.name.file})`);
    const effective = servers(ctx.view.config);
    const entries = servers(ctx.user.config);
    for (const [name, entry] of Object.entries(entries)) {
      const record = Object.hasOwn(ctx.state.entries, name) ? ctx.state.entries[name] : undefined;
      const detail = record ? matchesWrapped(entry, record) ? 'wrapped' : matches(entry, record.before)
        ? 'original (setup can be retried)' : 'conflict: transport changed; restore record retained'
        : isCodexWrapped(entry) ? 'wrapped without a restore record' : 'unwrapped';
      const context = !effective[name] || effective[name].enabled === false ? '; disabled in this context'
        : layeredTransport(ctx.view, ctx.user, name) ? '; another config layer defines its transport' : '';
      ctx.log(`[speculate] ${label(name)}: ${detail}${context}`);
    }
    for (const name of Object.keys(effective).filter((name) => !Object.hasOwn(entries, name))) {
      ctx.log(`[speculate] ${label(name)}: outside user configuration.`);
    }
    ctx.log('[speculate] Plugin/app tools are managed by Codex. New user servers need sync --client codex; no Codex hook is installed.');
    ctx.log('[speculate] Policy checks use on-disk configuration; session-only --profile and -c overrides are not inherited.');
    return 0;
  });
}

export async function speculateCodexAuth(opts: CodexManageOptions): Promise<number> {
  const targets: { name: string; url: string }[] = [];
  let enabled = false;
  const inspected = await withContext(opts, !!opts.forget, async (ctx) => {
    enabled = ctx.state.enabled;
    for (const [name, raw] of Object.entries(servers(ctx.user.config))) {
      const record = Object.hasOwn(ctx.state.entries, name) ? ctx.state.entries[name] : undefined;
      const original = record ? apply(raw, record.before) : raw;
      if (typeof original.url !== 'string') continue;
      if (opts.target && opts.target !== name && opts.target !== original.url) continue;
      targets.push({ name, url: original.url });
    }
    if (!targets.length && opts.target) {
      try {
        const url = new URL(opts.target);
        if (!['http:', 'https:'].includes(url.protocol)) throw new Error();
        targets.push({ name: opts.target, url: opts.target });
      } catch { throw new SetupError('No matching remote server in Codex user configuration.'); }
    }
    if (opts.forget) {
      if (!opts.target) throw new SetupError('auth --client codex --forget requires a server name or URL.');
      const urls = new Set(targets.map((target) => target.url));
      for (const [name, raw] of Object.entries(servers(ctx.user.config))) {
        if (!isCodexWrapped(raw) || Object.hasOwn(ctx.state.entries, name)) continue;
        const args = raw.args as string[];
        const index = args.indexOf('--url');
        if (index >= 0 && urls.has(args[index + 1])) {
          throw new SetupError('A matching Codex wrapper has no restore record; restore it before forgetting authentication.');
        }
      }
      const names = new Set(Object.entries(servers(ctx.user.config)).filter(([name, raw]) => {
        const saved = Object.hasOwn(ctx.state.entries, name) ? ctx.state.entries[name] : undefined;
        return saved && urls.has(String(apply(raw, saved.before).url));
      }).map(([name]) => name));
      if (names.size && await restore(ctx, names) !== 0) return 1;
    }
    return 0;
  });
  if (inspected !== 0) return inspected;
  let failed = false;
  for (const target of targets) {
    const code = await speculateAuth({ target: target.url, forget: opts.forget,
      ...(opts.oauthStorePath ? { storePath: opts.oauthStorePath } : {}), log: opts.log });
    if (code !== 0) failed = true;
  }
  if (!failed && !opts.forget && enabled && targets.length) return speculateCodexOn({ ...opts, onNeedsAuth: undefined });
  return failed ? 1 : 0;
}
