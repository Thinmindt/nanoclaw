/**
 * The add-github-status skill's resources are the canonical copies; src/ holds the applied result.
 * If someone edits one side only, a rebuild from the skill would silently revert (or never get) the
 * change. Fail as soon as the two drift apart.
 */
import fs from 'fs';
import path from 'path';

import { describe, expect, it } from 'vitest';

const SKILL = path.join('.claude', 'skills', 'add-github-status', 'resources');
const PAIRS: [string, string][] = [
  ['github-status.ts', 'src/github-status.ts'],
  ['github-status.test.ts', 'src/github-status.test.ts'],
  ['github-status-skill-sync.test.ts', 'src/github-status-skill-sync.test.ts'],
  ['github.ts', 'src/cli/resources/github.ts'],
  ['github-registration.test.ts', 'src/cli/resources/github-registration.test.ts'],
  ['github-group-scope.test.ts', 'src/cli/resources/github-group-scope.test.ts'],
];

describe('add-github-status skill copies', () => {
  it.each(PAIRS)('resources/%s matches %s', (resource, applied) => {
    const canonical = path.join(SKILL, resource);
    expect(fs.existsSync(canonical), `missing ${canonical}`).toBe(true);
    expect(fs.readFileSync(applied, 'utf-8')).toBe(fs.readFileSync(canonical, 'utf-8'));
  });
});
