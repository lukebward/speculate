import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  advanceMemoryGeneration,
  inventoryMemory,
  parseMemoryArgs,
  runMemory,
  usageGenerationPath,
  usageMemoryLockPath,
  withUsageMemoryLock,
} from '../src/memory.js';
import { StateStore } from '../src/persistence.js';

const roots: string[] = [];
const dir = () => { const value = mkdtempSync(join(tmpdir(), 'speculate-memory-')); roots.push(value); return value; };
afterEach(() => { for (const root of roots.splice(0)) { try { rmSync(root, { recursive: true, force: true }); } catch {} } });

describe('memory command', () => {
  it('parses inventory and explicit clear scopes', () => {
    expect(parseMemoryArgs([])).toEqual({ action: 'status', json: false });
    expect(parseMemoryArgs(['--json'])).toEqual({ action: 'status', json: true });
    expect(parseMemoryArgs(['clear', '--all'])).toEqual({ action: 'clear', all: true, json: false });
    expect(parseMemoryArgs(['clear', '--config', 'a.json'])).toEqual({ action: 'clear', configPath: 'a.json', json: false });
    expect(parseMemoryArgs(['clear'])).toHaveProperty('error');
    expect(parseMemoryArgs(['clear', '--all', '--config', 'x'])).toHaveProperty('error');
  });

  it('clears only allowlisted state and usage files, preserving auth, host state, unknown files and symlinks', () => {
    const root = dir();
    const usage = join(root, 'usage');
    mkdirSync(usage);
    const state = join(root, 'state-0123456789abcdef.json');
    writeFileSync(state, '{}');
    writeFileSync(join(root, 'managed.json'), 'managed');
    writeFileSync(join(root, 'oauth.json'), 'oauth');
    writeFileSync(join(root, 'notes.json'), 'notes');
    const counters = { hits: 0, joins: 0, misses: 0, speculativeCalls: 0, wasted: 0,
      estimatedSavedMs: 0, estimatedAddedWaitMs: 0, predictionOpportunities: 0,
      predictionOffered: 0, predictionHitsAt1: 0, predictionHitsAt3: 0,
      nearMisses: 0, nearMissDistanceOne: 0 };
    writeFileSync(join(usage, '1-12345678-abcd.json'), JSON.stringify({
      version: 1, sessionId: 'x', source: 'mcp', workspace: root,
      startedAt: 1, updatedAt: 1, counters,
    }));
    writeFileSync(join(usage, 'archive-2026-01-12345678-abcd.json'), JSON.stringify({
      version: 1, kind: 'archive', snapshots: [],
    }));
    const outside = join(dir(), 'outside.json');
    writeFileSync(outside, 'outside');
    try { symlinkSync(outside, join(root, 'state-fedcba9876543210.json')); } catch {}
    const lines: string[] = [];
    expect(runMemory({ action: 'clear', all: true, json: false }, { directory: root, write: (s) => lines.push(s) })).toBe(0);
    expect(existsSync(state)).toBe(false);
    expect(existsSync(join(usage, '1-12345678-abcd.json'))).toBe(false);
    expect(existsSync(join(usage, 'archive-2026-01-12345678-abcd.json'))).toBe(false);
    expect(readFileSync(join(root, 'managed.json'), 'utf8')).toBe('managed');
    expect(readFileSync(join(root, 'oauth.json'), 'utf8')).toBe('oauth');
    expect(readFileSync(join(root, 'notes.json'), 'utf8')).toBe('notes');
    expect(readFileSync(outside, 'utf8')).toBe('outside');
    expect(existsSync(usageGenerationPath(usage))).toBe(true);
  });

  it('advancing a generation prevents a live store from resurrecting cleared state', () => {
    const root = dir();
    const path = join(root, 'state.json');
    const store = new StateStore(path, () => 100);
    expect(store.save({ learner: { transitions: [] }, ruleFeedback: {} })).toBe(true);
    store.load();
    advanceMemoryGeneration(path);
    expect(store.save({ learner: { transitions: [{ server: 's' }] }, ruleFeedback: {} })).toBe(true);
    expect(existsSync(path)).toBe(false);
    expect(store.diagnostics.staleGenerationSaves).toBe(1);
  });

  it('clear all invalidates a live store that loaded before its state file existed', () => {
    const root = dir();
    const path = join(root, 'state-0123456789abcdef.json');
    const store = new StateStore(path, () => 100);
    expect(store.load()).toBeNull();
    expect(runMemory({ action: 'clear', all: true, json: true }, {
      directory: root, write: () => {},
    })).toBe(0);
    expect(store.save({
      learner: { transitions: [] },
      ruleFeedback: { preclear: { hits: 1, wasted: 0, speculated: 1 } },
    })).toBe(true);
    expect(existsSync(path)).toBe(false);
    expect(store.diagnostics.staleGenerationSaves).toBe(1);
  });

  it('discovers and removes current-format temp-only managed state', () => {
    const root = dir();
    const temp = join(
      root,
      'state-0123456789abcdef.json.123.456.550e8400-e29b-41d4-a716-446655440000.tmp',
    );
    const unknown = join(root, 'state-0123456789abcdef.json.123.456.not-a-generated-uuid.tmp');
    writeFileSync(temp, 'learned-canary');
    writeFileSync(unknown, 'unknown');
    expect(runMemory({ action: 'clear', all: true, json: true }, {
      directory: root, write: () => {},
    })).toBe(0);
    expect(existsSync(temp)).toBe(false);
    expect(readFileSync(unknown, 'utf8')).toBe('unknown');
  });

  it('resolves and clears only a configured custom state path', () => {
    const root = dir();
    const custom = join(root, 'nested', 'learned.json');
    mkdirSync(join(root, 'nested'));
    writeFileSync(custom, '{}');
    writeFileSync(join(root, 'keep.json'), 'keep');
    const output: string[] = [];
    const code = runMemory(
      { action: 'clear', configPath: 'speculate.config.json', json: true },
      {
        cwd: root,
        directory: join(root, 'managed'),
        write: (text) => output.push(text),
        load: (() => ({
          mode: 'strict', maxPredictionsPerTrigger: 3, log: 'off', servers: {},
          persistence: { enabled: true, path: 'nested/learned.json', retentionDays: 7, maxBytes: 65_536 },
        })) as never,
      },
    );
    expect(code).toBe(0);
    expect(existsSync(custom)).toBe(false);
    expect(readFileSync(join(root, 'keep.json'), 'utf8')).toBe('keep');
    expect(JSON.parse(output.join(''))).toMatchObject({ scope: custom, cleared: 1, failed: 0 });
  });

  it('refuses a linked generation marker without deleting state or its target', () => {
    const root = dir();
    const state = join(root, 'state.json');
    const outside = join(dir(), 'outside.txt');
    writeFileSync(state, '{}');
    writeFileSync(outside, 'outside');
    try { symlinkSync(outside, `${state}.generation`); } catch { return; }
    const output: string[] = [];
    runMemory(
      { action: 'clear', configPath: 'config.json', json: true },
      {
        cwd: root,
        write: (text) => output.push(text),
        load: (() => ({ mode: 'strict', maxPredictionsPerTrigger: 3, log: 'off', servers: {}, persistence: { path: state } })) as never,
      },
    );
    expect(readFileSync(state, 'utf8')).toBe('{}');
    expect(readFileSync(outside, 'utf8')).toBe('outside');
    expect(JSON.parse(output.join(''))).toMatchObject({ cleared: 0, skipped: 1 });
  });

  it('does not traverse a linked usage directory', () => {
    const root = dir();
    const outside = dir();
    const record = join(outside, '1-12345678-abcd.json');
    writeFileSync(record, JSON.stringify({ version: 1, sessionId: 'x', source: 'mcp', counters: {} }));
    try { symlinkSync(outside, join(root, 'usage'), process.platform === 'win32' ? 'junction' : 'dir'); } catch { return; }
    const output: string[] = [];
    expect(runMemory({ action: 'clear', all: true, json: true }, {
      directory: root, write: (text) => output.push(text),
    })).toBe(1);
    expect(existsSync(record)).toBe(true);
    expect(JSON.parse(output.join(''))).toMatchObject({ failed: 1 });
    expect(inventoryMemory(root).usage.files).toBe(0);
  });

  it('recovers a stale usage lock and supports a zero-wait attempt', () => {
    const usage = join(dir(), 'usage');
    mkdirSync(usage);
    const lock = usageMemoryLockPath(usage);
    writeFileSync(lock, 'stale');
    const old = new Date(Date.now() - 31_000);
    utimesSync(lock, old, old);
    expect(withUsageMemoryLock(usage, () => 42, 0)).toEqual({ acquired: true, value: 42 });
    expect(existsSync(lock)).toBe(false);
  });

  it('reports malformed extreme timestamps and counters without throwing', () => {
    const root = dir();
    writeFileSync(join(root, 'state-0123456789abcdef.json'), JSON.stringify({
      version: 1, savedAt: 1e100, learner: { transitions: [], openers: [] }, ruleFeedback: {},
      memory: { removedSensitive: 1e100, removedExpired: -3, removedInvalid: 'bad' },
    }));
    const output: string[] = [];
    expect(runMemory({ action: 'status', json: false }, { directory: root, write: (text) => output.push(text) })).toBe(0);
    expect(output.join('')).not.toContain('saved ');
    const item = inventoryMemory(root).stateFiles[0]!;
    expect(item.savedAt).toBeNull();
    expect(item.removedSensitive).toBe(Number.MAX_SAFE_INTEGER);
    expect(item.removedExpired).toBe(0);
  });
});
