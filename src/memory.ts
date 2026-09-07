import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { loadConfig } from './config.js';
import {
  clearPersistedStateDirectory,
  clearPersistedState,
  defaultStateDirectory,
  defaultStatePath,
} from './persistence.js';
import { sanitizeLearnerState } from './privacy.js';

export type MemoryArgs =
  | { action: 'status'; json: boolean; configPath?: string }
  | { action: 'clear'; json: boolean; all?: true; configPath?: string };

export interface MemoryRunOptions {
  directory?: string;
  cwd?: string;
  write?: (text: string) => void;
  load?: typeof loadConfig;
}

export interface MemoryInventory {
  directory: string;
  policy: { retentionDays: number; maxBytes: number };
  stateFiles: Array<{
    path: string;
    bytes: number;
    savedAt: number | null;
    transitions: { tracked: number; supported: number };
    openers: { tracked: number; supported: number };
    removedSensitive: number;
    removedExpired: number;
    removedInvalid: number;
    trimmedForSize: number;
  }>;
  usage: { directory: string; files: number; bytes: number };
  totalBytes: number;
  skipped: number;
}

const STATE_FILE = /^state-[0-9a-f]{16}\.json$/;
const STATE_MARKER = /^state-[0-9a-f]{16}\.json\.generation$/;
const UUID_V4 = '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const STATE_TEMP = new RegExp(
  `^(state-[0-9a-f]{16}\\.json)(?:\\.\\d+\\.\\d+(?:\\.${UUID_V4})?)?\\.tmp$`,
  'i',
);
const USAGE_SESSION = /^\d+-[0-9a-f-]{8,}\.json$/i;
const USAGE_ARCHIVE = /^archive-\d{4}-\d{2}-[0-9a-f-]{8,}\.json$/i;

export function parseMemoryArgs(argv: string[]): MemoryArgs | { error: string } {
  let action: 'status' | 'clear' = 'status';
  let json = false;
  let all = false;
  let configPath: string | undefined;
  let i = 0;
  if (argv[0] === 'clear') { action = 'clear'; i = 1; }
  for (; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--json') json = true;
    else if (arg === '--all' && action === 'clear') all = true;
    else if (arg === '--config') {
      const value = argv[++i];
      if (!value || value.startsWith('--')) return { error: '--config requires a path' };
      configPath = value;
    } else return { error: `unknown memory argument '${arg}'` };
  }
  if (all && configPath !== undefined) return { error: 'choose either --all or --config, not both' };
  if (action === 'clear' && !all && configPath === undefined) {
    return { error: 'memory clear requires --all or --config PATH' };
  }
  return action === 'status'
    ? { action, json, ...(configPath !== undefined ? { configPath } : {}) }
    : { action, json, ...(all ? { all: true } : {}), ...(configPath !== undefined ? { configPath } : {}) };
}

function safeRegularFile(path: string, parent: string): boolean {
  try {
    const rel = relative(resolve(parent), resolve(path));
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return false;
    const stat = lstatSync(path);
    return stat.isFile() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

function boundedCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.min(Number.MAX_SAFE_INTEGER, Math.floor(value))
    : 0;
}

function displayTimestamp(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 8_640_000_000_000_000
    ? value
    : null;
}

function readStateSummary(
  path: string,
  retentionDays: number,
): Omit<MemoryInventory['stateFiles'][number], 'path' | 'bytes'> {
  const empty = {
    savedAt: null,
    transitions: { tracked: 0, supported: 0 },
    openers: { tracked: 0, supported: 0 },
    removedSensitive: 0,
    removedExpired: 0,
    removedInvalid: 0,
    trimmedForSize: 0,
  };
  try {
    if (statSync(path).size > 67_108_864) return empty;
    const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      const root = value as Record<string, unknown>;
      const learner = root['learner'] !== null && typeof root['learner'] === 'object' && !Array.isArray(root['learner'])
        ? root['learner'] as Record<string, unknown>
        : {};
      const savedAt = displayTimestamp(root['savedAt']);
      const clean = sanitizeLearnerState(learner, {
        now: Date.now(),
        cutoff: Date.now() - retentionDays * 24 * 60 * 60_000,
        fallbackTimestamp: savedAt ?? Date.now(),
      }).value;
      const transitions = clean.transitions;
      const openers = clean.openers;
      const readyTransition = (item: unknown): boolean => {
        if (item === null || typeof item !== 'object' || Array.isArray(item)) return false;
        const record = item as Record<string, unknown>;
        if (typeof record['count'] !== 'number' || record['count'] < 2) return false;
        return !Array.isArray(record['templates']) || record['templates'].every((template) =>
          template !== null && typeof template === 'object' && !Array.isArray(template) &&
          (template as Record<string, unknown>)['underivable'] !== true);
      };
      const readyOpener = (item: unknown): boolean => item !== null && typeof item === 'object' &&
        !Array.isArray(item) && typeof (item as Record<string, unknown>)['count'] === 'number' &&
        ((item as Record<string, unknown>)['count'] as number) >= 2;
      const memory = root['memory'] !== null && typeof root['memory'] === 'object' && !Array.isArray(root['memory'])
        ? root['memory'] as Record<string, unknown>
        : {};
      return {
        savedAt,
        transitions: { tracked: transitions.length, supported: transitions.filter(readyTransition).length },
        openers: { tracked: openers.length, supported: openers.filter(readyOpener).length },
        removedSensitive: boundedCount(memory['removedSensitive']),
        removedExpired: boundedCount(memory['removedExpired']),
        removedInvalid: boundedCount(memory['removedInvalid']),
        trimmedForSize: boundedCount(memory['trimmedForSize']),
      };
    }
  } catch {}
  return empty;
}

function configuredState(
  configPath: string,
  cwd: string,
  load: typeof loadConfig,
): { path: string | null; retentionDays: number; maxBytes: number } {
  const absoluteConfig = resolve(cwd, configPath);
  const config = load(absoluteConfig);
  if (config.persistence?.enabled === false) {
    return { path: null, retentionDays: config.persistence.retentionDays ?? 30, maxBytes: config.persistence.maxBytes ?? 8_388_608 };
  }
  const custom = config.persistence?.path;
  const path = custom === undefined
    ? defaultStatePath(absoluteConfig)
    : isAbsolute(custom) ? custom : resolve(cwd, custom);
  return {
    path,
    retentionDays: config.persistence?.retentionDays ?? 30,
    maxBytes: config.persistence?.maxBytes ?? 8_388_608,
  };
}

export function inventoryMemory(
  directory: string = defaultStateDirectory(),
  onlyPath?: string,
  policy: { retentionDays: number; maxBytes: number } = { retentionDays: 30, maxBytes: 8_388_608 },
): MemoryInventory {
  const stateFiles: MemoryInventory['stateFiles'] = [];
  let skipped = 0;
  const candidates = onlyPath === undefined
    ? (() => {
        if (pathExists(directory) && !safeDirectory(directory)) { skipped++; return []; }
        try { return readdirSync(directory).filter((entry) => STATE_FILE.test(entry)).map((entry) => join(directory, entry)); } catch { return []; }
      })()
    : [onlyPath];
  for (const path of candidates) {
    const parent = dirname(path);
    if (!safeDirectory(parent) || !safeRegularFile(path, parent)) { if (onlyPath === undefined || pathExists(path)) skipped++; continue; }
    const stat = statSync(path);
    stateFiles.push({ path: resolve(path), bytes: stat.size, ...readStateSummary(path, policy.retentionDays) });
  }
  const usageDirectory = join(directory, 'usage');
  let usageFiles = 0;
  let usageBytes = 0;
  if (onlyPath === undefined) {
    let entries: string[] = [];
    if (pathExists(usageDirectory) && !safeDirectory(usageDirectory)) skipped++;
    else try { entries = readdirSync(usageDirectory); } catch {}
    for (const entry of entries) {
      if (!USAGE_SESSION.test(entry) && !USAGE_ARCHIVE.test(entry)) continue;
      const path = join(usageDirectory, entry);
      if (!safeRegularFile(path, usageDirectory) || !isUsageRecord(path)) { skipped++; continue; }
      usageFiles++;
      usageBytes += statSync(path).size;
    }
  }
  const stateBytes = stateFiles.reduce((sum, item) => sum + item.bytes, 0);
  return {
    directory: resolve(directory),
    policy,
    stateFiles,
    usage: { directory: resolve(usageDirectory), files: usageFiles, bytes: usageBytes },
    totalBytes: stateBytes + usageBytes,
    skipped,
  };
}

function pathExists(path: string): boolean {
  try { lstatSync(path); return true; } catch { return false; }
}

function safeDirectory(path: string): boolean {
  try {
    const absolute = resolve(path);
    const stat = lstatSync(absolute);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
    const actual = realpathSync(absolute);
    return process.platform === 'win32'
      ? actual.toLowerCase() === absolute.toLowerCase()
      : actual === absolute;
  } catch {
    return false;
  }
}

function isUsageRecord(path: string): boolean {
  try {
    if (statSync(path).size > 8_388_608) return false;
    const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
    const root = value as Record<string, unknown>;
    return root['version'] === 1 && (
      (typeof root['sessionId'] === 'string' && (root['source'] === 'mcp' || root['source'] === 'cli') && typeof root['counters'] === 'object') ||
      (root['kind'] === 'archive' && Array.isArray(root['snapshots']))
    );
  } catch {
    return false;
  }
}

export function usageGenerationPath(directory: string): string {
  return join(directory, '.generation');
}

export function usageMemoryLockPath(directory: string): string {
  return join(directory, '.memory.lock');
}

export function readUsageGeneration(directory: string): string {
  try {
    const path = usageGenerationPath(directory);
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1_024) return `invalid:${stat.size}:${stat.mtimeMs}`;
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

export function withUsageMemoryLock<T>(
  directory: string,
  action: () => T,
  waitMs: number = 500,
): { acquired: true; value: T } | { acquired: false; error?: string } {
  if (existsSync(directory)) {
    if (!safeDirectory(directory)) return { acquired: false, error: 'linked or invalid directory' };
  } else {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (!safeDirectory(directory)) return { acquired: false, error: 'linked or invalid directory' };
  }
  const path = usageMemoryLockPath(directory);
  let fd: number | undefined;
  const boundedWait = Number.isFinite(waitMs) ? Math.max(0, Math.min(500, Math.floor(waitMs))) : 500;
  const deadline = Date.now() + boundedWait;
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  let firstAttempt = true;
  let staleRetries = 0;
  while (firstAttempt || Date.now() <= deadline) {
    firstAttempt = false;
    try { fd = openSync(path, 'wx', 0o600); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        return { acquired: false, error: (error as NodeJS.ErrnoException).code ?? 'lock failed' };
      }
      try {
        if (Date.now() - statSync(path).mtimeMs > 30_000 && staleRetries < 2) {
          unlinkSync(path);
          staleRetries++;
          firstAttempt = true;
          continue;
        }
      } catch {}
      if (Date.now() >= deadline) return { acquired: false, error: 'busy' };
      Atomics.wait(sleeper, 0, 0, 10);
    }
  }
  if (fd === undefined) return { acquired: false, error: 'busy' };
  try { return { acquired: true, value: action() }; }
  finally {
    try { closeSync(fd); } catch {}
    try { unlinkSync(path); } catch {}
  }
}

function replaceUsageGenerationLocked(directory: string, beforeReplace: () => void): void {
  const path = usageGenerationPath(directory);
  if (existsSync(path)) {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('usage generation marker is not a regular file');
  }
  const tmp = `${path}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tmp, randomUUID(), { flag: 'wx', mode: 0o600 });
    beforeReplace();
    try { unlinkSync(path); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    renameSync(tmp, path);
  } finally {
    try { unlinkSync(tmp); } catch {}
  }
}

function clearUsage(directory: string): { cleared: number; skipped: number; failed: number } {
  const result = { cleared: 0, skipped: 0, failed: 0 };
  let locked: ReturnType<typeof withUsageMemoryLock<void>>;
  try {
    locked = withUsageMemoryLock(directory, () => {
      // Refuse an unsafe marker before deleting any history.
      const marker = usageGenerationPath(directory);
      if (existsSync(marker)) {
        const stat = lstatSync(marker);
        if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('unsafe generation marker');
      }
      replaceUsageGenerationLocked(directory, () => {
        let entries: string[] = [];
        try { entries = readdirSync(directory); } catch {}
        for (const entry of entries) {
          if (!USAGE_SESSION.test(entry) && !USAGE_ARCHIVE.test(entry)) continue;
          const path = join(directory, entry);
          if (!safeRegularFile(path, directory) || !isUsageRecord(path)) { result.skipped++; continue; }
          try { unlinkSync(path); result.cleared++; } catch { result.failed++; }
        }
      });
    });
  } catch {
    result.failed++;
    return result;
  }
  if (!locked.acquired) result.failed++;
  return result;
}

/** Primarily for tests and exact configured-path clearing. */
export function advanceMemoryGeneration(path: string): void {
  const result = clearPersistedState(path);
  if (!result.cleared) throw new Error(result.error ?? 'could not clear state');
}

export function runMemory(args: MemoryArgs, options: MemoryRunOptions = {}): number {
  const directory = options.directory ?? defaultStateDirectory();
  const cwd = options.cwd ?? process.cwd();
  const write = options.write ?? ((text: string) => process.stdout.write(text));
  const load = options.load ?? loadConfig;
  const configured = args.configPath === undefined ? undefined : configuredState(args.configPath, cwd, load);
  if (args.action === 'status') {
    const inventory = configured?.path === null
      ? { directory: resolve(directory), policy: { retentionDays: configured.retentionDays, maxBytes: configured.maxBytes }, stateFiles: [], usage: { directory: resolve(join(directory, 'usage')), files: 0, bytes: 0 }, totalBytes: 0, skipped: 0 }
      : inventoryMemory(
          directory,
          configured?.path,
          configured === undefined
            ? undefined
            : { retentionDays: configured.retentionDays, maxBytes: configured.maxBytes },
        );
    if (args.json) write(`${JSON.stringify(inventory, null, 2)}\n`);
    else {
      write(
        `Speculate memory (retention ${inventory.policy.retentionDays}d, cap ${inventory.policy.maxBytes} bytes): ` +
        `${inventory.stateFiles.length} learned state file(s), ` +
        `${inventory.usage.files} usage record(s), ${inventory.totalBytes} bytes\n` +
        `${inventory.stateFiles.map((item) => `${item.path}: ${item.bytes} bytes, ${item.transitions.supported}/${item.transitions.tracked} transitions with repeated evidence, ${item.openers.supported}/${item.openers.tracked} openers with repeated evidence${item.savedAt === null ? '' : `, saved ${new Date(item.savedAt).toISOString()}`}`).join('\n')}` +
        `${inventory.stateFiles.length > 0 ? '\n' : ''}`,
      );
    }
    return 0;
  }
  let cleared = 0;
  let skipped = 0;
  let failed = 0;
  const targets: string[] = [];
  if (args.all && pathExists(directory) && !safeDirectory(directory)) {
    const report = { scope: 'all managed memory', cleared: 0, skipped: 0, failed: 1 };
    write(args.json ? `${JSON.stringify(report, null, 2)}\n` : `Speculate memory clear (${report.scope}): 0 cleared, 0 skipped, 1 failed\n`);
    return 1;
  }
  const collectAllTargets = (): void => {
    let entries: string[] = [];
    try { entries = readdirSync(directory); } catch {}
    const bases = new Set<string>();
    for (const entry of entries) {
      if (STATE_FILE.test(entry)) bases.add(entry);
      else if (STATE_MARKER.test(entry)) bases.add(entry.slice(0, -'.generation'.length));
      else {
        const temp = STATE_TEMP.exec(entry);
        if (temp?.[1]) bases.add(temp[1]);
      }
    }
    for (const entry of bases) targets.push(join(directory, entry));
  };
  const clearTargets = (): void => {
    for (const path of targets) {
      const parent = dirname(path);
      if (args.all && (!STATE_FILE.test(basename(path)) || (pathExists(path) && !safeRegularFile(path, parent)))) {
        skipped++;
        continue;
      }
      const result = clearPersistedState(path);
      if (result.cleared) cleared++;
      else if (result.skipped) skipped++;
      else failed++;
    }
  };
  if (args.all) {
    const stateClear = clearPersistedStateDirectory(directory, () => {
      collectAllTargets();
      clearTargets();
    });
    if (!stateClear.acquired) failed++;
    const usage = clearUsage(join(directory, 'usage'));
    cleared += usage.cleared;
    skipped += usage.skipped;
    failed += usage.failed;
  } else {
    if (configured?.path !== null && configured?.path !== undefined) targets.push(configured.path);
    clearTargets();
  }
  const report = { scope: args.all ? 'all managed memory' : configured?.path === null ? 'persistence disabled' : resolve(configured?.path ?? ''), cleared, skipped, failed };
  write(args.json ? `${JSON.stringify(report, null, 2)}\n` : `Speculate memory clear (${report.scope}): ${cleared} cleared, ${skipped} skipped, ${failed} failed\n`);
  return failed > 0 ? 1 : 0;
}
