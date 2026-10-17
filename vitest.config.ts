import { defineConfig } from 'vitest/config';

// Vitest runs the core's unit specs. The mod's own tests (tests/*.test.ts)
// run inside Claude Code's test kit: `npm run test:mod`.
export default defineConfig({
  test: { include: ['test/**/*.spec.ts'] },
});
