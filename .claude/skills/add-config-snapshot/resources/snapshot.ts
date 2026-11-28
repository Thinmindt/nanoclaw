/**
 * A read-only, secret-free snapshot of the live config that decides who can reach whom, written for
 * the Project Manager to read (the `add-config-snapshot` skill).
 *
 * Inputs: the central DB opened read-only, the mount allowlist, the gateway's agent list with each
 * agent's secret and connection ids (`/v1/agents/<id>/secrets` and `/connections`), its published
 * rule list, and from the env file only the access flags in `ENV_FLAGS`, through `readEnvFile`,
 * which returns just the keys asked for; the gateway key is never asked for. Never the gateway's
 * secrets or connections lists.
 * `src/config.ts` reads every key it knows from the env file, so its paths are not used here.
 *
 * `checkSnapshot` decides whether a snapshot may be written; `writeSnapshot` writes only after it
 * passes, so a refused or failed run leaves the last good copy in place.
 */
import fs from 'fs';
import path from 'path';

import Database from 'better-sqlite3';

import { looksLikeCredential } from '../drivers/types.js';
import { readEnvFile } from '../env.js';

type Row = Record<string, unknown>;

/** The env flags that decide which agent groups may use a host tool: lists of group ids. */
const ENV_FLAGS = ['CALENDAR_TOOL_AGENT_GROUPS', 'GITHUB_STATUS_AGENT_GROUPS', 'PLAYGROUND_AGENT_GROUPS'];

const QUERIES = {
  agentGroups: 'SELECT id, name, folder FROM agent_groups ORDER BY id',
  agentMessagePolicies:
    'SELECT from_agent_group_id, to_agent_group_id, approver FROM agent_message_policies ORDER BY 1, 2',
  wirings: 'SELECT * FROM messaging_group_agents ORDER BY id',
  messagingGroups: 'SELECT id, channel_type, name, unknown_sender_policy FROM messaging_groups ORDER BY id',
  destinations: 'SELECT agent_group_id, local_name, target_type, target_id FROM agent_destinations ORDER BY 1, 2',
  containerConfigs: 'SELECT agent_group_id, cli_scope, additional_mounts FROM container_configs ORDER BY 1',
};

/**
 * Every key the snapshot may hold, by path (`[]` for an array element). A key outside this list
 * refuses the whole snapshot: a column a migration adds, or a field a new gateway version returns,
 * is read by the operator and listed here before it reaches the Project Manager.
 */
export const ALLOWED_KEYS = new Set([
  'written',
  'gatewayPin',
  'agentGroups',
  'agentGroups[].id',
  'agentGroups[].name',
  'agentGroups[].folder',
  'agentMessagePolicies',
  'agentMessagePolicies[].from_agent_group_id',
  'agentMessagePolicies[].to_agent_group_id',
  'agentMessagePolicies[].approver',
  'wirings',
  ...[
    'id',
    'messaging_group_id',
    'agent_group_id',
    'session_mode',
    'priority',
    'created_at',
    'engage_mode',
    'engage_pattern',
    'sender_scope',
    'ignored_message_policy',
    'threads',
  ].map((column) => `wirings[].${column}`),
  'messagingGroups',
  'messagingGroups[].id',
  'messagingGroups[].channel_type',
  'messagingGroups[].name',
  'messagingGroups[].unknown_sender_policy',
  'destinations',
  'destinations[].agent_group_id',
  'destinations[].local_name',
  'destinations[].target_type',
  'destinations[].target_id',
  'containerConfigs',
  'containerConfigs[].agent_group_id',
  'containerConfigs[].cli_scope',
  'containerConfigs[].additional_mounts',
  'containerConfigs[].additional_mounts[].hostPath',
  'containerConfigs[].additional_mounts[].containerPath',
  'containerConfigs[].additional_mounts[].readonly',
  'mountAllowlistRoots',
  'mountAllowlistRoots[].path',
  'mountAllowlistRoots[].allowReadWrite',
  'envFlags',
  ...ENV_FLAGS.map((flag) => `envFlags.${flag}`),
  'gatewayAgents',
  'gatewayAgents[].id',
  'gatewayAgents[].identifier',
  'gatewayAgents[].name',
  'gatewayAgents[].secretIds',
  'gatewayAgents[].connectionIds',
  // The published rules exactly as gateway 1.42.0's list endpoint returns them.
  'gatewayRules',
  ...[
    'id',
    'scope',
    'status',
    'generation',
    'priority',
    'enabled',
    'isDefault',
    'logicalId',
    'source',
    'name',
    'description',
    'action',
    'rateLimit',
    'rateLimitWindow',
    'requireApproval',
    'conditions',
    'identities',
    'identities[].type',
    'identities[].id',
    'targets',
    'targets[].kind',
    'targets[].hostPattern',
    'targets[].pathPattern',
    'targets[].method',
    'targets[].secretId',
    'targets[].secretScope',
    'targets[].connectionId',
    'targets[].tools',
    'createdAt',
  ].map((key) => `gatewayRules[].${key}`),
]);

/** Each problem names a key path, never a value, so a refusal can be logged safely. */
export function checkSnapshot(value: unknown, at = ''): string[] {
  if (typeof value === 'string') return looksLikeCredential(value) ? [`credential-shaped value at ${at}`] : [];
  if (Array.isArray(value)) return value.flatMap((item) => checkSnapshot(item, `${at}[]`));
  if (value === null || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([key, child]) => {
    const keyPath = at ? `${at}.${key}` : key;
    return ALLOWED_KEYS.has(keyPath) ? checkSnapshot(child, keyPath) : [`unknown key ${keyPath}`];
  });
}

/** Valid JSON whose first line carries the write time and the gateway pin. */
export function renderSnapshot(written: string, gatewayPin: string, body: Row): string {
  const header = `{"written":${JSON.stringify(written)},"gatewayPin":${JSON.stringify(gatewayPin)},`;
  return header + JSON.stringify(body, null, 2).slice(1) + '\n';
}

function readDb(dbPath: string): Row {
  const db = new Database(dbPath, { readonly: true });
  const sections: Row = {};
  for (const [name, sql] of Object.entries(QUERIES)) sections[name] = db.prepare(sql).all();
  db.close();
  sections.containerConfigs = (sections.containerConfigs as Row[]).map((c) => ({
    ...c,
    additional_mounts: JSON.parse(c.additional_mounts as string),
  }));
  return sections;
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url} → HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

/** A field picked by name; one the source stopped returning refuses the snapshot instead of going missing. */
function field(row: Row, key: string): unknown {
  if (row[key] === undefined) throw new Error(`snapshot refused, nothing written: missing field ${key}`);
  return row[key];
}

/** The host's rule for a root (normalizeRoot, src/modules/mount-security/index.ts): allowReadWrite, else !readOnly, else read-only. */
function allowsReadWrite(root: Row): boolean {
  if (typeof root.allowReadWrite === 'boolean') return root.allowReadWrite;
  if (typeof root.readOnly === 'boolean') return !root.readOnly;
  return false;
}

async function readGateway(gatewayUrl: string): Promise<Row> {
  const agents = await getJson<Row[]>(`${gatewayUrl}/v1/agents`);
  const gatewayAgents = await Promise.all(
    agents.map(async (a) => ({
      id: field(a, 'id'),
      identifier: field(a, 'identifier'),
      name: field(a, 'name'),
      secretIds: await getJson(`${gatewayUrl}/v1/agents/${a.id}/secrets`),
      connectionIds: (await getJson<Row[]>(`${gatewayUrl}/v1/agents/${a.id}/connections`)).map((c) =>
        field(c, 'appConnectionId'),
      ),
    })),
  );
  return { gatewayAgents, gatewayRules: await getJson(`${gatewayUrl}/v1/policy/rules?status=published`) };
}

export interface SnapshotPaths {
  dbPath: string;
  allowlistPath: string;
  gatewayUrl: string;
  /** The add-onecli skill's versions.json, which pins the gateway version. */
  pinPath: string;
  /** The folder holding the env file. */
  projectRoot: string;
  outDir: string;
}

/** Writes `<outDir>/<UTC date>.json` and `<outDir>/latest.json`, each by rename; returns the dated path. */
export async function writeSnapshot(paths: SnapshotPaths, now: Date): Promise<string> {
  const allowlist = JSON.parse(fs.readFileSync(paths.allowlistPath, 'utf-8')) as { allowedRoots: Row[] };
  const body = {
    ...readDb(paths.dbPath),
    mountAllowlistRoots: allowlist.allowedRoots.map((r) => ({
      path: field(r, 'path'),
      allowReadWrite: allowsReadWrite(r),
    })),
    envFlags: readEnvFile(ENV_FLAGS, paths.projectRoot),
    ...(await readGateway(paths.gatewayUrl)),
  };
  const pin = JSON.parse(fs.readFileSync(paths.pinPath, 'utf-8'))['onecli-gateway'];
  const text = renderSnapshot(now.toISOString(), pin, body);
  const problems = checkSnapshot(JSON.parse(text));
  if (problems.length > 0) throw new Error(`snapshot refused, nothing written:\n${problems.join('\n')}`);

  const dated = path.join(paths.outDir, `${now.toISOString().slice(0, 10)}.json`);
  for (const file of [dated, path.join(paths.outDir, 'latest.json')]) {
    fs.writeFileSync(`${file}.tmp`, text);
    fs.renameSync(`${file}.tmp`, file);
  }
  return dated;
}
