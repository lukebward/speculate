import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { buildLaunchPlan } from '../../../src/agentAdapters/claude.js';

const root = process.argv[2]!;
const home = join(root, 'home');
const cwd = join(root, 'work');
mkdirSync(home, { recursive: true });
mkdirSync(cwd, { recursive: true });

const coordinates = { socketPath: '/private/observer.sock', capability: 'capability', launchId: 'launch' };
const plan = await buildLaunchPlan({
  cwd,
  home,
  env: { HOME: home, TMPDIR: process.env.TMPDIR },
  clientArgs: [],
  observe: 'hooks',
  relayBaseUrl: null,
  session: coordinates,
  hook: coordinates,
  self: { command: process.execPath, args: [] },
  clientBin: process.execPath,
});
const settingsPath = plan.args[plan.args.indexOf('--settings') + 1]!;
process.stdout.write(`${dirname(settingsPath)}\n`);
await new Promise(() => {});
