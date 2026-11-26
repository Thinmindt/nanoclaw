/**
 * The add-scout-gate skill's resources are the canonical copies; this folder and the two seat-lines
 * files under src/cli/resources/ hold the applied result. Fail as soon as the two drift apart, so an edit made on one side only can't be lost.
 * The property tests beside this file are not copied: they need fast-check, which the skill does
 * not install.
 */
import fs from 'fs';
import path from 'path';

import { describe, expect, it } from 'vitest';

const RESOURCES = path.join('.claude', 'skills', 'add-scout-gate', 'resources');
const SKILL = path.join(RESOURCES, 'a2a-gate');
const FILES = [
  'index.ts',
  'scrub.ts',
  'inbound.ts',
  'scrub.test.ts',
  'inbound.test.ts',
  'gate.test.ts',
  'skill-sync.test.ts',
];
/** The `ncl seat-lines` command and its agreement tests, installed under src/cli/resources/. */
const CLI_FILES = ['seat-lines.ts', 'seat-lines.test.ts'];

describe('add-scout-gate skill copies', () => {
  it.each(FILES)('resources/a2a-gate/%s matches src/modules/a2a-gate/%s', (file) => {
    expect(fs.readFileSync(path.join('src', 'modules', 'a2a-gate', file))).toEqual(
      fs.readFileSync(path.join(SKILL, file)),
    );
  });
  it.each(CLI_FILES)('resources/%s matches src/cli/resources/%s', (file) => {
    expect(fs.readFileSync(path.join('src', 'cli', 'resources', file))).toEqual(
      fs.readFileSync(path.join(RESOURCES, file)),
    );
  });
});
