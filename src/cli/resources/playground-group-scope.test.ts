/**
 * Integration guard for the add-playground skill: `playground-run` is registered through the real
 * command barrel and works for an agent whose cli_scope is `group`, through the real guard and dispatch,
 * against a real test DB. The only fake is the external edge: a stand-in `docker` binary that answers
 * like the sandbox runner. Delete the barrel line, or break the group gate, and these go red.
 */
import fs from 'fs';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ROOT = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync } = require('fs') as typeof import('fs');
  return mkdtempSync('/tmp/playground-scope-');
});

// The edge the result goes out through: a waking message to the agent's session.
const notified = vi.hoisted(() => ({ messages: [] as { sessionId: string; text: string }[] }));
vi.mock('../../modules/approvals/index.js', () => ({
  registerApprovalHandler: vi.fn(),
  requestApproval: vi.fn(),
  notifyAgent: vi.fn(async (session: { id: string }, text: string) => {
    notified.messages.push({ sessionId: session.id, text });
  }),
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
// Hermetic: never read the install's real .env.
vi.mock('../../env.js', () => ({ readEnvFile: () => ({}) }));
vi.mock('../../config.js', async () => {
  const actual = await vi.importActual('../../config.js');
  return { ...actual, GROUPS_DIR: path.join(ROOT, 'groups') };
});

import { closeDb, createAgentGroup, initTestDb, runMigrations } from '../../db/index.js';
import { createSession } from '../../db/sessions.js';
import { ensureContainerConfig, getContainerConfig } from '../../db/container-configs.js';
import '../commands/index.js';
import { dispatch } from '../dispatch.js';
import type { CallerContext } from '../frame.js';
import { lookup } from '../registry.js';

const OWN = 'ag-steward';
const agent = (agentGroupId: string): CallerContext => ({
  caller: 'agent',
  sessionId: 's',
  agentGroupId,
  messagingGroupId: 'm',
});
const ENV_KEYS = ['PLAYGROUND_AGENT_GROUPS', 'PLAYGROUND_DOCKER_BIN', 'PLAYGROUND_IMAGE'] as const;
const saved: Record<string, string | undefined> = {};
const groupDir = path.join(ROOT, 'groups', 'steward');

beforeEach(async () => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  fs.mkdirSync(groupDir, { recursive: true });
  fs.writeFileSync(path.join(groupDir, 'main.js'), 'console.log("hi");\n');
  const bin = path.join(ROOT, 'docker');
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString('base64');
  fs.writeFileSync(
    bin,
    [
      '#!/bin/sh',
      `printf '%s\\n' "$@" > "${ROOT}/args"`,
      `echo '{"kind":"result","exit":0,"timed_out":false,"log":"ran"}'`,
      `echo '{"kind":"frame","name":"frame-000001.png","b64":"${png}"}'`,
    ].join('\n'),
    { mode: 0o755 },
  );
  process.env.PLAYGROUND_AGENT_GROUPS = OWN;
  process.env.PLAYGROUND_DOCKER_BIN = bin;

  await runMigrations(await initTestDb());
  await createAgentGroup({
    id: OWN,
    name: 'Steward',
    folder: 'steward',
    agent_provider: null,
    created_at: new Date().toISOString(),
  });
  await ensureContainerConfig(OWN);
  await createSession({
    id: 's',
    agent_group_id: OWN,
    messaging_group_id: null,
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'running',
    last_active: null,
    created_at: new Date().toISOString(),
  });
  notified.messages = [];
});

afterEach(async () => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  await closeDb();
});

describe('playground-run', () => {
  it('is registered open to agents, with no resource so group scope can reach it', () => {
    const cmd = lookup('playground-run');
    expect(cmd?.access).toBe('open');
    expect(cmd?.resource).toBeUndefined();
  });

  it('starts for a group-scoped agent through the real guard and dispatch, and the result wakes it', async () => {
    expect((await getContainerConfig(OWN))?.cli_scope).toBe('group');
    const res = await dispatch(
      { id: 'r1', command: 'playground-run', args: { dir: '/workspace/agent', entry: 'main.js' } },
      agent(OWN),
    );
    expect(res).toMatchObject({ ok: true, data: { started: true } });
    await vi.waitFor(() => expect(notified.messages).toHaveLength(1));
    expect(notified.messages[0].sessionId).toBe('s');
    expect(notified.messages[0].text).toMatch(/exit 0[\s\S]*frame-000001\.png[\s\S]*ran/);
    const args = fs.readFileSync(path.join(ROOT, 'args'), 'utf-8').split('\n');
    expect(args).toContain('none');
    expect(args).toContain('8g');
    expect(fs.readdirSync(path.join(groupDir, 'playground'))).toHaveLength(1);
  });

  it('refuses agent groups not listed in the configuration', async () => {
    await createAgentGroup({
      id: 'ag-other',
      name: 'Other',
      folder: 'other',
      agent_provider: null,
      created_at: new Date().toISOString(),
    });
    await ensureContainerConfig('ag-other');
    const res = await dispatch(
      { id: 'r2', command: 'playground-run', args: { dir: '.', entry: 'main.js' } },
      agent('ag-other'),
    );
    expect(res).toMatchObject({ ok: false });
    expect(JSON.stringify(res)).toMatch(/not allowed/);
  });
});
