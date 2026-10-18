/**
 * The add-calendar-tool skill's resources are the canonical copies; src/ holds the applied result.
 * If someone edits one side only, a rebuild from the skill would silently revert (or never get) the
 * change. Fail as soon as the two drift apart.
 */
import fs from 'fs';
import path from 'path';

import { describe, expect, it } from 'vitest';

const SKILL = path.join('.claude', 'skills', 'add-calendar-tool', 'resources');
const PAIRS: [string, string][] = [
  ['calendar-tool.ts', 'src/calendar-tool.ts'],
  ['calendar-tool.test.ts', 'src/calendar-tool.test.ts'],
  ['calendar-tool-skill-sync.test.ts', 'src/calendar-tool-skill-sync.test.ts'],
  ['calendar.ts', 'src/cli/resources/calendar.ts'],
  ['calendar-registration.test.ts', 'src/cli/resources/calendar-registration.test.ts'],
  ['calendar-group-scope.test.ts', 'src/cli/resources/calendar-group-scope.test.ts'],
];

describe('add-calendar-tool skill copies', () => {
  it.each(PAIRS)('resources/%s matches %s', (resource, applied) => {
    const canonical = path.join(SKILL, resource);
    expect(fs.existsSync(canonical), `missing ${canonical}`).toBe(true);
    expect(fs.readFileSync(applied, 'utf-8')).toBe(fs.readFileSync(canonical, 'utf-8'));
  });
});
