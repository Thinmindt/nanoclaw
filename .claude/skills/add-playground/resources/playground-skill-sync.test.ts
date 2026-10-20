/**
 * The add-playground skill's resources are the canonical copies; src/ and container/playground/ hold
 * the applied result. Fail as soon as the two drift apart.
 */
import fs from 'fs';
import path from 'path';

import { describe, expect, it } from 'vitest';

const SKILL = path.join('.claude', 'skills', 'add-playground', 'resources');
const PAIRS: [string, string][] = [
  ['playground-tool.ts', 'src/playground-tool.ts'],
  ['playground-tool.test.ts', 'src/playground-tool.test.ts'],
  ['playground-skill-sync.test.ts', 'src/playground-skill-sync.test.ts'],
  ['playground.ts', 'src/cli/resources/playground.ts'],
  ['playground-group-scope.test.ts', 'src/cli/resources/playground-group-scope.test.ts'],
  ['Dockerfile', 'container/playground/Dockerfile'],
  ['runner.mjs', 'container/playground/runner.mjs'],
];

describe('add-playground skill copies', () => {
  it.each(PAIRS)('resources/%s matches %s', (resource, applied) => {
    const canonical = path.join(SKILL, resource);
    expect(fs.existsSync(canonical), `missing ${canonical}`).toBe(true);
    expect(fs.readFileSync(applied, 'utf-8')).toBe(fs.readFileSync(canonical, 'utf-8'));
  });
});
