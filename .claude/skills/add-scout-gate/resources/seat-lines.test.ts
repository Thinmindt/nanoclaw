/**
 * `ncl seat-lines` against the real a2a.send guard: each case goes through both, and each test asserts
 * the named decision on both sides. These tests are the alarm if the listing and the guard drift apart.
 * Installed by the add-scout-gate skill.
 */
import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ensureContainerConfig, updateContainerConfigScalars } from '../../db/container-configs.js';
import { closeDb, createAgentGroup, initTestDb, runMigrations } from '../../db/index.js';
import { guard } from '../../guard/index.js';
import { createDestination } from '../../modules/agent-to-agent/db/agent-destinations.js';
import { setMessagePolicy } from '../../modules/agent-to-agent/db/agent-message-policies.js';
import { a2aSend } from '../../modules/agent-to-agent/guard.js';
import { commandGuard } from '../registry.js';
import { listSeatLines } from './seat-lines.js';

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual('../../config.js');
  return { ...actual, DATA_DIR: `${process.env.TEST_TMP}/nanoclaw-test-seat-lines` };
});

const TEST_DIR = `${process.env.TEST_TMP}/nanoclaw-test-seat-lines`;
const ARCHITECT = 'ag-architect';
const SCOUT = 'ag-scout';
const PM = 'ag-pm';
const GONE = 'ag-gone';
const NAMES: Record<string, string> = { [ARCHITECT]: 'Architect', [SCOUT]: 'Scout', [PM]: 'Project Manager' };

function now(): string {
  return new Date().toISOString();
}

function line(from: string, to: string, localName = to) {
  return createDestination({
    agent_group_id: from,
    local_name: localName,
    target_type: 'agent',
    target_id: to,
    created_at: now(),
  });
}

/** What the guard does with a message on this line that passes the Scout gate's content check. */
async function guardEffect(from: string, to: string): Promise<string> {
  const decision = await guard(a2aSend, {
    actor: { kind: 'agent', agentGroupId: from },
    resource: { from, to },
    payload: { id: 'msg-1', platform_id: to, content: JSON.stringify({ text: 'a clean question' }) },
  });
  return decision.effect;
}

async function listed(from: string, to: string): Promise<string | undefined> {
  const rows = await listSeatLines();
  return rows.find((r) => r.from === (NAMES[from] ?? from) && r.to === (NAMES[to] ?? to))?.decision;
}

describe('ncl seat-lines agrees with the a2a.send guard', () => {
  beforeEach(async () => {
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
    fs.mkdirSync(path.join(TEST_DIR, 'a2a-gate'), { recursive: true });
    fs.writeFileSync(path.join(TEST_DIR, 'a2a-gate', 'private-terms'), 'hollyhock\n');
    fs.writeFileSync(path.join(TEST_DIR, 'a2a-gate', 'canaries'), 'zebra-umbrella-42\n');
    const db = await initTestDb();
    await runMigrations(db);
    for (const [id, name] of Object.entries(NAMES)) {
      await createAgentGroup({ id, name, folder: id, agent_provider: null, created_at: now() });
    }
  });

  afterEach(async () => {
    await closeDb();
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  });

  it('(a) a line into the Scout with a policy is held, not refused', async () => {
    await line(ARCHITECT, SCOUT);
    await setMessagePolicy(ARCHITECT, SCOUT, 'user:owner', now());
    expect(await guardEffect(ARCHITECT, SCOUT)).toBe('hold');
    expect(await listed(ARCHITECT, SCOUT)).toBe('held');
  });

  it('(b) a line into the Scout with no policy is refused', async () => {
    await line(ARCHITECT, SCOUT);
    expect(await guardEffect(ARCHITECT, SCOUT)).toBe('deny');
    expect(await listed(ARCHITECT, SCOUT)).toBe('refused');
  });

  it('(c) a line between two ordinary seats with no policy is free flow', async () => {
    await line(ARCHITECT, PM);
    expect(await guardEffect(ARCHITECT, PM)).toBe('allow');
    expect(await listed(ARCHITECT, PM)).toBe('free flow');
  });

  it('(d) a line whose target is no seat is refused, and printed with its raw id', async () => {
    await line(ARCHITECT, GONE);
    expect(await guardEffect(ARCHITECT, GONE)).toBe('deny');
    expect(await listed(ARCHITECT, GONE)).toBe('refused, no such seat');
  });

  it.each([
    ['with no policy', false],
    ['with a policy', true],
  ])("(e) the Scout's line to itself is allowed and printed free flow, self, %s", async (_, policy) => {
    await line(SCOUT, SCOUT);
    if (policy) await setMessagePolicy(SCOUT, SCOUT, 'user:owner', now());
    expect(await guardEffect(SCOUT, SCOUT)).toBe('allow');
    expect(await listed(SCOUT, SCOUT)).toBe('free flow, self');
  });

  it('prints one row per pair of seats, adds the folder where names repeat, and leaves out channel lines', async () => {
    await createAgentGroup({
      id: 'ag-pm-2',
      name: 'Project Manager',
      folder: 'pm-two',
      agent_provider: null,
      created_at: now(),
    });
    await line(ARCHITECT, PM, 'pm');
    await line(ARCHITECT, PM, 'plumb');
    await line(PM, 'ag-pm-2');
    await createDestination({
      agent_group_id: ARCHITECT,
      local_name: 'room',
      target_type: 'channel',
      target_id: 'mg-1',
      created_at: now(),
    });
    expect(await listSeatLines()).toEqual([
      { from: 'Architect', to: `Project Manager (${PM})`, decision: 'free flow' },
      { from: `Project Manager (${PM})`, to: 'Project Manager (pm-two)', decision: 'free flow' },
    ]);
  });

  it('is refused to an agent caller, even one with global CLI scope', async () => {
    await ensureContainerConfig(ARCHITECT);
    await updateContainerConfigScalars(ARCHITECT, { cli_scope: 'global' });
    const decision = await guard(commandGuard('seat-lines'), {
      actor: { kind: 'agent', agentGroupId: ARCHITECT },
      payload: {},
    });
    expect(decision.effect).toBe('deny');
  });
});
