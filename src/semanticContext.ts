import { homedir } from 'node:os';
import { resolve, sep } from 'node:path';
import { createSecretGuard, type SecretGuard } from './privacy.js';
import type { SemanticRecentCall, VerifiedSemanticContext } from './semanticTypes.js';

const DEFAULT_LIMITS = {
  maxTaskBytes: 8 * 1024,
  maxCallBytes: 2 * 1024,
  maxCalls: 8,
  maxConversationBytes: 32 * 1024,
  maxConversations: 64,
  maxLaunchBytes: 2 * 1024 * 1024,
};

export interface SemanticContextLimits {
  maxTaskBytes: number;
  maxCallBytes: number;
  maxCalls: number;
  maxConversationBytes: number;
  maxConversations: number;
  maxLaunchBytes: number;
}

export interface SemanticArgumentProjectionOptions {
  guard: SecretGuard;
  workspace?: string;
  homeDir?: string;
  rejectRedaction: boolean;
}

interface ContextEntry {
  snapshot: VerifiedSemanticContext;
  promptAt: number;
  bytes: number;
}

export class SemanticContextStore {
  private readonly contexts = new Map<string, ContextEntry>();
  private readonly now: () => number;
  private readonly guard: SecretGuard;
  private readonly homeDir: string;
  private readonly limits: SemanticContextLimits;
  private readonly onEvict: (conversationId: string) => void;
  private readonly revisions = new Map<string, number>();
  private totalBytes = 0;

  constructor(private readonly options: {
    launchId: string;
    now?: () => number;
    guard?: SecretGuard;
    homeDir?: string;
    limits?: Partial<SemanticContextLimits>;
    onEvict?: (conversationId: string) => void;
  }) {
    this.now = options.now ?? Date.now;
    this.guard = options.guard ?? createSecretGuard();
    this.homeDir = options.homeDir ?? homedir();
    this.limits = { ...DEFAULT_LIMITS, ...options.limits };
    this.onEvict = options.onEvict ?? (() => {});
  }

  observePrompt(input: {
    launchId: string;
    conversationId: string;
    task: string;
    workspace?: string;
    revision?: number;
  }): boolean {
    if (
      input.launchId !== this.options.launchId || input.conversationId.length === 0 ||
      Buffer.byteLength(input.task, 'utf8') > this.limits.maxTaskBytes
    ) {
      if (input.launchId === this.options.launchId) this.invalidate(input.conversationId);
      return false;
    }
    const task = this.guard.redact(input.task);
    if (this.guard.isSensitive(task)) {
      this.invalidate(input.conversationId);
      return false;
    }
    const previousRevision = this.revisions.get(input.conversationId) ?? 0;
    const revision = input.revision ?? previousRevision + 1;
    if (!Number.isSafeInteger(revision) || revision <= previousRevision) return false;
    if (!this.revisions.has(input.conversationId) && this.revisions.size >= 4_096) return false;
    const workspace = input.workspace === undefined
      ? undefined
      : normalizePath(input.workspace, undefined, this.homeDir);
    const snapshot: VerifiedSemanticContext = {
      launchId: input.launchId,
      conversationId: input.conversationId,
      revision,
      task,
      ...(workspace === undefined ? {} : { workspace }),
      recentCalls: [],
    };
    const retained = this.replace(input.conversationId, {
      snapshot,
      promptAt: this.now(),
      bytes: serializedBytes(snapshot),
    });
    if (retained) this.revisions.set(input.conversationId, revision);
    return retained;
  }

  observeCall(conversationId: string, input: {
    server: string;
    tool: string;
    args: Readonly<Record<string, unknown>>;
    success: boolean;
    completedAt: number;
  }): boolean {
    const entry = this.contexts.get(conversationId);
    if (!entry || !Number.isFinite(input.completedAt)) return false;
    if (this.guard.isSensitive(input.server) || this.guard.isSensitive(input.tool)) return false;
    const workspace = rawWorkspace(entry.snapshot.workspace, this.homeDir);
    const args = projectSemanticArguments(input.args, {
      guard: this.guard,
      ...(workspace === undefined ? {} : { workspace }),
      homeDir: this.homeDir,
      rejectRedaction: false,
    });
    if (args === null) return false;
    const call: SemanticRecentCall = {
      server: input.server,
      tool: input.tool,
      args,
      success: input.success,
      relativeMs: Math.max(0, input.completedAt - entry.promptAt),
    };
    if (serializedBytes(call) > this.limits.maxCallBytes) return false;
    const recentCalls = [...entry.snapshot.recentCalls, call].slice(-this.limits.maxCalls);
    const snapshot = { ...entry.snapshot, recentCalls };
    while (recentCalls.length > 0 && serializedBytes(snapshot) > this.limits.maxConversationBytes) {
      recentCalls.shift();
    }
    return this.replace(conversationId, {
      ...entry,
      snapshot,
      bytes: serializedBytes(snapshot),
    });
  }

  get(conversationId: string): VerifiedSemanticContext | null {
    const entry = this.contexts.get(conversationId);
    if (!entry) return null;
    this.contexts.delete(conversationId);
    this.contexts.set(conversationId, entry);
    return structuredClone(entry.snapshot);
  }

  projectCandidate(
    conversationId: string,
    args: Readonly<Record<string, unknown>>,
  ): Record<string, unknown> | null {
    const entry = this.contexts.get(conversationId);
    if (!entry) return null;
    const workspace = rawWorkspace(entry.snapshot.workspace, this.homeDir);
    return projectSemanticArguments(args, {
      guard: this.guard,
      ...(workspace === undefined ? {} : { workspace }),
      homeDir: this.homeDir,
      rejectRedaction: true,
    });
  }

  projectDescription(value: string): string | undefined {
    const redacted = this.guard.redact(value);
    if (this.guard.isSensitive(redacted) || Buffer.byteLength(redacted, 'utf8') > 2 * 1024) {
      return undefined;
    }
    return redacted;
  }

  invalidate(conversationId: string): void {
    const entry = this.contexts.get(conversationId);
    if (!entry) return;
    this.totalBytes -= entry.bytes;
    this.contexts.delete(conversationId);
    this.onEvict(conversationId);
  }

  clear(): void {
    for (const conversationId of this.contexts.keys()) this.onEvict(conversationId);
    this.contexts.clear();
    this.totalBytes = 0;
  }

  private replace(conversationId: string, entry: ContextEntry): boolean {
    if (entry.bytes > this.limits.maxConversationBytes || entry.bytes > this.limits.maxLaunchBytes) {
      this.invalidate(conversationId);
      return false;
    }
    const previous = this.contexts.get(conversationId);
    if (previous) this.totalBytes -= previous.bytes;
    this.contexts.delete(conversationId);
    this.contexts.set(conversationId, entry);
    this.totalBytes += entry.bytes;
    while (
      this.contexts.size > this.limits.maxConversations ||
      this.totalBytes > this.limits.maxLaunchBytes
    ) {
      const oldest = this.contexts.entries().next().value as [string, ContextEntry] | undefined;
      if (!oldest) break;
      this.contexts.delete(oldest[0]);
      this.totalBytes -= oldest[1].bytes;
      this.onEvict(oldest[0]);
    }
    return this.contexts.has(conversationId);
  }
}

export function projectSemanticArguments(
  args: Readonly<Record<string, unknown>>,
  options: SemanticArgumentProjectionOptions,
): Record<string, unknown> | null {
  const seen = new Set<object>();
  const projected = projectValue(args, undefined, options, seen, 0);
  return projected !== INVALID && isRecord(projected) ? projected : null;
}

const INVALID = Symbol('invalid');

function projectValue(
  value: unknown,
  fieldName: string | undefined,
  options: SemanticArgumentProjectionOptions,
  seen: Set<object>,
  depth: number,
): unknown | typeof INVALID {
  if (depth > 12) return INVALID;
  if (fieldName !== undefined && options.guard.isSensitive(value, fieldName)) {
    return options.rejectRedaction ? INVALID : '[redacted]';
  }
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : INVALID;
  if (typeof value === 'string') {
    if (options.guard.isSensitive(value, fieldName)) {
      return options.rejectRedaction ? INVALID : '[redacted]';
    }
    return normalizePath(value, options.workspace, options.homeDir);
  }
  if (typeof value !== 'object') return value === undefined ? undefined : INVALID;
  if (seen.has(value)) return INVALID;
  seen.add(value);
  if (Array.isArray(value)) {
    const output: unknown[] = [];
    for (const item of value) {
      const projected = projectValue(item, fieldName, options, seen, depth + 1);
      if (projected === INVALID) return INVALID;
      output.push(projected === undefined ? null : projected);
    }
    seen.delete(value);
    return output;
  }
  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const projected = projectValue(child, key, options, seen, depth + 1);
    if (projected === INVALID) return INVALID;
    if (projected !== undefined) {
      Object.defineProperty(output, key, {
        configurable: true,
        enumerable: true,
        value: projected,
        writable: true,
      });
    }
  }
  seen.delete(value);
  return output;
}

function normalizePath(value: string, workspace?: string, homeDir?: string): string {
  if (/^[A-Za-z]:[\\/]/.test(value)) return normalizeWindowsPath(value, workspace, homeDir);
  if (!value.startsWith(sep)) return value;
  const absolute = resolve(value);
  if (workspace !== undefined) {
    const root = resolve(workspace);
    if (absolute === root) return '<workspace>';
    if (absolute.startsWith(`${root}${sep}`)) return `<workspace>${sep}${absolute.slice(root.length + 1)}`;
  }
  if (homeDir !== undefined) {
    const root = resolve(homeDir);
    if (absolute === root) return '<home>';
    if (absolute.startsWith(`${root}${sep}`)) return `<home>${sep}${absolute.slice(root.length + 1)}`;
  }
  return absolute;
}

function normalizeWindowsPath(value: string, workspace?: string, homeDir?: string): string {
  const normalize = (path: string) => path.replace(/\\/g, '/').replace(/\/$/, '').toLowerCase();
  const original = value.replace(/\\/g, '/');
  const absolute = normalize(value);
  for (const [rootValue, marker] of [[workspace, '<workspace>'], [homeDir, '<home>']] as const) {
    if (rootValue === undefined || !/^[A-Za-z]:[\\/]/.test(rootValue)) continue;
    const root = normalize(rootValue);
    if (absolute === root) return marker;
    if (absolute.startsWith(`${root}/`)) return `${marker}/${original.slice(root.length + 1)}`;
  }
  return original;
}

function rawWorkspace(workspace: string | undefined, homeDir: string): string | undefined {
  if (workspace === undefined) return undefined;
  if (workspace === '<home>') return homeDir;
  if (workspace.startsWith(`<home>${sep}`)) return resolve(homeDir, workspace.slice(7));
  return workspace.startsWith('<') ? undefined : workspace;
}

function serializedBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
