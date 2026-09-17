import { describe, expect, it } from 'vitest';
import { createSecretGuard } from '../src/privacy.js';
import { projectSemanticArguments, SemanticContextStore } from '../src/semanticContext.js';

describe('semantic argument projection', () => {
  it('allowlists JSON values, normalizes workspace paths and redacts historical secrets', () => {
    const guard = createSecretGuard(['known-secret-value']);
    expect(projectSemanticArguments({
      path: '/Users/test/work/project/src/auth.ts',
      authorization: 'Bearer known-secret-value',
      nested: { keep: true, omit: undefined },
    }, {
      guard,
      workspace: '/Users/test/work/project',
      homeDir: '/Users/test',
      rejectRedaction: false,
    })).toEqual({
      path: '<workspace>/src/auth.ts',
      authorization: '[redacted]',
      nested: { keep: true },
    });
  });

  it('omits a candidate when redaction would change its material identity', () => {
    expect(projectSemanticArguments({ path: 'safe', token: 'private-value' }, {
      guard: createSecretGuard(),
      rejectRedaction: true,
    })).toBeNull();
    expect(projectSemanticArguments({ value: BigInt(1) }, {
      guard: createSecretGuard(),
      rejectRedaction: true,
    })).toBeNull();
  });
});

describe('SemanticContextStore', () => {
  it('isolates verified conversations and rejects tasks over 8 KiB instead of truncating them', () => {
    const store = new SemanticContextStore({ launchId: 'launch', now: () => 1_000 });
    expect(store.observePrompt({
      launchId: 'launch', conversationId: 'a', task: 'task a', workspace: '/work/a', revision: 1,
    })).toBe(true);
    expect(store.observePrompt({
      launchId: 'launch', conversationId: 'b', task: 'task b', workspace: '/work/b', revision: 1,
    })).toBe(true);
    expect(store.get('a')?.task).toBe('task a');
    expect(store.get('b')?.task).toBe('task b');
    expect(store.observePrompt({
      launchId: 'other', conversationId: 'a', task: 'wrong launch', revision: 2,
    })).toBe(false);
    expect(store.observePrompt({
      launchId: 'launch', conversationId: 'a', task: 'x'.repeat(8 * 1024 + 1), revision: 2,
    })).toBe(false);
    expect(store.get('a')).toBeNull();
    expect(store.get('b')?.task).toBe('task b');
  });

  it('does not retain a task containing an unredactable credential shape', () => {
    const store = new SemanticContextStore({ launchId: 'launch' });
    expect(store.observePrompt({
      launchId: 'launch', conversationId: 'a',
      task: 'debug api_key=credential-value-1234567890', revision: 1,
    })).toBe(false);
    expect(store.get('a')).toBeNull();
  });

  it('retains only eight bounded completed calls without raw results', () => {
    let now = 1_000;
    const store = new SemanticContextStore({ launchId: 'launch', now: () => now });
    store.observePrompt({
      launchId: 'launch', conversationId: 'conversation', task: 'inspect files',
      workspace: '/Users/test/project', revision: 1,
    });
    for (let index = 0; index < 10; index++) {
      now += 10;
      expect(store.observeCall('conversation', {
        server: 'workspace', tool: 'read_file',
        args: { path: `/Users/test/project/file-${index}.ts` },
        success: index % 2 === 0, completedAt: now,
      })).toBe(true);
    }
    const snapshot = store.get('conversation')!;
    expect(snapshot.recentCalls).toHaveLength(8);
    expect(snapshot.recentCalls[0]).toMatchObject({ args: { path: '<workspace>/file-2.ts' }, relativeMs: 30 });
    expect(JSON.stringify(snapshot)).not.toContain('result');

    expect(store.observeCall('conversation', {
      server: 'workspace', tool: 'read_file', args: { text: 'x'.repeat(2 * 1024) },
      success: true, completedAt: now,
    })).toBe(false);
  });

  it('evicts least-recently-used conversations to satisfy count and launch byte bounds', () => {
    const store = new SemanticContextStore({
      launchId: 'launch',
      now: () => 0,
      limits: { maxConversations: 2, maxLaunchBytes: 700, maxConversationBytes: 500 },
    });
    for (const conversationId of ['a', 'b']) {
      expect(store.observePrompt({
        launchId: 'launch', conversationId, task: conversationId.repeat(100), revision: 1,
      })).toBe(true);
    }
    expect(store.get('a')).not.toBeNull();
    expect(store.observePrompt({
      launchId: 'launch', conversationId: 'c', task: 'c'.repeat(100), revision: 1,
    })).toBe(true);
    expect(store.get('b')).toBeNull();
    expect(store.get('a')).not.toBeNull();
    expect(store.get('c')).not.toBeNull();
  });

  it('invalidates and clears retained context without leaking references', () => {
    const store = new SemanticContextStore({ launchId: 'launch' });
    store.observePrompt({ launchId: 'launch', conversationId: 'a', task: 'task', revision: 1 });
    const copy = store.get('a')!;
    (copy.recentCalls as unknown[]).push({ secret: true });
    expect(store.get('a')?.recentCalls).toEqual([]);
    store.invalidate('a');
    expect(store.get('a')).toBeNull();
    expect(store.observePrompt({
      launchId: 'launch', conversationId: 'a', task: 'replayed revision', revision: 1,
    })).toBe(false);
    expect(store.observePrompt({
      launchId: 'launch', conversationId: 'a', task: 'new revision', revision: 2,
    })).toBe(true);
    store.observePrompt({ launchId: 'launch', conversationId: 'b', task: 'task', revision: 1 });
    store.clear();
    expect(store.get('b')).toBeNull();
  });
});
