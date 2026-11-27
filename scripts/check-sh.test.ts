/**
 * scripts/check.sh, the local bar. The drift test: every run step of ci.yml's
 * test and skill-pins jobs is either run by check.sh (in the form below where
 * the local step differs) or on its "skip:" list with its reason.
 * One-directional: check.sh may run more than CI does. Then the image check,
 * which must fail rather than let a missing or stale image pass the Bun suite.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const root = path.join(__dirname, '..');
const read = (file: string) => fs.readFileSync(path.join(root, file), 'utf8');

// CI steps that check.sh runs in another form.
const LOCAL_FORM: Record<string, string> = {
  // The image's baked node_modules stand in, checked against the lock label build.sh writes and the image's package.json.
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

  describe('agent image check', () => {
    // A pnpm that passes at once stands in for the host steps, so only the image check runs for real.
    let bin: string;
    beforeAll(() => {
      bin = fs.mkdtempSync(path.join(os.tmpdir(), 'check-sh-'));
      fs.writeFileSync(path.join(bin, 'pnpm'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    });
    afterAll(() => fs.rmSync(bin, { recursive: true, force: true }));

    const check = (runtime: string) =>
      spawnSync('bash', [path.join(root, 'scripts', 'check.sh')], {
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, CONTAINER_RUNTIME: runtime },
        encoding: 'utf8',
      });

    it('fails with a message when the image cannot be read (no runtime, runtime down, or no image)', () => {
      const result = check('false');
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('cannot read the agent image');
    });

    it("fails with a message when the image's lock label is not the checkout's bun.lock", () => {
      // `echo` as the runtime answers the label query with its own arguments, never the lock's hash.
      const result = check('echo');
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('was built from another container/agent-runner/bun.lock');
      // The way out is this checkout's own image, never a rebuild of another install's from here.
      expect(result.stderr).toContain('NANOCLAW_PROJECT_ROOT unset');
    });

    it("fails with a message when the image's runner package.json is not the checkout's", () => {
      // A runtime whose image carries the checkout's lock label but another package.json, as when a
      // dependency changes in package.json and not in bun.lock (CI's frozen bun install fails there).
      const runtime = path.join(bin, 'runtime');
      fs.writeFileSync(
        runtime,
        '#!/bin/sh\ncase "$1" in\n' +
          "  image) shasum -a 256 container/agent-runner/bun.lock | cut -d' ' -f1 ;;\n" +
          "  run) echo '{}' ;;\n" +
          'esac\n',
        { mode: 0o755 },
      );
      const result = check(runtime);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("container/agent-runner/package.json is not the image's");
      // A bare build.sh on a pulled-image install only layers tools on the same image; `build` rebuilds it.
      expect(result.stderr).toContain('container/build.sh build');
    });
  });
});
