import fs from 'fs';
import http from 'http';
import type { AddressInfo } from 'net';
import os from 'os';
import path from 'path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SqliteDriver } from '../db/drivers/sqlite.js';
import { runMigrations } from '../db/migrations/index.js';
import { writeSnapshot, type SnapshotPaths } from './snapshot.js';

const NOW = new Date('2026-11-27T10:40:00Z');
// Assembled at run time so no secret scanner reads a token-shaped literal in the source.
const TOKEN_SHAPED = 'ghp_' + 'x'.repeat(36);

const AGENT = {
  id: 'gw-1',
  name: 'PM',
  identifier: 'pm',
  accessToken: 'agent-access-token',
  isDefault: false,
  secretMode: 'selective',
  createdAt: '2026-11-01T00:00:00.000Z',
  _count: { agentSecrets: 1, agentAppConnections: 1 },
};
const RULE = {
  id: 'r-1',
  scope: 'project',
  status: 'published',
  generation: 3,
  priority: 1,
  enabled: true,
  isDefault: false,
  logicalId: 'l-1',
  source: 'api',
  name: 'Seat sites: pm',
  description: null,
  action: 'allow',
  rateLimit: null,
  rateLimitWindow: null,
  requireApproval: false,
  conditions: null,
  identities: [{ type: 'agent', id: 'gw-1' }],
  targets: [{ kind: 'network', hostPattern: 'example.org', pathPattern: '/docs/*', method: 'GET' }],
  createdAt: '2026-11-01T00:00:00.000Z',
};

let dir: string;
let paths: SnapshotPaths;
let server: http.Server;
let requested: string[];
let gateway: { agents: unknown[]; rules: unknown[] };

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'config-snapshot-'));
  const out = path.join(dir, 'out');
  fs.mkdirSync(out);

  const raw = new Database(path.join(dir, 'v2.db'));
  await runMigrations(new SqliteDriver(raw));
  raw.exec(`
    INSERT INTO agent_groups (id, name, folder, created_at) VALUES
      ('ag-arch', 'Architect', 'architect', 't'), ('ag-pm', 'PM', 'pm', 't');
    INSERT INTO container_configs (agent_group_id, additional_mounts, updated_at) VALUES
      ('ag-pm', '[{"hostPath":"/home/u/workbench","containerPath":"workbench","readonly":false}]', 't');
    INSERT INTO messaging_groups (id, channel_type, platform_id, instance, name, unknown_sender_policy, created_at)
      VALUES ('mg-1', 'discord', 'c-1', 'default', '#pm', 'strict', 't');
    INSERT INTO messaging_group_agents (id, messaging_group_id, agent_group_id, created_at)
      VALUES ('w-1', 'mg-1', 'ag-pm', 't');
    INSERT INTO agent_message_policies (from_agent_group_id, to_agent_group_id, approver, created_at)
      VALUES ('ag-pm', 'ag-arch', 'discord:owner', 't');
    INSERT INTO agent_destinations (agent_group_id, local_name, target_type, target_id, created_at)
      VALUES ('ag-pm', 'architect', 'agent', 'ag-arch', 't');
  `);
  raw.close();

  const allowlist = { allowedRoots: [{ path: '/home/u/repos', allowReadWrite: false, description: 'mirrors' }] };
  fs.writeFileSync(path.join(dir, 'mount-allowlist.json'), JSON.stringify({ ...allowlist, blockedPatterns: [] }));
  fs.writeFileSync(path.join(dir, 'versions.json'), JSON.stringify({ 'onecli-gateway': '1.42.0' }));

  gateway = { agents: [AGENT], rules: [RULE] };
  requested = [];
  const routes: Record<string, () => unknown> = {
    '/v1/agents': () => gateway.agents,
    '/v1/agents/gw-1/secrets': () => ['sec-1'],
    '/v1/agents/gw-1/connections': () => [{ appConnectionId: 'conn-1', sessionPolicy: {} }],
    '/v1/policy/rules?status=published': () => gateway.rules,
  };
  server = http.createServer((req, res) => {
    requested.push(`${req.method} ${req.url}`);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(routes[req.url!]()));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

  paths = {
    dbPath: path.join(dir, 'v2.db'),
    allowlistPath: path.join(dir, 'mount-allowlist.json'),
    gatewayUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    pinPath: path.join(dir, 'versions.json'),
    outDir: out,
  };
});

afterEach(async () => {
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('writeSnapshot', () => {
  it('writes a dated file and latest, with the write time and gateway pin on line one and only the listed fields', async () => {
    const dated = await writeSnapshot(paths, NOW);

    expect(dated).toBe(path.join(paths.outDir, '2026-11-27.json'));
    const text = fs.readFileSync(dated, 'utf-8');
    expect(fs.readFileSync(path.join(paths.outDir, 'latest.json'), 'utf-8')).toBe(text);
    expect(text.split('\n')[0]).toBe('{"written":"2026-11-27T10:40:00.000Z","gatewayPin":"1.42.0",');
    expect(JSON.parse(text)).toEqual({
      written: '2026-11-27T10:40:00.000Z',
      gatewayPin: '1.42.0',
      agentGroups: [
        { id: 'ag-arch', name: 'Architect', folder: 'architect' },
        { id: 'ag-pm', name: 'PM', folder: 'pm' },
      ],
      agentMessagePolicies: [{ from_agent_group_id: 'ag-pm', to_agent_group_id: 'ag-arch', approver: 'discord:owner' }],
      wirings: [
        {
          id: 'w-1',
          messaging_group_id: 'mg-1',
          agent_group_id: 'ag-pm',
          session_mode: 'shared',
          priority: 0,
          created_at: 't',
          engage_mode: null,
          engage_pattern: null,
          sender_scope: null,
          ignored_message_policy: null,
          threads: null,
        },
      ],
      messagingGroups: [{ id: 'mg-1', channel_type: 'discord', name: '#pm', unknown_sender_policy: 'strict' }],
      destinations: [{ agent_group_id: 'ag-pm', local_name: 'architect', target_type: 'agent', target_id: 'ag-arch' }],
      containerConfigs: [
        {
          agent_group_id: 'ag-pm',
          cli_scope: 'group',
          additional_mounts: [{ hostPath: '/home/u/workbench', containerPath: 'workbench', readonly: false }],
        },
      ],
      mountAllowlistRoots: [{ path: '/home/u/repos', allowReadWrite: false }],
      gatewayAgents: [{ id: 'gw-1', identifier: 'pm', name: 'PM', secretIds: ['sec-1'], connectionIds: ['conn-1'] }],
      gatewayRules: [RULE],
    });
    // Only the gateway's agent and rule lists are read: no secrets endpoint.
    expect(requested.sort()).toEqual([
      'GET /v1/agents',
      'GET /v1/agents/gw-1/connections',
      'GET /v1/agents/gw-1/secrets',
      'GET /v1/policy/rules?status=published',
    ]);
  });

  it('replaces latest by rename, so a reader holding the old copy never sees it rewritten in place', async () => {
    await writeSnapshot(paths, NOW);
    const latest = path.join(paths.outDir, 'latest.json');
    const held = path.join(dir, 'held.json');
    fs.linkSync(latest, held);
    const old = fs.readFileSync(held, 'utf-8');

    await writeSnapshot(paths, new Date('2026-11-28T10:40:00Z'));

    expect(fs.readFileSync(held, 'utf-8')).toBe(old);
    expect(fs.readFileSync(latest, 'utf-8')).not.toBe(old);
  });

  it.each([
    ['an unknown key', () => (gateway.rules = [{ ...RULE, planted: 'x' }]), 'unknown key gatewayRules[].planted'],
    [
      'a prefix-shaped value',
      () => (gateway.agents = [{ ...AGENT, name: TOKEN_SHAPED }]),
      'credential-shaped value at gatewayAgents[].name',
    ],
  ])('refuses a snapshot with %s and leaves the last good copy', async (_case, plant, problem) => {
    await writeSnapshot(paths, NOW);
    const good = fs.readFileSync(path.join(paths.outDir, 'latest.json'), 'utf-8');

    plant();
    await expect(writeSnapshot(paths, new Date('2026-11-28T10:40:00Z'))).rejects.toThrow(problem);

    expect(fs.readFileSync(path.join(paths.outDir, 'latest.json'), 'utf-8')).toBe(good);
    expect(fs.readdirSync(paths.outDir)).toEqual(['2026-11-27.json', 'latest.json']);
  });
});
