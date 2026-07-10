/**
 * On-disk persistence for learned state (DESIGN.md §13.6).
 *
 * What persists: the transition learner's model (tool names + argument
 * templates, including constant argument values) and per-rule feedback
 * counters. What NEVER persists: tool results — the speculation cache is
 * memory-only by design (§6.4) — and anything else request-scoped.
 *
 * Failure philosophy: state is an optimization, so every failure mode
 * degrades to "cold start". A missing, corrupt, or version-mismatched file
 * loads as null; a failed save logs once to stderr and the proxy carries on.
 * Writes are atomic (tmp + rename) and 0600 — argument values can be
 * private, so the file is owner-only.
 */
import {
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';

export interface RuleFeedbackSnapshot {
  hits: number;
  wasted: number;
  speculated: number;
}

export interface PersistedState {
  version: 1;
  savedAt: number;
  learner: unknown;
  ruleFeedback: Record<string, RuleFeedbackSnapshot>;
}

const STATE_VERSION = 1 as const;

export class StateStore {
  private warnedSaveFailure = false;

  constructor(
    readonly path: string,
    private readonly now: () => number = Date.now,
  ) {}

  /** null on missing/corrupt/version-mismatch — cold start, never an error. */
  load(): PersistedState | null {
    let text: string;
    try {
      text = readFileSync(this.path, 'utf8');
    } catch {
      return null; // most commonly ENOENT: first run
    }
    try {
      const data = JSON.parse(text) as PersistedState;
      if (
        data === null ||
        typeof data !== 'object' ||
        data.version !== STATE_VERSION ||
        typeof data.ruleFeedback !== 'object'
      ) {
        return null;
      }
      return data;
    } catch {
      return null;
    }
  }

  /** Atomic write; returns false (and warns once) on failure. */
  save(state: { learner: unknown; ruleFeedback: Record<string, RuleFeedbackSnapshot> }): boolean {
    const full: PersistedState = {
      version: STATE_VERSION,
      savedAt: this.now(),
      learner: state.learner,
      ruleFeedback: state.ruleFeedback,
    };
    const tmp = `${this.path}.tmp`;
    try {
      mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
      writeFileSync(tmp, JSON.stringify(full), { mode: 0o600 });
      renameSync(tmp, this.path);
      return true;
    } catch (err) {
      if (!this.warnedSaveFailure) {
        this.warnedSaveFailure = true;
        process.stderr.write(
          `[speculate] state save failed (will keep retrying silently): ${(err as Error).message}\n`,
        );
      }
      return false;
    }
  }
}

/**
 * Default state-file location for a given config file: one state file per
 * config (≈ per project), under XDG state dir. Moving the config starts a
 * fresh state file — acceptable for an optimization cache.
 */
export function defaultStatePath(configPath: string): string {
  const abs = isAbsolute(configPath) ? configPath : resolve(configPath);
  const hash = createHash('sha256').update(abs).digest('hex').slice(0, 16);
  const xdg = process.env.XDG_STATE_HOME;
  const stateHome =
    xdg && xdg.length > 0 && isAbsolute(xdg)
      ? xdg // XDG spec: relative values are to be ignored
      : process.platform === 'win32' && process.env.LOCALAPPDATA
        ? process.env.LOCALAPPDATA
        : join(homedir(), '.local', 'state');
  return join(stateHome, 'speculate', `state-${hash}.json`);
}
