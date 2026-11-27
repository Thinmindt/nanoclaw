/**
 * Drift test between CI and the local bar. Every run step of ci.yml's test and
 * skill-pins jobs is either run by scripts/check.sh (in the form below where
 * the local step differs) or on check.sh's "skip:" list with its reason.
 * One-directional: check.sh may run more than CI does.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const root = path.join(__dirname, '..');
const read = (file: string) => fs.readFileSync(path.join(root, file), 'utf8');

// CI steps that check.sh runs in another form.
const LOCAL_FORM: Record<string, string> = {
  // The image's baked node_modules stand in, checked against the lock label build.sh writes.
  'bun install --frozen-lockfile': 'dev.nanoclaw.agent-runner-lock-sha256',
  // The same typecheck, inside the agent image.
  'pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit': 'node_modules/.bin/tsc -p tsconfig.json --noEmit',
};

describe('scripts/check.sh', () => {
  it("runs or skip-lists every run step of ci.yml's test and skill-pins jobs", () => {
    const ci = parse(read('.github/workflows/ci.yml'));
    const lines = read('scripts/check.sh').split('\n');
    const steps = lines.filter((line) => !line.trimStart().startsWith('#'));
    const skips = lines.filter((line) => line.startsWith('# skip: '));
    for (const job of ['test', 'skill-pins']) {
      for (const { run } of ci.jobs[job].steps) {
        if (!run) continue;
        const local = LOCAL_FORM[run] ?? run;
        const covered =
          steps.some((line) => line.includes(local)) || skips.some((line) => line.startsWith(`# skip: ${run} (`));
        expect(covered, `${job}: ${run}`).toBe(true);
      }
    }
  });
});
