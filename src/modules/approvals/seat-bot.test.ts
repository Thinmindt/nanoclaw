/**
 * Which bot carries an approval card when the asking session has no chat, or
 * sits on a chat record its seat has left.
 *
 * Two live Discord bots in the real channel registry: the default `discord`
 * and the seat's own `discord-pm`. Delivery goes through the host's real
 * delivery bridge, which picks the adapter by its instance name, so each
 * fake adapter records only the cards that reached it. The owner's cached DM
 * starts on the default bot; the seat is linked to one room on its own bot.
 */
import * as fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChannelAdapter } from '../../channels/adapter.js';
import {
  createChannelDeliveryAdapter,
  initChannelAdapters,
  registerChannelAdapter,
  teardownChannelAdapters,
} from '../../channels/channel-registry.js';
import { createAgentGroup } from '../../db/agent-groups.js';
import { initTestDb, closeDb, runMigrations } from '../../db/index.js';
import { createMessagingGroup, createMessagingGroupAgent } from '../../db/messaging-groups.js';
import { createSession, getPendingApprovalsByAction } from '../../db/sessions.js';
import { setDeliveryAdapter } from '../../delivery.js';
import { log } from '../../log.js';
import { writeSessionMessage } from '../../session-manager.js';
import type { Session } from '../../types.js';
import { upsertUser } from '../permissions/db/users.js';
import { upsertUserDm } from '../permissions/db/user-dms.js';
import { grantRole } from '../permissions/db/user-roles.js';
import { requestApproval } from './primitive.js';

vi.mock('../../container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual('../../config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-approval-seat-bot' };
});

vi.mock('../../session-manager.js', async () => {
  const actual = await vi.importActual<typeof import('../../session-manager.js')>('../../session-manager.js');
  return { ...actual, writeSessionMessage: vi.fn() };
});

const TEST_DIR = '/tmp/nanoclaw-test-approval-seat-bot';
const ACTION = 'test_action';

function now(): string {
  return new Date().toISOString();
}

/** Every card an adapter was handed, by the registry key of the bot that got it. */
let posts: Array<{ bot: string; platformId: string }>;
/** Bots whose deliver throws / whose openDM throws. */
let failingPost: Set<string>;
let failingDm: Set<string>;

function registerBot(key: string, channelType: string, withOpenDM: boolean): void {
  const adapter: ChannelAdapter = {
    name: key,
    channelType,
    instance: key === channelType ? undefined : key,
    supportsThreads: true,
    async setup() {},
    async teardown() {},
    isConnected: () => true,
    async deliver(platformId) {
      posts.push({ bot: key, platformId });
      if (failingPost.has(key)) throw new Error(`${key} post failed`);
      return 'pm-1';
    },
  };
  if (withOpenDM) {
    adapter.openDM = async (handle) => {
      if (failingDm.has(key)) throw new Error(`${key} cannot open the DM`);
      return `dm-${key}-${handle}`;
    };
  }
  registerChannelAdapter(key, { factory: () => adapter });
}

async function room(id: string, instance: string, platformId: string): Promise<void> {
  await createMessagingGroup({
    id,
    channel_type: 'discord',
    platform_id: platformId,
    instance,
    name: id,
    is_group: 1,
    unknown_sender_policy: 'strict',
    created_at: now(),
  });
}

async function link(messagingGroupId: string): Promise<void> {
  await createMessagingGroupAgent({
    id: `mga-${messagingGroupId}`,
    messaging_group_id: messagingGroupId,
    agent_group_id: 'ag-pm',
    engage_mode: 'pattern',
    engage_pattern: '.',
    sender_scope: 'all',
    ignored_message_policy: 'drop',
    session_mode: 'shared',
    priority: 0,
    created_at: now(),
  });
}

/** Raise one card from a session on `messagingGroupId` (null: no chat); return where it went. */
async function raiseCard(messagingGroupId: string | null, threadId: string | null = null) {
  const session: Session = {
    id: `sess-${messagingGroupId ?? 'none'}-${threadId ?? 'none'}`,
    agent_group_id: 'ag-pm',
    messaging_group_id: messagingGroupId,
    thread_id: threadId,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: now(),
    created_at: now(),
  };
  await createSession(session);
  await requestApproval({
    session,
    agentName: 'PM',
    action: ACTION,
    payload: {},
    title: 'Approval',
    question: 'Agent "PM" wants to send a message to "Scout"',
  });
  const [stored] = await getPendingApprovalsByAction(ACTION);
  return { posts, stored };
}

beforeEach(async () => {
  vi.clearAllMocks();
  posts = [];
  failingPost = new Set();
  failingDm = new Set();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  const db = await initTestDb();
  await runMigrations(db);

  registerBot('discord', 'discord', true);
  registerBot('discord-pm', 'discord', true);
  registerBot('slack', 'slack', false);
  await initChannelAdapters(() => ({
    onInbound: () => {},
    onInboundEvent: () => {},
    onMetadata: () => {},
    onAction: () => {},
  }));
  setDeliveryAdapter(createChannelDeliveryAdapter());

  await createAgentGroup({ id: 'ag-pm', name: 'PM', folder: 'pm', agent_provider: null, created_at: now() });
  await upsertUser({ id: 'discord:owner', kind: 'discord', display_name: 'Owner', created_at: now() });
  await grantRole({
    user_id: 'discord:owner',
    role: 'owner',
    agent_group_id: null,
    granted_by: null,
    granted_at: now(),
  });

  // The owner's cached DM is on the default bot.
  await createMessagingGroup({
    id: 'mg-dm-default',
    channel_type: 'discord',
    platform_id: 'dm-discord-owner',
    instance: 'discord',
    name: 'Owner DM',
    is_group: 0,
    unknown_sender_policy: 'strict',
    created_at: now(),
  });
  await upsertUserDm({
    user_id: 'discord:owner',
    channel_type: 'discord',
    messaging_group_id: 'mg-dm-default',
    resolved_at: now(),
  });

  // The seat's room on its own bot, linked; an old room on the default bot, left.
  await room('mg-room-pm', 'discord-pm', 'C-pm');
  await link('mg-room-pm');
  await room('mg-room-old', 'discord', 'C-old');
});

afterEach(async () => {
  await teardownChannelAdapters();
  await closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("the seat's one linked bot carries the card", () => {
  it('when the session has no chat', async () => {
    const info = vi.spyOn(log, 'info');
    const { posts, stored } = await raiseCard(null);

    expect(posts).toEqual([{ bot: 'discord-pm', platformId: 'dm-discord-pm-owner' }]);
    expect(stored.instance).toBe('discord-pm');
    expect(stored.approver_user_id).toBe('discord:owner');
    expect(info).toHaveBeenCalledWith('Approval requested', expect.objectContaining({ bot: 'discord-pm' }));
  });

  it('when the session has no chat and a scheduled-task thread', async () => {
    const { posts, stored } = await raiseCard(null, 'task-thread');

    expect(posts.map((p) => p.bot)).toEqual(['discord-pm']);
    expect(stored.instance).toBe('discord-pm');
  });

  it('when the session sits on a chat record the seat has left', async () => {
    const { posts, stored } = await raiseCard('mg-room-old');

    expect(posts.map((p) => p.bot)).toEqual(['discord-pm']);
    expect(stored.instance).toBe('discord-pm');
  });
});

describe('cards that land where they do today', () => {
  it('a session on a record the seat is still linked to', async () => {
    const { posts, stored } = await raiseCard('mg-room-pm');

    expect(posts.map((p) => p.bot)).toEqual(['discord-pm']);
    expect(stored.instance).toBe('discord-pm');
  });

  it('a seat with two bots linked', async () => {
    await link('mg-room-old');
    const { posts, stored } = await raiseCard(null);

    expect(posts.map((p) => p.bot)).toEqual(['discord']);
    expect(stored.instance).toBe('discord');
  });

  it("a seat whose bot cannot open the approver's DM", async () => {
    failingDm.add('discord-pm');
    const { posts, stored } = await raiseCard(null);

    expect(posts.map((p) => p.bot)).toEqual(['discord']);
    expect(stored.instance).toBe('discord');
  });

  it('two approvers on two chat services with no approver named: the person is unchanged', async () => {
    await upsertUser({ id: 'slack:admin', kind: 'slack', display_name: 'Admin', created_at: now() });
    await grantRole({
      user_id: 'slack:admin',
      role: 'admin',
      agent_group_id: 'ag-pm',
      granted_by: null,
      granted_at: now(),
    });
    const { posts, stored } = await raiseCard(null);

    expect(posts.map((p) => p.bot)).toEqual(['slack']);
    expect(stored.approver_user_id).toBe('slack:admin');
  });
});

describe('a card whose post fails after the DM opened', () => {
  it("is sent once more to today's target, and the stored request and log lines name each bot", async () => {
    failingPost.add('discord-pm');
    const info = vi.spyOn(log, 'info');
    const error = vi.spyOn(log, 'error');
    const { posts, stored } = await raiseCard(null);

    expect(posts.map((p) => p.bot)).toEqual(['discord-pm', 'discord']);
    expect(stored.instance).toBe('discord');
    expect(error).toHaveBeenCalledWith(
      'Failed to deliver approval card',
      expect.objectContaining({ bot: 'discord-pm' }),
    );
    expect(info).toHaveBeenCalledWith('Approval requested', expect.objectContaining({ bot: 'discord' }));
  });

  it('is removed and the seat told when the second post fails too', async () => {
    failingPost.add('discord-pm');
    failingPost.add('discord');
    const { posts, stored } = await raiseCard(null);

    expect(posts.map((p) => p.bot)).toEqual(['discord-pm', 'discord']);
    expect(stored).toBeUndefined();
    expect(vi.mocked(writeSessionMessage)).toHaveBeenCalledOnce();
  });

  it("is not retried when it was going to today's target in the first place", async () => {
    failingPost.add('discord-pm');
    const { posts, stored } = await raiseCard('mg-room-pm');

    expect(posts.map((p) => p.bot)).toEqual(['discord-pm']);
    expect(stored).toBeUndefined();
    expect(vi.mocked(writeSessionMessage)).toHaveBeenCalledOnce();
  });
});
