/**
 * The per-group tool denylist: the operator's file is validated strictly,
 * and `materializeContainerJson` writes the group's entry into the
 * container.json the agent-runner reads. Installed by the add-tool-denylist
 * skill; goes red if the call in `src/container-config.ts` is removed.
 */
import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_DIR = '/tmp/nanoclaw-test-tool-denylist';

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual('../../config.js');
  return {
    ...actual,
    DATA_DIR: '/tmp/nanoclaw-test-tool-denylist/data',
    GROUPS_DIR: '/tmp/nanoclaw-test-tool-denylist/groups',
  };
});

const { parseToolDenylist, toolDenylistFor } = await import('./index.js');
const { closeDb, createAgentGroup, initTestDb, runMigrations } = await import('../../db/index.js');
const { ensureContainerConfig } = await import('../../db/container-configs.js');
const { materializeContainerJson } = await import('../../container-config.js');

const FILE = path.join(TEST_DIR, 'data', 'tool-denylist.json');

beforeEach(() => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  fs.mkdirSync(path.join(TEST_DIR, 'data'), { recursive: true });
});
afterEach(() => fs.rmSync(TEST_DIR, { recursive: true, force: true }));

describe('parseToolDenylist', () => {
  it('accepts tool names and MCP patterns, deduplicated', () => {
    expect(parseToolDenylist('{"ag-1":["WebSearch","WebSearch","mcp__x__*"]}')).toEqual({
      'ag-1': ['WebSearch', 'mcp__x__*'],
    });
  });

  it('refuses anything that is not a map of tool-name lists', () => {
    expect(() => parseToolDenylist('[]')).toThrow();
    expect(() => parseToolDenylist('{"ag-1":"WebSearch"}')).toThrow();
    expect(() => parseToolDenylist('{"ag-1":["Web Search"]}')).toThrow();
    expect(() => parseToolDenylist('{"ag-1":[""]}')).toThrow();
    expect(() => parseToolDenylist('{"ag-1":[3]}')).toThrow();
    expect(() => parseToolDenylist('not json')).toThrow();
  });
});

describe('toolDenylistFor', () => {
  it('is empty when the file is absent or the group is not listed', () => {
    expect(toolDenylistFor('ag-1', undefined, FILE)).toEqual([]);
    fs.writeFileSync(FILE, '{"ag-2":["WebSearch"]}');
    expect(toolDenylistFor('ag-1', undefined, FILE)).toEqual([]);
  });

  it('refuses a listed group whose provider cannot honor the list', () => {
    fs.writeFileSync(FILE, '{"ag-1":["WebSearch"]}');
    expect(toolDenylistFor('ag-1', 'claude', FILE)).toEqual(['WebSearch']);
    expect(() => toolDenylistFor('ag-1', 'codex', FILE)).toThrow(/cannot switch them off/);
    expect(toolDenylistFor('ag-2', 'codex', FILE)).toEqual([]);
  });

  it('fails closed on a malformed file', () => {
    fs.writeFileSync(FILE, '{"ag-1":["WebSearch",}');
    expect(() => toolDenylistFor('ag-1', undefined, FILE)).toThrow();
  });
});

describe('materializeContainerJson', () => {
  beforeEach(async () => {
    const db = await initTestDb();
    await runMigrations(db);
    await createAgentGroup({
      id: 'ag-1',
      name: 'Architect',
      folder: 'architect',
      agent_provider: null,
      created_at: new Date().toISOString(),
    });
    await ensureContainerConfig('ag-1');
  });
  afterEach(async () => closeDb());

  it('writes the group entry into container.json as disallowedTools', async () => {
    fs.writeFileSync(FILE, '{"ag-1":["WebSearch"]}');
    await materializeContainerJson('ag-1');
    const written = JSON.parse(fs.readFileSync(path.join(TEST_DIR, 'groups', 'architect', 'container.json'), 'utf8'));
    expect(written.disallowedTools).toEqual(['WebSearch']);
  });

  it('writes no key when the group has no entry', async () => {
    await materializeContainerJson('ag-1');
    const written = JSON.parse(fs.readFileSync(path.join(TEST_DIR, 'groups', 'architect', 'container.json'), 'utf8'));
    expect(written).not.toHaveProperty('disallowedTools');
  });
});
