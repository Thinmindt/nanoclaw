/**
 * The GitHub status commands must work for an agent whose cli_scope is `group`.
 *
 * Drives the REAL dispatch (guard included) as a group-scoped agent against a real test DB. Dispatch
 * auto-fills `agent_group_id` / `group` for such agents, and the guard denies commands whose resource is
 * outside the group whitelist, so either regression shows up here as a refused or failed call. The only
 * fake is the external edge: a stand-in `onecli` binary.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../modules/approvals/index.js', () => ({
  registerApprovalHandler: vi.fn(),
  requestApproval: vi.fn(),
}));

vi.mock('../../container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
  isContainerRunning: vi.fn().mockReturnValue(false),
  getActiveContainerCount: vi.fn().mockReturnValue(0),
  killContainer: vi.fn(),
  buildAgentGroupImage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../container-restart.js', () => ({
  restartAgentGroupContainers: vi.fn().mockResolvedValue(0),
}));

// Hermetic: never read the install's real .env, which may configure live repositories.
vi.mock('../../env.js', () => ({ readEnvFile: () => ({}) }));

import { closeDb, createAgentGroup, initTestDb, runMigrations } from '../../db/index.js';
import { ensureContainerConfig, getContainerConfig } from '../../db/container-configs.js';
import '../commands/index.js';
import { dispatch } from '../dispatch.js';
import type { CallerContext } from '../frame.js';

const OWN = 'ag-project-manager';
const agent: CallerContext = { caller: 'agent', sessionId: 's', agentGroupId: OWN, messagingGroupId: 'm' };
const ENV_KEYS = [
  'GITHUB_STATUS_OWNER_LOGIN',
  'GITHUB_STATUS_REPOS',
  'GITHUB_STATUS_GATEWAY_AGENT',
  'GITHUB_STATUS_AGENT_GROUPS',
  'ONECLI_BIN',
] as const;
const saved: Record<string, string | undefined> = {};
let dir: string;

beforeEach(async () => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'github-scope-'));
  const bin = path.join(dir, 'onecli');
  fs.writeFileSync(
    bin,
    [
      '#!/bin/sh',
      'for last; do :; done',
      'case "$last" in',
      `  */issues?*) printf '[{"number":2,"title":"Bug","state":"open","user":{"login":"owner"}}]\\n200' ;;`,
      `  *) printf '[]\\n200' ;;`,
      'esac',
    ].join('\n'),
    { mode: 0o755 },
  );
  process.env.GITHUB_STATUS_OWNER_LOGIN = 'owner';
  process.env.GITHUB_STATUS_REPOS = 'demo=owner/demo-repo';
  process.env.GITHUB_STATUS_GATEWAY_AGENT = 'github-status-tool';
  process.env.GITHUB_STATUS_AGENT_GROUPS = OWN;
  process.env.ONECLI_BIN = bin;

  await runMigrations(await initTestDb());
  await createAgentGroup({
    id: OWN,
    name: OWN,
    folder: OWN,
    agent_provider: null,
    created_at: new Date().toISOString(),
  });
  await ensureContainerConfig(OWN);
});

afterEach(async () => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  await closeDb();
});

describe('github-* under cli_scope=group', () => {
  it('runs for a group-scoped agent through the real guard and dispatch', async () => {
    expect((await getContainerConfig(OWN))?.cli_scope).toBe('group');

    const res = await dispatch({ id: 'req-1', command: 'github-issue-status', args: { repo: 'demo' } }, agent);

    expect(res.ok).toBe(true);
    expect(res).toMatchObject({ data: { issues: [{ number: 2, title: 'Bug' }] } });
    expect((res as { human?: string }).human).toContain('#2 open "Bug" (owner)');
  });

  it('accepts the flags as the CLI sends them', async () => {
    const res = await dispatch({ id: 'req-2', command: 'github-pr-status', args: { repo: 'demo', all: true } }, agent);
    expect(res).toMatchObject({ ok: true, data: { scope: 'all', pulls: [] } });
    const repos = await dispatch({ id: 'req-3', command: 'github-repos', args: {} }, agent);
    expect(repos).toMatchObject({ ok: true, data: [{ name: 'demo' }] });
  });
});
