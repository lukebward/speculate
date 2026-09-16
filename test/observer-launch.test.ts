import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/packageResources.js', () => ({
  sessionObserverHookPath: () => "/tmp/it's/hook.mjs",
}));

import { observerHookCommand } from '../src/agentAdapters/observerLaunch.js';

describe('observer launch plumbing', () => {
  it('shell-quotes apostrophes in the packaged hook path', () => {
    expect(observerHookCommand()).toContain("'/tmp/it'\\''s/hook.mjs'");
  });
});
