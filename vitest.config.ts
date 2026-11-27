import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { defineConfig } from 'vitest/config';

// One temp root per run, so two suites running at once (two worktrees) never share a folder.
// Tests write under process.env.TEST_TMP; TMPDIR points os.tmpdir() there too, so every mkdtemp
// lands in it. src/test-global-setup.ts removes the root afterwards.
process.env.TEST_TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-test-run-'));
process.env.TMPDIR = process.env.TEST_TMP;

export default defineConfig({
  test: {
    globalSetup: ['src/test-global-setup.ts'],
    setupFiles: ['src/test-setup.ts'],
    // container/agent-runner tests run under Bun (they depend on bun:sqlite).
    // See container/agent-runner/package.json "test" script.
    // container/*.test.ts: top-level only — container/agent-runner tests run
    // under Bun (they depend on bun:sqlite) and must not be picked up here.
    include: [
      'src/**/*.test.ts',
      'setup/**/*.test.ts',
      'scripts/**/*.test.ts',
      'container/*.test.ts',
      // A gateway skill's own scripts, tested where they live. NOT its
      // `payload/` — those files import as if already installed under `src/`,
      // so they only resolve once the skill has been applied, and the skill
      // runs them itself as its `nc:run effect:test` step.
      '.claude/skills/*/scripts/**/*.test.ts',
    ],
  },
});
