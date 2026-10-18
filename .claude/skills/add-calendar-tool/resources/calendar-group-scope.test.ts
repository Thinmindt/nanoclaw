/**
 * The calendar command must work for an agent whose cli_scope is `group`.
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

// Hermetic: never read the install's real .env, which may configure a live calendar.
vi.mock('../../env.js', () => ({ readEnvFile: () => ({}) }));
vi.mock('../../config.js', async () => {
  const actual = await vi.importActual('../../config.js');
  return { ...actual, TIMEZONE: 'America/Los_Angeles' };
});

import { closeDb, createAgentGroup, initTestDb, runMigrations } from '../../db/index.js';
import { ensureContainerConfig, getContainerConfig, updateContainerConfigScalars } from '../../db/container-configs.js';
import '../commands/index.js';
import { dispatch } from '../dispatch.js';
import type { CallerContext } from '../frame.js';

const OWN = 'ag-steward';
const agent: CallerContext = { caller: 'agent', sessionId: 's', agentGroupId: OWN, messagingGroupId: 'm' };
const ENV_KEYS = [
  'CALENDAR_TOOL_CALENDAR_ID',
  'CALENDAR_TOOL_CONNECTION_ID',
  'CALENDAR_TOOL_GATEWAY_AGENT',
  'CALENDAR_TOOL_AGENT_GROUPS',
  'ONECLI_BIN',
] as const;
const saved: Record<string, string | undefined> = {};
let dir: string;

beforeEach(async () => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'calendar-scope-'));
  const bin = path.join(dir, 'onecli');
  fs.writeFileSync(bin, `#!/bin/sh\ncat > "${dir}/stdin"\nprintf '{"id":"evt-1","summary":"Vet"}\\n200'\n`, {
    mode: 0o755,
  });
  process.env.CALENDAR_TOOL_CALENDAR_ID = 'cal-1@group.calendar.google.com';
  process.env.CALENDAR_TOOL_CONNECTION_ID = 'conn-1';
  process.env.CALENDAR_TOOL_GATEWAY_AGENT = 'calendar-event-tool';
  process.env.CALENDAR_TOOL_AGENT_GROUPS = OWN;
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

function inAWeek(): string {
  return `${new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)}T15:00`;
}

describe('calendar-create-event under cli_scope=group', () => {
  it('runs for a group-scoped agent through the real guard and dispatch', async () => {
    expect((await getContainerConfig(OWN))?.cli_scope).toBe('group');

    const res = await dispatch(
      { id: 'req-1', command: 'calendar-create-event', args: { title: 'Vet', start: inAWeek() } },
      agent,
    );

    expect(res.ok).toBe(true);
    const body = JSON.parse(fs.readFileSync(path.join(dir, 'stdin'), 'utf-8'));
    expect(body.summary).toBe('Vet');
    expect(body).not.toHaveProperty('agent_group_id');
    expect(body).not.toHaveProperty('group');
  });

  it('accepts --all-day as the CLI sends it', async () => {
    const day = inAWeek().slice(0, 10);
    const res = await dispatch(
      { id: 'req-2', command: 'calendar-create-event', args: { title: 'Trip', start: day, 'all-day': true } },
      agent,
    );

    expect(res).toMatchObject({ ok: true });
    const body = JSON.parse(fs.readFileSync(path.join(dir, 'stdin'), 'utf-8'));
    expect(body.start).toEqual({ date: day });
  });

  it('reads local times in the install time zone', async () => {
    const res = await dispatch(
      { id: 'req-3', command: 'calendar-create-event', args: { title: 'x', start: inAWeek() } },
      agent,
    );

    expect(res).toMatchObject({ ok: true });
    const body = JSON.parse(fs.readFileSync(path.join(dir, 'stdin'), 'utf-8'));
    expect(body.start).toMatchObject({ timeZone: 'America/Los_Angeles' });
  });

  it("prefers the agent group's own time zone", async () => {
    await updateContainerConfigScalars(OWN, { timezone: 'America/New_York' });
    const res = await dispatch(
      { id: 'req-4', command: 'calendar-create-event', args: { title: 'x', start: inAWeek() } },
      agent,
    );

    expect(res).toMatchObject({ ok: true });
    const body = JSON.parse(fs.readFileSync(path.join(dir, 'stdin'), 'utf-8'));
    expect(body.start).toMatchObject({ timeZone: 'America/New_York' });
  });
});
