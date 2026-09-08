/** Codex's native configuration API, without starting a thread or MCP server. */
import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from 'node:child_process';
import { accessSync, constants, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { win32ShimInvocation } from './manage.js';

export interface CodexConfigLayerSource {
  type: string;
  file?: string;
  dotCodexFolder?: string;
  profile?: string | null;
  [key: string]: unknown;
}
export interface CodexConfigLayerMetadata {
  name: CodexConfigLayerSource;
  version: string;
}
export interface CodexConfigLayer extends CodexConfigLayerMetadata {
  /** Raw TOML values, including fields unknown to the installed Codex version. */
  config: Record<string, unknown>;
  disabledReason?: string | null;
}
export interface CodexConfigRead {
  config: Record<string, unknown>;
  layers: CodexConfigLayer[];
  origins: Record<string, CodexConfigLayerMetadata>;
}
export interface CodexConfigEdit {
  keyPath: string;
  /** null removes a key. Quoted TOML key components support dotted server names. */
  value: unknown;
  mergeStrategy: 'replace' | 'upsert';
}
export interface CodexConfigWrite {
  filePath: string;
  expectedVersion: string;
  edits: CodexConfigEdit[];
}
export interface CodexConfigWriteResult {
  status: string;
  version: string;
  filePath: string;
  overriddenMetadata?: unknown;
}
export interface CodexMcpServerStatus {
  name: string;
  enabled: boolean;
  disabledReason: string | null;
}

/** Never includes raw Codex errors, stdout, or stderr: these can contain secrets. */
export class CodexClientError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = 'CodexClientError';
  }
}

export type CodexSpawner = (
  command: string,
  args: string[],
  options: SpawnOptionsWithoutStdio,
) => ChildProcessWithoutNullStreams;

export interface CodexClientOptions {
  bin?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  spawn?: CodexSpawner;
  timeoutMs?: number;
  maxOutputBytes?: number;
  platform?: NodeJS.Platform;
}

/** Resolve to an absolute path so registrations also work in GUI processes. */
export function resolveCodexBin(
  bin: string = process.env.SPECULATE_CODEX_BIN ?? 'codex',
  opts: { platform?: NodeJS.Platform; pathEnv?: string; home?: string; cwd?: string; env?: NodeJS.ProcessEnv } = {},
): string {
  const platform = opts.platform ?? process.platform;
  const env = opts.env ?? process.env;
  const cwd = opts.cwd ?? process.cwd();
  if (isAbsolute(bin) || (platform === 'win32' && /^[A-Za-z]:[\\/]/.test(bin))) return bin;
  if (bin.includes('/') || bin.includes('\\')) return resolve(cwd, bin);
  const home = opts.home ?? homedir();
  const pathDirs = (opts.pathEnv ?? env.PATH ?? '').split(platform === 'win32' ? ';' : ':');
  const fallbackDirs = platform === 'win32'
    ? [env.APPDATA ? join(env.APPDATA, 'npm') : '', join(home, '.local', 'bin'), dirname(process.execPath)]
    : [join(home, '.local', 'bin'), join(home, '.codex', 'bin'), join(home, '.npm-global', 'bin'),
      '/opt/homebrew/bin', '/usr/local/bin', dirname(process.execPath)];
  const extensions = platform === 'win32' && !/\.(exe|cmd|bat)$/i.test(bin) ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const rawDir of [...pathDirs, ...fallbackDirs]) {
    const dir = rawDir.trim().replace(/^"|"$/g, '');
    if (!dir) continue;
    for (const ext of extensions) {
      const candidate = resolve(cwd, dir, `${bin}${ext}`);
      try {
        if (!statSync(candidate).isFile()) continue;
        accessSync(candidate, platform === 'win32' ? constants.F_OK : constants.X_OK);
        return candidate;
      } catch { /* Continue through PATH and known installation locations. */ }
    }
  }
  throw new CodexClientError('Codex CLI was not found. Install Codex or set SPECULATE_CODEX_BIN to its executable.', 'notFound');
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** npm launchers must not depend on a GUI process having `node` on PATH. */
function codexInvocation(bin: string, args: string[], platform: NodeJS.Platform): {
  file: string; args: string[]; windowsVerbatimArguments?: true;
} {
  let target = bin;
  try { target = realpathSync(bin); } catch { /* Let spawn report a missing executable safely. */ }
  if (/\.[cm]?js$/i.test(target)) return { file: process.execPath, args: [target, ...args] };
  if (platform === 'win32' && /\.(cmd|bat)$/i.test(bin)) {
    const npmLauncher = join(dirname(bin), 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
    try {
      // A custom wrapper can select its own home or configuration. Only the
      // conventional Codex npm shim may use its adjacent Node launcher.
      if (/^codex\.(cmd|bat)$/i.test(basename(bin)) && statSync(npmLauncher).isFile()) {
        return { file: process.execPath, args: [npmLauncher, ...args] };
      }
    } catch { /* A non-npm shim uses the existing escaped cmd.exe invocation. */ }
    return { ...win32ShimInvocation(bin, args), windowsVerbatimArguments: true };
  }
  return { file: bin, args };
}

const safeWriteErrors: Record<string, string> = {
  configVersionConflict: 'Codex configuration changed during this operation. Run the command again.',
  configLayerReadonly: 'Codex only permits this operation on its user configuration.',
};

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class CodexClient {
  readonly bin: string;
  codexHome = '';
  private nextId = 0;
  private readonly pending = new Map<number, Pending>();
  private buffer = '';
  private outputBytes = 0;
  private stopped = false;
  private exited = false;
  private closePromise?: Promise<void>;

  constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    bin: string,
    private readonly timeoutMs = 15_000,
    private readonly maxOutputBytes = 32 * 1024 * 1024,
    private readonly options: CodexClientOptions = {},
  ) {
    this.bin = bin;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => this.receive(chunk));
    // Drain diagnostics without retaining or printing credential-bearing content.
    child.stderr.on('data', (chunk: Buffer) => this.accountBytes(chunk.length));
    child.stdin.on('error', () => this.fail('Codex configuration connection closed.', 'connectionClosed'));
    child.on('error', () => this.fail('Could not start the Codex configuration service. Check the Codex installation.', 'startFailed'));
    child.on('close', () => {
      this.exited = true;
      this.fail('Codex configuration service exited before completing the operation.', 'connectionClosed');
    });
  }

  async initialize(): Promise<void> {
    const result = await this.request('initialize', {
      clientInfo: { name: 'speculate', title: 'Speculate', version: '1' },
    });
    if (this.stopped) throw new CodexClientError('Codex configuration connection is closed.', 'connectionClosed');
    if (!record(result) || typeof result.codexHome !== 'string') {
      this.fail('Codex returned an unsupported configuration protocol. Update Codex and retry.', 'invalidResponse');
      throw new CodexClientError('Codex returned an unsupported configuration protocol. Update Codex and retry.', 'invalidResponse');
    }
    this.codexHome = result.codexHome;
    this.child.stdin.write(`${JSON.stringify({ method: 'initialized', params: {} })}\n`);
  }

  async readConfig(cwd: string | null): Promise<CodexConfigRead> {
    const result = await this.request('config/read', { cwd, includeLayers: true });
    if (!record(result) || !record(result.config) || !Array.isArray(result.layers) || !record(result.origins)
      || result.layers.some((layer) => !record(layer) || !record(layer.name)
        || typeof layer.name.type !== 'string' || typeof layer.version !== 'string' || !record(layer.config))) {
      throw new CodexClientError('Codex returned an unsupported configuration response. Update Codex and retry.', 'invalidResponse');
    }
    return result as unknown as CodexConfigRead;
  }

  async writeConfig(params: CodexConfigWrite): Promise<CodexConfigWriteResult> {
    const result = await this.request('config/batchWrite', params);
    if (!record(result) || typeof result.version !== 'string' || typeof result.filePath !== 'string'
      || typeof result.status !== 'string') {
      throw new CodexClientError('Codex did not confirm the configuration update. Check status before retrying.', 'invalidResponse');
    }
    return result as unknown as CodexConfigWriteResult;
  }

  /** Reads Codex's runtime enablement, including managed identity restrictions. */
  listServers(): Promise<CodexMcpServerStatus[]> {
    return readCodexMcpStatus({ ...this.options, bin: this.bin });
  }

  private request(method: string, params: unknown): Promise<unknown> {
    if (this.stopped) return Promise.reject(new CodexClientError('Codex configuration connection is closed.', 'connectionClosed'));
    const id = ++this.nextId;
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => this.fail('Codex configuration request timed out. Check status before retrying.', 'timeout'), this.timeoutMs);
      this.pending.set(id, { resolve: resolvePromise, reject, timer });
      try {
        this.child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
      } catch {
        this.fail('Could not send the Codex configuration request.', 'connectionClosed');
      }
    });
  }

  private accountBytes(bytes: number): boolean {
    this.outputBytes += bytes;
    if (this.outputBytes <= this.maxOutputBytes) return true;
    this.fail('Codex configuration output exceeded the supported size.', 'outputLimit');
    return false;
  }

  private receive(chunk: string): void {
    if (this.stopped || !this.accountBytes(Buffer.byteLength(chunk))) return;
    this.buffer += chunk;
    for (;;) {
      const newline = this.buffer.indexOf('\n');
      if (newline < 0) return;
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (!line.trim()) continue;
      let response: unknown;
      try { response = JSON.parse(line); } catch {
        this.fail('Codex returned an invalid configuration protocol response.', 'invalidResponse');
        return;
      }
      if (!record(response)) {
        this.fail('Codex returned an invalid configuration protocol response.', 'invalidResponse');
        return;
      }
      if (typeof response.id !== 'number') continue; // Unrelated notifications.
      const pending = this.pending.get(response.id);
      if (!pending) continue;
      this.pending.delete(response.id);
      clearTimeout(pending.timer);
      if (record(response.error)) {
        const data = response.error.data;
        const requestedCode = record(data) ? data.config_write_error_code : undefined;
        const code = typeof requestedCode === 'string' && Object.hasOwn(safeWriteErrors, requestedCode) ? requestedCode : 'requestFailed';
        pending.reject(new CodexClientError(safeWriteErrors[code] ?? 'Codex rejected the configuration request. Check the Codex configuration and version.', code));
      } else if ('result' in response) {
        pending.resolve(response.result);
      } else {
        pending.reject(new CodexClientError('Codex returned an invalid configuration protocol response.', 'invalidResponse'));
      }
    }
  }

  private fail(message: string, code: string): void {
    if (this.stopped) return;
    this.stopped = true;
    this.buffer = '';
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(new CodexClientError(message, code));
    }
    this.pending.clear();
    void this.close();
  }

  /** End stdin, then terminate a hung service; no configuration calls are retried. */
  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.stopped = true;
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(new CodexClientError('Codex configuration connection is closed.', 'connectionClosed'));
    }
    this.pending.clear();
    this.buffer = '';
    this.closePromise = new Promise((resolvePromise) => {
      if (this.exited) { resolvePromise(); return; }
      let term: ReturnType<typeof setTimeout>;
      let kill: ReturnType<typeof setTimeout>;
      let deadline: ReturnType<typeof setTimeout>;
      const done = () => {
        clearTimeout(term);
        clearTimeout(kill);
        clearTimeout(deadline);
        this.child.removeListener('close', done);
        resolvePromise();
      };
      this.child.once('close', done);
      term = setTimeout(() => { try { this.child.kill(); } catch { /* Already exited. */ } }, 250);
      kill = setTimeout(() => { try { this.child.kill('SIGKILL'); } catch { /* Already exited. */ } }, 1000);
      deadline = setTimeout(done, 1500);
      this.child.stdin.end();
    });
    return this.closePromise;
  }
}

export async function startCodexClient(opts: CodexClientOptions = {}): Promise<CodexClient> {
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  const bin = resolveCodexBin(opts.bin ?? env.SPECULATE_CODEX_BIN ?? 'codex', { platform, env, cwd: opts.cwd });
  const args = ['app-server', '--stdio'];
  const invocation = codexInvocation(bin, args, platform);
  let child: ChildProcessWithoutNullStreams;
  try {
    child = (opts.spawn ?? spawn)(invocation.file, invocation.args, {
      cwd: opts.cwd,
      env,
      windowsHide: true,
      ...(invocation.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
    });
  } catch {
    throw new CodexClientError('Could not start the Codex configuration service. Check the Codex installation.', 'startFailed');
  }
  const client = new CodexClient(child, bin, opts.timeoutMs, opts.maxOutputBytes, opts);
  try {
    await client.initialize();
    return client;
  } catch (err) {
    await client.close();
    throw err;
  }
}

/** `mcp list` resolves status without launching or connecting to MCP servers. */
export async function readCodexMcpStatus(opts: CodexClientOptions = {}): Promise<CodexMcpServerStatus[]> {
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  const bin = resolveCodexBin(opts.bin ?? env.SPECULATE_CODEX_BIN ?? 'codex', { platform, env, cwd: opts.cwd });
  const args = ['mcp', 'list', '--json'];
  const invocation = codexInvocation(bin, args, platform);
  const output = await new Promise<string>((resolvePromise, reject) => {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = (opts.spawn ?? spawn)(invocation.file, invocation.args, {
        cwd: opts.cwd, env, windowsHide: true,
        ...(invocation.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
      });
    } catch {
      reject(new CodexClientError('Could not read Codex MCP server status.', 'statusFailed'));
      return;
    }
    let settled = false;
    let stdout = '';
    let bytes = 0;
    const fail = (code: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stdout = '';
      try { child.kill('SIGKILL'); } catch { /* Already exited. */ }
      reject(new CodexClientError('Could not verify Codex MCP server status. Check the Codex configuration and retry.', code));
    };
    const account = (size: number) => {
      bytes += size;
      if (bytes > (opts.maxOutputBytes ?? 32 * 1024 * 1024)) { fail('outputLimit'); return false; }
      return !settled;
    };
    const timer = setTimeout(() => fail('timeout'), opts.timeoutMs ?? 15_000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { if (account(Buffer.byteLength(chunk))) stdout += chunk; });
    child.stderr.on('data', (chunk: Buffer) => { account(chunk.length); });
    child.stdin.on('error', () => fail('statusFailed'));
    child.on('error', () => fail('statusFailed'));
    child.on('close', (code) => {
      if (settled) return;
      if (code !== 0) { fail('statusFailed'); return; }
      settled = true; clearTimeout(timer); resolvePromise(stdout);
    });
    child.stdin.end();
  });
  let values: unknown;
  try { values = JSON.parse(output); } catch {
    throw new CodexClientError('Codex returned an unsupported MCP status response.', 'invalidResponse');
  }
  if (!Array.isArray(values) || values.some((value) => !record(value) || typeof value.name !== 'string'
    || typeof value.enabled !== 'boolean' || !(value.disabled_reason == null || typeof value.disabled_reason === 'string'))) {
    throw new CodexClientError('Codex returned an unsupported MCP status response.', 'invalidResponse');
  }
  return values.map((value: Record<string, unknown>) => ({ name: value.name as string, enabled: value.enabled as boolean,
    disabledReason: typeof value.disabled_reason === 'string' ? value.disabled_reason : null }));
}
