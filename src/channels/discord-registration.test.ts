/**
 * Integration test for the discord channel's single reach-in: the self-registration
 * import in the `src/channels/index.ts` barrel. Importing the barrel runs discord.ts's
 * top-level `registerChannelAdapter('discord', …)` and its DISCORD_INSTANCES loop;
 * without the import the channel is silently absent.
 *
 * Behavior, not structural: it imports the real barrel and asserts the registry
 * actually contains the channel. This reflects what happens at host boot — if the
 * `import './discord.js';` line is deleted, or the barrel fails to evaluate for any
 * reason (so the channel genuinely would not register), this goes red. A structural
 * check of the import line would falsely pass in that second case.
 *
 * Importing the barrel is safe: registration is a pure top-level call, and discord.ts
 * builds the SDK adapter / bridge only inside its factory (invoked at host startup),
 * never at import. It does require the adapter package (`@chat-adapter/discord`) to be installed,
 * which holds in a composed install: the skill's `pnpm install` step runs before this
 * test — so this test also implicitly guards that dependency (an unmocked import throws
 * if the package is missing).
 *
 * discord is a Chat SDK channel: discord.ts also consumes a load-bearing *core* API —
 * `createChatSdkBridge(...)` from ./chat-sdk-bridge.js. That core-consumption is a
 * typed call, so the build/typecheck leg (`pnpm run build`) guards it against upstream
 * drift, not this test. Every Chat SDK channel follows this same shape.
 *
 * One bot per agent group. Under guard, each with its kill condition:
 *  1. The DISCORD_INSTANCES loop: every valid name registers as `discord-<name>`
 *     after the default `discord` (registry insertion order is boot order); a name
 *     outside ^[a-z0-9][a-z0-9-]*$ is skipped. Delete the loop and the keys vanish.
 *  2. The shared declaration: every instance carries DISCORD_DEFAULTS. Drop
 *     `defaults:` from the loop and hasDeclaredChannelDefaults() turns false.
 *  3. Per-entry credentials: DISCORD_*_<NAME> (uppercased, dashes to underscores)
 *     build `discord-<name>`; a name with no token, or a token without its public
 *     key or application id, returns null so only that bot is skipped.
 *  4. Per-entry setup: a value Discord rejects fails that bot's setup with its
 *     instance key in the error (the registry logs it per entry and moves on), before
 *     the bridge connects anything.
 *
 * DISCORD_INSTANCES is read from `.env` at module import (readEnvFile reads
 * process.cwd()/.env, never process.env), so the test chdirs into a temp dir
 * carrying a crafted .env BEFORE dynamically importing the barrel. Vitest's
 * per-file process isolation keeps the chdir and the module cache local to this
 * file. fetch is stubbed so the setup check never reaches Discord.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { ChannelSetup } from './adapter.js';
import { getChannelDefaults, getRegisteredChannelNames, hasDeclaredChannelDefaults } from './channel-registry.js';

const originalCwd = process.cwd();
const KEY = 'a'.repeat(64);

/** Shaped fake values only. Each token maps to the application record Discord would return for it. */
const records: Record<string, { status: number; body?: Record<string, string> }> = {
  'default-token': { status: 200, body: { id: '100', verify_key: KEY } },
  'architect-token': { status: 200, body: { id: '200', verify_key: KEY } },
  'revoked-token': { status: 401 },
  'other-app-token': { status: 200, body: { id: '999', verify_key: KEY } },
  'other-key-token': { status: 200, body: { id: '400', verify_key: 'b'.repeat(64) } },
};

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'discord-instances-'));
  writeFileSync(
    join(dir, '.env'),
    [
      'DISCORD_INSTANCES=architect,code-reviewer,revoked,other-app,other-key,no-key,absent,Bad_Name',
      'DISCORD_BOT_TOKEN=default-token',
      `DISCORD_PUBLIC_KEY=${KEY}`,
      'DISCORD_APPLICATION_ID=100',
      'DISCORD_BOT_TOKEN_ARCHITECT=architect-token',
      `DISCORD_PUBLIC_KEY_ARCHITECT=${KEY}`,
      'DISCORD_APPLICATION_ID_ARCHITECT=200',
      'DISCORD_BOT_TOKEN_CODE_REVIEWER=code-reviewer-token',
      `DISCORD_PUBLIC_KEY_CODE_REVIEWER=${KEY}`,
      'DISCORD_APPLICATION_ID_CODE_REVIEWER=300',
      'DISCORD_BOT_TOKEN_REVOKED=revoked-token',
      `DISCORD_PUBLIC_KEY_REVOKED=${KEY}`,
      'DISCORD_APPLICATION_ID_REVOKED=500',
      'DISCORD_BOT_TOKEN_OTHER_APP=other-app-token',
      `DISCORD_PUBLIC_KEY_OTHER_APP=${KEY}`,
      'DISCORD_APPLICATION_ID_OTHER_APP=600',
      'DISCORD_BOT_TOKEN_OTHER_KEY=other-key-token',
      `DISCORD_PUBLIC_KEY_OTHER_KEY=${KEY}`,
      'DISCORD_APPLICATION_ID_OTHER_KEY=400',
      // A token with neither its public key nor its application id.
      'DISCORD_BOT_TOKEN_NO_KEY=no-key-token',
      '',
    ].join('\n'),
  );
  process.chdir(dir);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init?: { headers?: Record<string, string> }) => {
      const token = (init?.headers?.Authorization ?? '').replace(/^Bot /, '');
      const record = records[token] ?? { status: 500 };
      return new Response(record.body ? JSON.stringify(record.body) : '{}', { status: record.status });
    }),
  );
  await import('./index.js'); // the real barrel — triggers every channel's self-registration
});

afterAll(() => {
  vi.unstubAllGlobals();
  process.chdir(originalCwd);
});

describe('discord channel registration', () => {
  it('registers discord via the channel barrel', () => {
    expect(getRegisteredChannelNames()).toContain('discord');
  });

  it('registers a discord-<name> adapter per DISCORD_INSTANCES entry, after the default bot', () => {
    const names = getRegisteredChannelNames();
    for (const key of ['discord-architect', 'discord-code-reviewer', 'discord-no-key', 'discord-absent']) {
      expect(names).toContain(key);
      expect(names.indexOf('discord')).toBeLessThan(names.indexOf(key));
    }
    // Outside ^[a-z0-9][a-z0-9-]*$: skipped, not registered under any key.
    expect(names.filter((n) => n.toLowerCase() === 'discord-bad_name')).toEqual([]);
  });

  it("every instance registration declares the default bot's DISCORD_DEFAULTS (not the core fallback)", () => {
    for (const key of ['discord-architect', 'discord-code-reviewer']) {
      expect(hasDeclaredChannelDefaults(key)).toBe(true);
      expect(getChannelDefaults(key)).toEqual(getChannelDefaults('discord'));
      expect(getChannelDefaults(key).group).toMatchObject({ engageMode: 'mention-sticky', threads: true });
    }
  });
});

describe('instance factory (via the shared createDiscordBridge)', () => {
  // Imported only once this describe starts, AFTER the barrel import above: a static
  // import of ./discord.js would run the registration as a side effect of this file
  // (with the original cwd's .env) and mask a deleted barrel line.
  let discord: typeof import('./discord.js');
  beforeAll(async () => {
    discord = await import('./discord.js');
  });

  it("builds the default bot from the unsuffixed keys under the 'discord' key", () => {
    const adapter = discord.createDiscordBridge();
    expect(adapter).toMatchObject({ name: 'discord', channelType: 'discord' });
    expect(adapter!.instance).toBeUndefined();
  });

  it('builds a named instance from DISCORD_*_<NAME> (uppercased, dashes to underscores)', () => {
    expect(discord.discordInstanceBridgeFactory('architect')).toMatchObject({
      name: 'discord-architect',
      channelType: 'discord',
      instance: 'discord-architect',
    });
    expect(discord.discordInstanceBridgeFactory('code-reviewer')).toMatchObject({
      instance: 'discord-code-reviewer',
    });
  });

  it('returns null for a name with no token: the registry "credentials missing" path', () => {
    expect(discord.discordInstanceBridgeFactory('absent')).toBeNull();
  });

  it('returns null for a token without its public key or application id', () => {
    expect(discord.discordInstanceBridgeFactory('no-key')).toBeNull();
  });
});

describe('per-bot credential check at setup', () => {
  let discord: typeof import('./discord.js');
  beforeAll(async () => {
    discord = await import('./discord.js');
  });

  const setup = {} as ChannelSetup;

  it.each([
    ['revoked', /'discord-revoked': Discord rejected the bot token \(401\)/],
    ['other-app', /'discord-other-app': application id does not match/],
    ['other-key', /'discord-other-key': public key does not match/],
  ])('fails only the %s bot, naming its instance', async (name, message) => {
    const adapter = discord.discordInstanceBridgeFactory(name);
    expect(adapter).not.toBeNull();
    await expect(adapter!.setup(setup)).rejects.toThrow(message);
  });
});
