/**
 * Integration guard for the add-github-status skill.
 *
 * Imports the REAL command barrel (no mocks of the command module) and drives the `github-*`
 * commands through the registry exactly as dispatch does: lookup → parseArgs → handler. The only
 * fake is the external edge, a stand-in `onecli` binary that records its arguments and answers like
 * GitHub. Delete the barrel line and the lookup fails; break the handler's config, group gate or
 * gateway call and the assertions below go red.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import '../commands/index.js';
import { lookup } from '../registry.js';

// Hermetic: never read the install's real .env, which may configure live repositories.
vi.mock('../../env.js', () => ({ readEnvFile: () => ({}) }));

const ENV_KEYS = [
  'GITHUB_STATUS_OWNER_LOGIN',
  'GITHUB_STATUS_REPOS',
  'GITHUB_STATUS_GATEWAY_AGENT',
  'GITHUB_STATUS_AGENT_GROUPS',
  'ONECLI_BIN',
] as const;
const saved: Record<string, string | undefined> = {};

let dir: string;
let fakeOnecli: string;

beforeAll(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'github-status-'));
  fakeOnecli = path.join(dir, 'onecli');
  const pulls = JSON.stringify([
    {
      number: 4,
      title: 'Add thing',
      state: 'open',
      user: { login: 'owner' },
      head: { ref: 'thing', sha: 'abc' },
      base: { ref: 'main' },
      updated_at: '2026-10-11T00:00:00Z',
    },
  ]);
  fs.writeFileSync(path.join(dir, 'pulls.json'), pulls);
  fs.writeFileSync(
    fakeOnecli,
    [
      '#!/bin/sh',
      `printf '%s\\n' "$@" >> "${dir}/args"`,
      'for last; do :; done',
      'case "$last" in',
      `  */pulls?*) cat "${dir}/pulls.json"; printf '\\n200' ;;`,
      `  */check-runs*) printf '{"check_runs":[{"name":"ci","status":"completed","conclusion":"success"}]}\\n200' ;;`,
      `  *) printf '[]\\n200' ;;`,
      'esac',
    ].join('\n'),
    { mode: 0o755 },
  );
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

function configure(): void {
  process.env.GITHUB_STATUS_OWNER_LOGIN = 'owner';
  process.env.GITHUB_STATUS_REPOS = 'demo=owner/demo-repo';
  process.env.GITHUB_STATUS_GATEWAY_AGENT = 'github-status-tool';
  process.env.GITHUB_STATUS_AGENT_GROUPS = 'ag-allowed';
  process.env.ONECLI_BIN = fakeOnecli;
}

const agent = (agentGroupId: string) =>
  ({ caller: 'agent', sessionId: 's', agentGroupId, messagingGroupId: 'm' }) as const;

describe('github-* registration', () => {
  it('registers the three commands through the real barrel, open to agents, without a resource', () => {
    for (const name of ['github-repos', 'github-pr-status', 'github-issue-status']) {
      const cmd = lookup(name);
      expect(cmd, name).toBeDefined();
      expect(cmd?.access).toBe('open');
      // No resource: keeps the command reachable under cli_scope=group (see github-group-scope.test.ts).
      expect(cmd?.resource).toBeUndefined();
    }
  });

  it('fetches pull request status through the gateway as the tool identity, with GET only', async () => {
    configure();
    fs.rmSync(path.join(dir, 'args'), { force: true });
    const cmd = lookup('github-pr-status')!;
    const result = (await cmd.handler(cmd.parseArgs({ repo: 'demo' }), agent('ag-allowed'))) as {
      pulls: { number: number; title: string; checks: { passed: number } }[];
    };

    expect(result.pulls).toHaveLength(1);
    expect(result.pulls[0]).toMatchObject({ number: 4, title: 'Add thing', checks: { passed: 1 } });
    const calls = fs
      .readFileSync(path.join(dir, 'args'), 'utf-8')
      .split('run\n')
      .filter(Boolean)
      .map((c) => c.split('\n'));
    expect(calls.length).toBeGreaterThanOrEqual(3); // list, reviews, check-runs
    for (const args of calls) {
      expect(args.slice(0, 2)).toEqual(['--agent', 'github-status-tool']);
      expect(args[args.indexOf('-X') + 1]).toBe('GET');
      expect(args.find((a) => a.startsWith('https://'))).toMatch(
        /^https:\/\/api\.github\.com\/repos\/owner\/demo-repo\//,
      );
    }
  });

  it('lists the configured repositories', async () => {
    configure();
    const cmd = lookup('github-repos')!;
    expect(await cmd.handler(cmd.parseArgs({}), agent('ag-allowed'))).toEqual([
      { name: 'demo', repository: 'owner/demo-repo' },
    ]);
  });

  it('refuses unknown flags before any gateway call', async () => {
    configure();
    fs.rmSync(path.join(dir, 'args'), { force: true });
    const cmd = lookup('github-pr-status')!;
    expect(() => cmd.parseArgs({ repo: 'demo', body: 'x' })).toThrow(/unknown field --body/);
    expect(fs.existsSync(path.join(dir, 'args'))).toBe(false);
  });

  it('refuses agent groups not listed in the configuration', async () => {
    configure();
    const cmd = lookup('github-issue-status')!;
    await expect(cmd.handler(cmd.parseArgs({ repo: 'demo' }), agent('ag-other'))).rejects.toThrow(/not allowed/);
  });

  it('explains how to configure it when settings are missing', async () => {
    for (const k of ENV_KEYS) delete process.env[k];
    const cmd = lookup('github-pr-status')!;
    await expect(cmd.handler(cmd.parseArgs({ repo: 'demo' }), { caller: 'host' })).rejects.toThrow(/not configured/);
  });
});
