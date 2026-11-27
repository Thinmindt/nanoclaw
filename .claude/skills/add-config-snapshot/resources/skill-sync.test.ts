/**
 * The add-config-snapshot skill's resources are the canonical copies; src/config-snapshot/ holds the
 * applied result. Fail as soon as the two drift apart, so an edit made on one side only can't be lost.
 */
import fs from 'fs';
import path from 'path';

import { describe, expect, it } from 'vitest';

const SKILL = path.join('.claude', 'skills', 'add-config-snapshot', 'resources');
const FILES = ['snapshot.ts', 'snapshot.test.ts', 'main.ts', 'skill-sync.test.ts'];

describe('add-config-snapshot skill copies', () => {
  it.each(FILES)('resources/%s matches src/config-snapshot/%s', (file) => {
    expect(fs.readFileSync(path.join('src', 'config-snapshot', file), 'utf-8')).toBe(
      fs.readFileSync(path.join(SKILL, file), 'utf-8'),
    );
  });
});
