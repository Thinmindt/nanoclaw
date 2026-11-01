/**
 * Sibling bots in one Discord room, one bot per agent group.
 *
 * With several bots in a shared room, each bot also receives the others'
 * posts. The bridge forwards them like any message (it never drops bot
 * authors), so what stops one agent's post from waking another is the room's
 * sender gate: a sibling bot's user id is an unapproved sender under the
 * Discord default `request_approval`, so its post is held for the owner and
 * nothing is routed to the agent. Letting agents read each other is a later,
 * separate change; until then this test pins the hold.
 *
 * Under guard:
 *  1. A bot-authored inbound on a named instance (`discord-architect`) is held
 *     at the gate: one pending approval for that sender on that row, no
 *     container woken, no session made.
 *  2. The approval card for it goes out through the same instance, to the
 *     owner's DM with that bot, never through the default bot.
 *  3. Control: the owner's own message on the same row is engaged, so the
 *     hold in (1) is the gate and not a wiring that never fires.
 */
import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { initTestDb, closeDb, runMigrations } from '../db/index.js';
import { createAgentGroup } from '../db/agent-groups.js';
import { createMessagingGroup, createMessagingGroupAgent } from '../db/messaging-groups.js';
import { upsertUser } from '../modules/permissions/db/users.js';
import { grantRole } from '../modules/permissions/db/user-roles.js';

vi.mock('../container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
  isContainerRunning: vi.fn().mockReturnValue(false),
  getActiveContainerCount: vi.fn().mockReturnValue(0),
  killContainer: vi.fn(),
}));

const deliverMock = vi.fn().mockResolvedValue('plat-msg-id');
vi.mock('../delivery.js', () => ({
  getDeliveryAdapter: () => ({ deliver: deliverMock }),
}));

// Each bot has its own DM with the owner: resolve the owner's DM row on the
// requested instance instead of opening a DM over the network.
vi.mock('../modules/permissions/user-dm.js', () => ({
  ensureUserDm: vi.fn(async (_userId: string, opts?: { instance?: string }) => {
    const { getDb } = await import('../db/connection.js');
    return getDb().get(
      `SELECT * FROM messaging_groups WHERE channel_type = 'discord' AND is_group = 0 AND instance = ?`,
      opts?.instance ?? 'discord',
    );
  }),
}));

const TEST_DIR = '/tmp/nanoclaw-test-discord-sibling-bot-gate';

vi.mock('../config.js', async () => {
  const actual = await vi.importActual('../config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-discord-sibling-bot-gate' };
});

const ROOM = 'discord:guild-1:shared-room';

function now() {
  return new Date().toISOString();
}

beforeEach(async () => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  const db = await initTestDb();
  await runMigrations(db);
  await import('../modules/permissions/index.js');

  await createAgentGroup({ id: 'ag-arch', name: 'Architect', folder: 'arch', agent_provider: null, created_at: now() });

  // The shared room as the architect's bot sees it: its own row on its instance.
  await createMessagingGroup({
    id: 'mg-room-arch',
    channel_type: 'discord',
    platform_id: ROOM,
    instance: 'discord-architect',
    name: 'shared room',
    is_group: 1,
    unknown_sender_policy: 'request_approval',
    created_at: now(),
  });
  await createMessagingGroupAgent({
    id: 'mga-room-arch',
    messaging_group_id: 'mg-room-arch',
    agent_group_id: 'ag-arch',
    engage_mode: 'pattern',
    engage_pattern: '.',
    sender_scope: 'all',
    ignored_message_policy: 'drop',
    session_mode: 'shared',
    priority: 0,
    created_at: now(),
  });

  await upsertUser({ id: 'discord:owner', kind: 'discord', display_name: 'Owner', created_at: now() });
  await grantRole({
    user_id: 'discord:owner',
    role: 'owner',
    agent_group_id: null,
    granted_by: null,
    granted_at: now(),
  });

  // The owner's DM with each bot is its own row.
  for (const [id, instance, platform] of [
    ['mg-dm-default', 'discord', 'discord:@me:dm-default-bot'],
    ['mg-dm-arch', 'discord-architect', 'discord:@me:dm-architect-bot'],
  ]) {
    await createMessagingGroup({
      id,
      channel_type: 'discord',
      platform_id: platform,
      instance,
      name: 'Owner DM',
      is_group: 0,
      unknown_sender_policy: 'strict',
      created_at: now(),
    });
  }

  deliverMock.mockClear();
});

afterEach(async () => {
  await closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

/** An inbound on the architect's bot, shaped as the Chat SDK bridge forwards it. */
function inbound(author: { userId: string; userName: string; isBot: boolean }, text: string) {
  return {
    channelType: 'discord',
    instance: 'discord-architect',
    platformId: ROOM,
    threadId: null,
    message: {
      id: `m-${Math.random().toString(36).slice(2, 8)}`,
      kind: 'chat-sdk' as const,
      content: JSON.stringify({ text, author, senderId: author.userId, sender: author.userName }),
      timestamp: now(),
      isMention: false,
      isGroup: true,
    },
  };
}

const siblingBot = { userId: 'steward-bot', userName: 'Steward bot', isBot: true };

describe('a sibling bot posting in a shared room', () => {
  it('is held at the sender gate on the receiving instance, not engaged', async () => {
    const { routeInbound } = await import('../router.js');
    const { wakeContainer } = await import('../container-runner.js');
    vi.mocked(wakeContainer).mockClear();

    await routeInbound(inbound(siblingBot, 'a reply meant for the owner'));
    await vi.waitFor(() => expect(deliverMock).toHaveBeenCalledTimes(1));

    // The hold is the pending approval for this sender on this row. (The
    // unregistered_senders row is upserted per room, so its reason column
    // ends on the router's later no_agent_engaged, not the gate's reason.)
    const { getDb } = await import('../db/connection.js');
    const pending = await getDb().all<{ messaging_group_id: string; sender_identity: string }>(
      'SELECT messaging_group_id, sender_identity FROM pending_sender_approvals',
    );
    expect(pending).toEqual([{ messaging_group_id: 'mg-room-arch', sender_identity: 'discord:steward-bot' }]);
    expect(wakeContainer).not.toHaveBeenCalled();
    expect(await getDb().all('SELECT id FROM sessions')).toEqual([]);
  });

  it("sends the approval card through the receiving bot's own DM with the owner", async () => {
    const { routeInbound } = await import('../router.js');
    await routeInbound(inbound(siblingBot, 'hello'));
    await vi.waitFor(() => expect(deliverMock).toHaveBeenCalledTimes(1));

    const [channelType, platformId, , , , , instance] = deliverMock.mock.calls[0];
    expect(channelType).toBe('discord');
    expect(platformId).toBe('discord:@me:dm-architect-bot');
    expect(instance).toBe('discord-architect');
  });

  it("control: the owner's own message on the same row is engaged", async () => {
    const { routeInbound } = await import('../router.js');
    const { wakeContainer } = await import('../container-runner.js');
    vi.mocked(wakeContainer).mockClear();

    await routeInbound(inbound({ userId: 'owner', userName: 'Owner', isBot: false }, 'over to you'));

    await vi.waitFor(() => expect(wakeContainer).toHaveBeenCalled());
    expect(deliverMock).not.toHaveBeenCalled();
  });
});
