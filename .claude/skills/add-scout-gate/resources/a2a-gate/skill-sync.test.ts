/**
 * The add-scout-gate skill's resources are the canonical copies; this folder holds the applied
 * result. Fail as soon as the two drift apart, so an edit made on one side only can't be lost.
 * The property tests beside this file are not copied: they need fast-check, which the skill does
 * not install.
 */
import fs from 'fs';
import path from 'path';

import { describe, expect, it } from 'vitest';

const SKILL = path.join('.claude', 'skills', 'add-scout-gate', 'resources', 'a2a-gate');
const FILES = [
  'index.ts',
  'scrub.ts',
  'inbound.ts',
  'scrub.test.ts',
  'inbound.test.ts',
  'gate.test.ts',
  'skill-sync.test.ts',
];

describe('add-scout-gate skill copies', () => {
  it.each(FILES)('resources/a2a-gate/%s matches src/modules/a2a-gate/%s', (file) => {
    expect(fs.readFileSync(path.join('src', 'modules', 'a2a-gate', file))).toEqual(
      fs.readFileSync(path.join(SKILL, file)),
    );
  });
});
