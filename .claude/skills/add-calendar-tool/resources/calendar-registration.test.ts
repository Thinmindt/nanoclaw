/**
 * Integration guard for the add-calendar-tool skill.
 *
 * Imports the REAL command barrel (no mocks of the command module) and drives
 * `calendar-create-event` through the registry exactly as dispatch does:
 * lookup → parseArgs → handler. The only fake is the external edge, a stand-in
 * `onecli` binary that records its arguments and stdin and answers like Google.
 * Delete the barrel line and the lookup fails; break the handler's config,
 * group gate or gateway call and the assertions below go red.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import '../commands/index.js';
import { lookup } from '../registry.js';

// Hermetic: never read the install's real .env, which may configure a live calendar.
vi.mock('../../env.js', () => ({ readEnvFile: () => ({}) }));

const ENV_KEYS = [
  'CALENDAR_TOOL_CALENDAR_ID',
  'CALENDAR_TOOL_CONNECTION_ID',
  'CALENDAR_TOOL_GATEWAY_AGENT',
  'CALENDAR_TOOL_AGENT_GROUPS',
  'ONECLI_BIN',
  'TZ',
] as const;
const saved: Record<string, string | undefined> = {};

let dir: string;
let fakeOnecli: string;

beforeAll(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'calendar-tool-'));
  fakeOnecli = path.join(dir, 'onecli');
  fs.writeFileSync(
    fakeOnecli,
    [
      '#!/bin/sh',
      `printf '%s\\n' "$@" > "${dir}/args"`,
      `cat > "${dir}/stdin"`,
      `printf '{"id":"evt-1","htmlLink":"https://calendar.google.com/e/1","summary":"Vet"}\\n200'`,
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
  process.env.CALENDAR_TOOL_CALENDAR_ID = 'cal-1@group.calendar.google.com';
  process.env.CALENDAR_TOOL_CONNECTION_ID = 'conn-1';
  process.env.CALENDAR_TOOL_GATEWAY_AGENT = 'calendar-event-tool';
  process.env.CALENDAR_TOOL_AGENT_GROUPS = 'ag-allowed';
  process.env.ONECLI_BIN = fakeOnecli;
  process.env.TZ = 'America/Los_Angeles';
}

const agent = (agentGroupId: string) =>
  ({ caller: 'agent', sessionId: 's', agentGroupId, messagingGroupId: 'm' }) as const;

function inAWeek(): string {
  const d = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  return `${d.toISOString().slice(0, 10)}T15:00`;
}

describe('calendar-create-event registration', () => {
  it('is registered through the real command barrel, open to agents', () => {
    const cmd = lookup('calendar-create-event');
    expect(cmd).toBeDefined();
    expect(cmd?.access).toBe('open');
    // No resource: keeps the command reachable under cli_scope=group (see calendar-group-scope.test.ts).
    expect(cmd?.resource).toBeUndefined();
  });

  it('creates an event through the gateway as the tool identity, with no guests', async () => {
    configure();
    const cmd = lookup('calendar-create-event')!;
    const result = await cmd.handler(cmd.parseArgs({ title: 'Vet', start: inAWeek() }), agent('ag-allowed'));

    expect(result).toMatchObject({ id: 'evt-1', htmlLink: 'https://calendar.google.com/e/1' });
    const args = fs.readFileSync(path.join(dir, 'args'), 'utf-8').split('\n');
    expect(args.slice(0, 3)).toEqual(['run', '--agent', 'calendar-event-tool']);
    expect(args).toContain('x-onecli-connection-id: conn-1');
    expect(args.find((a) => a.startsWith('https://'))).toContain(
      '/calendars/cal-1%40group.calendar.google.com/events?sendUpdates=none',
    );
    const body = JSON.parse(fs.readFileSync(path.join(dir, 'stdin'), 'utf-8'));
    expect(body.summary).toBe('Vet');
    expect(body).not.toHaveProperty('attendees');
  });

  it('refuses guests before any gateway call', async () => {
    configure();
    fs.rmSync(path.join(dir, 'args'), { force: true });
    const cmd = lookup('calendar-create-event')!;
    await expect(
      cmd.handler(cmd.parseArgs({ title: 'x', start: inAWeek(), attendees: 'a@b.c' }), agent('ag-allowed')),
    ).rejects.toThrow(/cannot add guests/);
    expect(fs.existsSync(path.join(dir, 'args'))).toBe(false);
  });

  it('refuses agent groups not listed in the configuration', async () => {
    configure();
    const cmd = lookup('calendar-create-event')!;
    await expect(cmd.handler(cmd.parseArgs({ title: 'x', start: inAWeek() }), agent('ag-other'))).rejects.toThrow(
      /not allowed/,
    );
  });

  it('explains how to configure it when settings are missing', async () => {
    for (const k of ENV_KEYS) delete process.env[k];
    const cmd = lookup('calendar-create-event')!;
    await expect(cmd.handler(cmd.parseArgs({ title: 'x', start: inAWeek() }), { caller: 'host' })).rejects.toThrow(
      /not configured/,
    );
  });
});
