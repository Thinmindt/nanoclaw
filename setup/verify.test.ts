import { describe, expect, it } from 'vitest';

import { determineVerifyStatus, discordInstanceAuth, discordInstanceKeys } from './verify.js';

const healthyBase = {
  service: 'running' as const,
  credentials: 'configured',
  registeredGroups: 1,
};

describe('determineVerifyStatus', () => {
  it('accepts a healthy install with at least one wired agent group', () => {
    expect(determineVerifyStatus(healthyBase)).toBe('success');
  });

  it('fails when no agent groups are registered', () => {
    expect(
      determineVerifyStatus({
        ...healthyBase,
        registeredGroups: 0,
      }),
    ).toBe('failed');
  });

  // Deferred wire (Teams): configured but zero groups is pending operator
  // action (first DM), not a broken install — success, not failed.
  it('accepts zero groups when wiring is pending a first DM', () => {
    expect(
      determineVerifyStatus({
        ...healthyBase,
        registeredGroups: 0,
        wiringPending: true,
      }),
    ).toBe('success');
  });

  it('pending wiring never rescues a stopped service or missing credentials', () => {
    expect(
      determineVerifyStatus({
        ...healthyBase,
        registeredGroups: 0,
        wiringPending: true,
        service: 'stopped',
      }),
    ).toBe('failed');
    expect(
      determineVerifyStatus({
        ...healthyBase,
        registeredGroups: 0,
        wiringPending: true,
        credentials: 'missing',
      }),
    ).toBe('failed');
  });

  it('fails when the service is not running', () => {
    expect(
      determineVerifyStatus({
        ...healthyBase,
        service: 'stopped',
      }),
    ).toBe('failed');
  });

  it('fails when credentials are missing', () => {
    expect(
      determineVerifyStatus({
        ...healthyBase,
        credentials: 'missing',
      }),
    ).toBe('failed');
  });
});

describe('named Discord bots (DISCORD_INSTANCES)', () => {
  it('reads the three suffixed keys of every valid name, dashes to underscores', () => {
    expect(discordInstanceKeys('architect, code-reviewer,Bad_Name')).toEqual([
      'DISCORD_BOT_TOKEN_ARCHITECT',
      'DISCORD_PUBLIC_KEY_ARCHITECT',
      'DISCORD_APPLICATION_ID_ARCHITECT',
      'DISCORD_BOT_TOKEN_CODE_REVIEWER',
      'DISCORD_PUBLIC_KEY_CODE_REVIEWER',
      'DISCORD_APPLICATION_ID_CODE_REVIEWER',
    ]);
    expect(discordInstanceKeys(undefined)).toEqual([]);
  });

  it('reports each bot as configured, incomplete, or not at all', () => {
    const set = new Set([
      'DISCORD_BOT_TOKEN_ARCHITECT',
      'DISCORD_PUBLIC_KEY_ARCHITECT',
      'DISCORD_APPLICATION_ID_ARCHITECT',
      'DISCORD_BOT_TOKEN_STEWARD',
    ]);
    expect(discordInstanceAuth('architect,steward,scout', (key) => set.has(key))).toEqual({
      'discord-architect': 'configured',
      'discord-steward': 'incomplete',
    });
  });
});
