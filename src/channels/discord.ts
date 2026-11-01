/**
 * Discord channel adapter (v2) — uses Chat SDK bridge.
 * Self-registers on import.
 *
 * Additional bot identities (one bot per agent group): set
 * DISCORD_INSTANCES=<name>[,<name>…] plus a per-instance credential set
 * (DISCORD_BOT_TOKEN_<NAME> / DISCORD_PUBLIC_KEY_<NAME> /
 * DISCORD_APPLICATION_ID_<NAME>; name uppercased, dashes → underscores). Each
 * name registers under the `discord-<name>` instance key through the same
 * createDiscordBridge factory as the default bot, which keeps the `discord`
 * key. channelType stays 'discord' either way. Each registration starts or
 * fails on its own: a missing value skips that bot with a warning naming it,
 * and a value Discord rejects fails that bot's setup, never a sibling's.
 */
import { createDiscordAdapter } from '@chat-adapter/discord';

import { readEnvFile } from '../env.js';
import { log } from '../log.js';
import type { ChannelAdapter, ChannelDefaults, ChannelSetup } from './adapter.js';
import { createChatSdkBridge, registerBridgeInboundPolicy, type ReplyContext } from './chat-sdk-bridge.js';
import { registerChannelAdapter } from './channel-registry.js';

/**
 * Dedicated bot app on a threaded platform. group threads:true matches the
 * declared supportsThreads (the skill-installed install-style knob) so
 * mention-sticky engagement stays bounded per-thread. dm.threads:false —
 * DM replies land top-level, one session per DM.
 */
const DISCORD_DEFAULTS: ChannelDefaults = {
  dm: { engageMode: 'pattern', engagePattern: '.', threads: false, unknownSenderPolicy: 'request_approval' },
  group: { engageMode: 'mention-sticky', threads: true, unknownSenderPolicy: 'request_approval' },
  mentions: 'platform',
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractReplyContext(raw: Record<string, any>): ReplyContext | null {
  if (!raw.referenced_message) return null;
  const reply = raw.referenced_message;
  return {
    text: reply.content || '',
    sender: reply.author?.global_name || reply.author?.username || 'Unknown',
  };
}

/**
 * Discord message forwards carry their content in `message_snapshots`, not
 * `content` (`message_reference.type === 1` means FORWARD; 0 is a normal
 * reply). Unwrap the snapshot into the payload, then drop `message_snapshots`
 * so adapters >= 4.38 (which flatten snapshots themselves) don't add it twice.
 * Note: snapshots contain no author, so the original sender is unavailable.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function unwrapForwardedSnapshot(data: Record<string, any>): void {
  if (data.message_reference?.type !== 1) return;
  const snaps = (data.message_snapshots ?? [])
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .map((s: any) => s?.message)
    .filter(Boolean);
  if (snaps.length === 0) return;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const text = snaps
    .map((m: any) => m.content)
    .filter(Boolean)
    .join('\n');
  const label = '[Forwarded message]';
  data.content = text ? `${label}\n${text}` : data.content || label;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fwdAttachments = snaps.flatMap((m: any) => m.attachments ?? []);
  if (fwdAttachments.length > 0) {
    data.attachments = [...(data.attachments ?? []), ...fwdAttachments];
  }
  delete data.message_snapshots;
}

export function unwrapForwards(adapter: ReturnType<typeof createDiscordAdapter>): void {
  const a = adapter as unknown as {
    handleForwardedMessage: (data: Record<string, unknown>, options?: unknown) => Promise<void>;
  };
  const orig = a.handleForwardedMessage.bind(adapter);
  a.handleForwardedMessage = async (data, options) => {
    unwrapForwardedSnapshot(data);
    return orig(data, options);
  };
}

/**
 * Posts by bots, the install's other Discord bots among them, never reach the
 * router. The adapter drops them on its own gateway path, but the bridge
 * forwards gateway events past that check, so the drop is made here, on every
 * Discord bridge through the bridge's inbound-policy hook.
 */
export function dropBotPosts(setup: ChannelSetup, instanceKey: string): ChannelSetup {
  return {
    ...setup,
    onInbound(platformId, threadId, message) {
      const content = message.content as { author?: { isBot?: unknown } } | null;
      if (content?.author?.isBot === true) {
        log.debug('Discord post by a bot dropped', { instance: instanceKey, platformId });
        return;
      }
      return setup.onInbound(platformId, threadId, message);
    },
  };
}

registerBridgeInboundPolicy('discord', dropBotPosts);

/** The three values one bot needs, as configured. */
export interface DiscordCredentials {
  botToken: string;
  publicKey: string;
  applicationId: string;
}

/** Discord's verdict on one bot's configured values. */
export type DiscordCredentialCheck = { ok: true; checked: boolean } | { ok: false; reason: string };

/**
 * Compare Discord's answer to `GET /oauth2/applications/@me` (the bot's own
 * application record, the same call add-discord derives the key and id from)
 * with the configured values. Only a definite answer fails a bot: 401 means
 * the token is wrong; a 200 whose `id` or `verify_key` differs means the
 * application id or public key is. Any other status leaves the bot to start
 * unchecked — a Discord outage at boot must not silence a bot that is fine.
 */
export function checkApplicationRecord(
  status: number,
  record: { id?: unknown; verify_key?: unknown } | null,
  expected: Pick<DiscordCredentials, 'publicKey' | 'applicationId'>,
): DiscordCredentialCheck {
  if (status === 401) return { ok: false, reason: 'Discord rejected the bot token (401)' };
  if (status !== 200 || !record) return { ok: true, checked: false };
  if (record.id !== expected.applicationId) {
    return { ok: false, reason: "application id does not match the token's application" };
  }
  if (record.verify_key !== expected.publicKey) {
    return { ok: false, reason: "public key does not match the token's application" };
  }
  return { ok: true, checked: true };
}

async function verifyDiscordCredentials(creds: DiscordCredentials, instanceKey: string): Promise<void> {
  let res: Response;
  try {
    res = await fetch('https://discord.com/api/v10/oauth2/applications/@me', {
      headers: { Authorization: `Bot ${creds.botToken}` },
    });
  } catch (err) {
    // fetch rejects with a TypeError when Discord cannot be reached at all.
    if (!(err instanceof TypeError)) throw err;
    log.warn('Discord credential check could not reach Discord, starting unchecked', { instance: instanceKey, err });
    return;
  }
  const record =
    res.status === 200 ? ((await res.json().catch(() => null)) as { id?: unknown; verify_key?: unknown } | null) : null;
  const check = checkApplicationRecord(res.status, record, creds);
  if (!check.ok) throw new Error(`Discord bot '${instanceKey}': ${check.reason}`);
  if (!check.checked) {
    log.warn('Discord credential check got no answer, starting unchecked', {
      instance: instanceKey,
      status: res.status,
    });
  }
}

/** Construction knobs for one Discord bot identity. */
export interface DiscordBridgeOptions {
  /**
   * Uppercased/underscored instance suffix appended to each credential env
   * key after an underscore — 'ARCHITECT' reads DISCORD_BOT_TOKEN_ARCHITECT /
   * DISCORD_PUBLIC_KEY_ARCHITECT / DISCORD_APPLICATION_ID_ARCHITECT. Omit for
   * the default bot's unsuffixed keys.
   */
  envKeySuffix?: string;
  /**
   * Registry/bridge instance key (e.g. 'discord-architect'). Omit for the
   * default instance, keyed by channelType.
   */
  instanceKey?: string;
}

/**
 * Build one Discord bot identity's bridge from its credential set. The
 * default bot is the zero-suffix call (used by the registration below); named
 * instances pass a suffix + instance key and get the exact same
 * construction. Returns null when no token is set (the registry's
 * "credentials missing, skipping" path), and also when the token is set but
 * the public key or application id is not, after a warning that names the
 * instance and the missing keys. Setup checks the three values against
 * Discord before connecting, so a wrong one fails this bot's setup with its
 * instance in the error.
 */
export function createDiscordBridge(options: DiscordBridgeOptions = {}): ChannelAdapter | null {
  const suffix = options.envKeySuffix ? `_${options.envKeySuffix}` : '';
  const keys = {
    botToken: `DISCORD_BOT_TOKEN${suffix}`,
    publicKey: `DISCORD_PUBLIC_KEY${suffix}`,
    applicationId: `DISCORD_APPLICATION_ID${suffix}`,
  };
  const env = readEnvFile([keys.botToken, keys.publicKey, keys.applicationId]);
  const instanceKey = options.instanceKey ?? 'discord';
  if (!env[keys.botToken]) return null;
  const missing = [keys.publicKey, keys.applicationId].filter((key) => !env[key]);
  if (missing.length > 0) {
    log.warn('Discord bot credentials incomplete, skipping', { instance: instanceKey, missing });
    return null;
  }
  const creds: DiscordCredentials = {
    botToken: env[keys.botToken],
    publicKey: env[keys.publicKey],
    applicationId: env[keys.applicationId],
  };
  const discordAdapter = createDiscordAdapter(creds);
  unwrapForwards(discordAdapter);
  const bridge = createChatSdkBridge({
    adapter: discordAdapter,
    instance: options.instanceKey, // undefined ⇒ default instance (keyed by channelType)
    concurrency: 'concurrent',
    botToken: creds.botToken,
    extractReplyContext,
    supportsThreads: true,
    defaults: DISCORD_DEFAULTS,
    // Discord rejects messages over 2000 chars; without this the bridge
    // would let long agent replies fail instead of splitting them.
    maxTextLength: 2000,
  });
  return {
    ...bridge,
    async setup(hostConfig: ChannelSetup) {
      await verifyDiscordCredentials(creds, instanceKey);
      return bridge.setup(hostConfig);
    },
  };
}

/** Env-key suffix for a named instance: uppercased, dashes → underscores. */
function instanceEnvKeySuffix(name: string): string {
  return name.toUpperCase().replace(/-/g, '_');
}

/** Named-instance entry into createDiscordBridge; exported for the registration test. */
export function discordInstanceBridgeFactory(name: string): ChannelAdapter | null {
  return createDiscordBridge({ envKeySuffix: instanceEnvKeySuffix(name), instanceKey: `discord-${name}` });
}

registerChannelAdapter('discord', {
  factory: () => createDiscordBridge(),
  defaults: DISCORD_DEFAULTS,
});

// Named instances: registration is unconditional for every listed name (a
// missing credential set is then reported at boot instead of leaving a bot
// silently absent), and every registration carries the same DISCORD_DEFAULTS
// declaration as the default bot, so offline creation paths (setup, ncl)
// resolve declared wiring defaults for named instances too. Names are
// lowercase kebab so the env-key mapping is one-to-one and the instance key
// is URL-safe for the bridge.
for (const raw of (readEnvFile(['DISCORD_INSTANCES']).DISCORD_INSTANCES ?? '').split(',')) {
  const name = raw.trim();
  if (!name) continue;
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) {
    log.warn('DISCORD_INSTANCES name must match ^[a-z0-9][a-z0-9-]*$, skipping', { name });
    continue;
  }
  registerChannelAdapter(`discord-${name}`, {
    factory: () => discordInstanceBridgeFactory(name),
    defaults: DISCORD_DEFAULTS,
  });
}
