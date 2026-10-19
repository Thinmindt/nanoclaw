/**
 * The add-mirror-refresh skill's resources are the canonical copies; scripts/mirrors/ holds the applied
 * result. Fail as soon as the two drift apart, so an edit made on one side only can't be lost.
 */
import fs from 'fs';
import path from 'path';

import { describe, expect, it } from 'vitest';

const SKILL = path.join('.claude', 'skills', 'add-mirror-refresh', 'resources');
const FILES = [
  'refresh-mirrors.sh',
  'refresh-mirrors.test.ts',
  'nanoclaw-mirror-refresh.service',
  'nanoclaw-mirror-refresh.timer',
  'mirror-refresh-skill-sync.test.ts',
];

describe('add-mirror-refresh skill copies', () => {
  it.each(FILES)('resources/%s matches scripts/mirrors/%s', (file) => {
    const canonical = path.join(SKILL, file);
    expect(fs.existsSync(canonical), `missing ${canonical}`).toBe(true);
    expect(fs.readFileSync(path.join('scripts', 'mirrors', file), 'utf-8')).toBe(fs.readFileSync(canonical, 'utf-8'));
  });
});
