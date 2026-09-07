import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { runDoctor } from '../src/doctor.js';
import { StateStore } from '../src/persistence.js';

it('reports retained learning for the current workspace/account scope', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'speculate-doctor-'));
  try {
    const path = join(directory, 'state.json');
    const store = new StateStore(path, Date.now, [], 'current-scope');
    expect(store.save({ learner: { transitions: [] }, ruleFeedback: {} })).toBe(true);
    const lines: string[] = [];
    const config = { mode: 'off', servers: {} } as Parameters<typeof runDoctor>[0];
    await runDoctor(config, path, (line) => lines.push(line), { stateScope: 'current-scope' });
    expect(lines.join('\n')).toContain('0 learned transition(s)');
    expect(lines.join('\n')).not.toContain('cold start');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
