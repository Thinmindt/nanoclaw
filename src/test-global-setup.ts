import fs from 'fs';

// Removes the per-run temp root that vitest.config.ts made, with everything the tests left in it.
export function teardown(): void {
  fs.rmSync(process.env.TEST_TMP!, { recursive: true });
}
